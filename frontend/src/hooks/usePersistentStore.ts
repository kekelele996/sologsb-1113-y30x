/**
 * 兼容入口：数据库已按限界上下文拆成目标库 / 编排库（见 src/db/*），
 * 页面仍通过本 hook 判定数据就绪；store 改为直接引用 src/db 下对应的库。
 */
export { usePersistentStore, bootstrapDatabases } from '../db/bootstrap';
