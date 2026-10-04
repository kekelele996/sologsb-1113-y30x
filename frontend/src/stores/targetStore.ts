import { create } from 'zustand';
import { catalogDb } from '../db/catalogDb';
import { OWNER_CATALOG, assertOwner, type FilterName, type ObsTarget, type Priority, type TargetType } from '../types';
import { TARGET_CONSTRAINT_KEYS } from '../types';
import { uid } from '../utils/id';
import { invalidateSessionsForTargets } from '../services/invalidation';

export interface TargetInput {
  name: string;
  catalog: string;
  raHours: number;
  decDeg: number;
  magnitude: number;
  type: TargetType;
  filter: FilterName;
  exposureSec: number;
  totalMinutes: number;
  priority: Priority;
  minAltitude: number;
  remark?: string;
}

export interface TargetSaveResult {
  target: ObsTarget;
  /** 是否动到了被排程段引用的约束字段（阈值 / 曝光） */
  constraintChanged: boolean;
  /** 本次被打入待重排的段数（编排侧联动成功时） */
  invalidated: number;
  /** 编排侧联动失败提示：目标已保存在目标库，未回滚；下次打开会自动补核对 */
  invalidationError?: string;
}

interface TargetState {
  targets: ObsTarget[];
  hydrated: boolean;
  hydrate: () => Promise<void>;
  addTarget: (input: TargetInput) => Promise<TargetSaveResult>;
  updateTarget: (id: string, patch: Partial<TargetInput>) => Promise<TargetSaveResult>;
  removeTarget: (id: string) => Promise<void>;
}

/** 判断这次补丁是否真的改到了排程约束字段（值相同不触发失效） */
function changedConstraintKeys(current: ObsTarget, patch: Partial<TargetInput>) {
  return TARGET_CONSTRAINT_KEYS.filter((key) => key in patch && patch[key] !== current[key]);
}

/** 观测目标库（目标协调员）：只写 catalogDb，编排库一行都不碰 */
export const useTargetStore = create<TargetState>()((set, get) => ({
  targets: [],
  hydrated: false,

  hydrate: async () => {
    const targets = await catalogDb.targets.orderBy('name').toArray();
    set({ targets, hydrated: true });
  },

  addTarget: async (input) => {
    const target: ObsTarget = {
      id: uid('target'),
      name: input.name.trim(),
      catalog: input.catalog.trim(),
      raHours: Number(input.raHours) || 0,
      decDeg: Number(input.decDeg) || 0,
      magnitude: Number(input.magnitude) || 0,
      type: input.type,
      filter: input.filter,
      exposureSec: Number(input.exposureSec) || 0,
      totalMinutes: Number(input.totalMinutes) || 0,
      priority: input.priority,
      minAltitude: Number(input.minAltitude) || 0,
      revision: 1,
      owner: OWNER_CATALOG,
      remark: input.remark?.trim() || undefined,
    };
    // 目标库自己的事务：失败只回滚这一个库
    await catalogDb.transaction('rw', catalogDb.targets, async () => {
      await catalogDb.targets.put(target);
    });
    set({ targets: [...get().targets, target].sort((a, b) => a.name.localeCompare(b.name)) });
    return { target, constraintChanged: false, invalidated: 0 };
  },

  updateTarget: async (id, patch) => {
    const current = get().targets.find((target) => target.id === id);
    if (!current) throw new Error(`目标 ${id} 不存在`);
    assertOwner(current, OWNER_CATALOG, '更新观测目标');

    const changedKeys = changedConstraintKeys(current, patch);
    const constraintChanged = changedKeys.length > 0;
    const next: ObsTarget = {
      ...current,
      ...patch,
      // 只有排程引用的阈值 / 曝光字段实际变动才升版本；改名称坐标备注不动排程
      revision: constraintChanged ? current.revision + 1 : current.revision,
      owner: OWNER_CATALOG,
    };

    // 第一步：目标库自己的事务提交。失败只回滚目标库，编排库完全不受影响
    await catalogDb.transaction('rw', catalogDb.targets, async () => {
      await catalogDb.targets.put(next);
    });
    set({ targets: get().targets.map((target) => (target.id === id ? next : target)) });

    // 第二步：跨上下文联动——在编排库自己的事务里把引用它的未拍完段打入待重排。
    // 联动失败不回滚目标（两侧独立事务），留待启动 / 水合时 reconcileSessionSnapshots 补核对。
    let invalidated = 0;
    let invalidationError: string | undefined;
    if (constraintChanged) {
      try {
        invalidated = await invalidateSessionsForTargets([{ targetId: next.id, revision: next.revision }]);
      } catch (error) {
        invalidationError = `目标改动已保存，但编排侧标记待重排失败（只回滚了编排库那份）：${(error as Error).message}；下次打开会自动补核对。`;
      }
    }

    return { target: next, constraintChanged, invalidated, invalidationError };
  },

  removeTarget: async (id) => {
    const current = get().targets.find((target) => target.id === id);
    if (!current) return;
    assertOwner(current, OWNER_CATALOG, '删除观测目标');
    // 只删目标库；编排库里引用它的历史排程段（尤其已拍完的）照旧留住
    await catalogDb.transaction('rw', catalogDb.targets, async () => {
      await catalogDb.targets.delete(id);
    });
    set({ targets: get().targets.filter((target) => target.id !== id) });
  },
}));
