import Dexie, { type Table } from 'dexie';
import type { ObsTarget } from '../types';
import { CATALOG_DB_NAME, CATALOG_STORES } from './catalogSchema';

/** 目标库 meta（只放本侧自己的标记，与编排库互不可见） */
export interface CatalogMetaRow {
  key: string;
  value: string;
}

class CatalogDatabase extends Dexie {
  targets!: Table<ObsTarget, string>;
  meta!: Table<CatalogMetaRow, string>;

  constructor() {
    super(CATALOG_DB_NAME);
    // v3：目标库独立成库，只含目标表；旧 gbobsplan-db 的回填见 migrateV2ToSplit
    this.version(3)
      .stores({
        ...CATALOG_STORES,
        meta: 'key',
      });
  }
}

export const catalogDb = new CatalogDatabase();
