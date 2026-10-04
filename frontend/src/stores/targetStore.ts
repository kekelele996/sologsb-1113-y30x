import { create } from 'zustand';
import { db, deleteRow, persistRow } from '../hooks/usePersistentStore';
import { uid } from '../utils/id';
import type { FilterName, ObsTarget, Priority, TargetType } from '../types';

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

export interface UpdateTargetResult {
  target?: ObsTarget;
  /** 阈值改动后被置为「待重排」的排程段数量 */
  invalidatedCount: number;
  /** 排程侧事务失败信息（目标侧写入已独立提交，回滚不波及目标） */
  invalidationError?: string;
}

interface TargetState {
  targets: ObsTarget[];
  hydrated: boolean;
  hydrate: () => Promise<void>;
  addTarget: (input: TargetInput) => Promise<ObsTarget>;
  updateTarget: (id: string, patch: Partial<TargetInput>) => Promise<UpdateTargetResult>;
  removeTarget: (id: string) => Promise<void>;
}

/** 观测目标库（目标协调员侧：只写目标表，阈值改动通过独立事务知会排程侧） */
export const useTargetStore = create<TargetState>()((set, get) => ({
  targets: [],
  hydrated: false,

  hydrate: async () => {
    const targets = await db.targets.orderBy('name').toArray();
    set({ targets, hydrated: true });
  },

  addTarget: async (input) => {
    const target: ObsTarget = {
      id: uid('target'),
      owner: 'coordinator',
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
      remark: input.remark?.trim() || undefined,
    };
    // 协调员侧写入：独立事务，只回滚目标表
    await persistRow('targets', target);
    set({ targets: [...get().targets, target].sort((a, b) => a.name.localeCompare(b.name)) });
    return target;
  },

  updateTarget: async (id, patch) => {
    const current = get().targets.find((target) => target.id === id);
    if (!current) {
      return { invalidatedCount: 0 };
    }
    const next: ObsTarget = { ...current, ...patch };
    // 协调员侧写入：独立事务，只回滚目标表
    await persistRow('targets', next);
    set({ targets: get().targets.map((target) => (target.id === id ? next : target)) });

    // 阈值一改动，引用它的排程段就失效——这是排程侧的事，走独立事务，
    // 失败只回滚排程侧，不波及已提交的目标改动（谁也改不到对方那份）。
    let invalidatedCount = 0;
    let invalidationError: string | undefined;
    if (patch.minAltitude !== undefined && patch.minAltitude !== current.minAltitude) {
      try {
        const { invalidateSessionsForTarget } = await import('./sessionStore');
        invalidatedCount = await invalidateSessionsForTarget(id);
      } catch (reason) {
        invalidationError = (reason as Error).message;
      }
    }
    return { target: next, invalidatedCount, invalidationError };
  },

  removeTarget: async (id) => {
    await deleteRow('targets', id);
    set({ targets: get().targets.filter((target) => target.id !== id) });
  },
}));
