'use server';

import {
  generateAzureVisionObject,
  generateAzureObject,
  analyzeBlueprintLayoutFromBase64,
  type BlueprintLayoutHints,
} from "@/ai/azure-ai";
import {
  GeometricReconstruction,
  AIAsset,
} from './reconstruction-types';
import { applyBuildingCodes } from './building-codes';
import {
  buildAssetPrompt,
  buildAssetRetryPrompt,
  buildBlueprintRetryPrompt,
  buildBlueprintVisionPrompt,
  buildTextToBuildingPrompt,
} from './prompt-templates';
import { z } from 'zod';
import { spawn } from 'child_process';
import path from 'path';
import DxfParser from 'dxf-parser';
import { promises as fs } from 'fs';
import os from 'os';

const AIAssetSchema = z.object({
  name: z.string(),
  parts: z.array(z.object({
    name: z.string(),
    position: z.array(z.number()),
    size: z.array(z.number()),
    color: z.string(),
    material: z.enum(['wood', 'metal', 'glass', 'plastic', 'stone', 'cloth'])
  }))
});

const summarizeReconstruction = (payload: GeometricReconstruction) => ({
  walls: payload?.walls?.length || 0,
  wallSolids: payload?.wallSolids?.length || 0,
  rooms: payload?.rooms?.length || 0,
  doors: payload?.doors?.length || 0,
  windows: payload?.windows?.length || 0,
  furnitures: payload?.furnitures?.length || 0,
  conflicts: payload?.conflicts?.length || 0,
  hasRoof: !!payload?.roof,
  buildingName: payload?.building_name || 'N/A',
});

const summarizeLayoutHints = (payload: BlueprintLayoutHints | null) => ({
  pages: payload?.pageCount || 0,
  linePolygons: payload?.linePolygons?.length || 0,
  dimensionAnchors: payload?.dimensionAnchors?.length || 0,
  lineTexts: payload?.lineTexts?.length || 0,
  floorLabelAnchors: payload?.floorLabelAnchors?.length || 0,
});

const LAYOUT_POLYGON_LIMIT = 180;
const LAYOUT_DIMENSION_ANCHOR_LIMIT = 60;
const LAYOUT_LINE_TEXT_LIMIT = 140;
const LAYOUT_FLOOR_LABEL_LIMIT = 36;
const LAYOUT_DIMENSION_REGEX = /(\d+(\.\d+)?\s?(mm|cm|m|ft|feet|in|inch|\"|')|\d+'\s?\d*\"?)/i;
const OPENING_TEXT_REGEX = /\b(door|doors|dr|d\d+|window|windows|win|w\d+)\b/i;

type LayoutHintMode = 'auto' | 'azure' | 'local' | 'hybrid';
const MIN_LAYOUT_SIGNALS_REQUIRED = 1;

const FLOOR_LABEL_PATTERNS: Array<{ key: string; regex: RegExp; floorKey?: string; }> = [
  { key: 'BASEMENT', regex: /\b(basement|cellar|lower\s*ground|b\/?f)\b/i, floorKey: 'L-1' },
  { key: 'STILT', regex: /\b(stilt\s*floor)\b/i, floorKey: 'L0' },
  { key: 'GROUND', regex: /\b(ground\s*floor|ground\b|g\/?f\b)\b/i, floorKey: 'L0' },
  { key: 'FIRST', regex: /\b(first\s*floor|1st\s*floor|ff\b|f\/?f\b)\b/i, floorKey: 'L1' },
  { key: 'SECOND', regex: /\b(second\s*floor|2nd\s*floor)\b/i, floorKey: 'L2' },
  { key: 'THIRD', regex: /\b(third\s*floor|3rd\s*floor)\b/i, floorKey: 'L3' },
  { key: 'FOURTH', regex: /\b(fourth\s*floor|4th\s*floor)\b/i, floorKey: 'L4' },
  { key: 'TERRACE', regex: /\b(terrace\s*floor|roof\s*floor|terrace\b)\b/i },
];

const FLOOR_LEVEL_CAPTURE_PATTERNS: RegExp[] = [
  /\b(?:level|lvl|floor|flr|storey|story)\s*[-_:]?\s*([a-z0-9]+)\b/gi,
  /\b([a-z0-9]+)\s*(?:level|lvl|floor|flr|storey|story)\b/gi,
  /\b(?:l|f)\s*[-_:]?\s*(\d{1,2})\b/gi,
];

const ROMAN_TO_INT: Record<string, number> = {
  i: 1,
  ii: 2,
  iii: 3,
  iv: 4,
  v: 5,
  vi: 6,
  vii: 7,
  viii: 8,
  ix: 9,
  x: 10,
};

const parseFloorToken = (tokenRaw: string): string | null => {
  const token = String(tokenRaw || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9+-]/g, '');
  if (!token) return null;
  if (token === 'g' || token === 'gf' || token === 'ground') return 'L0';
  if (token === 'b' || token === 'bf' || token === 'basement' || token === 'cellar') return 'L-1';
  const roman = ROMAN_TO_INT[token];
  if (Number.isFinite(roman)) return `L${roman}`;
  const numeric = Number(token);
  if (Number.isFinite(numeric) && numeric >= -3 && numeric <= 30) {
    return `L${Math.trunc(numeric)}`;
  }
  return null;
};

const collectFloorKeysFromText = (rawText: string): string[] => {
  const text = String(rawText || '').replace(/\s+/g, ' ').trim();
  if (!text) return [];
  const detected = new Set<string>();
  for (const pattern of FLOOR_LABEL_PATTERNS) {
    if (pattern.regex.test(text)) {
      detected.add(pattern.floorKey || pattern.key);
    }
  }
  for (const baseRegex of FLOOR_LEVEL_CAPTURE_PATTERNS) {
    const regex = new RegExp(baseRegex.source, baseRegex.flags);
    for (const match of text.matchAll(regex)) {
      const token = match?.[1];
      const floorKey = parseFloorToken(token);
      if (floorKey) detected.add(floorKey);
    }
  }
  return [...detected];
};

type PolygonBounds = {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
};

const toPolygonBounds = (polygon: number[]): PolygonBounds | null => {
  if (!Array.isArray(polygon) || polygon.length < 4) return null;
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let seen = false;
  for (let i = 0; i + 1 < polygon.length; i += 2) {
    const x = Number(polygon[i]);
    const y = Number(polygon[i + 1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    seen = true;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  if (!seen) return null;
  return { minX, maxX, minY, maxY };
};

type AxisRange = { min: number; max: number; };

const estimateBandCountFromRanges = (ranges: AxisRange[], span: number): number => {
  if (ranges.length < 8 || !Number.isFinite(span) || span <= 0) return 0;
  const sorted = [...ranges].sort((a, b) => a.min - b.min);
  const lengths = sorted
    .map((entry) => Math.max(0, entry.max - entry.min))
    .sort((a, b) => a - b);
  const medianLength = lengths[Math.floor(lengths.length / 2)] || 0;
  const gapThreshold = Math.max(span * 0.08, medianLength * 2.2, 14);
  const clusterMinSpan = Math.max(span * 0.12, 24);
  const clusterMinCount = Math.max(4, Math.ceil(sorted.length * 0.14));

  const clusters: Array<{ min: number; max: number; count: number; }> = [];
  for (const range of sorted) {
    const current = clusters[clusters.length - 1];
    if (!current) {
      clusters.push({ min: range.min, max: range.max, count: 1 });
      continue;
    }
    if (range.min <= current.max + gapThreshold) {
      current.max = Math.max(current.max, range.max);
      current.count += 1;
      continue;
    }
    clusters.push({ min: range.min, max: range.max, count: 1 });
  }

  const significant = clusters.filter((cluster) => {
    const clusterSpan = Math.max(0, cluster.max - cluster.min);
    return cluster.count >= clusterMinCount && clusterSpan >= clusterMinSpan;
  });

  return significant.length;
};

const inferPanelCountFromLineGeometry = (layoutHints: BlueprintLayoutHints | null): number => {
  if (!layoutHints) return 0;
  const bounds = (layoutHints.linePolygons || [])
    .map((polygon) => toPolygonBounds(polygon))
    .filter((entry): entry is PolygonBounds => !!entry);
  if (bounds.length < 10) return 0;

  const minX = Math.min(...bounds.map((b) => b.minX));
  const maxX = Math.max(...bounds.map((b) => b.maxX));
  const minY = Math.min(...bounds.map((b) => b.minY));
  const maxY = Math.max(...bounds.map((b) => b.maxY));
  const inferredWidth = Math.max(1, maxX - minX);
  const inferredHeight = Math.max(1, maxY - minY);

  const pageWidth = Math.max(
    inferredWidth,
    ...((layoutHints.pages || []).map((page) => Number(page?.width) || 0))
  );
  const pageHeight = Math.max(
    inferredHeight,
    ...((layoutHints.pages || []).map((page) => Number(page?.height) || 0))
  );

  const verticalBands = estimateBandCountFromRanges(
    bounds.map((b) => ({ min: b.minY, max: b.maxY })),
    pageHeight
  );
  const horizontalBands = estimateBandCountFromRanges(
    bounds.map((b) => ({ min: b.minX, max: b.maxX })),
    pageWidth
  );

  const inferred = Math.max(verticalBands, horizontalBands);
  if (inferred < 2) return 0;
  return Math.min(inferred, 8);
};

const asBool = (value: string | undefined, fallback: boolean): boolean => {
  if (value == null || value.trim() === '') return fallback;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
};

const VERBOSE_LOGS = asBool(process.env.INFRALITH_VERBOSE_LOGS, true);
const VERBOSE_LOG_PAYLOADS = asBool(process.env.INFRALITH_VERBOSE_LOG_PAYLOADS, false);
const ENFORCE_MULTI_FLOOR_COVERAGE = asBool(process.env.INFRALITH_ENFORCE_MULTI_FLOOR_COVERAGE, true);

const parseTimeoutMs = (
  value: string | undefined,
  fallback: number,
  min = 1_000,
  max = 300_000
): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
};

const parsePositiveEnvNumber = (value: string | undefined): number | null => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
};

const STAGE_HEARTBEAT_MS = parseTimeoutMs(process.env.INFRALITH_STAGE_HEARTBEAT_MS, 20_000, 5_000, 120_000);
const LAYOUT_STAGE_TIMEOUT_MS = parseTimeoutMs(process.env.INFRALITH_LAYOUT_TIMEOUT_MS, 65_000);

const createTraceId = (prefix: string) =>
  `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

const sanitizeLogData = (value: unknown): unknown => {
  if (VERBOSE_LOG_PAYLOADS) return value;
  if (value == null) return value;
  if (typeof value === 'string') {
    return value.length > 220 ? `${value.slice(0, 220)}... (${value.length} chars)` : value;
  }
  if (Array.isArray(value)) {
    return `Array(${value.length})`;
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (typeof v === 'string') {
        out[k] = v.length > 140 ? `${v.slice(0, 140)}... (${v.length} chars)` : v;
      } else if (Array.isArray(v)) {
        out[k] = `Array(${v.length})`;
      } else {
        out[k] = v;
      }
    }
    return out;
  }
  return value;
};

type LogLevel = 'log' | 'warn' | 'error';

const traceLog = (
  component: string,
  traceId: string,
  step: string,
  message: string,
  data?: unknown,
  level: LogLevel = 'log'
) => {
  if (!VERBOSE_LOGS && level === 'log') return;
  const stamp = new Date().toISOString();
  const prefix = `[${component}] [trace:${traceId}] [${step}] ${stamp} ${message}`;
  const payload = data === undefined ? undefined : sanitizeLogData(data);
  if (level === 'warn') {
    payload === undefined ? console.warn(prefix) : console.warn(prefix, payload);
    return;
  }
  if (level === 'error') {
    payload === undefined ? console.error(prefix) : console.error(prefix, payload);
    return;
  }
  payload === undefined ? console.log(prefix) : console.log(prefix, payload);
};

type TimedStageOptions = {
  component: string;
  traceId: string;
  step: string;
  label: string;
  timeoutMs: number;
  heartbeatMs?: number;
  timeoutLevel?: LogLevel;
};

const withMonitoredTimeout = async <T>(
  runner: () => Promise<T>,
  {
    component,
    traceId,
    step,
    label,
    timeoutMs,
    heartbeatMs = STAGE_HEARTBEAT_MS,
    timeoutLevel = 'warn',
  }: TimedStageOptions
): Promise<T> => {
  const startedAt = Date.now();
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let timeoutTimer: ReturnType<typeof setTimeout> | null = null;

  return await new Promise<T>((resolve, reject) => {
    let settled = false;

    const finish = () => {
      settled = true;
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
        timeoutTimer = null;
      }
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
    };

    timeoutTimer = setTimeout(() => {
      if (settled) return;
      const elapsedMs = Date.now() - startedAt;
      traceLog(component, traceId, step, `${label} timed out`, { elapsedMs, timeoutMs }, timeoutLevel);
      finish();
      reject(new Error(`${label} timed out after ${elapsedMs}ms`));
    }, timeoutMs);

    if (heartbeatMs > 0) {
      heartbeatTimer = setInterval(() => {
        if (settled) return;
        const elapsedMs = Date.now() - startedAt;
        traceLog(component, traceId, step, `${label} still running`, { elapsedMs, timeoutMs }, 'warn');
      }, heartbeatMs);
    }

    Promise.resolve()
      .then(runner)
      .then((value) => {
        if (settled) return;
        finish();
        resolve(value);
      })
      .catch((error) => {
        if (settled) return;
        finish();
        reject(error instanceof Error ? error : new Error(String(error)));
      });
  });
};

const getLayoutHintMode = (): LayoutHintMode => {
  const raw = (process.env.INFRALITH_LAYOUT_HINT_MODE || 'auto').trim().toLowerCase();
  if (raw === 'azure' || raw === 'local' || raw === 'hybrid' || raw === 'auto') {
    return raw;
  }
  return 'auto';
};

const shouldRetryForUnderfit = (
  result: GeometricReconstruction,
  layoutHints: BlueprintLayoutHints | null
) => {
  const wallCount = result?.walls?.length || 0;
  const roomCount = result?.rooms?.length || 0;
  const layoutLines = layoutHints?.linePolygons?.length || 0;
  const signalStrength = layoutLines;
  const openingSignals = inferOpeningSignalCountFromHints(layoutHints);
  const openingCount = (result?.doors?.length || 0) + (result?.windows?.length || 0);

  // If hints show complex blueprint but output is too simple, force one stricter retry.
  if (signalStrength >= 40 && wallCount <= 8) return true;
  if (signalStrength >= 60 && roomCount <= 2) return true;
  if (openingSignals >= 2 && openingCount === 0) return true;
  return false;
};

const inferExpectedFloorCountFromHints = (layoutHints: BlueprintLayoutHints | null): number => {
  if (!layoutHints) return 0;
  const texts = [
    ...(layoutHints.lineTexts || []),
    ...(layoutHints.floorLabelAnchors || []).map((anchor) => String(anchor?.text || '')),
    ...(layoutHints.dimensionAnchors || []).map((anchor) => String(anchor?.text || '')),
  ];
  const detected = new Set<string>();
  for (const rawText of texts) {
    for (const floorKey of collectFloorKeysFromText(String(rawText || ''))) {
      detected.add(floorKey);
    }
  }
  const labelDrivenCount = detected.size;
  const geometryDrivenCount = inferPanelCountFromLineGeometry(layoutHints);
  return Math.max(labelDrivenCount, geometryDrivenCount);
};

const inferOpeningSignalCountFromHints = (layoutHints: BlueprintLayoutHints | null): number => {
  if (!layoutHints) return 0;
  const texts = [
    ...(layoutHints.lineTexts || []),
    ...(layoutHints.dimensionAnchors || []).map((anchor) => String(anchor?.text || '')),
  ];
  const matches = new Set<string>();
  for (const rawText of texts) {
    const text = String(rawText || '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    if (OPENING_TEXT_REGEX.test(text)) matches.add(text.toLowerCase());
  }
  return matches.size;
};

const getObservedFloorCount = (result: GeometricReconstruction): number => {
  const levels = new Set<number>();
  const addLevel = (value: unknown) => {
    const n = Number(value);
    if (Number.isFinite(n)) levels.add(Math.round(n));
  };

  for (const wall of result?.walls || []) addLevel(wall?.floor_level);
  for (const room of result?.rooms || []) addLevel(room?.floor_level);
  for (const door of result?.doors || []) addLevel(door?.floor_level);
  for (const win of result?.windows || []) addLevel(win?.floor_level);
  for (const item of result?.furnitures || []) addLevel(item?.floor_level);

  return Math.max(1, levels.size || 0);
};

type FloorCoverage = {
  level: number;
  walls: number;
  rooms: number;
  doors: number;
  windows: number;
  furnitures: number;
};

type FloorCoverageQuality = {
  perFloor: FloorCoverage[];
  weakLevels: number[];
  minWallsThreshold: number;
};

const buildFloorCoverage = (result: GeometricReconstruction): FloorCoverage[] => {
  const byLevel = new Map<number, FloorCoverage>();
  const ensureLevel = (level: number) => {
    const existing = byLevel.get(level);
    if (existing) return existing;
    const next: FloorCoverage = { level, walls: 0, rooms: 0, doors: 0, windows: 0, furnitures: 0 };
    byLevel.set(level, next);
    return next;
  };
  const levelOf = (value: unknown): number | null => {
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    return Math.round(n);
  };

  for (const wall of result?.walls || []) {
    const level = levelOf(wall?.floor_level);
    if (level == null) continue;
    ensureLevel(level).walls += 1;
  }
  for (const room of result?.rooms || []) {
    const level = levelOf(room?.floor_level);
    if (level == null) continue;
    ensureLevel(level).rooms += 1;
  }
  for (const door of result?.doors || []) {
    const level = levelOf(door?.floor_level);
    if (level == null) continue;
    ensureLevel(level).doors += 1;
  }
  for (const win of result?.windows || []) {
    const level = levelOf(win?.floor_level);
    if (level == null) continue;
    ensureLevel(level).windows += 1;
  }
  for (const item of result?.furnitures || []) {
    const level = levelOf(item?.floor_level);
    if (level == null) continue;
    ensureLevel(level).furnitures += 1;
  }

  return [...byLevel.values()].sort((a, b) => a.level - b.level);
};

const assessFloorCoverageQuality = (
  result: GeometricReconstruction,
  expectedFloorCount: number
): FloorCoverageQuality => {
  const perFloor = buildFloorCoverage(result);
  if (expectedFloorCount < 2 || perFloor.length === 0) {
    return { perFloor, weakLevels: [], minWallsThreshold: 0 };
  }

  const maxWalls = Math.max(...perFloor.map((f) => f.walls), 0);
  const minWallsThreshold = Math.max(2, Math.floor(maxWalls * 0.35));
  const weakLevels = perFloor
    .filter((f) => f.walls < minWallsThreshold)
    .map((f) => f.level);

  return {
    perFloor,
    weakLevels,
    minWallsThreshold,
  };
};

const hasNonEmptyWalls = (
  value: GeometricReconstruction | null | undefined
): value is GeometricReconstruction => Array.isArray(value?.walls) && value.walls.length > 0;

const polygonArea = (points: [number, number][]) => {
  if (!points?.length) return 0;
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[(i + 1) % points.length];
    sum += (x1 * y2) - (x2 * y1);
  }
  return sum / 2;
};

const dedupe2DPoints = (points: [number, number][], precision = 3): [number, number][] => {
  const seen = new Set<string>();
  const unique: [number, number][] = [];
  for (const [x, y] of points) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const key = `${x.toFixed(precision)},${y.toFixed(precision)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push([Number(x.toFixed(precision)), Number(y.toFixed(precision))]);
  }
  return unique;
};

const convexHull = (points: [number, number][]): [number, number][] => {
  const pts = [...points].sort((a, b) => (a[0] === b[0] ? a[1] - b[1] : a[0] - b[0]));
  if (pts.length <= 1) return pts;

  const cross = (o: [number, number], a: [number, number], b: [number, number]) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

  const lower: [number, number][] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
      lower.pop();
    }
    lower.push(p);
  }

  const upper: [number, number][] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
      upper.pop();
    }
    upper.push(p);
  }

  lower.pop();
  upper.pop();
  return [...lower, ...upper];
};

