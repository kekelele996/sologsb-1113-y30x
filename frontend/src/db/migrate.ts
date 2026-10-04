import type {
  FilterName,
  Instrument,
  ObsNight,
  ObsSession,
  ObsTarget,
  Priority,
  SessionStatus,
  TargetType,
  Telescope,
} from '../types';
import Dexie from 'dexie';
import { catalogDb } from './catalogDb';
import { LEGACY_DB_NAME, openLegacyDb, type LegacyObsSession, type LegacyObsTarget, type LegacyRow } from './legacyDb';
import { PLAN_META_MIGRATED, planDb } from './planDb';
import { SCHEMA_VERSION } from './catalogSchema';

/**
 * v2 → v3 拆分升级。
 *
 * 旧 gbobsplan-db 里目标库和编排表混放、记录没有归属。升级流程：
 * 1. 只读打开旧库，把现有记录按归属回填：targets → 目标库（补 owner=revision=1），
 *    nights/telescopes/instruments/sessions → 编排库（补 owner；排程段补目标约束快照）；
 * 2. 两侧各用各的事务：目标库写失败只回滚目标库，编排库写失败只回滚编排库，互不连坐；
 * 3. 两侧都回填成功并各自落了迁移标记后，才删除旧库（“回填再启用”）。
 *
 * 迁移可安全重试：新库用 put（按主键覆盖）且每侧先查迁移标记，中途失败刷新页面会再来一遍。
 */
export async function migrateV2ToSplit(): Promise<{ migrated: boolean; reason?: string }> {
  // 两侧都已完成回填：旧库此前可能已被删除，直接放行
  const [catalogDone, planDone] = await Promise.all([
    catalogDb.meta.get(PLAN_META_MIGRATED),
    planDb.meta.get(PLAN_META_MIGRATED),
  ]);
  if (catalogDone && planDone) return { migrated: true, reason: 'already' };

  // 全新用户：先探测旧库是否存在，避免 open() 凭空建一个空旧库再删
  const legacyExists = await Dexie.exists(LEGACY_DB_NAME);
  if (!legacyExists) {
    return { migrated: false, reason: 'no-legacy-db' };
  }

  const legacy = openLegacyDb();
  try {
    await legacy.open();
  } catch {
    // 探测后仍打不开（极端情况，如浏览器隐私模式限制）：新库直接启用，不阻塞
    legacy.close();
    return { migrated: false, reason: 'legacy-open-failed' };
  }

  try {
    const [legacyTargets, legacySessions, legacyNights, legacyTelescopes, legacyInstruments] = (await Promise.all([
      legacy.table('targets').toCollection().toArray(),
      legacy.table('sessions').toCollection().toArray(),
      legacy.table('nights').toCollection().toArray(),
      legacy.table('telescopes').toCollection().toArray(),
      legacy.table('instruments').toCollection().toArray(),
    ])) as [LegacyObsTarget[], LegacyObsSession[], LegacyRow[], LegacyRow[], LegacyRow[]];

    /* ------------------------- 目标库回填（协调员侧） ------------------------- */
    if (!catalogDone) {
      const targets = legacyTargets.map(toCatalogTarget);
      await catalogDb.transaction('rw', catalogDb.targets, catalogDb.meta, async () => {
        if (targets.length > 0) await catalogDb.targets.bulkPut(targets);
        await catalogDb.meta.put({ key: PLAN_META_MIGRATED, value: new Date().toISOString() });
      });
    }

    /* ------------------------- 编排库回填（排程员侧） ------------------------- */
    if (!planDone) {
      // 快照按旧目标当前值回填，revision 固定 1：升级不产生“无改动却失效”的假信号
      const targetMap = new Map(legacyTargets.map((row) => [row.id, row]));
      const nights = legacyNights.map((row) => ({ ...(row as unknown as ObsNight), owner: 'plan' as const }));
      const telescopes = legacyTelescopes.map((row) => ({ ...(row as unknown as Telescope), owner: 'plan' as const }));
      const instruments = legacyInstruments.map((row) => ({ ...(row as unknown as Instrument), owner: 'plan' as const }));
      const sessions = legacySessions.map((row) => toPlanSession(row, targetMap));

      await planDb.transaction(
        'rw',
        planDb.sessions,
        planDb.nights,
        planDb.telescopes,
        planDb.instruments,
        planDb.meta,
        async () => {
          if (nights.length > 0) await planDb.nights.bulkPut(nights);
          if (telescopes.length > 0) await planDb.telescopes.bulkPut(telescopes);
          if (instruments.length > 0) await planDb.instruments.bulkPut(instruments);
          if (sessions.length > 0) await planDb.sessions.bulkPut(sessions);
          await planDb.meta.put({ key: PLAN_META_MIGRATED, value: new Date().toISOString() });
        },
      );
    }

    // 两侧都落好归属与快照后，旧库才删除（启用新结构）
    await legacy.close();
    await legacy.delete();
    return { migrated: true };
  } catch (error) {
    legacy.close();
    // 任一侧失败：只回滚了它自己的事务，另一侧已提交的数据保留；下次打开重试回填
    throw new Error(`升级回填失败（已保留可回填的旧库，可重试）：${(error as Error).message}`);
  }
}

function toCatalogTarget(row: LegacyObsTarget): ObsTarget {
  return {
    id: row.id,
    name: String(row.name ?? ''),
    catalog: String(row.catalog ?? ''),
    raHours: Number(row.raHours ?? 0),
    decDeg: Number(row.decDeg ?? 0),
    magnitude: Number(row.magnitude ?? 0),
    type: (row.type as TargetType) ?? '星云',
    filter: (row.filter as FilterName) ?? '无滤镜',
    exposureSec: Number(row.exposureSec ?? 0),
    totalMinutes: Number(row.totalMinutes ?? 0),
    priority: (row.priority as Priority) ?? 'P2',
    minAltitude: Number(row.minAltitude ?? 0),
    revision: 1,
    owner: 'catalog',
    ...(row.remark ? { remark: String(row.remark) } : {}),
  };
}

function toPlanSession(row: LegacyObsSession, targetMap: Map<string, LegacyObsTarget>): ObsSession {
  const target = row.targetId ? targetMap.get(row.targetId) : undefined;
  const legacyStatus = String(row.status ?? '待执行');
  // 旧库只有 4 种状态；未知值一律按待执行落库
  const status: SessionStatus = ['待执行', '进行中', '已完成', '因云取消'].includes(legacyStatus)
    ? (legacyStatus as SessionStatus)
    : '待执行';
  return {
    id: row.id,
    nightId: String(row.nightId ?? ''),
    targetId: String(row.targetId ?? ''),
    startTime: String(row.startTime ?? '18:00'),
    endTime: String(row.endTime ?? '19:00'),
    telescopeId: String(row.telescopeId ?? ''),
    instrumentId: String(row.instrumentId ?? ''),
    filterSlot: String(row.filterSlot ?? '无滤镜'),
    plannedFrames: Number(row.plannedFrames ?? 0),
    status,
    targetSnapshot: {
      revision: 1,
      minAltitude: Number(target?.minAltitude ?? 0),
      exposureSec: Number(target?.exposureSec ?? 0),
      totalMinutes: Number(target?.totalMinutes ?? 0),
      filter: ((target?.filter as FilterName) ?? '无滤镜'),
    },
    owner: 'plan',
    schemaVersion: SCHEMA_VERSION,
    ...(row.rescheduleReason ? { rescheduleReason: String(row.rescheduleReason) } : {}),
    ...(row.backupNightId ? { backupNightId: String(row.backupNightId) } : {}),
  };
}
