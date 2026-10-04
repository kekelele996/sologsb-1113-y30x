/**
 * 数据归属（份）：观测目标、曝光参数与高度阈值归「目标协调员」维护；
 * 观测夜、排程段与望远镜占用归「值班排程员」维护。两侧各写各的表，
 * 跨侧影响（如阈值改动令排程段失效）只能通过独立事务触发，谁也改不到对方那份。
 */
export type DataOwner = 'coordinator' | 'scheduler';

export const DATA_OWNERS: DataOwner[] = ['coordinator', 'scheduler'];

export const DATA_OWNER_LABEL: Record<DataOwner, string> = {
  coordinator: '目标协调员',
  scheduler: '值班排程员',
};
