import { TELESCOPE_NIGHT_CAPACITY_MINUTES, type ObsNight } from '../types/night';
import { isConfirmedSession, type ObsSession, type SessionStatus } from '../types/session';
import { durationMinutes } from './astro';

/** 待重排 / 排队顺延段切换时附带的原因文案 */
export const INVALID_REASON_THRESHOLD = '引用目标的高度阈值 / 曝光参数已被协调员调整，约束快照过期，需排程员重排';
export const OVERFLOW_REASON = (nightDate: string, overflowMinutes: number) =>
  `原排观测夜 ${nightDate} 该望远镜各已确认段合计超出容量 ${overflowMinutes} 分钟，顺延到后续观测夜等待重排`;

/**
 * 一台望远镜一个观测夜的已确认占用分钟数。
 * 只有已确认状态（待执行 / 进行中 / 已完成 / 因云取消）占容量；
 * 待重排、排队顺延都已离开原夜，不占容量。
 */
export function usedCapacityMinutes(sessions: Pick<ObsSession, 'nightId' | 'telescopeId' | 'status' | 'startTime' | 'endTime'>[], nightId: string, telescopeId: string): number {
  return sessions
    .filter((session) => session.nightId === nightId && session.telescopeId === telescopeId && isConfirmedSession(session))
    .reduce((sum, session) => sum + durationMinutes(session.startTime, session.endTime), 0);
}

/** 剩余容量（不会为负） */
export function freeCapacityMinutes(sessions: ObsSession[], nightId: string, telescopeId: string): number {
  return Math.max(0, TELESCOPE_NIGHT_CAPACITY_MINUTES - usedCapacityMinutes(sessions, nightId, telescopeId));
}

export interface CapacityCheck {
  /** 段时长（分钟） */
  duration: number;
  /** 容量上限 */
  capacity: number;
  /** 排段前已占用 */
  usedBefore: number;
  /** 是否放得下（忽略自身时需要调用方先排除该 id） */
  fits: boolean;
  /** 放不下时超出的分钟数 */
  overflowMinutes: number;
}

/** 检查某个（尚未入列或已从列表剔除的）段放进某夜某望远镜后是否超容量；不挤掉任何已确认段 */
export function checkCapacity(sessions: ObsSession[], nightId: string, telescopeId: string, startTime: string, endTime: string): CapacityCheck {
  const duration = durationMinutes(startTime, endTime);
  const usedBefore = usedCapacityMinutes(sessions, nightId, telescopeId);
  const overflowMinutes = Math.max(0, usedBefore + duration - TELESCOPE_NIGHT_CAPACITY_MINUTES);
  return { duration, capacity: TELESCOPE_NIGHT_CAPACITY_MINUTES, usedBefore, fits: overflowMinutes === 0, overflowMinutes };
}

/**
 * 容量放不下时的落位结果：状态转「排队顺延」，目标夜取该夜之后最近的观测夜
 * （只改候选段自身，绝不动任何已确认段；候选夜排不下就继续找再后一夜，
 * 找不到后续夜时 nightId 保留空串，由排程员新建观测夜后重排）。
 */
export interface OverflowPlacement {
  status: Extract<SessionStatus, '排队顺延'>;
  nightId: string;
  invalidReason: string;
}

export function queueToLaterNight(params: {
  sessions: ObsSession[];
  fromNightId: string;
  telescopeId: string;
  startTime: string;
  endTime: string;
  nights: ObsNight[];
}): OverflowPlacement {
  const { sessions, fromNightId, telescopeId, startTime, endTime, nights } = params;
  const fromNight = nights.find((night) => night.id === fromNightId);
  const ordered = [...nights].sort((a, b) => a.date.localeCompare(b.date));
  const laterNights = fromNight ? ordered.filter((night) => night.date > fromNight.date) : ordered;
  const check = checkCapacity(sessions, fromNightId, telescopeId, startTime, endTime);

  for (const candidate of laterNights) {
    // 顺延段在候选夜仍按“排队”身份挂着，不占候选夜容量；这里仅用于挑一个日期最近的落脚夜
    if (freeCapacityMinutes(sessions, candidate.id, telescopeId) >= check.duration) {
      return { status: '排队顺延', nightId: candidate.id, invalidReason: OVERFLOW_REASON(fromNight?.date ?? fromNightId, check.overflowMinutes) };
    }
  }
  return {
    status: '排队顺延',
    nightId: laterNights[0]?.id ?? '',
    invalidReason: OVERFLOW_REASON(fromNight?.date ?? fromNightId, check.overflowMinutes),
  };
}

/**
 * 目标阈值 / 曝光改动后，挑出引用该目标且应当失效的排程段：
 * 已完成 / 因云取消照旧留住；待重排 / 排队顺延保持原样；
 * 只有快照 revision 落后于目标当前 revision 的待执行 / 进行中段需要进待重排。
 */
export function sessionsInvalidatedByTarget(
  sessions: ObsSession[],
  targetId: string,
  currentRevision: number,
): Array<Pick<ObsSession, 'id'>> {
  return sessions
    .filter((session) => session.targetId === targetId)
    .filter((session) => session.status === '待执行' || session.status === '进行中')
    .filter((session) => (session.targetSnapshot?.revision ?? 0) < currentRevision)
    .map((session) => ({ id: session.id }));
}