const snapPoint = (point: [number, number], tolerance = 0.12): [number, number] => {
  const t = Math.max(0.01, tolerance);
  return [
    Number((Math.round(point[0] / t) * t).toFixed(3)),
    Number((Math.round(point[1] / t) * t).toFixed(3)),
  ];
};

const pointKey = (point: [number, number]) => `${point[0].toFixed(3)},${point[1].toFixed(3)}`;

const extractConcaveBoundaryFromWalls = (
  walls: Array<{ start: [number, number]; end: [number, number] }>,
  tolerance = 0.12
): [number, number][] | null => {
  const adjacency = new Map<string, Set<string>>();
  const keyToPoint = new Map<string, [number, number]>();

  for (const wall of walls) {
    if (!Array.isArray(wall?.start) || !Array.isArray(wall?.end)) continue;
    const a = snapPoint([Number(wall.start[0]), Number(wall.start[1])], tolerance);
    const b = snapPoint([Number(wall.end[0]), Number(wall.end[1])], tolerance);
    const aKey = pointKey(a);
    const bKey = pointKey(b);
    if (aKey === bKey) continue;

    keyToPoint.set(aKey, a);
    keyToPoint.set(bKey, b);

    if (!adjacency.has(aKey)) adjacency.set(aKey, new Set());
    if (!adjacency.has(bKey)) adjacency.set(bKey, new Set());
    adjacency.get(aKey)!.add(bKey);
    adjacency.get(bKey)!.add(aKey);
  }

  if (adjacency.size < 3) return null;

  const visited = new Set<string>();
  const componentBestPolygons: [number, number][][] = [];

  for (const startKey of adjacency.keys()) {
    if (visited.has(startKey)) continue;

    const queue = [startKey];
    const component: string[] = [];
    visited.add(startKey);

    while (queue.length > 0) {
      const key = queue.shift()!;
      component.push(key);
      for (const neighbor of adjacency.get(key) || []) {
        if (visited.has(neighbor)) continue;
        visited.add(neighbor);
        queue.push(neighbor);
      }
    }

    // For deterministic loop tracing, prefer components where every node has degree 2.
    const hasNonCycleDegree = component.some((key) => (adjacency.get(key)?.size || 0) !== 2);
    if (hasNonCycleDegree) continue;

    const orderedStart = [...component].sort((a, b) => {
      const pa = keyToPoint.get(a)!;
      const pb = keyToPoint.get(b)!;
      return pa[0] === pb[0] ? pa[1] - pb[1] : pa[0] - pb[0];
    })[0];

    const neighbors = [...(adjacency.get(orderedStart) || [])];
    if (neighbors.length !== 2) continue;

    const orderedKeys: string[] = [orderedStart];
    let prevKey = orderedStart;
    let currentKey = neighbors[0];
    let guard = 0;
    const guardLimit = component.length + 5;

    while (guard++ < guardLimit) {
      if (currentKey === orderedStart) break;
      orderedKeys.push(currentKey);
      const nextCandidates = [...(adjacency.get(currentKey) || [])];
      if (nextCandidates.length !== 2) break;
      const nextKey = nextCandidates[0] === prevKey ? nextCandidates[1] : nextCandidates[0];
      prevKey = currentKey;
      currentKey = nextKey;
    }

    if (currentKey !== orderedStart || orderedKeys.length < 3) continue;
    const polygon = orderedKeys
      .map((key) => keyToPoint.get(key))
      .filter((p): p is [number, number] => Array.isArray(p));

    if (polygon.length >= 3) {
      componentBestPolygons.push(polygon);
    }
  }

  if (componentBestPolygons.length === 0) return null;
  componentBestPolygons.sort((a, b) => Math.abs(polygonArea(b)) - Math.abs(polygonArea(a)));
  return componentBestPolygons[0];
};

const inferRoofFromWallFootprint = (payload: GeometricReconstruction): GeometricReconstruction => payload;

const pointDistance = (a: [number, number], b: [number, number]) => Math.hypot(a[0] - b[0], a[1] - b[1]);

const clampNumber = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

const ORIENTATION_EPS = 1e-6;
const TOPOLOGY_SNAP_TOLERANCE = 0.12;

const orientation = (a: [number, number], b: [number, number], c: [number, number]) =>
  (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);

const isNearlyZero = (value: number, eps = ORIENTATION_EPS) => Math.abs(value) <= eps;

const isPointOnSegment = (a: [number, number], b: [number, number], p: [number, number], eps = ORIENTATION_EPS) => {
  if (!isNearlyZero(orientation(a, b, p), eps)) return false;
  return (
    p[0] >= Math.min(a[0], b[0]) - eps &&
    p[0] <= Math.max(a[0], b[0]) + eps &&
    p[1] >= Math.min(a[1], b[1]) - eps &&
    p[1] <= Math.max(a[1], b[1]) + eps
  );
};

const segmentsIntersect = (
  a1: [number, number],
  a2: [number, number],
  b1: [number, number],
  b2: [number, number],
  eps = ORIENTATION_EPS
) => {
  const o1 = orientation(a1, a2, b1);
  const o2 = orientation(a1, a2, b2);
  const o3 = orientation(b1, b2, a1);
  const o4 = orientation(b1, b2, a2);

  if (isNearlyZero(o1, eps) && isPointOnSegment(a1, a2, b1, eps)) return true;
  if (isNearlyZero(o2, eps) && isPointOnSegment(a1, a2, b2, eps)) return true;
  if (isNearlyZero(o3, eps) && isPointOnSegment(b1, b2, a1, eps)) return true;
  if (isNearlyZero(o4, eps) && isPointOnSegment(b1, b2, a2, eps)) return true;

  return (
    ((o1 > eps && o2 < -eps) || (o1 < -eps && o2 > eps)) &&
    ((o3 > eps && o4 < -eps) || (o3 < -eps && o4 > eps))
  );
};

const buildEndpointDegreeMap = (
  walls: GeometricReconstruction['walls'],
  tolerance = TOPOLOGY_SNAP_TOLERANCE
) => {
  const degree = new Map<string, number>();
  for (const wall of walls || []) {
    if (!Array.isArray(wall?.start) || !Array.isArray(wall?.end)) continue;
    const a = pointKey(snapPoint(wall.start, tolerance));
    const b = pointKey(snapPoint(wall.end, tolerance));
    if (a === b) continue;
    degree.set(a, (degree.get(a) || 0) + 1);
    degree.set(b, (degree.get(b) || 0) + 1);
  }
  return degree;
};

