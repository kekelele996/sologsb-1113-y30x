/**
 * 目标库（限界上下文：目标协调员）。
 * 物理上与编排库分成两个 Dexie 数据库：协调员只读写这一个库，
 * 编排库失败不会回滚到这里，反之亦然。
 */
export const CATALOG_DB_NAME = 'gbobsplan-catalog-db';

/** 当前数据结构版本（两侧统一升到 v3：目标库 / 编排库拆分） */
export const SCHEMA_VERSION = 3;

/**
 * v3 建库索引。
 * 目标库内不允许出现 sessions / nights / telescopes / instruments 表。
 * owner 建索引仅为便于排查归属，不参与业务查询。
 */
export const CATALOG_STORES = {
  targets: 'id, name, catalog, type, priority, magnitude, revision, owner',
} as const;
