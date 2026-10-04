import { planDb } from '../db/planDb';
import type { ObsSession } from '../types';
import { sessionsInvalidatedByTarget, INVALID_REASON_THRESHOLD } from '../utils/scheduling';

/**
 * 跨上下文联动（编排侧自治）：
 * 目标库协调员改了阈值 / 曝光并在自己的事务提交后，调用这里；
 * 这里只开编排库自己的事务，把引用该目标、快照过期且尚未拍完的段改成「待重排」。
 * 已经拍完（已完成 / 因云取消）的段不动；失败只回滚编排库这份，目标侧改动不受影响。
 *
 * @returns 本次新打入待重排的段数
 */
export async function invalidateSessionsForTargets(updates: Array<{ targetId: string; revision: number }>): Promise<number> {
  if (updates.length === 0) return 0;
  let changed = 0;

  await planDb.transaction('rw', planDb.sessions, async () => {
    const all = await planDb.sessions.toArray();
    const staleIds = new Set<string>();
    updates.forEach(({ targetId, revision }) => {
      sessionsInvalidatedByTarget(all, targetId, revision).forEach((item) => staleIds.add(item.id));
    });
    if (staleIds.size === 0) return;

    await planDb.sessions.where('id').anyOf([...staleIds]).modify((session: ObsSession) => {
      session.status = '待重排';
      session.invalidReason = INVALID_REASON_THRESHOLD;
    });
    changed = staleIds.size;
  });

  if (changed > 0) await refreshSessionStore();
  return changed;
}

/**
 * 启动 / 编排库重新水合后全量核对一次：
 * 防止“目标侧已提交、联动那步失败”留下的过期已确认段（只回滚自己那份意味着这是可能的中间态）。
 */
export async function reconcileSessionSnapshots(targets: Array<{ id: string; revision: number }>): Promise<number> {
  return invalidateSessionsForTargets(targets.map((target) => ({ targetId: target.id, revision: target.revision })));
}

/** 联动写库后把最新数据灌回排程段 store（动态 import 规避模块循环依赖） */
async function refreshSessionStore(): Promise<void> {
  const { useSessionStore } = await import('../stores/sessionStore');
  await useSessionStore.getState().hydrate();
}