const countDanglingWalls = (
  walls: GeometricReconstruction['walls'],
  tolerance = TOPOLOGY_SNAP_TOLERANCE
) => {
  const degree = buildEndpointDegreeMap(walls, tolerance);
  const danglingWalls = new Set<string>();
  for (const wall of walls || []) {
    const a = pointKey(snapPoint(wall.start, tolerance));
    const b = pointKey(snapPoint(wall.end, tolerance));
    if ((degree.get(a) || 0) <= 1 || (degree.get(b) || 0) <= 1) {
      danglingWalls.add(String(wall.id));
    }
  }
  return danglingWalls.size;
};

const hasClosedWallLoops = (
  walls: GeometricReconstruction['walls'],
  tolerance = TOPOLOGY_SNAP_TOLERANCE
) => {
  const loopCandidates = (walls || []).filter((wall) =>
    Array.isArray(wall?.start) && Array.isArray(wall?.end)
  );
  if (loopCandidates.length < 3) return false;
  const degree = buildEndpointDegreeMap(loopCandidates, tolerance);
  if (degree.size < 3) return false;
  return [...degree.values()].every((d) => d >= 2 && d % 2 === 0);
};

const countWallSelfIntersections = (walls: GeometricReconstruction['walls']) => {
  let intersections = 0;
  const endpointKeys = walls.map((wall) => ({
    a: pointKey(snapPoint(wall.start, TOPOLOGY_SNAP_TOLERANCE)),
    b: pointKey(snapPoint(wall.end, TOPOLOGY_SNAP_TOLERANCE)),
  }));

  for (let i = 0; i < walls.length; i += 1) {
    const wa = walls[i];
    for (let j = i + 1; j < walls.length; j += 1) {
      const wb = walls[j];
      const sharesEndpoint =
        endpointKeys[i].a === endpointKeys[j].a ||
        endpointKeys[i].a === endpointKeys[j].b ||
        endpointKeys[i].b === endpointKeys[j].a ||
        endpointKeys[i].b === endpointKeys[j].b;
      if (sharesEndpoint) continue;
      if (segmentsIntersect(wa.start, wa.end, wb.start, wb.end)) {
        intersections += 1;
      }
    }
  }

  return intersections;
};

const isRoomPolygonValid = (polygon: [number, number][]) => {
  if (!Array.isArray(polygon) || polygon.length < 3) return false;

  const clean: [number, number][] = [];
  for (const p of polygon) {
    if (!Array.isArray(p) || p.length < 2) return false;
    if (!Number.isFinite(p[0]) || !Number.isFinite(p[1])) return false;
    const next: [number, number] = [Number(p[0]), Number(p[1])];
    const prev = clean[clean.length - 1];
    if (prev && pointDistance(prev, next) < 1e-4) continue;
    clean.push(next);
  }

  if (clean.length < 3) return false;
  if (pointDistance(clean[0], clean[clean.length - 1]) < 1e-4) {
    clean.pop();
  }
  if (clean.length < 3) return false;
  if (Math.abs(polygonArea(clean)) < 1e-3) return false;

  for (let i = 0; i < clean.length; i += 1) {
    const a1 = clean[i];
    const a2 = clean[(i + 1) % clean.length];
    for (let j = i + 1; j < clean.length; j += 1) {
      const areAdjacent =
        Math.abs(i - j) <= 1 || (i === 0 && j === clean.length - 1);
      if (areAdjacent) continue;
      const b1 = clean[j];
      const b2 = clean[(j + 1) % clean.length];
      if (segmentsIntersect(a1, a2, b1, b2)) return false;
    }
  }

  return true;
};

const computeDeterministicTopologyChecks = (
  walls: GeometricReconstruction['walls'],
  doors: GeometricReconstruction['doors'],
  windows: GeometricReconstruction['windows'],
  rooms: GeometricReconstruction['rooms']
): NonNullable<GeometricReconstruction['topology_checks']> => {
  const wallList = Array.isArray(walls) ? walls : [];
  const doorList = Array.isArray(doors) ? doors : [];
  const windowList = Array.isArray(windows) ? windows : [];
  const roomList = Array.isArray(rooms) ? rooms : [];

  const floorSet = new Set<number>();
  for (const wall of wallList) {
    const floor = Number.isFinite(Number(wall.floor_level)) ? Number(wall.floor_level) : 0;
    floorSet.add(floor);
  }
  if (floorSet.size === 0) floorSet.add(0);

  let totalDanglingWalls = 0;
  let totalSelfIntersections = 0;
  let closedWallLoops = true;

  for (const floor of floorSet) {
    const floorWalls = wallList.filter((wall) => {
      const level = Number.isFinite(Number(wall.floor_level)) ? Number(wall.floor_level) : 0;
      return level === floor;
    });
    if (floorWalls.length === 0) continue;

    totalDanglingWalls += countDanglingWalls(floorWalls);
    totalSelfIntersections += countWallSelfIntersections(floorWalls);

    const exterior = floorWalls.filter((wall) => wall.is_exterior);
    if (exterior.length >= 3) {
      if (!hasClosedWallLoops(exterior)) closedWallLoops = false;
    } else {
      // Fallback when exterior tagging is absent: no dangling walls implies usable enclosure quality.
      if (countDanglingWalls(floorWalls) > 0 || floorWalls.length < 3) closedWallLoops = false;
    }
  }

  const wallIdSet = new Set(wallList.map((wall) => String(wall.id)));
  const unhostedOpenings =
    doorList.filter((door) => !wallIdSet.has(String(door.host_wall_id))).length +
    windowList.filter((window) => !wallIdSet.has(String(window.host_wall_id))).length;

  const roomPolygonValidityPass = roomList.every((room) => isRoomPolygonValid(room.polygon));

  return {
    closed_wall_loops: closedWallLoops && wallList.length >= 3,
    self_intersections: totalSelfIntersections,
    dangling_walls: totalDanglingWalls,
    unhosted_openings: unhostedOpenings,
    room_polygon_validity_pass: roomPolygonValidityPass,
  };
};

const applyWallMiterJoins = (
  walls: GeometricReconstruction['walls'],
  tolerance = 0.12
): { walls: GeometricReconstruction['walls']; adjustedEndpointCount: number } => {
  if (!Array.isArray(walls) || walls.length < 2) {
    return { walls, adjustedEndpointCount: 0 };
  }

  type EndpointRef = {
    wallIndex: number;
    atStart: boolean;
    directionAway: [number, number];
    length: number;
    thickness: number;
  };

  const endpointGroups = new Map<string, EndpointRef[]>();
  const pushEndpoint = (key: string, endpoint: EndpointRef) => {
    const group = endpointGroups.get(key) || [];
    group.push(endpoint);
    endpointGroups.set(key, group);
  };

  for (let idx = 0; idx < walls.length; idx += 1) {
    const wall = walls[idx];
    const dx = wall.end[0] - wall.start[0];
    const dz = wall.end[1] - wall.start[1];
    const length = Math.hypot(dx, dz);
    if (!Number.isFinite(length) || length < 1e-6) continue;
    const thickness = Number(wall.thickness);
    if (!Number.isFinite(thickness) || thickness <= 0) continue;

    const ux = dx / length;
    const uz = dz / length;
    const startKey = pointKey(snapPoint(wall.start, tolerance));
    const endKey = pointKey(snapPoint(wall.end, tolerance));

    pushEndpoint(startKey, {
      wallIndex: idx,
      atStart: true,
      directionAway: [ux, uz],
      length,
      thickness,
    });
    pushEndpoint(endKey, {
      wallIndex: idx,
      atStart: false,
      directionAway: [-ux, -uz],
      length,
      thickness,
    });
  }

  const adjustedWalls: GeometricReconstruction['walls'] = walls.map((wall) => ({
    ...wall,
    start: [Number(wall.start[0].toFixed(3)), Number(wall.start[1].toFixed(3))],
    end: [Number(wall.end[0].toFixed(3)), Number(wall.end[1].toFixed(3))],
  }));

  const MIN_JOIN_ANGLE = (15 * Math.PI) / 180;
  const MAX_JOIN_ANGLE = (165 * Math.PI) / 180;
  const MAX_ENDPOINT_TRIM = 0.35;
  let adjustedEndpointCount = 0;

  for (const endpoints of endpointGroups.values()) {
    // Restrict to standard corner joins; skip T-junctions/crossings.
    if (endpoints.length !== 2) continue;
    const [a, b] = endpoints;
    if (a.wallIndex === b.wallIndex) continue;

    const dot = clampNumber(
      a.directionAway[0] * b.directionAway[0] + a.directionAway[1] * b.directionAway[1],
      -1,
      1
    );
    const angle = Math.acos(dot);
    if (!Number.isFinite(angle) || angle < MIN_JOIN_ANGLE || angle > MAX_JOIN_ANGLE) continue;

    const tanHalf = Math.tan(angle / 2);
    if (!Number.isFinite(tanHalf) || tanHalf < 1e-6) continue;

    const trimFor = (self: EndpointRef, other: EndpointRef) => {
      const halfThickness = Math.max(self.thickness / 2, other.thickness / 2);
      const rawTrim = halfThickness / tanHalf;
      if (!Number.isFinite(rawTrim) || rawTrim <= 0) return 0;
      return Math.min(rawTrim, self.length * 0.45, MAX_ENDPOINT_TRIM);
    };

    const trimA = trimFor(a, b);
    const trimB = trimFor(b, a);

    if (trimA > 0.005) {
      const wall = adjustedWalls[a.wallIndex];
      const base = a.atStart ? wall.start : wall.end;
      const moved: [number, number] = [
        Number((base[0] + a.directionAway[0] * trimA).toFixed(3)),
        Number((base[1] + a.directionAway[1] * trimA).toFixed(3)),
      ];
      if (a.atStart) wall.start = moved;
      else wall.end = moved;
      adjustedEndpointCount += 1;
    }

    if (trimB > 0.005) {
      const wall = adjustedWalls[b.wallIndex];
      const base = b.atStart ? wall.start : wall.end;
      const moved: [number, number] = [
        Number((base[0] + b.directionAway[0] * trimB).toFixed(3)),
        Number((base[1] + b.directionAway[1] * trimB).toFixed(3)),
      ];
      if (b.atStart) wall.start = moved;
      else wall.end = moved;
      adjustedEndpointCount += 1;
    }
  }

  const usableWalls = adjustedWalls.filter((wall) => {
    const dx = wall.end[0] - wall.start[0];
    const dz = wall.end[1] - wall.start[1];
    return Math.hypot(dx, dz) >= 0.25;
  });

  return { walls: usableWalls, adjustedEndpointCount };
};

const buildServerCutWallSolids = (
  walls: GeometricReconstruction['walls'],
  doors: GeometricReconstruction['doors'],
  windows: GeometricReconstruction['windows']
): GeometricReconstruction['walls'] => {
  if (!Array.isArray(walls) || walls.length === 0) return [];

  const EPS = 1e-6;
  const MIN_SOLID_LENGTH = 0.08;
  const MIN_SOLID_HEIGHT = 0.08;

  const doorsByWall = new Map<string, GeometricReconstruction['doors']>();
  const windowsByWall = new Map<string, GeometricReconstruction['windows']>();

  for (const door of doors || []) {
    const key = String(door.host_wall_id);
    const list = doorsByWall.get(key) || [];
    list.push(door);
    doorsByWall.set(key, list);
  }
  for (const win of windows || []) {
    const key = String(win.host_wall_id);
    const list = windowsByWall.get(key) || [];
    list.push(win);
    windowsByWall.set(key, list);
  }

  type CutRange = { x0: number; x1: number; y0: number; y1: number };
  let solidCounter = 0;
  const solids: GeometricReconstruction['walls'] = [];

  const mergeVerticalRanges = (ranges: Array<[number, number]>) => {
    if (ranges.length === 0) return [] as Array<[number, number]>;
    const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
    const merged: Array<[number, number]> = [sorted[0]];
    for (let i = 1; i < sorted.length; i += 1) {
      const [start, end] = sorted[i];
      const last = merged[merged.length - 1];
      if (start <= last[1] + EPS) {
        last[1] = Math.max(last[1], end);
      } else {
        merged.push([start, end]);
      }
    }
    return merged;
  };

  const uniqueSorted = (values: number[]) => {
    values.sort((a, b) => a - b);
    const out: number[] = [];
    for (const value of values) {
      if (out.length === 0 || Math.abs(out[out.length - 1] - value) > 1e-4) {
        out.push(value);
      }
    }
    return out;
  };

  for (const wall of walls) {
    const sx = Number(wall.start[0]);
    const sz = Number(wall.start[1]);
    const ex = Number(wall.end[0]);
    const ez = Number(wall.end[1]);
    const dx = ex - sx;
    const dz = ez - sz;
    const length = Math.hypot(dx, dz);
    const wallHeight = Math.max(0, Number(wall.height || 0));
    if (!Number.isFinite(length) || length < MIN_SOLID_LENGTH || wallHeight < MIN_SOLID_HEIGHT) continue;

    const ux = dx / length;
    const uz = dz / length;
    const wallDoors = doorsByWall.get(String(wall.id)) || [];
    const wallWindows = windowsByWall.get(String(wall.id)) || [];
    const cuts: CutRange[] = [];

    const pushCut = (x0: number, x1: number, y0: number, y1: number) => {
      const cx0 = clampNumber(Math.min(x0, x1), 0, length);
      const cx1 = clampNumber(Math.max(x0, x1), 0, length);
      const cy0 = clampNumber(Math.min(y0, y1), 0, wallHeight);
      const cy1 = clampNumber(Math.max(y0, y1), 0, wallHeight);
      if (cx1 - cx0 < MIN_SOLID_LENGTH || cy1 - cy0 < MIN_SOLID_HEIGHT) return;
      cuts.push({ x0: cx0, x1: cx1, y0: cy0, y1: cy1 });
    };

    for (const door of wallDoors) {
      const px = Number(door.position[0]);
      const pz = Number(door.position[1]);
      if (!Number.isFinite(px) || !Number.isFinite(pz)) continue;
      const width = Number(door.width);
      const height = Number(door.height);
      if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) continue;
      const center = clampNumber((px - sx) * ux + (pz - sz) * uz, 0, length);
      const halfWidth = width / 2;
      const doorHeight = clampNumber(height, 0, wallHeight);
      if (halfWidth <= 0) continue;
      pushCut(center - halfWidth, center + halfWidth, 0, doorHeight);
    }

    // No synthetic window head-height inference. If blueprint does not provide window
    // height explicitly, we avoid fabricating vertical cuts in wall solids.
    void wallWindows;

    const addSolid = (x0: number, x1: number, y0: number, y1: number) => {
      const segLength = x1 - x0;
      const segHeight = y1 - y0;
      if (segLength < MIN_SOLID_LENGTH || segHeight < MIN_SOLID_HEIGHT) return;
      const wx0 = sx + ux * x0;
      const wz0 = sz + uz * x0;
      const wx1 = sx + ux * x1;
      const wz1 = sz + uz * x1;
      solidCounter += 1;
      solids.push({
        id: `${wall.id}-solid-${solidCounter}`,
        source_wall_id: wall.id,
        start: [Number(wx0.toFixed(3)), Number(wz0.toFixed(3))],
        end: [Number(wx1.toFixed(3)), Number(wz1.toFixed(3))],
        thickness: Number(wall.thickness),
        height: Number(segHeight.toFixed(3)),
        base_offset: Number(y0.toFixed(3)),
        color: wall.color,
        is_exterior: wall.is_exterior,
        floor_level: wall.floor_level,
      });
    };

    if (cuts.length === 0) {
      addSolid(0, length, 0, wallHeight);
      continue;
    }

    const breakpoints = uniqueSorted([0, length, ...cuts.flatMap((cut) => [cut.x0, cut.x1])]);
    for (let i = 0; i < breakpoints.length - 1; i += 1) {
      const ix0 = breakpoints[i];
      const ix1 = breakpoints[i + 1];
      if (ix1 - ix0 < MIN_SOLID_LENGTH) continue;
      const xMid = (ix0 + ix1) / 2;
      const activeCuts = cuts.filter((cut) => xMid >= cut.x0 - EPS && xMid <= cut.x1 + EPS);
      if (activeCuts.length === 0) {
        addSolid(ix0, ix1, 0, wallHeight);
        continue;
      }

      const mergedVerticalCuts = mergeVerticalRanges(
        activeCuts.map((cut) => [cut.y0, cut.y1] as [number, number])
      );

      let cursor = 0;
      for (const [cy0, cy1] of mergedVerticalCuts) {
        if (cy0 - cursor >= MIN_SOLID_HEIGHT) {
          addSolid(ix0, ix1, cursor, cy0);
        }
        cursor = Math.max(cursor, cy1);
      }
      if (wallHeight - cursor >= MIN_SOLID_HEIGHT) {
        addSolid(ix0, ix1, cursor, wallHeight);
      }
    }
  }

  return solids;
};

