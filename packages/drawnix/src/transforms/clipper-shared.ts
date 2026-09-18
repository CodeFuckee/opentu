/**
 * clipper-lib 共享类型与工具
 * boolean.ts（布尔运算）与 precise-erase.ts（精确橡皮擦）共用的最小类型面与坐标转换。
 * clipper-lib 无官方类型声明，运行时为同一份动态导入的对象。
 */

import { Point } from '@plait/core';

export interface ClipperPoint {
  X: number;
  Y: number;
}

export type ClipperPath = ClipperPoint[];

export interface ClipperInstance {
  AddPath: (path: ClipperPath, polyType: number, closed: boolean) => void;
  AddPaths: (paths: ClipperPath[], polyType: number, closed: boolean) => void;
  Execute: (
    clipType: number,
    solution: ClipperPath[],
    fillType1?: number,
    fillType2?: number
  ) => boolean;
}

export interface ClipperOffsetInstance {
  AddPath: (path: ClipperPath, joinType: number, endType: number) => void;
  Execute: (solution: ClipperPath[], delta: number) => void;
}

export interface ClipperLibType {
  Clipper: new () => ClipperInstance;
  ClipperOffset: new () => ClipperOffsetInstance;
  PolyType: {
    ptSubject: number;
    ptClip: number;
  };
  ClipType: {
    ctUnion: number;
    ctDifference: number;
    ctIntersection: number;
    ctXor: number;
  };
  PolyFillType: {
    pftEvenOdd: number;
    pftNonZero: number;
  };
  JoinType: {
    jtRound: number;
    jtMiter: number;
    jtSquare: number;
  };
  EndType: {
    etOpenRound: number;
    etOpenSquare: number;
    etOpenButt: number;
  };
}

// Clipper 使用整数运算，需要缩放因子
export const CLIPPER_SCALE = 1000;

/**
 * 加载 clipper-lib（动态导入）
 */
export async function loadClipperLib(): Promise<ClipperLibType> {
  // clipper-lib 没有类型声明
  // @ts-expect-error - clipper-lib doesn't have type definitions
  const clipper = await import('clipper-lib');
  return clipper.default || clipper;
}

/**
 * 将 Point 数组转换为 Clipper 路径格式
 */
export function pointsToClipperPath(points: Point[]): ClipperPath {
  return points.map((p) => ({
    X: Math.round(p[0] * CLIPPER_SCALE),
    Y: Math.round(p[1] * CLIPPER_SCALE),
  }));
}

/**
 * 将 Clipper 路径转换回 Point 数组
 */
export function clipperPathToPoints(path: ClipperPath): Point[] {
  return path.map((p) => [p.X / CLIPPER_SCALE, p.Y / CLIPPER_SCALE] as Point);
}
