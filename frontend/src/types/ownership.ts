/** 记录归属（限界上下文）：目标库归目标协调员，编排表归值班排程员，两侧互不可写对方那份 */
export type Owner = 'catalog' | 'plan';

export const OWNER_CATALOG: Owner = 'catalog';
export const OWNER_PLAN: Owner = 'plan';

/** 归属文案（错误提示、迁移日志复用） */
export const OWNER_LABEL: Record<Owner, string> = {
  catalog: '目标库（协调员）',
  plan: '编排表（排程员）',
};

/** 带归属的记录基类：v3 起每条记录都必须标明归谁管，写入前由所属侧校验 */
export interface OwnedRecord {
  owner: Owner;
}

/** 归属校验：谁也写不到对方那份。旧数据未回填归属时直接拒绝写入 */
export function assertOwner(row: Partial<OwnedRecord> | undefined, expected: Owner, where: string): void {
  if (!row || !row.owner) {
    throw new Error(`${where}：该记录尚未回填数据归属，需先完成升级迁移后才能写入`);
  }
  if (row.owner !== expected) {
    throw new Error(`${where}：记录归属为「${OWNER_LABEL[row.owner as Owner]}」，当前侧（${OWNER_LABEL[expected]}）无权修改`);
  }
}
