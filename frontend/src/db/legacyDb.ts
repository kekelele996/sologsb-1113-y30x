import Dexie from 'dexie';

/** 升级前混在一起的旧库（v1/v2）：仅迁移期间只读打开，回填成功后删除 */
export const LEGACY_DB_NAME = 'gbobsplan-db';

/** 旧库记录（v2 结构，字段全部宽松处理，缺失时由迁移逻辑补默认值） */
export interface LegacyObsTarget {
  id: string;
  name?: string;
  catalog?: string;
  raHours?: number;
  decDeg?: number;
  magnitude?: number;
  type?: string;
  filter?: string;
  exposureSec?: number;
  totalMinutes?: number;
  priority?: string;
  minAltitude?: number;
  remark?: string;
  [key: string]: unknown;
}

export interface LegacyObsSession {
  id: string;
  nightId?: string;
  targetId?: string;
  startTime?: string;
  endTime?: string;
  telescopeId?: string;
  instrumentId?: string;
  filterSlot?: string;
  plannedFrames?: number;
  status?: string;
  rescheduleReason?: string;
  backupNightId?: string;
  schemaVersion?: number;
  [key: string]: unknown;
}

export interface LegacyRow {
  id: string;
  [key: string]: unknown;
}

/**
 * 以旧版本号（2）只读打开旧库。
 * 不能用更高版本号声明，否则 Dexie 会判定旧库需要升级；迁移只做读出 → 回填，
 * 旧库结构保持原样直到两侧新库都回填成功后再删除。
 */
export function openLegacyDb(): Dexie {
  const legacy = new Dexie(LEGACY_DB_NAME);
  legacy.version(1).stores({
    targets: 'id, name, catalog, type, priority, magnitude',
    sessions: 'id, nightId, targetId, telescopeId, instrumentId, startTime, status',
    telescopes: 'id, code, status',
    instruments: 'id, model, telescopeCode, terminalType',
    nights: 'id, date, siteName, primary, backup',
    meta: 'key',
  });
  legacy.version(2).stores({
    targets: 'id, name, catalog, type, priority, magnitude',
    sessions: 'id, nightId, targetId, telescopeId, instrumentId, startTime, status, backupNightId',
    telescopes: 'id, code, status',
    instruments: 'id, model, telescopeCode, terminalType',
    nights: 'id, date, siteName, primary, backup',
    meta: 'key',
  });
  return legacy;
}
