import { create } from 'zustand';
import { catalogDb } from '../db/catalogDb';
import { SCHEMA_VERSION } from '../db/catalogSchema';
import { planDb } from '../db/planDb';
import {
  isFinishedSession,
  OWNER_PLAN,
  assertOwner,
  snapshotTarget,
  type ObsSession,
  type ObsTarget,
  type SessionStatus,
} from '../types';
import { uid } from '../utils/id';
import { checkCapacity, queueToLaterNight } from '../utils/scheduling';
import { useNightStore } from './nightStore';

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

export interface SessionSaveResult {
  session: ObsSession;
  /** 是否因本夜该望远镜超容量而自动排队顺延到后续观测夜（没有挤掉任何已确认段） */
  overflowed: boolean;
}

interface SessionState {
  sessions: ObsSession[];
  hydrated: boolean;
  hydrate: () => Promise<void>;
  addSession: (input: SessionInput) => Promise<SessionSaveResult>;
  updateSession: (id: string, patch: Partial<SessionInput>) => Promise<SessionSaveResult>;
  removeSession: (id: string) => Promise<void>;
  /** 批量改期到备用观测夜并填写改期原因 */
  rescheduleToBackup: (ids: string[], backupNightId: string, reason: string) => Promise<number>;
  updateStatus: (id: string, status: SessionStatus) => Promise<SessionSaveResult>;
}

/** 跨库只读：排程段排定 / 换目标时，从目标库取目标当前约束固化为快照（不写目标库） */
async function loadTargetSnapshot(targetId: string) {
  const target = (await catalogDb.targets.get(targetId)) as ObsTarget | undefined;
  if (!target) throw new Error(`目标库中找不到目标 ${targetId}，无法排程`);
  return { snapshot: snapshotTarget(target), target };
}

/**
 * 容量路由：段要落进某夜某望远镜时，若各已确认段加起来超出 720 分钟容量，
 * 该段转「排队顺延」挂到后续观测夜，绝不顶掉 / 挪动任何已确认段。
 */
function routeByCapacity(params: {
  sessions: ObsSession[];
  nightId: string;
  telescopeId: string;
  startTime: string;
  endTime: string;
}): Pick<ObsSession, 'status' | 'nightId' | 'invalidReason'> & { overflowed: boolean } {
  const { sessions, nightId, telescopeId, startTime, endTime } = params;
  const check = checkCapacity(sessions, nightId, telescopeId, startTime, endTime);
  if (check.fits) return { status: '待执行', nightId, invalidReason: undefined, overflowed: false };
  const placement = queueToLaterNight({ sessions, fromNightId: nightId, telescopeId, startTime, endTime, nights: useNightStore.getState().nights });
  return { ...placement, overflowed: true };
}