const normalizeReconstructionGeometry = (payload: GeometricReconstruction): GeometricReconstruction => {
  if (!Array.isArray(payload?.walls) || payload.walls.length === 0) {
    return {
      ...payload,
      topology_checks: computeDeterministicTopologyChecks(
        payload?.walls || [],
        payload?.doors || [],
        payload?.windows || [],
        payload?.rooms || []
      ),
    };
  }

  const snapTolerance = 0.12;
  const axisSnapRatio = 0.2;

  const cluster = new Map<string, { sx: number; sz: number; count: number }>();
  const addToCluster = (point: [number, number]) => {
    const snapped = snapPoint(point, snapTolerance);
    const key = pointKey(snapped);
    const slot = cluster.get(key) || { sx: 0, sz: 0, count: 0 };
    slot.sx += point[0];
    slot.sz += point[1];
    slot.count += 1;
    cluster.set(key, slot);
  };

  for (const wall of payload.walls) {
    addToCluster(wall.start);
    addToCluster(wall.end);
  }

  const resolvePoint = (point: [number, number]): [number, number] => {
    const snapped = snapPoint(point, snapTolerance);
    const key = pointKey(snapped);
    const slot = cluster.get(key);
    if (!slot || slot.count <= 0) {
      return [Number(point[0].toFixed(3)), Number(point[1].toFixed(3))];
    }
    return [Number((slot.sx / slot.count).toFixed(3)), Number((slot.sz / slot.count).toFixed(3))];
  };

  const normalizedWalls: GeometricReconstruction['walls'] = [];
  for (const wall of payload.walls) {
    let start = resolvePoint(wall.start);
    let end = resolvePoint(wall.end);
    let dx = end[0] - start[0];
    let dz = end[1] - start[1];

    if (Math.abs(dx) <= Math.abs(dz) * axisSnapRatio) {
      const alignedX = Number(((start[0] + end[0]) / 2).toFixed(3));
      start = [alignedX, start[1]];
      end = [alignedX, end[1]];
    } else if (Math.abs(dz) <= Math.abs(dx) * axisSnapRatio) {
      const alignedZ = Number(((start[1] + end[1]) / 2).toFixed(3));
      start = [start[0], alignedZ];
      end = [end[0], alignedZ];
    }

    dx = end[0] - start[0];
    dz = end[1] - start[1];
    if (Math.hypot(dx, dz) < 0.25) continue;
    const thickness = Number(wall.thickness);
    const height = Number(wall.height);
    if (!Number.isFinite(thickness) || thickness <= 0) continue;
    if (!Number.isFinite(height) || height <= 0) continue;

    normalizedWalls.push({
      ...wall,
      start,
      end,
      thickness: Number(thickness.toFixed(3)),
      height: Number(height.toFixed(3)),
    });
  }

  if (normalizedWalls.length === 0) {
    return {
      ...payload,
      topology_checks: computeDeterministicTopologyChecks(
        payload?.walls || [],
        payload?.doors || [],
        payload?.windows || [],
        payload?.rooms || []
      ),
    };
  }
  const miterResult = applyWallMiterJoins(normalizedWalls, snapTolerance);
  const finalizedWalls = miterResult.walls;
  if (finalizedWalls.length === 0) {
    return {
      ...payload,
      topology_checks: computeDeterministicTopologyChecks(
        payload?.walls || [],
        payload?.doors || [],
        payload?.windows || [],
        payload?.rooms || []
      ),
    };
  }

  const wallIdSet = new Set(finalizedWalls.map((wall) => String(wall.id)));

  const normalizedDoors = (payload.doors || [])
    .map((door) => {
      const hostKnown = wallIdSet.has(String(door.host_wall_id));
      const width = Number(door.width);
      const height = Number(door.height);
      const x = Number(door.position?.[0]);
      const z = Number(door.position?.[1]);
      if (!hostKnown) return null;
      if (!Number.isFinite(width) || width <= 0) return null;
      if (!Number.isFinite(height) || height <= 0) return null;
      if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
      return {
        ...door,
        position: [Number(x.toFixed(3)), Number(z.toFixed(3))] as [number, number],
        width: Number(width.toFixed(3)),
        height: Number(height.toFixed(3)),
      };
    })
    .filter((door): door is NonNullable<typeof door> => door != null);

  const normalizedWindows = (payload.windows || [])
    .map((win) => {
      const hostKnown = wallIdSet.has(String(win.host_wall_id));
      const width = Number(win.width);
      const sill = Number(win.sill_height);
      const x = Number(win.position?.[0]);
      const z = Number(win.position?.[1]);
      if (!hostKnown) return null;
      if (!Number.isFinite(width) || width <= 0) return null;
      if (!Number.isFinite(sill) || sill < 0) return null;
      if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
      return {
        ...win,
        position: [Number(x.toFixed(3)), Number(z.toFixed(3))] as [number, number],
        width: Number(width.toFixed(3)),
        sill_height: Number(sill.toFixed(3)),
      };
    })
    .filter((win): win is NonNullable<typeof win> => win != null);

  const normalizedRooms = (payload.rooms || [])
    .map((room) => {
      const pts = Array.isArray(room.polygon) ? room.polygon : [];
      const clean: [number, number][] = [];
      for (const p of pts) {
        if (!Array.isArray(p) || p.length < 2) continue;
        const next: [number, number] = [Number(p[0].toFixed(3)), Number(p[1].toFixed(3))];
        const prev = clean[clean.length - 1];
        if (prev && pointDistance(prev, next) < 0.02) continue;
        clean.push(next);
      }
      if (clean.length >= 2 && pointDistance(clean[0], clean[clean.length - 1]) < 0.02) {
        clean.pop();
      }
      if (clean.length < 3) return null;
      const ordered = polygonArea(clean) < 0 ? [...clean].reverse() : clean;
      const area = Math.abs(polygonArea(ordered));
      if (!Number.isFinite(area) || area < 1) return null;
      return {
        ...room,
        polygon: ordered,
        area: Number(area.toFixed(2)),
      };
    })
    .filter((room): room is NonNullable<typeof room> => room != null);

  const normalizedFurnitures = (payload.furnitures || [])
    .map((item) => {
      const x = Number(item.position?.[0]);
      const z = Number(item.position?.[1]);
      const width = Number(item.width);
      const depth = Number(item.depth);
      const height = Number(item.height);
      if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
      if (!Number.isFinite(width) || width <= 0) return null;
      if (!Number.isFinite(depth) || depth <= 0) return null;
      if (!Number.isFinite(height) || height <= 0) return null;
      return {
        ...item,
        position: [Number(x.toFixed(3)), Number(z.toFixed(3))] as [number, number],
        width: Number(width.toFixed(3)),
        depth: Number(depth.toFixed(3)),
        height: Number(height.toFixed(3)),
      };
    })
    .filter((item): item is NonNullable<typeof item> => item != null);

  const wallSolids = buildServerCutWallSolids(finalizedWalls, normalizedDoors, normalizedWindows);
  const topologyChecks = computeDeterministicTopologyChecks(
    finalizedWalls,
    normalizedDoors,
    normalizedWindows,
    normalizedRooms
  );

  const normalized: GeometricReconstruction = {
    ...payload,
    walls: finalizedWalls,
    wallSolids: wallSolids.length > 0 ? wallSolids : undefined,
    doors: normalizedDoors,
    windows: normalizedWindows,
    rooms: normalizedRooms,
    furnitures: normalizedFurnitures,
    topology_checks: topologyChecks,
  };

  const droppedWalls = payload.walls.length - normalizedWalls.length;
  if (droppedWalls > 0) {
    normalized.conflicts = [
      ...(normalized.conflicts || []),
      {
        type: 'code',
        severity: 'low',
        description: `Dropped ${droppedWalls} degenerate wall segment(s) during geometric normalization.`,
        location: normalizedWalls[0].start,
      },
    ];
  }

  if (miterResult.adjustedEndpointCount > 0 && normalized.walls.length > 0) {
    normalized.conflicts = [
      ...(normalized.conflicts || []),
      {
        type: 'code',
        severity: 'low',
        description: `Applied miter corner normalization on ${miterResult.adjustedEndpointCount} wall endpoint(s) to reduce overlap artifacts.`,
        location: normalized.walls[0].start,
      },
    ];
  }

  const droppedDoors = (payload.doors || []).length - normalizedDoors.length;
  if (droppedDoors > 0 && normalized.walls.length > 0) {
    normalized.conflicts = [
      ...(normalized.conflicts || []),
      {
        type: 'code',
        severity: 'medium',
        description: `Dropped ${droppedDoors} door(s) due to missing host wall or invalid dimensions/position.`,
        location: normalized.walls[0].start,
      },
    ];
  }

  const droppedWindows = (payload.windows || []).length - normalizedWindows.length;
  if (droppedWindows > 0 && normalized.walls.length > 0) {
    normalized.conflicts = [
      ...(normalized.conflicts || []),
      {
        type: 'code',
        severity: 'medium',
        description: `Dropped ${droppedWindows} window(s) due to missing host wall or invalid dimensions/position.`,
        location: normalized.walls[0].start,
      },
    ];
  }

  return normalized;
};

type Segment2D = { start: [number, number]; end: [number, number] };
type Affine2D = { a: number; b: number; c: number; d: number; e: number; f: number };
type FlattenedDxfEntity = { entity: any; transform: Affine2D };

const DXF_UNIT_TO_METERS: Record<number, number> = {
  1: 0.0254, // inches
  2: 0.3048, // feet
  4: 0.001, // millimeters
  5: 0.01, // centimeters
  6: 1, // meters
};

const IDENTITY_AFFINE: Affine2D = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

