import type { OwnedRecord } from './ownership';

/** 目标类型 */
export type TargetType = '星系' | '星云' | '疏散星团' | '行星' | '月面';

/** 观测优先级 */
export type Priority = 'P1' | 'P2' | 'P3';

/** 推荐滤镜 */
export type FilterName = '无滤镜' | 'L' | 'R' | 'G' | 'B' | 'Ha' | 'OIII' | 'SII';

/**
 * 观测目标（归目标协调员，只存在于目标库）。
 * revision 在阈值 / 曝光等排程约束字段每次改动时 +1，
 * 排程段靠它判断自己排程时引用的目标参数是否已过期。
 */
export interface ObsTarget extends OwnedRecord {
  id: string;
  /** 目标名（M31、NGC 7000） */
  name: string;
  /** 星表编号 */
  catalog: string;
  /** 赤经（小时，0~24） */
  raHours: number;
  /** 赤纬（度，-90~90） */
  decDeg: number;
  /** 视星等 */
  magnitude: number;
  /** 目标类型 */
  type: TargetType;
  /** 推荐滤镜 */
  filter: FilterName;
  /** 单帧曝光秒数 */
  exposureSec: number;
  /** 建议累计时长（分钟） */
  totalMinutes: number;
  /** 优先级 */
  priority: Priority;
  /** 最小地平高度角阈值（度）：低于该值排程时自动标灰 */
  minAltitude: number;
  /**
   * 排程约束版本号：minAltitude / exposureSec / totalMinutes / filter
   * 等被排程段引用的字段一改动就 +1；只改名称、备注、坐标不影响已排时段。
   */
  revision: number;
  /** 备注 */
  remark?: string;
}

/**
 * 被排程段引用、会影响已排时段有效性的目标字段。
 * 协调员只改这些字段才会让引用它的排程段失效；坐标 / 名称 / 备注变更不动排程。
 */
export const TARGET_CONSTRAINT_KEYS = ['minAltitude', 'exposureSec', 'totalMinutes', 'filter'] as const;
export type TargetConstraintKey = (typeof TARGET_CONSTRAINT_KEYS)[number];

/** 排程段引用目标时固化下来的约束快照（随段存在编排库，排程员只读不可手改） */
export interface TargetConstraintSnapshot {
  /** 快照时的目标 revision */
  revision: number;
  minAltitude: number;
  exposureSec: number;
  totalMinutes: number;
  filter: FilterName;
}

/** 取目标当前的约束快照（新排程段排定时调用） */
export function snapshotTarget(target: ObsTarget): TargetConstraintSnapshot {
  return {
    revision: target.revision,
    minAltitude: target.minAltitude,
    exposureSec: target.exposureSec,
    totalMinutes: target.totalMinutes,
    filter: target.filter,
  };
}

export const TARGET_TYPES: TargetType[] = ['星系', '星云', '疏散星团', '行星', '月面'];
export const PRIORITIES: Priority[] = ['P1', 'P2', 'P3'];
export const FILTER_NAMES: FilterName[] = ['无滤镜', 'L', 'R', 'G', 'B', 'Ha', 'OIII', 'SII'];

/** 目标类型配色 */
export const TARGET_COLOR: Record<TargetType, string> = {
  星系: '#7e57c2',
  星云: '#26a69a',
  疏散星团: '#42a5f5',
  行星: '#ef6c00',
  月面: '#8d8d8d',
};
