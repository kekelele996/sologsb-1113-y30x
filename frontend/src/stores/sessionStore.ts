import { create } from 'zustand';
import { db, deleteRow, persistRow, SCHEMA_VERSION } from '../hooks/usePersistentStore';
import { uid } from '../utils/id';
import { durationMinutes } from '../utils/astro';
import { occupiesCapacity, resolvePlacement } from '../utils/scheduling';
import { useNightStore } from './nightStore';
import type { ObsSession, SessionStatus } from '../types';

export interface SessionInput {
  nightId: string;
  targetId: string;
  startTime: string;
  endTime: string;
  telescopeId: string;
  instrumentId: string;
  filterSlot: string;
  plannedFrames: number;
  status: SessionStatus;
  rescheduleReason?: string;
  backupNightId?: string;
}

interface SessionState {
  sessions: ObsSession[];
  hydrated: boolean;
  hydrate: () => Promise<void>;
  addSession: (input: SessionInput) => Promise<ObsSession>;
  updateSession: (id: string, patch: Partial<SessionInput>) => Promise<void>;
  removeSession: (id: string) => Promise<void>;
  /** 批量改期到备用观测夜并填写改期原因 */
  rescheduleToBackup: (ids: string[], backupNightId: string, reason: string) => Promise<number>;
  /** 把因目标阈值失效的排程段重新排到某夜（容量感知，满了顺延下一夜） */
  reschedulePending: (id: string, nightId: string) => Promise<void>;
  /** 批量把待重排段重新排到某夜 */
  reschedulePendingBatch: (ids: string[], nightId: string) => Promise<number>;
  updateStatus: (id: string, status: SessionStatus) => Promise<void>;
  /** 目标阈值改动后，把引用该目标且未拍完的排程段置为「待重排」（排程侧独立事务） */
  invalidateSessionsForTarget: (targetId: string) => Promise<number>;
}