const toFiniteNumber = (value: unknown): number | null => {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

const toRadians = (degrees: number): number => (degrees * Math.PI) / 180;

const toDxfPoint = (value: any): [number, number] | null => {
  const x = toFiniteNumber(value?.x);
  const y = toFiniteNumber(value?.y);
  if (x == null || y == null) return null;
  return [x, y];
};

const applyAffineToPoint = (point: [number, number], t: Affine2D): [number, number] => {
  const [x, y] = point;
  return [
    Number((t.a * x + t.c * y + t.e).toFixed(6)),
    Number((t.b * x + t.d * y + t.f).toFixed(6)),
  ];
};

const composeAffine = (parent: Affine2D, child: Affine2D): Affine2D => ({
  a: parent.a * child.a + parent.c * child.b,
  b: parent.b * child.a + parent.d * child.b,
  c: parent.a * child.c + parent.c * child.d,
  d: parent.b * child.c + parent.d * child.d,
  e: parent.a * child.e + parent.c * child.f + parent.e,
  f: parent.b * child.e + parent.d * child.f + parent.f,
});

const getInsertTransform = (entity: any): Affine2D => {
  const position = toDxfPoint(entity?.position) ?? [0, 0];
  const scaleX = toFiniteNumber(entity?.xScale) ?? toFiniteNumber(entity?.scaleX) ?? 1;
  const scaleY = toFiniteNumber(entity?.yScale) ?? toFiniteNumber(entity?.scaleY) ?? 1;
  const rotationDegrees = toFiniteNumber(entity?.rotation) ?? 0;
  const rotation = toRadians(rotationDegrees);
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);

  return {
    a: cos * scaleX,
    b: sin * scaleX,
    c: -sin * scaleY,
    d: cos * scaleY,
    e: position[0],
    f: position[1],
  };
};

type BlueprintPreprocessResult = {
  image: string;
  source: 'original' | 'sharp';
  width: number;
  height: number;
};

type VisionInputSelection = {
  primaryImage: string;
  primarySource: 'original' | 'preprocessed';
  secondaryImage: string | null;
  secondarySource: 'original' | 'preprocessed' | null;
};

let sharpUnsupported = false;
let sharpWarned = false;
let tesseractUnsupported = false;
let tesseractWarned = false;
let canvasUnsupported = false;
let canvasWarned = false;

const ensureDataUrlPng = (base64Payload: string): string => `data:image/png;base64,${base64Payload}`;
const stripDataUrl = (value: string): string => {
  const marker = 'base64,';
  const idx = value.indexOf(marker);
  return idx >= 0 ? value.slice(idx + marker.length).trim() : value.trim();
};
const dynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string
) => Promise<any>;
const isModuleImportError = (message: string): boolean =>
  /Cannot find module|Cannot find package|ERR_MODULE_NOT_FOUND/i.test(message);
const originalPreprocessResult = (image: string): BlueprintPreprocessResult => ({
  image,
  source: 'original',
  width: 0,
  height: 0,
});

const selectVisionInputImage = (
  originalImage: string,
  preprocessed: BlueprintPreprocessResult
): VisionInputSelection => {
  const modeRaw = (process.env.INFRALITH_VISION_INPUT_SOURCE || 'preprocessed').trim().toLowerCase();
  const mode = modeRaw === 'original' || modeRaw === 'auto' || modeRaw === 'preprocessed'
    ? modeRaw
    : 'preprocessed';
  const hasPreprocessed = preprocessed.source === 'sharp' && !!preprocessed.image;

  if (!hasPreprocessed || mode === 'original') {
    return {
      primaryImage: originalImage,
      primarySource: 'original',
      secondaryImage: hasPreprocessed ? preprocessed.image : null,
      secondarySource: hasPreprocessed ? 'preprocessed' : null,
    };
  }

  if (mode === 'auto') {
    const minDim = Math.min(preprocessed.width || 0, preprocessed.height || 0);
    if (minDim > 0 && minDim < 700) {
      return {
        primaryImage: preprocessed.image,
        primarySource: 'preprocessed',
        secondaryImage: originalImage,
        secondarySource: 'original',
      };
    }
    return {
      primaryImage: originalImage,
      primarySource: 'original',
      secondaryImage: preprocessed.image,
      secondarySource: 'preprocessed',
    };
  }

  return {
    primaryImage: preprocessed.image,
    primarySource: 'preprocessed',
    secondaryImage: originalImage,
    secondarySource: 'original',
  };
};

const readPolygonFromBoundingBox = (bbox: any): number[] => {
  const x0 = Number(bbox?.x0 ?? bbox?.left ?? 0);
  const y0 = Number(bbox?.y0 ?? bbox?.top ?? 0);
  const x1 = Number(bbox?.x1 ?? ((bbox?.left ?? 0) + (bbox?.width ?? 0)));
  const y1 = Number(bbox?.y1 ?? ((bbox?.top ?? 0) + (bbox?.height ?? 0)));
  if (![x0, y0, x1, y1].every((v) => Number.isFinite(v))) return [];
  if (x1 <= x0 || y1 <= y0) return [];
  return [x0, y0, x1, y0, x1, y1, x0, y1].map((v) => Number(v.toFixed(2)));
};

const mergeLayoutHintSources = (
  localHints: BlueprintLayoutHints | null,
  azureHints: BlueprintLayoutHints | null
): BlueprintLayoutHints | null => {
  if (!localHints && !azureHints) return null;
  if (localHints && !azureHints) return localHints;
  if (!localHints && azureHints) return azureHints;

  const lineSeen = new Set<string>();
  const mergedLinePolygons: number[][] = [];
  for (const polygon of [...(azureHints?.linePolygons || []), ...(localHints?.linePolygons || [])]) {
    if (!Array.isArray(polygon) || polygon.length < 6) continue;
    const normalized = polygon.map((v) => Number(v.toFixed(2)));
    const key = normalized.join(',');
    if (lineSeen.has(key)) continue;
    lineSeen.add(key);
    mergedLinePolygons.push(normalized);
    if (mergedLinePolygons.length >= LAYOUT_POLYGON_LIMIT) break;
  }

  const anchorSeen = new Set<string>();
  const mergedAnchors: Array<{ text: string; polygon: number[]; }> = [];
  for (const anchor of [...(azureHints?.dimensionAnchors || []), ...(localHints?.dimensionAnchors || [])]) {
    const text = String(anchor?.text || '').trim();
    const polygon = Array.isArray(anchor?.polygon) ? anchor.polygon.map((v) => Number(v.toFixed(2))) : [];
    if (!text || polygon.length < 6) continue;
    const key = `${text}|${polygon.join(',')}`;
    if (anchorSeen.has(key)) continue;
    anchorSeen.add(key);
    mergedAnchors.push({ text, polygon });
    if (mergedAnchors.length >= LAYOUT_DIMENSION_ANCHOR_LIMIT) break;
  }

  const lineTextSeen = new Set<string>();
  const mergedLineTexts: string[] = [];
  for (const text of [...(azureHints?.lineTexts || []), ...(localHints?.lineTexts || [])]) {
    const normalized = String(text || '').replace(/\s+/g, ' ').trim();
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (lineTextSeen.has(key)) continue;
    lineTextSeen.add(key);
    mergedLineTexts.push(normalized.slice(0, 160));
    if (mergedLineTexts.length >= LAYOUT_LINE_TEXT_LIMIT) break;
  }

  const floorAnchorSeen = new Set<string>();
  const mergedFloorAnchors: Array<{ text: string; polygon: number[]; }> = [];
  for (const anchor of [...(azureHints?.floorLabelAnchors || []), ...(localHints?.floorLabelAnchors || [])]) {
    const text = String(anchor?.text || '').trim();
    const polygon = Array.isArray(anchor?.polygon) ? anchor.polygon.map((v) => Number(v.toFixed(2))) : [];
    if (!text || polygon.length < 6) continue;
    const key = `${text.toLowerCase()}|${polygon.join(',')}`;
    if (floorAnchorSeen.has(key)) continue;
    floorAnchorSeen.add(key);
    mergedFloorAnchors.push({ text, polygon });
    if (mergedFloorAnchors.length >= LAYOUT_FLOOR_LABEL_LIMIT) break;
  }

  const basePages = (azureHints?.pages?.length || 0) > 0 ? azureHints?.pages : localHints?.pages;
  return {
    pageCount: Math.max(localHints?.pageCount || 0, azureHints?.pageCount || 0, basePages?.length || 0),
    pages: basePages || [],
    linePolygons: mergedLinePolygons,
    dimensionAnchors: mergedAnchors,
    lineTexts: mergedLineTexts,
    floorLabelAnchors: mergedFloorAnchors,
  };
};

const isLocalLayoutStrong = (hints: BlueprintLayoutHints | null) => {
  if (!hints) return false;
  const dimensionSignals = hints.dimensionAnchors?.length || 0;
  const polygonSignals = hints.linePolygons?.length || 0;
  return dimensionSignals >= 2 || polygonSignals >= 40;
};

async function preprocessBlueprintImage(base64Image: string, traceId = 'n/a'): Promise<BlueprintPreprocessResult> {
  const useSharp = asBool(process.env.INFRALITH_USE_SHARP_PREPROCESS, true);
  if (!useSharp || sharpUnsupported) {
    traceLog('Preprocess', traceId, 'skip', 'sharp preprocessing skipped', {
      useSharp,
      sharpUnsupported,
    });
    return originalPreprocessResult(base64Image);
  }

  try {
    const sharpModule = await dynamicImport('sharp');
    const sharp = sharpModule?.default ?? sharpModule;
    if (typeof sharp !== 'function') {
      throw new Error('Sharp module is invalid.');
    }

    const inputBuffer = Buffer.from(stripDataUrl(base64Image), 'base64');
    if (!inputBuffer.length) {
      return originalPreprocessResult(base64Image);
    }

    const maxDim = Math.max(512, Math.min(4096, Number(process.env.INFRALITH_PREPROCESS_MAX_DIM || 2400)));
    const thresholdRaw = Number(process.env.INFRALITH_PREPROCESS_THRESHOLD || 0);
    const threshold = Number.isFinite(thresholdRaw) && thresholdRaw > 0 && thresholdRaw <= 255
      ? Math.round(thresholdRaw)
      : null;

    let pipeline = sharp(inputBuffer, { limitInputPixels: false })
      .rotate()
      .grayscale()
      .normalize()
      .resize({ width: maxDim, height: maxDim, fit: 'inside', withoutEnlargement: true });

    if (threshold != null) {
      pipeline = pipeline.threshold(threshold);
    }

    const { data, info } = await pipeline.png({ compressionLevel: 9 }).toBuffer({ resolveWithObject: true });
    const payload = ensureDataUrlPng(data.toString('base64'));
    traceLog('Preprocess', traceId, 'sharp', 'sharp preprocessing complete', {
      sourceBytes: inputBuffer.length,
      outputBytes: data.length,
      width: Number(info?.width || 0),
      height: Number(info?.height || 0),
      threshold: threshold ?? 'none',
      maxDim,
    });
    return {
      image: payload,
      source: 'sharp',
      width: Number(info?.width || 0),
      height: Number(info?.height || 0),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (isModuleImportError(message)) {
      sharpUnsupported = true;
      if (!sharpWarned) {
        sharpWarned = true;
        console.warn('[Infralith Vision Engine] Sharp not installed. Skipping local image pre-processing.');
      }
      traceLog('Preprocess', traceId, 'sharp', 'sharp package missing, fallback to original', undefined, 'warn');
      return originalPreprocessResult(base64Image);
    }

    traceLog('Preprocess', traceId, 'sharp', 'sharp preprocessing failed, fallback to original', { message }, 'warn');
    return originalPreprocessResult(base64Image);
  }
}

async function runLocalOcrLayoutHints(
  base64Image: string,
  widthHint = 0,
  heightHint = 0,
  traceId = 'n/a'
): Promise<BlueprintLayoutHints | null> {
  const enableLocalOcr = asBool(process.env.INFRALITH_ENABLE_LOCAL_OCR, true);
  if (!enableLocalOcr || tesseractUnsupported) return null;

  try {
    const tesseractModule = await dynamicImport('tesseract.js');
    const recognize = tesseractModule?.recognize || tesseractModule?.default?.recognize;
    if (typeof recognize !== 'function') {
      throw new Error('tesseract.js recognize() is unavailable.');
    }

    const startedAt = Date.now();
    const imageBuffer = Buffer.from(stripDataUrl(base64Image), 'base64');
    traceLog('Local OCR', traceId, '1/3', 'starting tesseract OCR', {
      imageBytes: imageBuffer.length,
      widthHint,
      heightHint,
    });
    const result = await recognize(imageBuffer, 'eng', {
      logger: () => { /* quiet server logs */ },
    });

    const data = result?.data || {};
    const lines = Array.isArray(data?.lines) ? data.lines : [];
    const words = Array.isArray(data?.words) ? data.words : [];
    const linePolygons: number[][] = [];
    const dimensionAnchors: Array<{ text: string; polygon: number[]; }> = [];
    const lineTexts: string[] = [];
    const floorLabelAnchors: Array<{ text: string; polygon: number[]; }> = [];

    for (const line of lines) {
      if (linePolygons.length >= LAYOUT_POLYGON_LIMIT) break;
      const polygon = readPolygonFromBoundingBox(line?.bbox);
      if (polygon.length >= 6) {
        linePolygons.push(polygon);
      }

      const text = String(line?.text || '').trim();
      if (text && lineTexts.length < LAYOUT_LINE_TEXT_LIMIT) {
        lineTexts.push(text.slice(0, 160));
      }
      if (text && LAYOUT_DIMENSION_REGEX.test(text) && dimensionAnchors.length < LAYOUT_DIMENSION_ANCHOR_LIMIT) {
        if (polygon.length >= 6) {
          dimensionAnchors.push({ text, polygon });
        }
      }
      if (text && floorLabelAnchors.length < LAYOUT_FLOOR_LABEL_LIMIT && collectFloorKeysFromText(text).length > 0) {
        if (polygon.length >= 6) {
          floorLabelAnchors.push({ text: text.slice(0, 96), polygon });
        }
      }
    }

    if (linePolygons.length < 20) {
      for (const word of words) {
        if (linePolygons.length >= LAYOUT_POLYGON_LIMIT) break;
        const polygon = readPolygonFromBoundingBox(word?.bbox);
        if (polygon.length >= 6) {
          linePolygons.push(polygon);
        }
        const text = String(word?.text || '').trim();
        if (text && lineTexts.length < LAYOUT_LINE_TEXT_LIMIT) {
          lineTexts.push(text.slice(0, 160));
        }
        if (text && LAYOUT_DIMENSION_REGEX.test(text) && dimensionAnchors.length < LAYOUT_DIMENSION_ANCHOR_LIMIT) {
          if (polygon.length >= 6) {
            dimensionAnchors.push({ text, polygon });
          }
        }
        if (text && floorLabelAnchors.length < LAYOUT_FLOOR_LABEL_LIMIT && collectFloorKeysFromText(text).length > 0) {
          if (polygon.length >= 6) {
            floorLabelAnchors.push({ text: text.slice(0, 96), polygon });
          }
        }
      }
    }

    const durationMs = Date.now() - startedAt;
    const width = Number(widthHint || data?.width || 0);
    const height = Number(heightHint || data?.height || 0);
    traceLog('Local OCR', traceId, '3/3', `parsed in ${durationMs}ms`, {
      linePolygons: linePolygons.length,
      dimensionAnchors: dimensionAnchors.length,
      words: words.length,
    });

    return {
      pageCount: 1,
      pages: [{
        pageNumber: 1,
        width,
        height,
        unit: 'pixel',
        lineCount: linePolygons.length,
        wordCount: words.length,
      }],
      linePolygons,
      dimensionAnchors,
      lineTexts,
      floorLabelAnchors,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (isModuleImportError(message)) {
      tesseractUnsupported = true;
      if (!tesseractWarned) {
        tesseractWarned = true;
        console.warn('[Infralith Vision Engine] tesseract.js not installed. Local OCR layout hints disabled.');
      }
      traceLog('Local OCR', traceId, '0/3', 'tesseract.js package missing', undefined, 'warn');
      return null;
    }

    traceLog('Local OCR', traceId, 'error', 'failed to extract OCR layout hints', { message }, 'warn');
    return null;
  }
}

async function renderDxfPreviewCanvas(walls: GeometricReconstruction['walls'], traceId = 'n/a'): Promise<string | undefined> {
  const enablePreview = asBool(process.env.INFRALITH_DXF_DEBUG_CANVAS, false);
  if (!enablePreview || canvasUnsupported || walls.length === 0) return undefined;

  try {
    const canvasModule = await dynamicImport('canvas');
    const createCanvas = canvasModule?.createCanvas || canvasModule?.default?.createCanvas;
    if (typeof createCanvas !== 'function') {
      throw new Error('createCanvas not available in canvas module.');
    }

    const points = walls.flatMap((wall) => [wall.start, wall.end]);
    const xs = points.map((p) => p[0]);
    const ys = points.map((p) => p[1]);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);

    const size = Math.max(512, Math.min(2048, Number(process.env.INFRALITH_DXF_DEBUG_CANVAS_SIZE || 1024)));
    const padding = 24;
    const width = maxX - minX || 1;
    const height = maxY - minY || 1;
    const scale = Math.min((size - padding * 2) / width, (size - padding * 2) / height);

    const canvas = createCanvas(size, size);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, size, size);
    ctx.strokeStyle = '#1f2937';
    ctx.lineWidth = 1.6;

    for (const wall of walls) {
      const sx = padding + (wall.start[0] - minX) * scale;
      const sy = size - (padding + (wall.start[1] - minY) * scale);
      const ex = padding + (wall.end[0] - minX) * scale;
      const ey = size - (padding + (wall.end[1] - minY) * scale);
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.lineTo(ex, ey);
      ctx.stroke();
    }

    const pngBuffer: Buffer = canvas.toBuffer('image/png');
    traceLog('DXF Canvas', traceId, 'render', 'generated dxf debug image', {
      wallCount: walls.length,
      canvasSize: size,
      pngBytes: pngBuffer.length,
    });
    return ensureDataUrlPng(pngBuffer.toString('base64'));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (isModuleImportError(message)) {
      canvasUnsupported = true;
      if (!canvasWarned) {
        canvasWarned = true;
        console.warn('[Infralith CAD Engine] canvas not installed. DXF preview rasterization disabled.');
      }
      traceLog('DXF Canvas', traceId, 'render', 'canvas package missing', undefined, 'warn');
      return undefined;
    }

    traceLog('DXF Canvas', traceId, 'render', 'dxf preview rasterization failed', { message }, 'warn');
    return undefined;
  }
}

