import { useEffect, useState } from 'react';
import { catalogDb } from '../db/catalogDb';
import { PLAN_META_SEEDED, planDb } from '../db/planDb';
import { migrateV2ToSplit } from '../db/migrate';
import {
  SEED_INSTRUMENTS,
  SEED_NIGHTS,
  SEED_SESSIONS,
  SEED_TARGETS,
  SEED_TELESCOPES,
} from '../db/seeds';
import { reconcileSessionSnapshots } from '../services/invalidation';

/** 目标库 meta 键：示例数据写入标记（目标侧自己记自己的） */
export const CATALOG_META_SEEDED = 'seeded';

/**
 * 两侧各自播种：目标库、编排库分别开自己的事务，
 * 一侧播种失败只回滚自己那份，另一侧的数据照常可用。
 */
export async function seedIfEmpty(): Promise<void> {
  // 目标库
  const catalogSeeded = await catalogDb.meta.get(CATALOG_META_SEEDED);
  if (!catalogSeeded) {
    const targetCount = await catalogDb.targets.count();
    await catalogDb.transaction('rw', catalogDb.targets, catalogDb.meta, async () => {
      if (targetCount === 0) await catalogDb.targets.bulkPut(SEED_TARGETS);
      await catalogDb.meta.put({ key: CATALOG_META_SEEDED, value: new Date().toISOString() });
    });
  }

  // 编排库
  const planSeeded = await planDb.meta.get(PLAN_META_SEEDED);
  if (!planSeeded) {
    const [sessionCount, telescopeCount, instrumentCount, nightCount] = await Promise.all([
      planDb.sessions.count(),
      planDb.telescopes.count(),
      planDb.instruments.count(),
      planDb.nights.count(),
    ]);
    await planDb.transaction(
      'rw',
      planDb.sessions,
      planDb.nights,
      planDb.telescopes,
      planDb.instruments,
      planDb.meta,
      async () => {
        if (nightCount === 0) await planDb.nights.bulkPut(SEED_NIGHTS);
        if (telescopeCount === 0) await planDb.telescopes.bulkPut(SEED_TELESCOPES);
        if (instrumentCount === 0) await planDb.instruments.bulkPut(SEED_INSTRUMENTS);
        if (sessionCount === 0) await planDb.sessions.bulkPut(SEED_SESSIONS);
        await planDb.meta.put({ key: PLAN_META_SEEDED, value: new Date().toISOString() });
      },
    );
  }
}

/** 把两个库的数据同步到各 Zustand store（动态 import 规避模块循环依赖） */
export async function hydrateAllStores(): Promise<void> {
  const [{ useTargetStore }, { useSessionStore }, { useEquipmentStore }, { useNightStore }] = await Promise.all([
    import('../stores/targetStore'),
    import('../stores/sessionStore'),
    import('../stores/equipmentStore'),
    import('../stores/nightStore'),
  ]);
  await Promise.all([
    useTargetStore.getState().hydrate(),
    useSessionStore.getState().hydrate(),
    useEquipmentStore.getState().hydrate(),
    useNightStore.getState().hydrate(),
  ]);

  // 水合后按目标库当前 revision 全量核对排程段快照：
  // 修复“目标侧已提交、联动标记失败”的中间态（两侧写入各自独立、互不连坐）
  const targets = await catalogDb.targets.toArray();
  await reconcileSessionSnapshots(targets.map((target) => ({ id: target.id, revision: target.revision })));
}

let bootstrap: Promise<void> | null = null;

/**
 * 启动序列：开两个独立数据库 → 旧 v2 混库按归属回填到两侧（回填成功才删旧库）
 * → 两侧各自播种 → 灌入 store 并核对快照。多次调用复用同一 promise。
 */
export function bootstrapDatabases(): Promise<void> {
  if (!bootstrap) {
    bootstrap = (async () => {
      await Promise.all([catalogDb.open(), planDb.open()]);
      await migrateV2ToSplit();
      await seedIfEmpty();
      await hydrateAllStores();
    })();
  }
  return bootstrap;
}

/** 页面与外壳用它判断两侧数据是否就绪（失败信息保留，不阻断渲染） */
export function usePersistentStore(): { ready: boolean; error: string } {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    bootstrapDatabases()
      .then(() => {
        if (alive) setReady(true);
      })
      .catch((reason: unknown) => {
        if (alive) {
          setError((reason as Error).message);
          setReady(true);
        }
      });
    return () => {
      alive = false;
    };
  }, []);

  return { ready, error };
}