/** 排程段与冲突检测所需数据（值班排程员侧：只写排程段表） */
export const useSessionStore = create<SessionState>()((set, get) => ({
  sessions: [],
  hydrated: false,

  hydrate: async () => {
    const sessions = await db.sessions.orderBy('startTime').toArray();
    set({ sessions, hydrated: true });
  },

  addSession: async (input) => {
    const duration = durationMinutes(input.startTime, input.endTime);
    const placement = resolvePlacement(
      get().sessions,
      useNightStore.getState().nights,
      input.telescopeId,
      input.nightId,
      duration,
    );
    const session: ObsSession = {
      id: uid('s'),
      owner: 'scheduler',
      nightId: placement.nightId,
      targetId: input.targetId,
      startTime: input.startTime,
      endTime: input.endTime,
      telescopeId: input.telescopeId,
      instrumentId: input.instrumentId,
      filterSlot: input.filterSlot,
      plannedFrames: Number(input.plannedFrames) || 0,
      status: input.status,
      rescheduleReason: input.rescheduleReason?.trim() || undefined,
      backupNightId: input.backupNightId,
      queued: placement.queued,
      queuedReason: placement.queuedReason,
      schemaVersion: SCHEMA_VERSION,
    };
    // 排程侧写入：独立事务，只回滚排程段表
    await persistRow('sessions', session);
    set({ sessions: [...get().sessions, session] });
    return session;
  },

  updateSession: async (id, patch) => {
    const current = get().sessions.find((session) => session.id === id);
    if (!current) return;
    const merged: ObsSession = { ...current, ...patch, schemaVersion: SCHEMA_VERSION };
    let next = merged;
    // 仅当该段占用望远镜容量时做容量排队；因云取消 / 待重排不占容量，不动落点
    if (occupiesCapacity(merged)) {
      const duration = durationMinutes(merged.startTime, merged.endTime);
      const placement = resolvePlacement(
        get().sessions,
        useNightStore.getState().nights,
        merged.telescopeId,
        merged.nightId,
        duration,
        id,
      );
      next = { ...merged, nightId: placement.nightId, queued: placement.queued, queuedReason: placement.queuedReason };
    }
    await persistRow('sessions', next);
    set({ sessions: get().sessions.map((session) => (session.id === id ? next : session)) });
  },

  removeSession: async (id) => {
    await deleteRow('sessions', id);
    set({ sessions: get().sessions.filter((session) => session.id !== id) });
  },

  rescheduleToBackup: async (ids, backupNightId, reason) => {
    const targets = get().sessions.filter((session) => ids.includes(session.id));
    const updated = targets.map((session) => ({
      ...session,
      backupNightId,
      status: '因云取消' as SessionStatus,
      rescheduleReason: reason.trim() || '改期至备用观测夜',
      queued: false,
      queuedReason: undefined,
      schemaVersion: SCHEMA_VERSION,
    }));
    for (const session of updated) {
      await persistRow('sessions', session);
    }
    set({ sessions: get().sessions.map((session) => updated.find((item) => item.id === session.id) ?? session) });
    return updated.length;
  },

  reschedulePending: async (id, nightId) => {
    const current = get().sessions.find((session) => session.id === id);
    if (!current) return;
    const duration = durationMinutes(current.startTime, current.endTime);
    const placement = resolvePlacement(
      get().sessions,
      useNightStore.getState().nights,
      current.telescopeId,
      nightId,
      duration,
      id,
    );
    const next: ObsSession = {
      ...current,
      nightId: placement.nightId,
      status: '待执行',
      rescheduleReason: undefined,
      backupNightId: undefined,
      queued: placement.queued,
      queuedReason: placement.queuedReason,
      schemaVersion: SCHEMA_VERSION,
    };
    await persistRow('sessions', next);
    set({ sessions: get().sessions.map((session) => (session.id === id ? next : session)) });
  },

  reschedulePendingBatch: async (ids, nightId) => {
    const targets = get().sessions.filter((session) => ids.includes(session.id));
    // 用一份工作副本逐段试算容量，避免同批段互相挤占
    const working = [...get().sessions];
    const updated: ObsSession[] = [];
    for (const current of targets) {
      const duration = durationMinutes(current.startTime, current.endTime);
      const placement = resolvePlacement(
        working,
        useNightStore.getState().nights,
        current.telescopeId,
        nightId,
        duration,
        current.id,
      );
      const next: ObsSession = {
        ...current,
        nightId: placement.nightId,
        status: '待执行',
        rescheduleReason: undefined,
        backupNightId: undefined,
        queued: placement.queued,
        queuedReason: placement.queuedReason,
        schemaVersion: SCHEMA_VERSION,
      };
      const index = working.findIndex((item) => item.id === current.id);
      if (index >= 0) working[index] = next;
      else working.push(next);
      updated.push(next);
    }
    // 排程侧独立事务：失败只回滚排程侧
    await db.transaction('rw', db.sessions, async () => {
      await db.sessions.bulkPut(updated);
    });
    set({ sessions: get().sessions.map((session) => updated.find((item) => item.id === session.id) ?? session) });
    return updated.length;
  },

  updateStatus: async (id, status) => {
    await get().updateSession(id, { status });
  },

  invalidateSessionsForTarget: async (targetId) => {
    const linked = get().sessions.filter((session) => session.targetId === targetId && session.status !== '已完成');
    if (linked.length === 0) return 0;
    const updated = linked.map((session) => ({
      ...session,
      status: '待重排' as SessionStatus,
      schemaVersion: SCHEMA_VERSION,
    }));
    // 排程侧独立事务：失败只回滚排程侧，不波及目标侧已提交的改动
    await db.transaction('rw', db.sessions, async () => {
      await db.sessions.bulkPut(updated);
    });
    set({ sessions: get().sessions.map((session) => updated.find((item) => item.id === session.id) ?? session) });
    return updated.length;
  },
}));

/** 目标阈值改动后，把引用该目标且未拍完的排程段置为「待重排」（排程侧独立事务，失败只回滚排程侧） */
export async function invalidateSessionsForTarget(targetId: string): Promise<number> {
  return useSessionStore.getState().invalidateSessionsForTarget(targetId);
}
