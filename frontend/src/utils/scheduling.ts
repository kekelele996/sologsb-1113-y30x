import { NIGHT_TOTAL_MINUTES, type ObsNight, type ObsSession, type SessionStatus } from '../types';
import { durationMinutes } from './astro';

/** 占用望远镜本夜容量的状态（已确认会发生的排程段） */
export const CAPACITY_STATUSES: SessionStatus[] = ['待执行', '进行中', '已完成'];

/** 该排程段是否占用望远镜本夜容量（因云取消 / 待重排不占容量） */
export function occupiesCapacity(session: ObsSession): boolean {
  return CAPACITY_STATUSES.includes(session.status);
}

/** 某望远镜在某夜已占用的分钟数（可排除某段，用于编辑 / 排队时试算） */
export function telescopeOccupiedMinutes(sessions: ObsSession[], nightId: string, telescopeId: string, excludeId?: string): number {
  return sessions
    .filter((session) => session.nightId === nightId && session.telescopeId === telescopeId && session.id !== excludeId && occupiesCapacity(session))
    .reduce((sum, session) => sum + durationMinutes(session.startTime, session.endTime), 0);
}

export interface PlacementResult {
  /** 落点观测夜 ID */
  nightId: string;
  /** 是否因容量排队到下一夜 */
  queued: boolean;
  /** 排队原因 */
  queuedReason?: string;
}

/**
 * 容量感知落点：同一望远镜在同一夜的排程段总时长不得超过夜容量（NIGHT_TOTAL_MINUTES）。
 * 超出容量则顺序顺延到后续仍有容量的观测夜；已确认的排程段（待执行 / 进行中 / 已完成）不动，
 * 只把当前这段往后排，不挤掉已确认的段。
 */
export function resolvePlacement(
  sessions: ObsSession[],
  nights: ObsNight[],
  telescopeId: string,
  requestedNightId: string,
  durationMin: number,
  excludeId?: string,
): PlacementResult {
  const ordered = [...nights].sort((a, b) => a.date.localeCompare(b.date));
  const startIndex = ordered.findIndex((night) => night.id === requestedNightId);
  for (let index = Math.max(0, startIndex); index < ordered.length; index++) {
    const night = ordered[index];
    const occupied = telescopeOccupiedMinutes(sessions, night.id, telescopeId, excludeId);
    if (occupied + durationMin <= NIGHT_TOTAL_MINUTES) {
      const queued = night.id !== requestedNightId;
      return { nightId: night.id, queued, queuedReason: queued ? '本夜望远镜容量已满，顺延至下一夜' : undefined };
    }
  }
  // 后续观测夜都排不下：落在请求夜并标记排队，不挤掉已确认的段
  return { nightId: requestedNightId, queued: true, queuedReason: '本夜及后续观测夜均无望远镜容量' };
}
