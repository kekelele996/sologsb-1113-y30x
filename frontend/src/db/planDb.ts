import Dexie, { type Table } from 'dexie';
import type { Instrument, ObsNight, ObsSession, Telescope } from '../types';

/**
 * 编排库（限界上下文：值班排程员）。
 * 物理上与目标库分成两个 Dexie 数据库：排程员只读写这一个库；
 * 目标库的事务失败只回滚目标库自己，不影响这里已经排定的观测夜与时段。
 */
export const PLAN_DB_NAME = 'gbobsplan-plan-db';

/** meta 键：升级回填完成标记 */
export const PLAN_META_MIGRATED = 'migratedFromV2';
/** meta 键：示例数据写入标记（编排侧） */
export const PLAN_META_SEEDED = 'seeded';

/** 排程侧 meta 表行 */
export interface PlanMetaRow {
  key: string;
  value: string;
}

/**
 * v3 建库索引。
 * - status：待重排 / 排队顺延筛选
 * - nightId + telescopeId：一夜一台望远镜的容量统计
 * （目标快照 revision 存在 targetSnapshot.revision，核对时整表读出，不单独建索引）
 */
export const PLAN_STORES = {
  sessions: 'id, nightId, targetId, telescopeId, instrumentId, startTime, status, backupNightId',
  nights: 'id, date, siteName, primary, backup',
  telescopes: 'id, code, status',
  instruments: 'id, model, telescopeCode, terminalType',
  meta: 'key',
} as const;

class PlanDatabase extends Dexie {
  sessions!: Table<ObsSession, string>;
  nights!: Table<ObsNight, string>;
  telescopes!: Table<Telescope, string>;
  instruments!: Table<Instrument, string>;
  meta!: Table<PlanMetaRow, string>;

  constructor() {
    super(PLAN_DB_NAME);
    // v3：编排库首次建库即按归属拆分后的结构；旧 gbobsplan-db 的回填见 migrateV2ToSplit
    this.version(3).stores(PLAN_STORES);
  }
}

export const planDb = new PlanDatabase();