const transformSegment = (segment: Segment2D, transform: Affine2D): Segment2D => ({
  start: applyAffineToPoint(segment.start, transform),
  end: applyAffineToPoint(segment.end, transform),
});

const transformPolygon = (points: [number, number][], transform: Affine2D): [number, number][] =>
  points.map((point) => applyAffineToPoint(point, transform));

const hasClosedPolylineFlag = (entity: any): boolean => {
  if (entity?.shape === true || entity?.closed === true) return true;
  const flags = Number(entity?.flags);
  if (!Number.isFinite(flags)) return false;
  return (flags & 1) === 1;
};

const getEntityVertices = (entity: any): [number, number][] => {
  const vertices = Array.isArray(entity?.vertices) ? entity.vertices : [];
  return vertices
    .map(toDxfPoint)
    .filter((point: [number, number] | null): point is [number, number] => point != null);
};

const buildSegmentsFromPoints = (points: [number, number][], closeLoop = false): Segment2D[] => {
  if (points.length < 2) return [];

  const segments: Segment2D[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    segments.push({ start: points[i], end: points[i + 1] });
  }

  if (closeLoop && points.length >= 3) {
    segments.push({ start: points[points.length - 1], end: points[0] });
  }

  return segments;
};

const getEntitySegments = (entity: any): Segment2D[] => {
  const type = String(entity?.type || '').toUpperCase();

  if (type === 'LINE') {
    const start = toDxfPoint(entity?.start);
    const end = toDxfPoint(entity?.end);
    if (!start || !end) return [];
    return [{ start, end }];
  }

  if (type === 'LWPOLYLINE' || type === 'POLYLINE') {
    const vertices = getEntityVertices(entity);
    return buildSegmentsFromPoints(vertices, hasClosedPolylineFlag(entity));
  }

  if (type === 'ARC') {
    const center = toDxfPoint(entity?.center);
    const radius = toFiniteNumber(entity?.radius);
    const startAngle = toFiniteNumber(entity?.startAngle);
    const endAngle = toFiniteNumber(entity?.endAngle);
    if (!center || radius == null || radius <= 0 || startAngle == null || endAngle == null) return [];

    let arcStart = startAngle;
    let arcEnd = endAngle;
    while (arcEnd <= arcStart) arcEnd += 360;
    const span = Math.min(360, Math.max(1, arcEnd - arcStart));
    const samples = Math.max(8, Math.min(96, Math.ceil(span / 7.5)));
    const points: [number, number][] = [];
    for (let i = 0; i <= samples; i++) {
      const angle = toRadians(arcStart + (span * i) / samples);
      points.push([
        center[0] + radius * Math.cos(angle),
        center[1] + radius * Math.sin(angle),
      ]);
    }
    return buildSegmentsFromPoints(points, false);
  }

  if (type === 'CIRCLE') {
    const center = toDxfPoint(entity?.center);
    const radius = toFiniteNumber(entity?.radius);
    if (!center || radius == null || radius <= 0) return [];
    const samples = 48;
    const points: [number, number][] = [];
    for (let i = 0; i < samples; i++) {
      const angle = (2 * Math.PI * i) / samples;
      points.push([
        center[0] + radius * Math.cos(angle),
        center[1] + radius * Math.sin(angle),
      ]);
    }
    return buildSegmentsFromPoints(points, true);
  }

  if (type === 'ELLIPSE') {
    const center = toDxfPoint(entity?.center);
    const majorAxis = toDxfPoint(entity?.majorAxisEndPoint);
    const axisRatio = toFiniteNumber(entity?.axisRatio);
    if (!center || !majorAxis || axisRatio == null || axisRatio <= 0) return [];

    const majorRadius = Math.hypot(majorAxis[0], majorAxis[1]);
    if (majorRadius <= 1e-6) return [];
    const minorRadius = majorRadius * axisRatio;
    const majorAngle = Math.atan2(majorAxis[1], majorAxis[0]);
    const startParam = toFiniteNumber(entity?.startAngle) ?? 0;
    const rawEndParam = toFiniteNumber(entity?.endAngle) ?? Math.PI * 2;
    let span = rawEndParam - startParam;
    while (span <= 0) span += Math.PI * 2;
    span = Math.min(Math.PI * 2, span);

    const samples = Math.max(12, Math.min(120, Math.ceil(span / (Math.PI / 18))));
    const points: [number, number][] = [];
    for (let i = 0; i <= samples; i++) {
      const t = startParam + (span * i) / samples;
      const localX = majorRadius * Math.cos(t);
      const localY = minorRadius * Math.sin(t);
      const rotatedX = localX * Math.cos(majorAngle) - localY * Math.sin(majorAngle);
      const rotatedY = localX * Math.sin(majorAngle) + localY * Math.cos(majorAngle);
      points.push([center[0] + rotatedX, center[1] + rotatedY]);
    }

    const closeLoop = span >= (Math.PI * 2 - 1e-3);
    return buildSegmentsFromPoints(points, closeLoop);
  }

  if (type === 'SPLINE') {
    const sourcePoints = Array.isArray(entity?.fitPoints) && entity.fitPoints.length >= 2
      ? entity.fitPoints
      : Array.isArray(entity?.controlPoints)
        ? entity.controlPoints
        : [];
    const points = sourcePoints
      .map(toDxfPoint)
      .filter((point: [number, number] | null): point is [number, number] => point != null);
    return buildSegmentsFromPoints(points, false);
  }

  const vertices = getEntityVertices(entity);
  if (vertices.length >= 2) {
    return buildSegmentsFromPoints(vertices, hasClosedPolylineFlag(entity));
  }

  const pointList = Array.isArray(entity?.points)
    ? entity.points
      .map(toDxfPoint)
      .filter((point: [number, number] | null): point is [number, number] => point != null)
    : [];
  if (pointList.length >= 2) {
    return buildSegmentsFromPoints(pointList, false);
  }

  return [];
};