/** 排程段（值班排程员）：只写 planDb；目标库只读引用 */
export const useSessionStore = create<SessionState>()((set, get) => ({
  sessions: [],
  hydrated: false,

  hydrate: async () => {
    const sessions = await planDb.sessions.orderBy('startTime').toArray();
    set({ sessions, hydrated: true });
  },

  addSession: async (input) => {
    const { snapshot } = await loadTargetSnapshot(input.targetId);
    const others = get().sessions;

    const placement = routeByCapacity({
      sessions: others,
      nightId: input.nightId,
      telescopeId: input.telescopeId,
      startTime: input.startTime,
      endTime: input.endTime,
    });

    const session: ObsSession = {
      id: uid('s'),
      nightId: placement.nightId,
      targetId: input.targetId,
      startTime: input.startTime,
      endTime: input.endTime,
      telescopeId: input.telescopeId,
      instrumentId: input.instrumentId,
      filterSlot: input.filterSlot,
      plannedFrames: Number(input.plannedFrames) || 0,
      status: placement.status,
      targetSnapshot: snapshot,
      owner: OWNER_PLAN,
      schemaVersion: SCHEMA_VERSION,
      ...(placement.invalidReason ? { invalidReason: placement.invalidReason } : {}),
      ...(input.rescheduleReason?.trim() ? { rescheduleReason: input.rescheduleReason.trim() } : {}),
      ...(input.backupNightId ? { backupNightId: input.backupNightId } : {}),
    };

    // 编排库自己的事务：失败只回滚编排库，目标库不受影响
    await planDb.transaction('rw', planDb.sessions, async () => {
      await planDb.sessions.put(session);
    });
    set({ sessions: [...get().sessions, session] });
    return { session, overflowed: placement.overflowed };
  },

  updateSession: async (id, patch) => {
    const current = get().sessions.find((session) => session.id === id);
    if (!current) throw new Error(`排程段 ${id} 不存在`);
    assertOwner(current, OWNER_PLAN, '更新排程段');

    const merged: ObsSession = { ...current, ...patch };

    // 排程员重新指定夜 / 望远镜 / 时段，或把待重排 / 排队顺延段重新确认回待执行时，
    // 都重新走容量路由；只改帧数、备注等不重算容量。已完成 / 因云取消的段已落定，编辑也照旧留住。
    const reconfirmingPending =
      (current.status === '待重排' || current.status === '排队顺延') && merged.status === '待执行';
    const schedulingChanged = Boolean(
      !isFinishedSession(merged) &&
        (reconfirmingPending ||
          (patch.nightId && patch.nightId !== current.nightId) ||
          (patch.telescopeId && patch.telescopeId !== current.telescopeId) ||
          (patch.startTime && patch.startTime !== current.startTime) ||
          (patch.endTime && patch.endTime !== current.endTime)),
    );

    // 换了引用目标，或排程员把段重新落定（重排 / 改夜 / 改时段）：快照都按目标当前约束重新固化，
    // 避免刚重排完快照还停在旧 revision、又被启动核对判成过期。
    let targetSnapshot = current.targetSnapshot;
    if ((patch.targetId && patch.targetId !== current.targetId) || schedulingChanged) {
      const loaded = await loadTargetSnapshot(merged.targetId);
      targetSnapshot = loaded.snapshot;
    }

    // 容量统计忽略自身
    const others = get().sessions.filter((session) => session.id !== id);
    let next: ObsSession = {
      ...merged,
      targetSnapshot,
      owner: OWNER_PLAN,
      schemaVersion: SCHEMA_VERSION,
      invalidReason: current.invalidReason,
    };

    let overflowed = false;
    if (schedulingChanged) {
      const placement = routeByCapacity({
        sessions: others,
        nightId: merged.nightId,
        telescopeId: merged.telescopeId,
        startTime: merged.startTime,
        endTime: merged.endTime,
      });
      overflowed = placement.overflowed;
      next = {
        ...next,
        status: placement.status,
        nightId: placement.nightId,
        invalidReason: placement.invalidReason,
      };
    } else if (next.status !== '待重排' && next.status !== '排队顺延') {
      // 普通编辑且段已恢复确认：清掉历史失效原因；待重排段保留原因直到排程员重排
      next = { ...next, invalidReason: undefined };
    }

    await planDb.transaction('rw', planDb.sessions, async () => {
      await planDb.sessions.put(next);
    });
    set({ sessions: get().sessions.map((session) => (session.id === id ? next : session)) });
    return { session: next, overflowed };
  },

  removeSession: async (id) => {
    const current = get().sessions.find((session) => session.id === id);
    if (!current) return;
    assertOwner(current, OWNER_PLAN, '删除排程段');
    await planDb.transaction('rw', planDb.sessions, async () => {
      await planDb.sessions.delete(id);
    });
    set({ sessions: get().sessions.filter((session) => session.id !== id) });
  },

  rescheduleToBackup: async (ids, backupNightId, reason) => {
    const picked = get().sessions.filter((session) => ids.includes(session.id));
    picked.forEach((session) => assertOwner(session, OWNER_PLAN, '批量改期'));

    const updated = picked.map((session) => ({
      ...session,
      backupNightId,
      status: '因云取消' as SessionStatus,
      rescheduleReason: reason.trim() || '改期至备用观测夜',
      invalidReason: undefined,
      owner: OWNER_PLAN,
      schemaVersion: SCHEMA_VERSION,
    }));

    await planDb.transaction('rw', planDb.sessions, async () => {
      await planDb.sessions.bulkPut(updated);
    });
    set({
      sessions: get().sessions.map((session) => updated.find((item) => item.id === session.id) ?? session),
    });
    return updated.length;
  },

  updateStatus: async (id, status) => {
    const current = get().sessions.find((session) => session.id === id);
    if (!current) throw new Error(`排程段 ${id} 不存在`);
    assertOwner(current, OWNER_PLAN, '更新排程段状态');
    // 状态从待重排 / 排队顺延改回待执行，视为排程员重新确认落回原夜：再走一次容量路由
    if (!isFinishedSession(current) && (current.status === '待重排' || current.status === '排队顺延') && status === '待执行') {
      return get().updateSession(id, { status: '待执行', nightId: current.nightId });
    }
    return get().updateSession(id, { status });
  },
}));
