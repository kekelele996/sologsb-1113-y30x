import type { TargetConstraintSnapshot } from './target';
import type { OwnedRecord } from './ownership';

/**
 * 排程段状态：
 * - 待执行：排程员排定、占用望远镜时段（已确认）
 * - 进行中：当晚正在拍
 * - 已完成 / 因云取消：已落定，目标参数再怎么改都照旧留住
 * - 待重排：引用的目标阈值 / 曝光被协调员改动，约束快照已过期，等排程员重排（不占容量）
 * - 排队顺延：本夜该望远镜容量排不下，自动顺延到后续观测夜，等排程员确认落回某一夜
 */
export type SessionStatus = '待执行' | '进行中' | '已完成' | '因云取消' | '待重排' | '排队顺延';

/** 已拍完 / 已落定的状态：目标侧再改动也不影响这些段 */
export const FINISHED_SESSION_STATUSES: SessionStatus[] = ['已完成', '因云取消'];

/** 已确认、占用某夜某台望远镜容量的状态（待重排 / 排队顺延都不再占容量） */
export const CONFIRMED_SESSION_STATUSES: SessionStatus[] = ['待执行', '进行中', '已完成', '因云取消'];

/** 尚未落定、等排程员处理的状态 */
export const PENDING_RESCHEDULE_STATUSES: SessionStatus[] = ['待重排', '排队顺延'];

/** 观测排程段（归值班排程员，只存在于编排库） */
export interface ObsSession extends OwnedRecord {
  id: string;
  /** 观测夜 ID（排队顺延且尚未指定下一夜时可空） */
  nightId: string;
  /** 观测目标 ID（跨库只读引用目标库） */
  targetId: string;
  /** 开始时刻 HH:mm */
  startTime: string;
  /** 结束时刻 HH:mm（可跨零点） */
  endTime: string;
  /** 望远镜 ID */
  telescopeId: string;
  /** 终端 ID */
  instrumentId: string;
  /** 滤镜轮位 */
  filterSlot: string;
  /** 计划帧数 */
  plannedFrames: number;
  /** 状态 */
  status: SessionStatus;
  /** 排定时固化的目标约束快照（阈值 / 曝光）；与目标当前 revision 不一致即失效 */
  targetSnapshot: TargetConstraintSnapshot;
  /** 失效原因（进入待重排 / 排队顺延时填写） */
  invalidReason?: string;
  /** 改期原因 */
  rescheduleReason?: string;
  /** 替补夜 ID（迁移时补齐） */
  backupNightId?: string;
  /** 数据结构版本 */
  schemaVersion: number;
}

/** 冲突项 */
export interface ConflictItem {
  /** 当前排程段 */
  sessionId: string;
  /** 与之冲突的排程段 */
  otherId: string;
  nightId: string;
  telescopeId: string;
  /** 重叠分钟数 */
  overlapMinutes: number;
  /** 重叠区间文案 */
  overlapText: string;
}

export const SESSION_STATUSES: SessionStatus[] = ['待执行', '进行中', '已完成', '因云取消', '待重排', '排队顺延'];

/** 6 种状态配色（MUI Chip color） */
export const STATUS_CHIP_COLOR: Record<SessionStatus, 'default' | 'primary' | 'success' | 'error' | 'warning' | 'info'> = {
  待执行: 'default',
  进行中: 'primary',
  已完成: 'success',
  因云取消: 'error',
  待重排: 'warning',
  排队顺延: 'info',
};

/** 已拍完 / 已落定的段：协调员改阈值也不回收 */
export function isFinishedSession(session: Pick<ObsSession, 'status'>): boolean {
  return FINISHED_SESSION_STATUSES.includes(session.status);
}

/** 已确认占用容量的段 */
export function isConfirmedSession(session: Pick<ObsSession, 'status'>): boolean {
  return CONFIRMED_SESSION_STATUSES.includes(session.status);
}