const dedupeSegments = (segments: Segment2D[]): Segment2D[] => {
  const seen = new Set<string>();
  const deduped: Segment2D[] = [];

  for (const segment of segments) {
    const [x1, y1] = segment.start;
    const [x2, y2] = segment.end;
    const a = `${x1.toFixed(4)},${y1.toFixed(4)}`;
    const b = `${x2.toFixed(4)},${y2.toFixed(4)}`;
    const key = a < b ? `${a}|${b}` : `${b}|${a}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(segment);
  }

  return deduped;
};

const getDxfScaleMeters = (parsed: any, rawWidth: number, rawHeight: number): { scale: number; inferred: boolean } => {
  let insUnits: unknown = parsed?.header?.$INSUNITS;
  if (typeof insUnits === 'object' && insUnits !== null && 'value' in insUnits) {
    insUnits = (insUnits as { value?: unknown }).value;
  }

  const mapped = DXF_UNIT_TO_METERS[Number(insUnits)];
  if (Number.isFinite(mapped) && mapped > 0) {
    return { scale: mapped, inferred: false };
  }

  // Unitless DXF: normalize largest dimension to 25m envelope.
  const maxDim = Math.max(rawWidth, rawHeight, 1);
  return { scale: 25 / maxDim, inferred: true };
};

const toMetersFromDxf = (point: [number, number], minX: number, minY: number, scaleMeters: number): [number, number] => {
  const [x, y] = point;
  return [Number(((x - minX) * scaleMeters).toFixed(3)), Number(((y - minY) * scaleMeters).toFixed(3))];
};

const getClosedPolyline = (entity: any): [number, number][] | null => {
  const type = String(entity?.type || '').toUpperCase();
  if (type !== 'LWPOLYLINE' && type !== 'POLYLINE') return null;
  if (!hasClosedPolylineFlag(entity)) return null;

  const vertices = getEntityVertices(entity);
  if (vertices.length < 3) return null;
  return vertices;
};

const flattenDxfEntities = (parsed: any): FlattenedDxfEntity[] => {
  const rootEntities = Array.isArray(parsed?.entities) ? parsed.entities : [];
  const blocks = parsed?.blocks ?? {};
  const flattened: FlattenedDxfEntity[] = [];

  const visit = (entities: any[], transform: Affine2D, depth: number) => {
    if (!Array.isArray(entities)) return;
    for (const entity of entities) {
      const type = String(entity?.type || '').toUpperCase();
      if (type === 'INSERT' && depth < 8) {
        const blockName = String(entity?.name || '');
        const blockEntities = Array.isArray(blocks?.[blockName]?.entities)
          ? blocks[blockName].entities
          : null;
        if (blockEntities && blockEntities.length > 0) {
          const insertTransform = composeAffine(transform, getInsertTransform(entity));
          visit(blockEntities, insertTransform, depth + 1);
          continue;
        }
      }
      flattened.push({ entity, transform });
    }
  };

  visit(rootEntities, IDENTITY_AFFINE, 0);
  return flattened;
};

export async function processDxfTo3D(dxfContent: string): Promise<GeometricReconstruction> {
  const traceId = createTraceId('dxf');
  const startedAt = Date.now();
  traceLog('Infralith CAD Engine', traceId, '0/5', 'DXF parse request received', {
    contentChars: dxfContent?.length || 0,
  });
  if (!dxfContent || !dxfContent.trim()) {
    throw new Error('DXF file is empty.');
  }

  let parsed: any;
  try {
    const parser = new DxfParser();
    parsed = parser.parseSync(dxfContent);
  } catch (error) {
    throw new Error('Invalid DXF file. Failed to parse CAD geometry.');
  }

  const flattenedEntities = flattenDxfEntities(parsed);
  if (flattenedEntities.length === 0) {
    throw new Error('DXF has no entities to process.');
  }

  const allSegments = dedupeSegments(
    flattenedEntities.flatMap(({ entity, transform }) =>
      getEntitySegments(entity).map((segment) => transformSegment(segment, transform))
    )
  );
  if (allSegments.length === 0) {
    const types = [...new Set(flattenedEntities.map(({ entity }) => String(entity?.type || 'UNKNOWN').toUpperCase()))];
    throw new Error(
      `DXF parsing completed but no usable wall geometry was found. Entity types present: ${types.slice(0, 16).join(', ') || 'none'}.`
    );
  }

  const allPoints = allSegments.flatMap((segment) => [segment.start, segment.end]);
  const xs = allPoints.map((p) => p[0]);
  const ys = allPoints.map((p) => p[1]);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const rawWidth = Math.max(1, maxX - minX);
  const rawHeight = Math.max(1, maxY - minY);

  const { scale: metersPerUnit, inferred: isInferredScale } = getDxfScaleMeters(parsed, rawWidth, rawHeight);
  const configuredWallThicknessM = parsePositiveEnvNumber(process.env.INFRALITH_DXF_WALL_THICKNESS_M);
  const configuredWallHeightM = parsePositiveEnvNumber(process.env.INFRALITH_DXF_WALL_HEIGHT_M);
  if (configuredWallThicknessM == null || configuredWallHeightM == null) {
    throw new Error(
      'DXF reconstruction requires explicit wall extrusion settings. Set INFRALITH_DXF_WALL_THICKNESS_M and INFRALITH_DXF_WALL_HEIGHT_M to production values for your project.'
    );
  }
  const boundaryTolerance = Math.max(rawWidth, rawHeight) * 0.03;

  const maxWallCount = 1800;
  const sortedSegments = [...allSegments].sort((a, b) => {
    const al = Math.hypot(a.end[0] - a.start[0], a.end[1] - a.start[1]);
    const bl = Math.hypot(b.end[0] - b.start[0], b.end[1] - b.start[1]);
    return bl - al;
  });

  const walls: GeometricReconstruction['walls'] = [];
  let wallCounter = 1;
  for (const segment of sortedSegments) {
    const rawLength = Math.hypot(segment.end[0] - segment.start[0], segment.end[1] - segment.start[1]);
    const metricLength = rawLength * metersPerUnit;
    if (metricLength < 0.35) continue;

    const nearBoundary =
      Math.abs(segment.start[0] - minX) <= boundaryTolerance ||
      Math.abs(segment.start[0] - maxX) <= boundaryTolerance ||
      Math.abs(segment.start[1] - minY) <= boundaryTolerance ||
      Math.abs(segment.start[1] - maxY) <= boundaryTolerance ||
      Math.abs(segment.end[0] - minX) <= boundaryTolerance ||
      Math.abs(segment.end[0] - maxX) <= boundaryTolerance ||
      Math.abs(segment.end[1] - minY) <= boundaryTolerance ||
      Math.abs(segment.end[1] - maxY) <= boundaryTolerance;

    walls.push({
      id: `dxf-w-${wallCounter++}`,
      start: toMetersFromDxf(segment.start, minX, minY, metersPerUnit),
      end: toMetersFromDxf(segment.end, minX, minY, metersPerUnit),
      thickness: Number(configuredWallThicknessM.toFixed(3)),
      height: Number(configuredWallHeightM.toFixed(3)),
      is_exterior: nearBoundary,
    });
    if (walls.length >= maxWallCount) break;
  }

  if (walls.length === 0) {
    throw new Error('DXF was parsed, but no valid wall segments could be derived.');
  }

  const rooms: GeometricReconstruction['rooms'] = [];
  const closedPolylines = flattenedEntities
    .map(({ entity, transform }) => {
      const polygon = getClosedPolyline(entity);
      return polygon ? transformPolygon(polygon, transform) : null;
    })
    .filter((polygon: [number, number][] | null): polygon is [number, number][] => polygon != null);

  let roomCounter = 1;
  for (const polygon of closedPolylines) {
    const metricPolygon = polygon.map((point: [number, number]) => toMetersFromDxf(point, minX, minY, metersPerUnit));
    if (metricPolygon.length < 3) continue;

    let signedArea = polygonArea(metricPolygon);
    if (Math.abs(signedArea) < 3 || Math.abs(signedArea) > 4000) continue;

    let ordered = metricPolygon;
    if (signedArea < 0) {
      ordered = [...metricPolygon].reverse();
      signedArea = -signedArea;
    }

    rooms.push({
      id: `dxf-r-${roomCounter}`,
      name: `Room ${roomCounter}`,
      polygon: ordered,
      area: Number(signedArea.toFixed(2)),
    });
    roomCounter++;
    if (rooms.length >= 150) break;
  }

  const dxfDebugImage = await renderDxfPreviewCanvas(walls, traceId);

  const headerProjectName = typeof parsed?.header?.$PROJECTNAME === 'string' ? parsed.header.$PROJECTNAME.trim() : '';
  const headerDrawingName = typeof parsed?.header?.$DWGNAME === 'string' ? parsed.header.$DWGNAME.trim() : '';

  const reconstruction: GeometricReconstruction = {
    building_name: headerProjectName || headerDrawingName || undefined,
    walls,
    doors: [],
    windows: [],
    rooms,
    debug_image: dxfDebugImage,
    conflicts: [
      ...(rooms.length === 0
        ? [{
          type: 'code' as const,
          severity: 'medium' as const,
          description: 'No closed room polygons found in DXF. Verify room outlines and closed polylines.',
          location: [0, 0] as [number, number],
        }]
        : []),
      ...(isInferredScale
        ? [{
          type: 'code' as const,
          severity: 'low' as const,
          description: 'DXF units were unspecified. Geometry was normalized to a 25m envelope; verify dimensions.',
          location: [0, 0] as [number, number],
        }]
        : []),
      ...(allSegments.length > maxWallCount
        ? [{
          type: 'code' as const,
          severity: 'low' as const,
          description: `DXF contained ${allSegments.length} segments. Model was simplified to the longest ${maxWallCount} wall candidates.`,
          location: [0, 0] as [number, number],
        }]
        : []),
    ],
  };

  const validated = applyBuildingCodes(reconstruction);
  const durationMs = Date.now() - startedAt;
  traceLog('Infralith CAD Engine', traceId, '5/5', `DXF conversion complete in ${durationMs}ms`, {
    ...summarizeReconstruction(validated),
    segmentCount: allSegments.length,
    inferredScale: isInferredScale,
    hasDebugImage: !!dxfDebugImage,
  });
  return validated;
}

type CommandResult = {
  code: number;
  stdout: string;
  stderr: string;
};

const KNOWN_DWG_CONVERTERS = ['dwg2dxf', 'dwgread', 'ODAFileConverter', 'TeighaFileConverter'] as const;

export type CadPipelineCapabilities = {
  dxfSupported: boolean;
  dwgSupported: boolean;
  dwgResolver: 'env-template' | 'binary' | 'none';
  availableConverters: string[];
};

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function hasFileExtension(name: string): boolean {
  const baseName = path.basename(name);
  return baseName.includes('.') && baseName.lastIndexOf('.') > 0;
}

async function commandExists(command: string): Promise<boolean> {
  if (!command.trim()) return false;

  const isDirectPath = command.includes('/') || command.includes('\\');
  if (isDirectPath) {
    return pathExists(command);
  }

  const pathEnv = process.env.PATH || '';
  const pathParts = pathEnv.split(path.delimiter).filter(Boolean);
  const pathExtRaw = process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM';
  const pathExt = pathExtRaw.split(';').filter(Boolean);

  const candidates = hasFileExtension(command)
    ? [command]
    : [
      command,
      ...pathExt.map((ext) => `${command}${ext.toLowerCase()}`),
      ...pathExt.map((ext) => `${command}${ext.toUpperCase()}`),
    ];

  for (const dir of pathParts) {
    for (const candidate of candidates) {
      const fullPath = path.join(dir, candidate);
      if (await pathExists(fullPath)) {
        return true;
      }
    }
  }

  return false;
}

async function runCommand(
  command: string,
  args: string[],
  options?: { cwd?: string; shell?: boolean; timeoutMs?: number }
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options?.cwd,
      shell: options?.shell ?? false,
    });

    let stdout = '';
    let stderr = '';
    const timeoutMs = options?.timeoutMs ?? 45_000;

    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Command timed out after ${timeoutMs}ms: ${command}`));
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

function stripDataUrlPrefix(value: string): string {
  const marker = 'base64,';
  const idx = value.indexOf(marker);
  if (idx === -1) return value.trim();
  return value.slice(idx + marker.length).trim();
}

function renderConverterTemplate(
  template: string,
  replacements: Record<string, string>
): string {
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (_, key: string) => replacements[key] ?? `{${key}}`);
}

async function fileExistsWithContent(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

export async function getCadPipelineCapabilities(): Promise<CadPipelineCapabilities> {
  const envTemplate = process.env.INFRALITH_DWG_TO_DXF_COMMAND?.trim();
  const availableConverters: string[] = [];

  for (const converter of KNOWN_DWG_CONVERTERS) {
    if (await commandExists(converter)) {
      availableConverters.push(converter);
    }
  }

  if (envTemplate) {
    return {
      dxfSupported: true,
      dwgSupported: true,
      dwgResolver: 'env-template',
      availableConverters,
    };
  }

  if (availableConverters.length > 0) {
    return {
      dxfSupported: true,
      dwgSupported: true,
      dwgResolver: 'binary',
      availableConverters,
    };
  }

  return {
    dxfSupported: true,
    dwgSupported: false,
    dwgResolver: 'none',
    availableConverters,
  };
}

async function convertDwgToDxfString(dwgBase64: string): Promise<string> {
  const payload = stripDataUrlPrefix(dwgBase64);
  let buffer: Buffer;
  try {
    buffer = Buffer.from(payload, 'base64');
  } catch {
    throw new Error('Invalid DWG payload encoding.');
  }

  if (!buffer.length) {
    throw new Error('DWG payload is empty.');
  }

  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'infralith-dwg-'));
  const inputDir = path.join(tempRoot, 'input');
  const outputDir = path.join(tempRoot, 'output');
  const inputPath = path.join(inputDir, 'blueprint.dwg');
  const outputPath = path.join(outputDir, 'blueprint.dxf');
  const outputCandidates = [
    outputPath,
    path.join(outputDir, 'blueprint.DXF'),
  ];
  const errors: string[] = [];

  await fs.mkdir(inputDir, { recursive: true });
  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(inputPath, buffer);

  const envTemplate = process.env.INFRALITH_DWG_TO_DXF_COMMAND?.trim();
  const capabilities = await getCadPipelineCapabilities();
  if (!capabilities.dwgSupported) {
    throw new Error(
      'DWG conversion is not configured on this server. Install dwg2dxf/dwgread/ODAFileConverter or set INFRALITH_DWG_TO_DXF_COMMAND.'
    );
  }

  const replacements = {
    input: inputPath,
    output: outputPath,
    input_dir: inputDir,
    output_dir: outputDir,
    input_name: 'blueprint.dwg',
    output_name: 'blueprint.dxf',
  };

  const attempts: Array<
    | { name: string; type: 'shell'; command: string }
    | { name: string; type: 'binary'; command: string; args: string[] }
  > = [];

  if (envTemplate) {
    attempts.push({
      name: 'env-template',
      type: 'shell',
      command: renderConverterTemplate(envTemplate, replacements),
    });
  }

  attempts.push(
    {
      name: 'dwg2dxf',
      type: 'binary',
      command: 'dwg2dxf',
      args: [inputPath, outputPath],
    },
    {
      name: 'dwgread',
      type: 'binary',
      command: 'dwgread',
      args: ['-O', 'DXF', '-o', outputPath, inputPath],
    },
    {
      name: 'ODAFileConverter',
      type: 'binary',
      command: 'ODAFileConverter',
      args: [inputDir, outputDir, 'ACAD2018', 'DXF', '0', '1'],
    },
    {
      name: 'TeighaFileConverter',
      type: 'binary',
      command: 'TeighaFileConverter',
      args: [inputDir, outputDir, 'ACAD2018', 'DXF', '0', '1'],
    }
  );

  try {
    for (const attempt of attempts) {
      try {
        const result = attempt.type === 'shell'
          ? await runCommand(attempt.command, [], { shell: true })
          : await runCommand(attempt.command, attempt.args);

        let finalPath: string | null = null;
        for (const candidate of outputCandidates) {
          if (await fileExistsWithContent(candidate)) {
            finalPath = candidate;
            break;
          }
        }

        if (!finalPath) {
          const stderr = result.stderr?.trim();
          const stdout = result.stdout?.trim();
          errors.push(`${attempt.name}: conversion produced no DXF file.${stderr ? ` stderr=${stderr}` : ''}${stdout ? ` stdout=${stdout}` : ''}`);
          continue;
        }

        return await fs.readFile(finalPath, 'utf8');
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`${attempt.name}: ${message}`);
      }
    }
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }

  throw new Error(
    `DWG conversion failed. Install/configure a converter and set INFRALITH_DWG_TO_DXF_COMMAND (example: "dwgread -O DXF -o {output} {input}") or install dwg2dxf/dwgread/ODAFileConverter. Details: ${errors.join(' | ')}`
  );
}

export async function processDwgTo3D(dwgBase64: string): Promise<GeometricReconstruction> {
  const traceId = createTraceId('dwg');
  const startedAt = Date.now();
  traceLog('Infralith CAD Engine', traceId, '0/2', 'Starting DWG conversion pipeline', {
    payloadChars: dwgBase64?.length || 0,
  });
  const dxfContent = await convertDwgToDxfString(dwgBase64);
  const result = await processDxfTo3D(dxfContent);
  const durationMs = Date.now() - startedAt;
  traceLog('Infralith CAD Engine', traceId, '2/2', `DWG conversion + parsing completed in ${durationMs}ms`, summarizeReconstruction(result));
  return result;
}


/**
 * Construction-grade geometric reconstruction engine.
 * Converts 2D architectural floor plans into metrically consistent parametric 3D models.
 * Uses Azure layout analysis and Azure OpenAI Vision for semantic reconstruction.
 */
export async function processBlueprintTo3D(imageUrl: string): Promise<GeometricReconstruction> {
  const traceId = createTraceId('vision');
  const startedAt = Date.now();
  traceLog('Infralith Vision Engine', traceId, '0/9', 'request received', {
    payloadChars: imageUrl.length,
  });
  traceLog('Infralith Vision Engine', traceId, '0/9', 'Routing blueprint to Azure OpenAI Vision');
  // STAGE 1: Extract OCR/layout hints
  let layoutHints: BlueprintLayoutHints | null = null;
  const layoutHintMode = getLayoutHintMode();
  traceLog('Infralith Vision Engine', traceId, '1/9', 'running structural pre-processing (OCR/layout hints only)', {
    layoutHintMode,
  });
  const preprocessed = await preprocessBlueprintImage(imageUrl, traceId);
  const structuralInputImage = preprocessed.image;
  traceLog('Infralith Vision Engine', traceId, '1/9', 'pre-process result', {
    source: preprocessed.source,
    width: preprocessed.width,
    height: preprocessed.height,
    payloadChars: structuralInputImage.length,
  });
  let localLayoutHints: BlueprintLayoutHints | null = null;
  if (layoutHintMode !== 'azure') {
    localLayoutHints = await runLocalOcrLayoutHints(structuralInputImage, preprocessed.width, preprocessed.height, traceId);
    if (localLayoutHints) {
      traceLog('Infralith Vision Engine', traceId, '1/9', 'local OCR layout hints extracted', summarizeLayoutHints(localLayoutHints));
    }
  }
  const shouldCallAzureLayout =
    layoutHintMode === 'azure' ||
    layoutHintMode === 'hybrid' ||
    (layoutHintMode === 'auto' && !isLocalLayoutStrong(localLayoutHints));
  if (shouldCallAzureLayout) {
    try {
      const azureLayoutHints = await withMonitoredTimeout(
        () => analyzeBlueprintLayoutFromBase64(structuralInputImage),
        {
          component: 'Infralith Vision Engine',
          traceId,
          step: '1/9',
          label: 'azure layout hint extraction',
          timeoutMs: LAYOUT_STAGE_TIMEOUT_MS,
        }
      );
      layoutHints = mergeLayoutHintSources(localLayoutHints, azureLayoutHints);
      traceLog('Infralith Vision Engine', traceId, '1/9', 'layout hint output', {
        source: localLayoutHints ? 'merged-local-azure' : 'azure',
        ...summarizeLayoutHints(layoutHints),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      layoutHints = localLayoutHints;
      traceLog('Infralith Vision Engine', traceId, '1/9', 'layout hint extraction failed, continuing with local hints', {
        reason: message,
        hasLocalHints: !!localLayoutHints,
      }, 'warn');
    }
  } else {
    layoutHints = localLayoutHints;
    traceLog('Infralith Vision Engine', traceId, '1/9', 'layout hint output', {
      source: localLayoutHints ? 'local' : 'none',
      ...summarizeLayoutHints(layoutHints),
    });
  }
  const lineSignalCount = layoutHints?.linePolygons?.length || 0;
  const dimensionSignalCount = layoutHints?.dimensionAnchors?.length || 0;
  const totalLayoutSignals = lineSignalCount + dimensionSignalCount;
  if (!layoutHints || totalLayoutSignals < MIN_LAYOUT_SIGNALS_REQUIRED) {
    const message = 'Layout parsing failed: no usable line/dimension signals extracted. Please upload a clearer plan or check OCR/layout services.';
    traceLog('Infralith Vision Engine', traceId, '1/9', message, {
      hasLayoutHints: !!layoutHints,
      lineSignals: lineSignalCount,
      dimensionSignals: dimensionSignalCount,
      mode: layoutHintMode,
    }, 'error');
    throw new Error(message);
  }
  // STAGE 2: Send image + layout hints to the AI Vision model
  const prompt = buildBlueprintVisionPrompt(layoutHints);
  try {
    const expectedFloorCount = inferExpectedFloorCountFromHints(layoutHints);
    traceLog('Infralith Vision Engine', traceId, '2/9', 'sending blueprint + hints to Azure Vision');
    let result = await generateAzureVisionObject<GeometricReconstruction>(prompt, imageUrl);
    let observedFloorCount = getObservedFloorCount(result);
    let floorCoverage = assessFloorCoverageQuality(result, expectedFloorCount);
    traceLog('Infralith Vision Engine', traceId, '3/9', 'AI reconstruction received', {
      ...summarizeReconstruction(result),
      expectedFloorCount,
      observedFloorCount,
      floorCoverage: floorCoverage.perFloor,
      weakLevels: floorCoverage.weakLevels,
      minWallsThreshold: floorCoverage.minWallsThreshold,
    });

    const underfitDetected = shouldRetryForUnderfit(result, layoutHints);
    const floorCollapseDetected = expectedFloorCount >= 2 && observedFloorCount < expectedFloorCount;
    const weakFloorCoverageDetected =
      ENFORCE_MULTI_FLOOR_COVERAGE &&
      expectedFloorCount >= 2 &&
      floorCoverage.weakLevels.length > 0;

    if (underfitDetected || floorCollapseDetected || weakFloorCoverageDetected) {
      let strictPrompt = buildBlueprintRetryPrompt(prompt);
      if (floorCollapseDetected) {
        strictPrompt = `${strictPrompt}

CRITICAL MULTI-FLOOR ENFORCEMENT (MANDATORY):
- Layout hints indicate at least ${expectedFloorCount} floor label(s). Do not collapse to a single floor.
- Use distinct floor_level values and set meta.floor_count >= ${expectedFloorCount}.
- If any floor is uncertain, still preserve separate floor_level partitions and add explicit conflicts.`;
      }
      if (weakFloorCoverageDetected) {
        strictPrompt = `${strictPrompt}

CRITICAL PER-FLOOR STRUCTURE ENFORCEMENT (MANDATORY):
- Reconstruct each detected floor as a non-trivial wall graph.
- Current weak floors: [${floorCoverage.weakLevels.join(', ')}].
- Minimum required wall segments per floor in this retry: ${Math.max(2, floorCoverage.minWallsThreshold)}.
- Do not satisfy floor_count by sprinkling isolated walls across levels.
- If a floor cannot be reconstructed confidently, still include a structurally plausible shell and add explicit conflicts.`;
      }
      traceLog('Infralith Vision Engine', traceId, '4/9', 'retrying reconstruction with stricter constraints', {
        underfitDetected,
        floorCollapseDetected,
        weakFloorCoverageDetected,
        expectedFloorCount,
        observedFloorCount,
        floorCoverage: floorCoverage.perFloor,
      }, 'warn');
      result = await generateAzureVisionObject<GeometricReconstruction>(strictPrompt, imageUrl);
      observedFloorCount = getObservedFloorCount(result);
      floorCoverage = assessFloorCoverageQuality(result, expectedFloorCount);
      traceLog('Infralith Vision Engine', traceId, '4/9', 'retry reconstruction received', {
        ...summarizeReconstruction(result),
        expectedFloorCount,
        observedFloorCount,
        floorCoverage: floorCoverage.perFloor,
        weakLevels: floorCoverage.weakLevels,
        minWallsThreshold: floorCoverage.minWallsThreshold,
      });
    }
    if (expectedFloorCount >= 2 && observedFloorCount < expectedFloorCount) {
      throw new Error(`Multi-floor collapse detected: layout hints indicate at least ${expectedFloorCount} floor labels, but reconstruction returned ${observedFloorCount} floor level(s). Upload a clearer multi-floor plan sheet or split each floor into separate images.`);
    }
    if (
      ENFORCE_MULTI_FLOOR_COVERAGE &&
      expectedFloorCount >= 2 &&
      floorCoverage.weakLevels.length > 0
    ) {
      throw new Error(`Multi-floor under-segmentation detected: floor labels indicate ${expectedFloorCount} floors, but weak structural coverage remains for floor level(s) [${floorCoverage.weakLevels.join(', ')}]. Please upload a clearer sheet per floor or reduce clutter/overlap in the drawing.`);
    }
    if (!hasNonEmptyWalls(result)) {
      throw new Error("Engineering Synthesis Failed: GPT-4o Vision could not construct a valid geometric structure from the provided blueprint. Please ensure the image is a clear architectural floor plan.");
    }
    result = normalizeReconstructionGeometry(result);
    traceLog('Infralith Vision Engine', traceId, '6/9', 'applying deterministic building-code validation');
    const validatedResult = applyBuildingCodes(result);
    traceLog('Infralith Vision Engine', traceId, '7/9', 'validation complete', summarizeReconstruction(validatedResult));
    const finalPayload: GeometricReconstruction = {
      ...validatedResult,
      is_vision_only: !layoutHints,
    };
    traceLog('Infralith Vision Engine', traceId, '8/9', 'final payload assembled', {
      is_vision_only: finalPayload.is_vision_only,
      layoutHints: summarizeLayoutHints(layoutHints),
    });
    const durationMs = Date.now() - startedAt;
    traceLog('Infralith Vision Engine', traceId, '9/9', `returning reconstruction in ${durationMs}ms`, {
      is_vision_only: finalPayload.is_vision_only,
      ...summarizeReconstruction(finalPayload),
    });
    return finalPayload;
  } catch (e) {
    traceLog('Infralith Vision Engine', traceId, 'error', 'Azure Vision Pipeline Error', { error: String(e) }, 'error');
    throw e;
  }
}
/**
 * Generate a 3D building from a text description.
 * Uses Azure OpenAI to generate complete parametric geometry with luxury finishes.
 */
export async function generateBuildingFromDescription(description: string): Promise<GeometricReconstruction> {
  const traceId = createTraceId('text2bim');
  const startedAt = Date.now();
  traceLog('Infralith Architect Engine', traceId, '0/2', 'Generating parametric building from description', {
    promptSeedChars: description.length,
  });

  const prompt = buildTextToBuildingPrompt(description);
  try {
    traceLog('Infralith Architect Engine', traceId, '1/2', 'sending text-to-bim request');
    const result = await generateAzureObject<GeometricReconstruction>(prompt);
    if (!hasNonEmptyWalls(result)) {
      throw new Error("Architectural Generation Failed: The AI was unable to synthesize a valid structure from the given description.");
    }
    const normalized = applyBuildingCodes(normalizeReconstructionGeometry(result));
    const durationMs = Date.now() - startedAt;
    traceLog('Infralith Architect Engine', traceId, '2/2', `Structured generation completed in ${durationMs}ms`, summarizeReconstruction(normalized));
    return normalized;
  } catch (e) {
    traceLog('Infralith Architect Engine', traceId, 'error', 'Text-to-3D Pipeline Error', { error: String(e) }, 'error');
    throw e;
  }
}

/**
 * Enterprise Real-Time Asset Generator.
 * Uses Azure OpenAI to procedurally generate a highly detailed 3D asset model made of bounding boxes.
 * This guarantees the models are completely unique and not predefined templates.
 */
export async function generateRealTimeAsset(description: string): Promise<AIAsset> {
  const traceId = createTraceId('voxel');
  const startedAt = Date.now();
  traceLog('Procedural Voxel Engine', traceId, '0/3', 'Generating asset request received', {
    promptChars: description?.length || 0,
    description,
  });

  const prompt = buildAssetPrompt(description);
  try {
    traceLog('Procedural Voxel Engine', traceId, '1/3', 'sending text-to-object request');
    let result = await generateAzureObject<AIAsset>(prompt, AIAssetSchema);
    if (!result || !Array.isArray(result.parts) || result.parts.length === 0) {
      throw new Error("Asset Generation Failed.");
    }

    if (result.parts.length < 4) {
      const retryPrompt = buildAssetRetryPrompt(prompt);
      traceLog('Procedural Voxel Engine', traceId, '2/3', 'under-detailed asset detected, retrying', {
        initialPartCount: result.parts.length,
      }, 'warn');
      const retried = await generateAzureObject<AIAsset>(retryPrompt, AIAssetSchema);
      if (retried && Array.isArray(retried.parts) && retried.parts.length >= result.parts.length) {
        result = retried;
      }
    }

    const durationMs = Date.now() - startedAt;
    traceLog('Procedural Voxel Engine', traceId, '3/3', `asset ready in ${durationMs}ms`, {
      name: result.name,
      partCount: result.parts.length,
    });
    return result;
  } catch (e) {
    traceLog('Procedural Voxel Engine', traceId, 'error', 'Error calling Azure OpenAI for asset', { error: String(e) }, 'error');
    throw e;
  }
}
