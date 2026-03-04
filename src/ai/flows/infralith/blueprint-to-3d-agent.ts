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
const LAYOUT_FLOOR_LABEL_REGEX = /\b((?:basement|cellar|lower\s*ground|stilt|ground|first|second|third|fourth|fifth|terrace|roof)\s*floor|(?:level|lvl|floor|flr)\s*[-_:]?\s*[a-z0-9]+|(?:g|b|l|f)\s*[-_:]?\s*\d{1,2})\b/i;

type LayoutHintMode = 'auto' | 'azure' | 'local' | 'hybrid';

const asBool = (value: string | undefined, fallback: boolean): boolean => {
  if (value == null || value.trim() === '') return fallback;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
};

const VERBOSE_LOGS = asBool(process.env.INFRALITH_VERBOSE_LOGS, true);
const VERBOSE_LOG_PAYLOADS = asBool(process.env.INFRALITH_VERBOSE_LOG_PAYLOADS, false);

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

const parseBoundedInt = (
  value: string | undefined,
  fallback: number,
  min: number,
  max: number
): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
};

const parseBoundedFloat = (
  value: string | undefined,
  fallback: number,
  min: number,
  max: number
): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
};

const STAGE_HEARTBEAT_MS = parseTimeoutMs(process.env.INFRALITH_STAGE_HEARTBEAT_MS, 20_000, 5_000, 120_000);
const LAYOUT_STAGE_TIMEOUT_MS = parseTimeoutMs(process.env.INFRALITH_LAYOUT_TIMEOUT_MS, 65_000);
const VISION_CONSENSUS_RUNS = parseBoundedInt(process.env.INFRALITH_VISION_CONSENSUS_RUNS, 3, 1, 5);
const VISION_CONSENSUS_MIN_SCORE = parseBoundedFloat(process.env.INFRALITH_VISION_CONSENSUS_MIN_SCORE, 66, 20, 120);

type SemanticMentionKey =
  | 'kitchen'
  | 'bedroom'
  | 'bathroom'
  | 'living'
  | 'dining'
  | 'stairs'
  | 'study'
  | 'utility'
  | 'storage'
  | 'garage'
  | 'foyer'
  | 'balcony'
  | 'den';

type SemanticMentionDef = {
  key: SemanticMentionKey;
  label: string;
  patterns: RegExp[];
};

const SEMANTIC_MENTION_DEFS: SemanticMentionDef[] = [
  { key: 'kitchen', label: 'Kitchen', patterns: [/\bkitchen\b/i, /\bpantry\b/i, /\bscullery\b/i] },
  { key: 'bedroom', label: 'Bedroom', patterns: [/\bbed(?:room)?\b/i, /\bbdrm\b/i, /\bmaster suite\b/i] },
  { key: 'bathroom', label: 'Bathroom/WC', patterns: [/\bbath(?:room)?\b/i, /\btoilet\b/i, /\bwc\b/i, /\bpowder\b/i, /\blav(?:atory)?\b/i, /\bwash(?:room)?\b/i] },
  { key: 'living', label: 'Living/Family', patterns: [/\bliving\b/i, /\bfamily(?:\s*room)?\b/i, /\blounge\b/i, /\bgreat\s*room\b/i] },
  { key: 'dining', label: 'Dining', patterns: [/\bdining\b/i, /\bbreakfast\b/i] },
  { key: 'stairs', label: 'Stairs', patterns: [/\bstair(?:case)?s?\b/i, /\bstairwell\b/i, /\b(?:up|dn|down)\b/i] },
  { key: 'study', label: 'Study/Office', patterns: [/\bstudy\b/i, /\boffice\b/i, /\bwork\s*room\b/i] },
  { key: 'utility', label: 'Utility/Laundry', patterns: [/\butility\b/i, /\blaundry\b/i, /\bservice\b/i, /\bwash\s*area\b/i] },
  { key: 'storage', label: 'Storage', patterns: [/\bstore(?:room)?\b/i, /\bstorage\b/i, /\bcloset\b/i] },
  { key: 'garage', label: 'Garage', patterns: [/\bgarage\b/i, /\bcarport\b/i, /\b\d+\s*car\b/i] },
  { key: 'foyer', label: 'Foyer/Entry', patterns: [/\bfoyer\b/i, /\bentry\b/i, /\blobby\b/i, /\bvestibule\b/i] },
  { key: 'balcony', label: 'Balcony/Terrace', patterns: [/\bbalcony\b/i, /\bterrace\b/i, /\bpatio\b/i] },
  { key: 'den', label: 'Den', patterns: [/\bden\b/i] },
];

const SEMANTIC_LABEL_BY_KEY: Record<SemanticMentionKey, string> = SEMANTIC_MENTION_DEFS.reduce((acc, item) => {
  acc[item.key] = item.label;
  return acc;
}, {} as Record<SemanticMentionKey, string>);

const normalizeSemanticText = (value: unknown): string =>
  String(value || '')
    .toLowerCase()
    .replace(/[_\-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const collectLayoutSemanticText = (layoutHints: BlueprintLayoutHints | null): string[] => {
  if (!layoutHints) return [];
  const texts: string[] = [];
  for (const text of layoutHints.lineTexts || []) {
    const normalized = normalizeSemanticText(text);
    if (normalized) texts.push(normalized);
  }
  for (const anchor of layoutHints.floorLabelAnchors || []) {
    const normalized = normalizeSemanticText(anchor?.text);
    if (normalized) texts.push(normalized);
  }
  return texts;
};

const extractRequiredSemanticMentionKeys = (layoutHints: BlueprintLayoutHints | null): SemanticMentionKey[] => {
  const textLines = collectLayoutSemanticText(layoutHints);
  if (textLines.length === 0) return [];

  const required = new Set<SemanticMentionKey>();
  for (const line of textLines) {
    for (const def of SEMANTIC_MENTION_DEFS) {
      if (def.patterns.some((pattern) => pattern.test(line))) {
        required.add(def.key);
      }
    }
  }
  return [...required];
};

const collectSemanticMentionsFromResult = (result: GeometricReconstruction): Set<SemanticMentionKey> => {
  const present = new Set<SemanticMentionKey>();
  const probes: string[] = [];
  for (const room of result?.rooms || []) probes.push(normalizeSemanticText(room?.name));
  for (const item of result?.furnitures || []) {
    probes.push(normalizeSemanticText(item?.type));
    probes.push(normalizeSemanticText(item?.description));
  }

  for (const text of probes) {
    if (!text) continue;
    for (const def of SEMANTIC_MENTION_DEFS) {
      if (def.patterns.some((pattern) => pattern.test(text))) {
        present.add(def.key);
      }
    }
  }

  return present;
};

const getMissingSemanticMentionKeys = (
  required: SemanticMentionKey[],
  result: GeometricReconstruction
): SemanticMentionKey[] => {
  if (!required.length) return [];
  const present = collectSemanticMentionsFromResult(result);
  return required.filter((key) => !present.has(key));
};

const describeSemanticMentionKeys = (keys: SemanticMentionKey[]): string[] =>
  keys.map((key) => SEMANTIC_LABEL_BY_KEY[key] || key);

const hasSemanticMentionKey = (result: GeometricReconstruction, key: SemanticMentionKey): boolean =>
  !getMissingSemanticMentionKeys([key], result).includes(key);

const hasMultiFloorExpectation = (
  layoutHints: BlueprintLayoutHints | null,
  result: GeometricReconstruction
): boolean => {
  const floorSignals = estimateFloorHintCount(layoutHints);
  const inferredFloorCount = estimateResultFloorCount(result);
  return floorSignals >= 2 || inferredFloorCount >= 2;
};

const shouldAttemptStairSymbolRecovery = (
  layoutHints: BlueprintLayoutHints | null,
  result: GeometricReconstruction,
  requiredSemanticMentions: SemanticMentionKey[]
): boolean => {
  if (requiredSemanticMentions.includes('stairs')) return false;
  if (!hasMultiFloorExpectation(layoutHints, result)) return false;
  if (hasSemanticMentionKey(result, 'stairs')) return false;

  const walls = result?.walls?.length || 0;
  const rooms = result?.rooms?.length || 0;
  if (walls < 8 || rooms < 4) return false;

  return true;
};

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

type FidelityAssessment = {
  shouldRetry: boolean;
  reasons: string[];
};

const toFiniteScalar = (value: unknown): number | null => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const normalizeFloorLabelText = (value: string): string | null => {
  const text = value.toLowerCase().replace(/\s+/g, ' ').trim();
  if (!text) return null;

  const named = text.match(/\b(basement|cellar|ground|first|second|third|fourth|fifth|terrace|roof)\b/);
  if (named?.[1]) return named[1];

  const level = text.match(/\b(?:level|lvl|floor|flr)\s*[-_:]?\s*([a-z0-9]+)\b/);
  if (level?.[1]) return `level-${level[1]}`;

  const shortCode = text.match(/\b(?:g|b|l|f)\s*[-_:]?\s*(\d{1,2})\b/);
  if (shortCode?.[1]) return `code-${shortCode[1]}`;

  return null;
};

const estimateFloorHintCount = (layoutHints: BlueprintLayoutHints | null): number => {
  if (!layoutHints) return 0;

  const labels = new Set<string>();
  for (const anchor of layoutHints.floorLabelAnchors || []) {
    const normalized = normalizeFloorLabelText(String(anchor?.text || ''));
    if (!normalized) continue;
    labels.add(normalized);
    if (labels.size >= 6) break;
  }

  if (labels.size > 0) return labels.size;

  for (const lineText of layoutHints.lineTexts || []) {
    const normalized = normalizeFloorLabelText(String(lineText || ''));
    if (!normalized) continue;
    labels.add(normalized);
    if (labels.size >= 6) break;
  }

  return labels.size;
};

const estimateResultFloorCount = (result: GeometricReconstruction): number => {
  const hinted = Math.max(0, Math.round(toFiniteScalar(result?.meta?.floor_count) ?? 0));
  let maxLevel = -1;
  const bump = (level: unknown) => {
    const n = toFiniteScalar(level);
    if (n == null) return;
    maxLevel = Math.max(maxLevel, Math.round(n));
  };

  for (const wall of result?.walls || []) bump(wall.floor_level);
  for (const room of result?.rooms || []) bump(room.floor_level);
  for (const door of result?.doors || []) bump(door.floor_level);
  for (const win of result?.windows || []) bump(win.floor_level);

  const fromGeometry = maxLevel >= 0 ? maxLevel + 1 : 0;
  return Math.max(hinted, fromGeometry);
};

const toFloorBucket = (value: unknown): number => {
  const parsed = toFiniteScalar(value);
  if (parsed == null) return 0;
  return Math.max(0, Math.round(parsed));
};

const roomPolygonSignature = (points: [number, number][] | null | undefined): string => {
  if (!Array.isArray(points) || points.length < 3) return 'na';
  const xs = points.map((pt) => Number(pt?.[0]));
  const ys = points.map((pt) => Number(pt?.[1]));
  if (xs.some((v) => !Number.isFinite(v)) || ys.some((v) => !Number.isFinite(v))) return 'na';

  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const area = Math.abs(polygonArea(points));
  return `${(maxX - minX).toFixed(2)}x${(maxY - minY).toFixed(2)}|${area.toFixed(2)}`;
};

type FloorComplexity = {
  level: number;
  walls: number;
  interiorWalls: number;
  rooms: number;
  doors: number;
  windows: number;
};

const collectFloorComplexity = (result: GeometricReconstruction): FloorComplexity[] => {
  const levels = new Map<number, FloorComplexity>();
  const ensure = (levelValue: unknown): FloorComplexity => {
    const level = toFloorBucket(levelValue);
    const existing = levels.get(level);
    if (existing) return existing;
    const created: FloorComplexity = {
      level,
      walls: 0,
      interiorWalls: 0,
      rooms: 0,
      doors: 0,
      windows: 0,
    };
    levels.set(level, created);
    return created;
  };

  for (const wall of result?.walls || []) {
    const bucket = ensure(wall?.floor_level);
    bucket.walls += 1;
    if (wall?.is_exterior === false) bucket.interiorWalls += 1;
  }
  for (const room of result?.rooms || []) ensure(room?.floor_level).rooms += 1;
  for (const door of result?.doors || []) ensure(door?.floor_level).doors += 1;
  for (const win of result?.windows || []) ensure(win?.floor_level).windows += 1;

  if (levels.size === 0) {
    return [{
      level: 0,
      walls: 0,
      interiorWalls: 0,
      rooms: 0,
      doors: 0,
      windows: 0,
    }];
  }

  return [...levels.values()].sort((a, b) => a.level - b.level);
};

const isLikelySparseMultiFloorShell = (
  result: GeometricReconstruction,
  floorSignals: number
): boolean => {
  if (floorSignals < 2) return false;
  const inferredFloorCount = estimateResultFloorCount(result);
  if (inferredFloorCount < 2) return false;

  const floorStats = collectFloorComplexity(result);
  if (floorStats.length < 2) return false;

  const sparseFloorCount = floorStats.filter((stats) =>
    stats.walls <= 5 &&
    stats.interiorWalls <= 1 &&
    stats.rooms <= 1 &&
    stats.doors === 0 &&
    stats.windows === 0
  ).length;
  const interiorWallTotal = floorStats.reduce((sum, stats) => sum + stats.interiorWalls, 0);
  const roomSignatures = new Set((result?.rooms || []).map((room) => roomPolygonSignature(room?.polygon || [])));
  const repeatedRoomFootprints = roomSignatures.size <= Math.max(1, Math.floor((result?.rooms?.length || 0) / 2));
  const tooFewRoomsForMultiFloor = (result?.rooms?.length || 0) <= floorStats.length + 1;

  return (
    sparseFloorCount >= Math.ceil(floorStats.length * 0.66) &&
    interiorWallTotal <= Math.max(2, floorStats.length) &&
    repeatedRoomFootprints &&
    tooFewRoomsForMultiFloor
  );
};

type InteriorLayoutSignal = {
  placeholder: boolean;
  reasons: string[];
  denseFloors: number;
  gridLikeFloors: number;
  averageInteriorWallsPerFloor: number;
};

const collectRoomBounds = (
  polygon: [number, number][] | null | undefined
): { minX: number; maxX: number; minY: number; maxY: number; area: number } | null => {
  if (!Array.isArray(polygon) || polygon.length < 3) return null;
  const xs = polygon.map((pt) => Number(pt?.[0]));
  const ys = polygon.map((pt) => Number(pt?.[1]));
  if (xs.some((value) => !Number.isFinite(value)) || ys.some((value) => !Number.isFinite(value))) return null;

  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const area = Math.abs(polygonArea(polygon));
  if (!Number.isFinite(area) || area <= 0) return null;

  return { minX, maxX, minY, maxY, area };
};

const isMostlyAxisAlignedRectangle = (
  polygon: [number, number][] | null | undefined,
  fillTolerance = 0.08
): boolean => {
  const bounds = collectRoomBounds(polygon);
  if (!bounds || !Array.isArray(polygon)) return false;
  const width = bounds.maxX - bounds.minX;
  const depth = bounds.maxY - bounds.minY;
  if (width <= 0 || depth <= 0) return false;

  const bboxArea = width * depth;
  if (!Number.isFinite(bboxArea) || bboxArea <= 0) return false;

  const fillRatio = bounds.area / bboxArea;
  if (fillRatio < 1 - fillTolerance) return false;

  let edgeAlignedVertices = 0;
  const edgeTolerance = 0.06;
  for (const point of polygon) {
    const x = Number(point?.[0]);
    const y = Number(point?.[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (
      Math.abs(x - bounds.minX) <= edgeTolerance ||
      Math.abs(x - bounds.maxX) <= edgeTolerance ||
      Math.abs(y - bounds.minY) <= edgeTolerance ||
      Math.abs(y - bounds.maxY) <= edgeTolerance
    ) {
      edgeAlignedVertices += 1;
    }
  }

  return edgeAlignedVertices >= Math.max(4, polygon.length - 1);
};

const analyzeInteriorLayoutSignal = (result: GeometricReconstruction): InteriorLayoutSignal => {
  const rooms = result?.rooms || [];
  if (rooms.length === 0) {
    return {
      placeholder: false,
      reasons: [],
      denseFloors: 0,
      gridLikeFloors: 0,
      averageInteriorWallsPerFloor: 0,
    };
  }

  const roomsByFloor = new Map<number, GeometricReconstruction['rooms']>();
  for (const room of rooms) {
    const floor = toFloorBucket(room?.floor_level);
    if (!roomsByFloor.has(floor)) roomsByFloor.set(floor, []);
    roomsByFloor.get(floor)?.push(room);
  }

  let denseFloors = 0;
  let gridLikeFloors = 0;
  let rectangularRoomCount = 0;
  const shapeFrequency = new Map<string, number>();
  const areaFrequency = new Map<string, number>();

  for (const floorRooms of roomsByFloor.values()) {
    if (floorRooms.length >= 3) {
      denseFloors += 1;

      const uniqueX = new Set<number>();
      const uniqueY = new Set<number>();
      let floorRectangularRooms = 0;
      for (const room of floorRooms) {
        const polygon = room?.polygon || [];
        for (const point of polygon) {
          const x = Number(point?.[0]);
          const y = Number(point?.[1]);
          if (Number.isFinite(x)) uniqueX.add(Number(x.toFixed(1)));
          if (Number.isFinite(y)) uniqueY.add(Number(y.toFixed(1)));
        }
        if (isMostlyAxisAlignedRectangle(polygon)) floorRectangularRooms += 1;
      }

      const floorRectangularShare = floorRectangularRooms / Math.max(1, floorRooms.length);
      if (floorRectangularShare >= 0.75 && uniqueX.size <= 6 && uniqueY.size <= 6) {
        gridLikeFloors += 1;
      }
    }

    for (const room of floorRooms) {
      const bounds = collectRoomBounds(room?.polygon || []);
      if (!bounds) continue;
      if (isMostlyAxisAlignedRectangle(room?.polygon || [])) rectangularRoomCount += 1;
      const width = bounds.maxX - bounds.minX;
      const depth = bounds.maxY - bounds.minY;
      const shapeKey = `${width.toFixed(2)}x${depth.toFixed(2)}`;
      const areaKey = bounds.area.toFixed(1);
      shapeFrequency.set(shapeKey, (shapeFrequency.get(shapeKey) || 0) + 1);
      areaFrequency.set(areaKey, (areaFrequency.get(areaKey) || 0) + 1);
    }
  }

  const floorStats = collectFloorComplexity(result);
  const interiorWallTotal = floorStats.reduce((sum, stats) => sum + stats.interiorWalls, 0);
  const averageInteriorWallsPerFloor = interiorWallTotal / Math.max(1, floorStats.length);

  const maxAreaFrequency = Math.max(0, ...areaFrequency.values());
  const repeatedShapePattern = shapeFrequency.size <= Math.max(2, Math.floor(rooms.length / 3));
  const repeatedAreaPattern = maxAreaFrequency >= Math.ceil(rooms.length * 0.4);
  const rectangularShare = rectangularRoomCount / Math.max(1, rooms.length);
  const gridDominant = denseFloors >= 2 && gridLikeFloors >= Math.ceil(denseFloors * 0.6);
  const simplificationConflict = (result?.conflicts || []).some((conflict) =>
    /\b(?:simplified|quadrant|proportional|uniform\s+footprint|rectangular\s+footprint)\b/i.test(
      String(conflict?.description || '')
    )
  );

  const placeholder = (
    rooms.length >= 6 &&
    rectangularShare >= 0.8 &&
    averageInteriorWallsPerFloor <= 2.5 &&
    (gridDominant || (repeatedShapePattern && repeatedAreaPattern) || simplificationConflict)
  );

  const reasons: string[] = [];
  if (gridDominant) {
    reasons.push(`Room partitions form repetitive grid splits across floors (${gridLikeFloors}/${Math.max(denseFloors, 1)} dense floor(s)).`);
  }
  if (repeatedShapePattern && repeatedAreaPattern) {
    reasons.push('Room dimensions/areas repeat excessively, indicating underfit interior partitioning.');
  }
  if (averageInteriorWallsPerFloor <= 2.5 && rooms.length >= 6) {
    reasons.push(`Interior wall density is too low (${averageInteriorWallsPerFloor.toFixed(2)} interior walls/floor) for current room count.`);
  }
  if (simplificationConflict) {
    reasons.push('Conflicts already indicate simplified proportional layout rather than evidence-backed partitions.');
  }

  return {
    placeholder,
    reasons,
    denseFloors,
    gridLikeFloors,
    averageInteriorWallsPerFloor,
  };
};

type RoomDimensionHint = {
  text: string;
  widthM: number;
  depthM: number;
  center: [number, number] | null;
  floorLevel: number | null;
};

type RoomDimensionMismatch = {
  hintText: string;
  floorLevel: number | null;
  expectedWidthM: number;
  expectedDepthM: number;
  matchedRoomId: string | number | null;
  matchedRoomName: string | null;
  sizeErrorRatio: number;
  positionDistance: number | null;
  hintCenter: [number, number] | null;
  reason: string;
};

type RoomDimensionAssessment = {
  hintCount: number;
  matchedCount: number;
  mismatches: RoomDimensionMismatch[];
  reasons: string[];
  shouldRetry: boolean;
};

const parseFloorLabelToLevel = (label: string): number | null => {
  const text = String(label || '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (!text) return null;
  if (/\b(basement|cellar|lower\s*ground|stilt|ground)\b/.test(text)) return 0;
  if (/\bfirst\b/.test(text)) return 1;
  if (/\bsecond\b/.test(text)) return 2;
  if (/\bthird\b/.test(text)) return 3;
  if (/\bfourth\b/.test(text)) return 4;
  if (/\bfifth\b/.test(text)) return 5;

  const numeric = text.match(/\b(?:level|lvl|floor|flr)\s*[-_:]?\s*(\d{1,2})\b/);
  if (numeric?.[1]) {
    const parsed = Number(numeric[1]);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return null;
};

const flatPolygonCenter = (polygon: number[] | null | undefined): [number, number] | null => {
  if (!Array.isArray(polygon) || polygon.length < 6) return null;
  let sumX = 0;
  let sumY = 0;
  let count = 0;
  for (let i = 0; i < polygon.length - 1; i += 2) {
    const x = Number(polygon[i]);
    const y = Number(polygon[i + 1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    sumX += x;
    sumY += y;
    count += 1;
  }
  if (count === 0) return null;
  return [sumX / count, sumY / count];
};

const parseDimensionTokenMeters = (token: string, fullText: string): number | null => {
  const raw = String(token || '').trim().toLowerCase();
  if (!raw) return null;

  const feetInch = raw.match(/(\d+(?:\.\d+)?)\s*'\s*(?:[-\s]?\s*(\d+(?:\.\d+)?)\s*(?:\"|in|inch|inches)?)?/);
  if (feetInch) {
    const feet = Number(feetInch[1] || 0);
    const inches = Number(feetInch[2] || 0);
    const meters = (feet * 0.3048) + (inches * 0.0254);
    return Number.isFinite(meters) && meters > 0 ? meters : null;
  }

  const numericMatch = raw.match(/\d+(?:\.\d+)?/);
  if (!numericMatch?.[0]) return null;
  const numeric = Number(numericMatch[0]);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;

  const context = `${raw} ${String(fullText || '').toLowerCase()}`;
  if (/\bmm\b/.test(context)) return numeric / 1000;
  if (/\bcm\b/.test(context)) return numeric / 100;
  if (/\bm\b/.test(context)) return numeric;
  if (/\b(ft|feet|foot)\b|\'/.test(context)) return numeric * 0.3048;
  if (/\b(in|inch|inches)\b|\"/.test(context)) return numeric * 0.0254;

  return null;
};

const extractDimensionPairFromText = (value: string): { widthM: number; depthM: number } | null => {
  const text = String(value || '').replace(/,/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  const pairMatch = text.match(/(.{0,36}?\d[\d\s.'"\-]*(?:mm|cm|m|ft|feet|foot|in|inch|inches|["'])?)\s*[x×]\s*(\d[\d\s.'"\-]*(?:mm|cm|m|ft|feet|foot|in|inch|inches|["'])?.{0,20})/i);
  if (!pairMatch?.[1] || !pairMatch?.[2]) return null;

  const widthM = parseDimensionTokenMeters(pairMatch[1], text);
  const depthM = parseDimensionTokenMeters(pairMatch[2], text);
  if (widthM == null || depthM == null) return null;
  if (widthM < 0.4 || depthM < 0.4 || widthM > 40 || depthM > 40) return null;

  return {
    widthM: Number(widthM.toFixed(3)),
    depthM: Number(depthM.toFixed(3)),
  };
};

const extractRoomDimensionHints = (layoutHints: BlueprintLayoutHints | null): RoomDimensionHint[] => {
  if (!layoutHints) return [];
  const floorAnchors = (layoutHints.floorLabelAnchors || [])
    .map((anchor, index) => {
      const center = flatPolygonCenter(anchor?.polygon || []);
      if (!center) return null;
      const fromLabel = parseFloorLabelToLevel(String(anchor?.text || ''));
      return {
        level: fromLabel ?? index,
        centerY: center[1],
      };
    })
    .filter((entry): entry is NonNullable<typeof entry> => !!entry)
    .sort((a, b) => a.centerY - b.centerY);

  const hints: RoomDimensionHint[] = [];
  const dedupe = new Set<string>();
  for (const anchor of layoutHints.dimensionAnchors || []) {
    if (hints.length >= 36) break;
    const pair = extractDimensionPairFromText(String(anchor?.text || ''));
    if (!pair) continue;
    const center = flatPolygonCenter(anchor?.polygon || []);

    let floorLevel: number | null = null;
    if (center && floorAnchors.length > 0) {
      let best: { level: number; distance: number } | null = null;
      for (const floorAnchor of floorAnchors) {
        const distance = Math.abs(center[1] - floorAnchor.centerY);
        if (!best || distance < best.distance) {
          best = { level: floorAnchor.level, distance };
        }
      }
      floorLevel = best?.level ?? null;
    }

    const key = [
      pair.widthM.toFixed(2),
      pair.depthM.toFixed(2),
      floorLevel == null ? 'na' : String(floorLevel),
      center ? `${center[0].toFixed(1)}:${center[1].toFixed(1)}` : 'nocenter',
      String(anchor?.text || '').toLowerCase().trim(),
    ].join('|');
    if (dedupe.has(key)) continue;
    dedupe.add(key);

    hints.push({
      text: String(anchor?.text || '').trim(),
      widthM: pair.widthM,
      depthM: pair.depthM,
      center,
      floorLevel,
    });
  }

  return hints;
};

const estimateRoomDimensionAlignment = (
  layoutHints: BlueprintLayoutHints | null,
  result: GeometricReconstruction
): RoomDimensionAssessment => {
  const hints = extractRoomDimensionHints(layoutHints);
  const rooms = result?.rooms || [];
  if (hints.length === 0 || rooms.length === 0) {
    return {
      hintCount: hints.length,
      matchedCount: 0,
      mismatches: [],
      reasons: [],
      shouldRetry: false,
    };
  }

  const wallPoints = (result?.walls || []).flatMap((wall) => [wall.start, wall.end]);
  let planWidth = 0;
  let planDepth = 0;
  if (wallPoints.length > 0) {
    const xs = wallPoints.map((point) => Number(point?.[0])).filter((value) => Number.isFinite(value));
    const ys = wallPoints.map((point) => Number(point?.[1])).filter((value) => Number.isFinite(value));
    if (xs.length > 0 && ys.length > 0) {
      planWidth = Math.max(...xs) - Math.min(...xs);
      planDepth = Math.max(...ys) - Math.min(...ys);
    }
  }

  const candidateHints = hints.filter((hint) => {
    if (planWidth <= 0 || planDepth <= 0) return true;
    const direct = Math.max(
      Math.abs(planWidth - hint.widthM) / Math.max(hint.widthM, 1e-3),
      Math.abs(planDepth - hint.depthM) / Math.max(hint.depthM, 1e-3)
    );
    const swapped = Math.max(
      Math.abs(planWidth - hint.depthM) / Math.max(hint.depthM, 1e-3),
      Math.abs(planDepth - hint.widthM) / Math.max(hint.widthM, 1e-3)
    );
    const footprintMatch = Math.min(direct, swapped);
    const nearWholePlan = footprintMatch <= 0.2 && (
      hint.widthM >= Math.min(planWidth, planDepth) * 0.8 ||
      hint.depthM >= Math.min(planWidth, planDepth) * 0.8
    );
    return !nearWholePlan;
  });

  if (candidateHints.length === 0) {
    return {
      hintCount: hints.length,
      matchedCount: 0,
      mismatches: [],
      reasons: [],
      shouldRetry: false,
    };
  }

  let matchedCount = 0;
  const mismatches: RoomDimensionMismatch[] = [];

  for (const hint of candidateHints) {
    const floorRooms = hint.floorLevel == null
      ? rooms
      : rooms.filter((room) => toFloorBucket(room?.floor_level) === toFloorBucket(hint.floorLevel));
    if (floorRooms.length === 0) {
      mismatches.push({
        hintText: hint.text,
        floorLevel: hint.floorLevel,
        expectedWidthM: hint.widthM,
        expectedDepthM: hint.depthM,
        matchedRoomId: null,
        matchedRoomName: null,
        sizeErrorRatio: 1,
        positionDistance: null,
        hintCenter: hint.center,
        reason: `No room polygons found on floor ${hint.floorLevel ?? 'unknown'} for dimension hint "${hint.text}".`,
      });
      continue;
    }

    let bestMatch: {
      roomId: string | number;
      roomName: string;
      sizeErrorRatio: number;
      positionDistance: number | null;
      score: number;
    } | null = null;

    for (const room of floorRooms) {
      const bounds = collectRoomBounds(room?.polygon || []);
      if (!bounds) continue;
      const width = bounds.maxX - bounds.minX;
      const depth = bounds.maxY - bounds.minY;
      if (width <= 0 || depth <= 0) continue;

      const direct = Math.max(
        Math.abs(width - hint.widthM) / Math.max(hint.widthM, 1e-3),
        Math.abs(depth - hint.depthM) / Math.max(hint.depthM, 1e-3)
      );
      const swapped = Math.max(
        Math.abs(width - hint.depthM) / Math.max(hint.depthM, 1e-3),
        Math.abs(depth - hint.widthM) / Math.max(hint.widthM, 1e-3)
      );
      const sizeErrorRatio = Math.min(direct, swapped);

      let positionDistance: number | null = null;
      if (hint.center) {
        const centerX = (bounds.minX + bounds.maxX) / 2;
        const centerY = (bounds.minY + bounds.maxY) / 2;
        positionDistance = Math.hypot(centerX - hint.center[0], centerY - hint.center[1]);
      }
      const positionPenalty = positionDistance == null
        ? 0
        : positionDistance / Math.max(1.5, Math.max(hint.widthM, hint.depthM) * 1.8);
      const score = sizeErrorRatio + (positionPenalty * 0.25);

      if (!bestMatch || score < bestMatch.score) {
        bestMatch = {
          roomId: room.id,
          roomName: room.name,
          sizeErrorRatio,
          positionDistance,
          score,
        };
      }
    }

    if (!bestMatch) {
      mismatches.push({
        hintText: hint.text,
        floorLevel: hint.floorLevel,
        expectedWidthM: hint.widthM,
        expectedDepthM: hint.depthM,
        matchedRoomId: null,
        matchedRoomName: null,
        sizeErrorRatio: 1,
        positionDistance: null,
        hintCenter: hint.center,
        reason: `No valid room polygon could be matched for dimension hint "${hint.text}".`,
      });
      continue;
    }

    const sizeTolerance = 0.28;
    const positionTolerance = Math.max(2.5, Math.max(hint.widthM, hint.depthM) * 2.2);
    const sizeMismatch = bestMatch.sizeErrorRatio > sizeTolerance;
    const positionMismatch =
      bestMatch.positionDistance != null &&
      bestMatch.positionDistance > positionTolerance;
    if (sizeMismatch || positionMismatch) {
      const mismatchReason = sizeMismatch
        ? `Dimension hint "${hint.text}" expects ~${hint.widthM.toFixed(2)}m x ${hint.depthM.toFixed(2)}m but matched room "${bestMatch.roomName}" differs by ${(bestMatch.sizeErrorRatio * 100).toFixed(0)}%.`
        : `Dimension hint "${hint.text}" maps far from room "${bestMatch.roomName}" (distance ${bestMatch.positionDistance?.toFixed(2)}m), indicating position mismatch.`;
      mismatches.push({
        hintText: hint.text,
        floorLevel: hint.floorLevel,
        expectedWidthM: hint.widthM,
        expectedDepthM: hint.depthM,
        matchedRoomId: bestMatch.roomId,
        matchedRoomName: bestMatch.roomName,
        sizeErrorRatio: bestMatch.sizeErrorRatio,
        positionDistance: bestMatch.positionDistance,
        hintCenter: hint.center,
        reason: mismatchReason,
      });
      continue;
    }

    matchedCount += 1;
  }

  const mismatchRatio = mismatches.length / Math.max(1, candidateHints.length);
  const shouldRetry =
    candidateHints.length >= 2 &&
    mismatches.length >= Math.max(1, Math.ceil(candidateHints.length * 0.34));
  const reasons = mismatches.slice(0, 3).map((item) => item.reason);
  if (mismatchRatio >= 0.5 && reasons.length < 3) {
    reasons.push(`Room dimensions/positions mismatch in ${mismatches.length}/${candidateHints.length} parsed room-dimension hints.`);
  }

  return {
    hintCount: candidateHints.length,
    matchedCount,
    mismatches,
    reasons,
    shouldRetry,
  };
};

const scoreReconstructionDensity = (
  result: GeometricReconstruction,
  layoutHints: BlueprintLayoutHints | null
): number => {
  const wallCount = result?.walls?.length || 0;
  const roomCount = result?.rooms?.length || 0;
  const doorCount = result?.doors?.length || 0;
  const windowCount = result?.windows?.length || 0;
  const floorSignals = estimateFloorHintCount(layoutHints);
  const inferredFloorCount = estimateResultFloorCount(result);
  const highConflicts = (result?.conflicts || []).filter((conflict) => conflict?.severity === 'high').length;
  const scaleConfidence = toFiniteScalar(result?.meta?.scale_confidence) ?? 0;
  const topology = result?.topology_checks;
  const interiorSignal = analyzeInteriorLayoutSignal(result);
  const dimensionAssessment = estimateRoomDimensionAlignment(layoutHints, result);

  let score = 0;
  score += Math.min(32, wallCount * 2.2);
  score += Math.min(28, roomCount * 4);
  score += Math.min(12, doorCount * 1.2 + windowCount * 0.9);
  score += Math.min(8, scaleConfidence * 8);

  if (floorSignals >= 2) {
    const targetFloors = Math.min(4, floorSignals);
    if (inferredFloorCount >= targetFloors) score += 8;
  }

  if (topology?.closed_wall_loops === true) score += 3;
  if ((topology?.dangling_walls ?? 0) === 0) score += 2;
  if ((topology?.unhosted_openings ?? 0) === 0) score += 2;
  if (topology?.room_polygon_validity_pass === true) score += 2;

  if (isLikelyRectangularFallback(result)) score -= 20;
  if (isLikelySparseMultiFloorShell(result, floorSignals)) score -= 24;
  if (interiorSignal.placeholder) score -= 18;
  if (dimensionAssessment.hintCount >= 2) {
    score -= Math.min(14, dimensionAssessment.mismatches.length * 3.5);
  }
  score -= Math.min(16, highConflicts * 5);

  return Math.round(score * 100) / 100;
};

const getOpeningCount = (result: GeometricReconstruction): number =>
  (result?.doors?.length || 0) + (result?.windows?.length || 0);

const asPoint2D = (value: unknown): [number, number] | null => {
  if (!Array.isArray(value) || value.length < 2) return null;
  const x = Number(value[0]);
  const y = Number(value[1]);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return [x, y];
};

const pointToSegmentDistance = (
  point: [number, number],
  start: [number, number],
  end: [number, number]
): number => {
  const [px, py] = point;
  const [x1, y1] = start;
  const [x2, y2] = end;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const l2 = dx * dx + dy * dy;
  if (l2 <= 1e-9) return Math.hypot(px - x1, py - y1);

  let t = ((px - x1) * dx + (py - y1) * dy) / l2;
  t = Math.max(0, Math.min(1, t));
  const cx = x1 + t * dx;
  const cy = y1 + t * dy;
  return Math.hypot(px - cx, py - cy);
};

const resolveNearestWallId = (
  payload: GeometricReconstruction,
  position: [number, number],
  preferredFloor: number
): string | number | null => {
  const walls = payload?.walls || [];
  if (walls.length === 0) return null;
  const sameFloor = walls.filter((wall) => toFloorBucket(wall?.floor_level) === preferredFloor);
  const candidates = sameFloor.length > 0 ? sameFloor : walls;

  let best: { id: string | number; distance: number } | null = null;
  for (const wall of candidates) {
    const start = asPoint2D(wall?.start);
    const end = asPoint2D(wall?.end);
    if (!start || !end) continue;
    const distance = pointToSegmentDistance(position, start, end);
    if (!Number.isFinite(distance)) continue;
    if (!best || distance < best.distance) {
      best = { id: wall.id, distance };
    }
  }

  if (!best) return null;
  const tolerance = 1.2;
  return best.distance <= tolerance ? best.id : null;
};

const buildUniqueId = (existing: Set<string>, base: string): string => {
  let candidate = base;
  let idx = 1;
  while (existing.has(candidate)) {
    candidate = `${base}-${idx}`;
    idx += 1;
  }
  existing.add(candidate);
  return candidate;
};

const mergeOpeningsFromRecovery = (
  base: GeometricReconstruction,
  recovered: GeometricReconstruction
): GeometricReconstruction => {
  const wallIdSet = new Set((base?.walls || []).map((wall) => String(wall.id)));
  const doorIds = new Set((base?.doors || []).map((door) => String(door.id)));
  const windowIds = new Set((base?.windows || []).map((win) => String(win.id)));

  const mergedDoors = [...(base?.doors || [])];
  const mergedWindows = [...(base?.windows || [])];
  const seenDoorKeys = new Set(
    mergedDoors.map((door) => {
      const floor = toFloorBucket(door?.floor_level);
      const point = asPoint2D(door?.position) || [0, 0];
      const width = toFiniteScalar(door?.width) ?? 0;
      const height = toFiniteScalar(door?.height) ?? 0;
      return `${floor}|${String(door?.host_wall_id)}|${point[0].toFixed(2)}|${point[1].toFixed(2)}|${width.toFixed(2)}|${height.toFixed(2)}`;
    })
  );
  const seenWindowKeys = new Set(
    mergedWindows.map((win) => {
      const floor = toFloorBucket(win?.floor_level);
      const point = asPoint2D(win?.position) || [0, 0];
      const width = toFiniteScalar(win?.width) ?? 0;
      const sill = toFiniteScalar(win?.sill_height) ?? 0;
      return `${floor}|${String(win?.host_wall_id)}|${point[0].toFixed(2)}|${point[1].toFixed(2)}|${width.toFixed(2)}|${sill.toFixed(2)}`;
    })
  );

  for (const door of recovered?.doors || []) {
    const position = asPoint2D(door?.position);
    const width = toFiniteScalar(door?.width);
    const height = toFiniteScalar(door?.height);
    if (!position || width == null || height == null || width <= 0.2 || height <= 0.8) continue;

    const floorLevel = toFloorBucket(door?.floor_level);
    let hostWallId: string | number | null = null;
    if (door?.host_wall_id != null && wallIdSet.has(String(door.host_wall_id))) {
      hostWallId = door.host_wall_id;
    } else {
      hostWallId = resolveNearestWallId(base, position, floorLevel);
    }
    if (hostWallId == null) continue;

    const dedupeKey = `${floorLevel}|${String(hostWallId)}|${position[0].toFixed(2)}|${position[1].toFixed(2)}|${width.toFixed(2)}|${height.toFixed(2)}`;
    if (seenDoorKeys.has(dedupeKey)) continue;
    seenDoorKeys.add(dedupeKey);

    const preferredId = `recovery-door-${String(door.id ?? mergedDoors.length + 1)}`;
    const id = buildUniqueId(doorIds, preferredId);
    mergedDoors.push({
      ...door,
      id,
      host_wall_id: hostWallId,
      position,
      width,
      height,
      floor_level: floorLevel,
    });
  }

  for (const win of recovered?.windows || []) {
    const position = asPoint2D(win?.position);
    const width = toFiniteScalar(win?.width);
    const sillHeight = toFiniteScalar(win?.sill_height);
    if (!position || width == null || sillHeight == null || width <= 0.2 || sillHeight < 0) continue;

    const floorLevel = toFloorBucket(win?.floor_level);
    let hostWallId: string | number | null = null;
    if (win?.host_wall_id != null && wallIdSet.has(String(win.host_wall_id))) {
      hostWallId = win.host_wall_id;
    } else {
      hostWallId = resolveNearestWallId(base, position, floorLevel);
    }
    if (hostWallId == null) continue;

    const dedupeKey = `${floorLevel}|${String(hostWallId)}|${position[0].toFixed(2)}|${position[1].toFixed(2)}|${width.toFixed(2)}|${sillHeight.toFixed(2)}`;
    if (seenWindowKeys.has(dedupeKey)) continue;
    seenWindowKeys.add(dedupeKey);

    const preferredId = `recovery-window-${String(win.id ?? mergedWindows.length + 1)}`;
    const id = buildUniqueId(windowIds, preferredId);
    mergedWindows.push({
      ...win,
      id,
      host_wall_id: hostWallId,
      position,
      width,
      sill_height: sillHeight,
      floor_level: floorLevel,
    });
  }

  return {
    ...base,
    doors: mergedDoors,
    windows: mergedWindows,
  };
};

const shouldAttemptOpeningRecovery = (
  result: GeometricReconstruction,
  layoutHints: BlueprintLayoutHints | null
): boolean => {
  const floorSignals = estimateFloorHintCount(layoutHints);
  const inferredFloorCount = Math.max(1, estimateResultFloorCount(result));
  const walls = result?.walls?.length || 0;
  const rooms = result?.rooms?.length || 0;
  const openings = getOpeningCount(result);
  const openingsPerFloor = openings / inferredFloorCount;
  const roomsPerFloor = rooms / inferredFloorCount;

  if (Math.max(floorSignals, inferredFloorCount) < 2) return false;
  if (walls < 10 || rooms < 6) return false;
  if (openings >= Math.max(6, Math.round(walls * 0.45))) return false;

  return openingsPerFloor < Math.max(0.7, roomsPerFloor * 0.5);
};

const shouldAttemptInteriorLayoutRecovery = (
  result: GeometricReconstruction,
  layoutHints: BlueprintLayoutHints | null
): boolean => {
  const interiorSignal = analyzeInteriorLayoutSignal(result);
  if (!interiorSignal.placeholder) return false;

  const floorSignals = estimateFloorHintCount(layoutHints);
  const inferredFloorCount = Math.max(1, estimateResultFloorCount(result));
  const walls = result?.walls?.length || 0;
  const rooms = result?.rooms?.length || 0;
  if (walls < 8 || rooms < 5) return false;

  return Math.max(floorSignals, inferredFloorCount) >= 2 || interiorSignal.gridLikeFloors >= 1;
};

const shouldAttemptRoomDimensionRecovery = (
  result: GeometricReconstruction,
  layoutHints: BlueprintLayoutHints | null
): boolean => {
  const assessment = estimateRoomDimensionAlignment(layoutHints, result);
  if (!assessment.shouldRetry) return false;
  if (assessment.hintCount < 2) return false;
  if ((result?.rooms?.length || 0) < 2) return false;
  return true;
};

const buildConsensusRecoveryReasons = (
  result: GeometricReconstruction,
  layoutHints: BlueprintLayoutHints | null,
  score: number
): string[] => {
  const reasons = [...evaluateReconstructionFidelity(result, layoutHints).reasons];
  const openings = getOpeningCount(result);
  const walls = result?.walls?.length || 0;
  const rooms = result?.rooms?.length || 0;
  const floorSignals = estimateFloorHintCount(layoutHints);
  const floorCount = Math.max(1, estimateResultFloorCount(result));
  const interiorSignal = analyzeInteriorLayoutSignal(result);
  const dimensionAssessment = estimateRoomDimensionAlignment(layoutHints, result);

  if (score < VISION_CONSENSUS_MIN_SCORE) {
    reasons.push(`Current geometric density score ${score.toFixed(1)} is below quality target ${VISION_CONSENSUS_MIN_SCORE.toFixed(1)}.`);
  }
  if (openings === 0 && walls >= 10 && rooms >= 5) {
    reasons.push('Doors/windows are missing despite rich wall and room geometry; recover visible openings.');
  }
  if (floorSignals >= 2 && rooms < floorCount * 2) {
    reasons.push(`Multi-floor plan detected (${floorSignals} hints) but room density is low (${rooms} room(s) across ${floorCount} floor level(s)).`);
  }
  if (interiorSignal.placeholder) {
    reasons.push('Interior partitioning appears over-regularized; recover floor-specific interior walls and room polygons from visible line evidence.');
  }
  if (dimensionAssessment.shouldRetry) {
    reasons.push(`Room dimension anchors show ${dimensionAssessment.mismatches.length}/${dimensionAssessment.hintCount} size or position mismatches; align room polygons to annotated dimensions.`);
  }

  const unique = Array.from(new Set(reasons.map((reason) => reason.trim()).filter(Boolean)));
  return unique.slice(0, 6);
};

const shouldRunConsensusEnsemble = (
  result: GeometricReconstruction,
  layoutHints: BlueprintLayoutHints | null,
  score: number
): boolean => {
  if (VISION_CONSENSUS_RUNS <= 1) return false;
  const fidelity = evaluateReconstructionFidelity(result, layoutHints);
  if (fidelity.shouldRetry) return true;
  if (score < VISION_CONSENSUS_MIN_SCORE) return true;

  const openings = getOpeningCount(result);
  const rooms = result?.rooms?.length || 0;
  const walls = result?.walls?.length || 0;
  const inferredFloorCount = Math.max(1, estimateResultFloorCount(result));
  const openingsPerFloor = openings / inferredFloorCount;
  const roomsPerFloor = rooms / inferredFloorCount;

  if (walls >= 10 && rooms >= 6 && openingsPerFloor < Math.max(0.6, roomsPerFloor * 0.45)) {
    return true;
  }
  return false;
};

const countDirectionBuckets = (walls: GeometricReconstruction['walls']): number => {
  const directions = new Set<number>();
  for (const wall of walls || []) {
    const dx = Number(wall?.end?.[0] || 0) - Number(wall?.start?.[0] || 0);
    const dz = Number(wall?.end?.[1] || 0) - Number(wall?.start?.[1] || 0);
    const length = Math.hypot(dx, dz);
    if (length < 0.2) continue;
    const deg = Math.atan2(dz, dx) * (180 / Math.PI);
    const normalized = ((deg % 180) + 180) % 180;
    directions.add(Math.round(normalized / 15) * 15);
  }
  return directions.size;
};

const isLikelyRectangularFallback = (result: GeometricReconstruction): boolean => {
  const walls = result?.walls || [];
  const rooms = result?.rooms || [];
  if (walls.length < 4 || walls.length > 10) return false;

  const exteriorWalls = walls.filter((wall) => wall?.is_exterior !== false);
  if (exteriorWalls.length < 4 || exteriorWalls.length > 8) return false;

  const directionBuckets = countDirectionBuckets(exteriorWalls);
  if (directionBuckets > 2) return false;

  return rooms.length <= 1;
};

const evaluateReconstructionFidelity = (
  result: GeometricReconstruction,
  layoutHints: BlueprintLayoutHints | null
): FidelityAssessment => {
  const reasons = new Set<string>();
  const wallCount = result?.walls?.length || 0;
  const roomCount = result?.rooms?.length || 0;
  const dimensionSignals = layoutHints?.dimensionAnchors?.length || 0;
  const ocrLineSignals = layoutHints?.linePolygons?.length || 0;
  const floorSignals = estimateFloorHintCount(layoutHints);
  const inferredFloorCount = estimateResultFloorCount(result);
  const scaleConfidence = toFiniteScalar(result?.meta?.scale_confidence);
  const topology = result?.topology_checks;
  const requiredSemanticMentions = extractRequiredSemanticMentionKeys(layoutHints);
  const missingSemanticMentions = getMissingSemanticMentionKeys(requiredSemanticMentions, result);
  const stairsRecovered = hasSemanticMentionKey(result, 'stairs');
  const interiorSignal = analyzeInteriorLayoutSignal(result);
  const dimensionAssessment = estimateRoomDimensionAlignment(layoutHints, result);

  if (wallCount <= 3) {
    reasons.add(`Only ${wallCount} wall segment(s) were produced, which is structurally incomplete.`);
  }
  if (dimensionSignals >= 5 && wallCount <= 8) {
    reasons.add(`Blueprint exposes ${dimensionSignals} dimension anchors but reconstruction has only ${wallCount} walls.`);
  }
  if (dimensionSignals >= 8 && roomCount <= 1) {
    reasons.add(`Dimension-rich blueprint (${dimensionSignals} anchors) collapsed to ${roomCount} room(s).`);
  }
  if (dimensionSignals >= 4 && roomCount === 0) {
    reasons.add('No room polygons were produced despite measurable blueprint annotations.');
  }
  if (floorSignals >= 2 && inferredFloorCount <= 1) {
    reasons.add(`Floor labels indicate multi-level drawing (${floorSignals} signals) but output floor_count is ${inferredFloorCount}.`);
  }
  if (floorSignals >= 2 && isLikelySparseMultiFloorShell(result, floorSignals)) {
    reasons.add('Multi-floor hints detected, but each floor collapsed to sparse outer-shell geometry without interior partitions.');
  }
  if (floorSignals >= 3 && roomCount <= floorSignals) {
    reasons.add(`Detected ${floorSignals} floor hints but only ${roomCount} room polygon(s) across all floors.`);
  }
  if (floorSignals >= 2 && inferredFloorCount >= 2 && roomCount >= 4 && !stairsRecovered) {
    reasons.add('Multi-floor geometry is present but staircase/vertical-circulation semantics are still missing.');
  }
  if (missingSemanticMentions.length > 0) {
    reasons.add(
      `Blueprint labels indicate ${describeSemanticMentionKeys(missingSemanticMentions).join(', ')} but these semantic spaces are missing in the reconstruction.`
    );
  }
  if (dimensionSignals >= 5 && (scaleConfidence == null || scaleConfidence < 0.3)) {
    reasons.add('Scale confidence remained too low despite visible dimension anchors.');
  }
  if (isLikelyRectangularFallback(result) && (dimensionSignals >= 4 || ocrLineSignals >= 70)) {
    reasons.add('Model appears collapsed to a simple rectangular shell despite richer blueprint evidence.');
  }
  if (interiorSignal.placeholder) {
    reasons.add('Interior partitioning appears over-regularized (repeating grid-like rooms), suggesting placeholder geometry instead of true room boundary extraction.');
  }
  if (dimensionAssessment.shouldRetry) {
    reasons.add(
      `Room dimension anchors mismatch (${dimensionAssessment.mismatches.length}/${dimensionAssessment.hintCount}); room sizes/positions are not aligned with annotated measurements.`
    );
  }

  if (topology?.closed_wall_loops === false) {
    reasons.add('Topology check reports open wall loops.');
  }
  if ((topology?.dangling_walls ?? 0) > 2) {
    reasons.add(`Topology check reports ${topology?.dangling_walls} dangling walls.`);
  }
  if ((topology?.unhosted_openings ?? 0) > 0) {
    reasons.add(`Topology check reports ${topology?.unhosted_openings} unhosted openings.`);
  }
  if (topology?.room_polygon_validity_pass === false) {
    reasons.add('Topology check reports invalid room polygon(s).');
  }

  const highSeverityConflicts = (result?.conflicts || []).filter((conflict) => conflict?.severity === 'high').length;
  if (highSeverityConflicts >= 3) {
    reasons.add(`Output still carries ${highSeverityConflicts} high-severity conflicts.`);
  }

  const selectedReasons = Array.from(reasons).slice(0, 5);
  return {
    shouldRetry: selectedReasons.length > 0,
    reasons: selectedReasons,
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

const inferRoofFromWallFootprint = (payload: GeometricReconstruction): GeometricReconstruction => {
  if (payload.roof || !Array.isArray(payload.walls) || payload.walls.length < 3) {
    return payload;
  }

  const exteriorWalls = payload.walls.filter((w) => w?.is_exterior);
  const sourceWalls = exteriorWalls.length >= 3 ? exteriorWalls : payload.walls;
  const footprintPoints = dedupe2DPoints(
    sourceWalls.flatMap((wall) => [wall.start, wall.end]).filter((pt): pt is [number, number] => Array.isArray(pt) && pt.length >= 2)
  );
  if (footprintPoints.length < 3) return payload;

  let polygon =
    extractConcaveBoundaryFromWalls(sourceWalls.map((wall) => ({ start: wall.start, end: wall.end }))) ||
    convexHull(footprintPoints);
  if (polygon.length < 3) return payload;
  if (polygonArea(polygon) < 0) {
    polygon = [...polygon].reverse();
  }

  const area = Math.abs(polygonArea(polygon));
  if (area < 4) return payload;

  const maxWallHeight = Math.max(...payload.walls.map((w) => Number(w?.height || 2.8)));
  const nextConflicts = [...(payload.conflicts || [])];
  nextConflicts.push({
    type: 'code',
    severity: 'low',
    description: 'Roof was inferred deterministically from outer wall footprint.',
    location: polygon[0],
  });

  return {
    ...payload,
    roof: {
      type: 'flat',
      polygon,
      height: 1.2,
      base_height: Number(maxWallHeight.toFixed(2)),
      color: '#a0522d',
    },
    conflicts: nextConflicts,
  };
};

const pointDistance = (a: [number, number], b: [number, number]) => Math.hypot(a[0] - b[0], a[1] - b[1]);

const closestPointOnSegment = (
  point: [number, number],
  start: [number, number],
  end: [number, number]
): { point: [number, number]; t: number; distance: number } => {
  const sx = start[0];
  const sz = start[1];
  const ex = end[0];
  const ez = end[1];
  const vx = ex - sx;
  const vz = ez - sz;
  const lenSq = vx * vx + vz * vz;
  if (lenSq < 1e-9) {
    const d = pointDistance(point, start);
    return { point: start, t: 0, distance: d };
  }
  const tRaw = ((point[0] - sx) * vx + (point[1] - sz) * vz) / lenSq;
  const t = Math.max(0, Math.min(1, tRaw));
  const projected: [number, number] = [sx + vx * t, sz + vz * t];
  return { point: projected, t, distance: pointDistance(point, projected) };
};

const clampNumber = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

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

    const ux = dx / length;
    const uz = dz / length;
    const startKey = pointKey(snapPoint(wall.start, tolerance));
    const endKey = pointKey(snapPoint(wall.end, tolerance));

    pushEndpoint(startKey, {
      wallIndex: idx,
      atStart: true,
      directionAway: [ux, uz],
      length,
      thickness: Math.max(0.08, Number(wall.thickness || 0.115)),
    });
    pushEndpoint(endKey, {
      wallIndex: idx,
      atStart: false,
      directionAway: [-ux, -uz],
      length,
      thickness: Math.max(0.08, Number(wall.thickness || 0.115)),
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
  const DEFAULT_WINDOW_HEIGHT = 1.2;

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
      const center = clampNumber((px - sx) * ux + (pz - sz) * uz, 0, length);
      const halfWidth = Math.max(0.25, Number(door.width || 0.9) / 2);
      const doorHeight = clampNumber(Number(door.height || 2.1), 0, wallHeight);
      pushCut(center - halfWidth, center + halfWidth, 0, doorHeight);
    }

    for (const win of wallWindows) {
      const px = Number(win.position[0]);
      const pz = Number(win.position[1]);
      if (!Number.isFinite(px) || !Number.isFinite(pz)) continue;
      const center = clampNumber((px - sx) * ux + (pz - sz) * uz, 0, length);
      const halfWidth = Math.max(0.2, Number(win.width || 1) / 2);
      const sill = clampNumber(Number(win.sill_height || 0.9), 0, wallHeight);
      const head = clampNumber(sill + DEFAULT_WINDOW_HEIGHT, 0, wallHeight);
      pushCut(center - halfWidth, center + halfWidth, sill, head);
    }

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
        thickness: Number(wall.thickness || 0.115),
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
  if (!Array.isArray(payload?.walls) || payload.walls.length === 0) return payload;

  const toFloorLevel = (value: unknown): number => {
    const n = Number(value);
    return Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0;
  };

  const floorLevels = Array.from(new Set(payload.walls.map((wall) => toFloorLevel(wall.floor_level))));
  if (floorLevels.length > 1) {
    const orderedLevels = [...floorLevels].sort((a, b) => a - b);
    const mergedWalls: GeometricReconstruction['walls'] = [];
    const mergedDoors: GeometricReconstruction['doors'] = [];
    const mergedWindows: GeometricReconstruction['windows'] = [];
    const mergedRooms: GeometricReconstruction['rooms'] = [];
    const mergedFurnitures: GeometricReconstruction['furnitures'] = [];
    const mergedWallSolids: GeometricReconstruction['walls'] = [];
    const mergedConflicts: GeometricReconstruction['conflicts'] = [...(payload.conflicts || [])];

    for (const level of orderedLevels) {
      const floorWalls = payload.walls.filter((wall) => toFloorLevel(wall.floor_level) === level);
      if (floorWalls.length === 0) continue;

      const floorPayload: GeometricReconstruction = {
        ...payload,
        walls: floorWalls,
        doors: (payload.doors || []).filter((door) => toFloorLevel(door.floor_level) === level),
        windows: (payload.windows || []).filter((win) => toFloorLevel(win.floor_level) === level),
        rooms: (payload.rooms || []).filter((room) => toFloorLevel(room.floor_level) === level),
        furnitures: (payload.furnitures || []).filter((item) => toFloorLevel(item.floor_level) === level),
        wallSolids: undefined,
        roof: undefined,
        conflicts: [],
      };

      const floorNormalized = normalizeReconstructionGeometry(floorPayload);
      mergedWalls.push(...(floorNormalized.walls || []));
      mergedDoors.push(...(floorNormalized.doors || []));
      mergedWindows.push(...(floorNormalized.windows || []));
      mergedRooms.push(...(floorNormalized.rooms || []));
      mergedFurnitures.push(...(floorNormalized.furnitures || []));
      mergedWallSolids.push(...(floorNormalized.wallSolids || []));
      mergedConflicts.push(...(floorNormalized.conflicts || []));
    }

    return {
      ...payload,
      walls: mergedWalls,
      wallSolids: mergedWallSolids.length > 0 ? mergedWallSolids : undefined,
      doors: mergedDoors,
      windows: mergedWindows,
      rooms: mergedRooms,
      furnitures: mergedFurnitures,
      conflicts: mergedConflicts,
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

    normalizedWalls.push({
      ...wall,
      start,
      end,
      thickness: Math.max(0.08, Number(wall.thickness || (wall.is_exterior ? 0.23 : 0.115))),
      height: Math.max(2.2, Number(wall.height || 2.8)),
    });
  }

  if (normalizedWalls.length === 0) return payload;
  const miterResult = applyWallMiterJoins(normalizedWalls, snapTolerance);
  const finalizedWalls = miterResult.walls;
  if (finalizedWalls.length === 0) return payload;

  const findNearestWallId = (position: [number, number]): string | number | null => {
    let nearest: { id: string | number; distance: number } | null = null;
    for (const wall of finalizedWalls) {
      const projected = closestPointOnSegment(position, wall.start, wall.end);
      if (!nearest || projected.distance < nearest.distance) {
        nearest = { id: wall.id, distance: projected.distance };
      }
    }
    return nearest?.id ?? null;
  };

  const wallIdSet = new Set(finalizedWalls.map((wall) => String(wall.id)));

  const normalizedDoors = (payload.doors || []).map((door) => {
    const hostKnown = wallIdSet.has(String(door.host_wall_id));
    const fallbackHost = findNearestWallId(door.position);
    return {
      ...door,
      host_wall_id: hostKnown ? door.host_wall_id : (fallbackHost ?? door.host_wall_id),
      width: Math.max(0.75, Number(door.width || 0.9)),
      height: Math.max(2.0, Number(door.height || 2.1)),
    };
  });

  const normalizedWindows = (payload.windows || []).map((win) => {
    const hostKnown = wallIdSet.has(String(win.host_wall_id));
    const fallbackHost = findNearestWallId(win.position);
    return {
      ...win,
      host_wall_id: hostKnown ? win.host_wall_id : (fallbackHost ?? win.host_wall_id),
      width: Math.max(0.5, Number(win.width || 1)),
      sill_height: Math.max(0.6, Number(win.sill_height || 0.9)),
    };
  });

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

  const normalizedFurnitures = (payload.furnitures || []).map((item) => {
    const initialPos: [number, number] = [Number(item.position[0]), Number(item.position[1])];
    let best: { wallStart: [number, number]; wallEnd: [number, number]; closest: [number, number]; distance: number } | null = null;
    for (const wall of finalizedWalls) {
      const projected = closestPointOnSegment(initialPos, wall.start, wall.end);
      if (!best || projected.distance < best.distance) {
        best = { wallStart: wall.start, wallEnd: wall.end, closest: projected.point, distance: projected.distance };
      }
    }

    if (!best) return item;
    const clearance = Math.max(0.25, Math.min(0.9, Math.max(Number(item.width || 0.6), Number(item.depth || 0.6)) * 0.35));
    if (best.distance >= clearance) return item;

    let nx = initialPos[0] - best.closest[0];
    let nz = initialPos[1] - best.closest[1];
    const nLen = Math.hypot(nx, nz);
    if (nLen < 1e-6) {
      const wx = best.wallEnd[0] - best.wallStart[0];
      const wz = best.wallEnd[1] - best.wallStart[1];
      const wLen = Math.hypot(wx, wz) || 1;
      nx = -wz / wLen;
      nz = wx / wLen;
    } else {
      nx /= nLen;
      nz /= nLen;
    }

    const delta = clearance - best.distance + 0.02;
    return {
      ...item,
      position: [
        Number((initialPos[0] + nx * delta).toFixed(3)),
        Number((initialPos[1] + nz * delta).toFixed(3)),
      ] as [number, number],
    };
  });

  const wallSolids = buildServerCutWallSolids(finalizedWalls, normalizedDoors, normalizedWindows);

  const normalized: GeometricReconstruction = {
    ...payload,
    walls: finalizedWalls,
    wallSolids: wallSolids.length > 0 ? wallSolids : undefined,
    doors: normalizedDoors,
    windows: normalizedWindows,
    rooms: normalizedRooms,
    furnitures: normalizedFurnitures,
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
  for (const entry of [...(azureHints?.lineTexts || []), ...(localHints?.lineTexts || [])]) {
    const text = String(entry || '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const key = text.toLowerCase();
    if (lineTextSeen.has(key)) continue;
    lineTextSeen.add(key);
    mergedLineTexts.push(text.slice(0, 160));
    if (mergedLineTexts.length >= LAYOUT_LINE_TEXT_LIMIT) break;
  }

  const floorSeen = new Set<string>();
  const mergedFloorLabels: Array<{ text: string; polygon: number[]; }> = [];
  for (const anchor of [...(azureHints?.floorLabelAnchors || []), ...(localHints?.floorLabelAnchors || [])]) {
    const text = String(anchor?.text || '').replace(/\s+/g, ' ').trim();
    const polygon = Array.isArray(anchor?.polygon) ? anchor.polygon.map((v) => Number(v.toFixed(2))) : [];
    if (!text || polygon.length < 6) continue;
    const key = `${text.toLowerCase()}|${polygon.join(',')}`;
    if (floorSeen.has(key)) continue;
    floorSeen.add(key);
    mergedFloorLabels.push({ text: text.slice(0, 96), polygon });
    if (mergedFloorLabels.length >= LAYOUT_FLOOR_LABEL_LIMIT) break;
  }

  const basePages = (azureHints?.pages?.length || 0) > 0 ? azureHints?.pages : localHints?.pages;
  return {
    pageCount: Math.max(localHints?.pageCount || 0, azureHints?.pageCount || 0, basePages?.length || 0),
    pages: basePages || [],
    linePolygons: mergedLinePolygons,
    dimensionAnchors: mergedAnchors,
    lineTexts: mergedLineTexts,
    floorLabelAnchors: mergedFloorLabels,
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
    const lineTextSeen = new Set<string>();

    for (const line of lines) {
      if (linePolygons.length >= LAYOUT_POLYGON_LIMIT) break;
      const polygon = readPolygonFromBoundingBox(line?.bbox);
      if (polygon.length >= 6) {
        linePolygons.push(polygon);
      }

      const text = String(line?.text || '').replace(/\s+/g, ' ').trim();
      if (text && lineTexts.length < LAYOUT_LINE_TEXT_LIMIT) {
        const key = text.toLowerCase();
        if (!lineTextSeen.has(key)) {
          lineTextSeen.add(key);
          lineTexts.push(text.slice(0, 160));
        }
      }
      if (text && LAYOUT_DIMENSION_REGEX.test(text) && dimensionAnchors.length < LAYOUT_DIMENSION_ANCHOR_LIMIT) {
        if (polygon.length >= 6) {
          dimensionAnchors.push({ text, polygon });
        }
      }
      if (text && LAYOUT_FLOOR_LABEL_REGEX.test(text) && floorLabelAnchors.length < LAYOUT_FLOOR_LABEL_LIMIT) {
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
        if (text && LAYOUT_DIMENSION_REGEX.test(text) && dimensionAnchors.length < LAYOUT_DIMENSION_ANCHOR_LIMIT) {
          if (polygon.length >= 6) {
            dimensionAnchors.push({ text, polygon });
          }
        }
        if (text && LAYOUT_FLOOR_LABEL_REGEX.test(text) && floorLabelAnchors.length < LAYOUT_FLOOR_LABEL_LIMIT) {
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
      lineTexts: lineTexts.length,
      floorLabelAnchors: floorLabelAnchors.length,
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

type FloorCropPlan = {
  label: string;
  level: number;
  top: number;
  height: number;
};

const polygonToBoundingBox = (polygon: number[] | null | undefined): [number, number, number, number] | null => {
  if (!Array.isArray(polygon) || polygon.length < 6) return null;
  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = 0; i < polygon.length - 1; i += 2) {
    const x = Number(polygon[i]);
    const y = Number(polygon[i + 1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    xs.push(x);
    ys.push(y);
  }
  if (xs.length === 0 || ys.length === 0) return null;
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
};

const resolveHintImageSize = (
  layoutHints: BlueprintLayoutHints | null,
  fallbackWidth = 0,
  fallbackHeight = 0
): { width: number; height: number } => {
  const width = Number(fallbackWidth);
  const height = Number(fallbackHeight);
  if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
    return { width: Math.round(width), height: Math.round(height) };
  }

  const page = layoutHints?.pages?.[0];
  const pageWidth = Number(page?.width || 0);
  const pageHeight = Number(page?.height || 0);
  if (Number.isFinite(pageWidth) && Number.isFinite(pageHeight) && pageWidth > 0 && pageHeight > 0) {
    return { width: Math.round(pageWidth), height: Math.round(pageHeight) };
  }

  return { width: 0, height: 0 };
};

const floorLabelToLevel = (label: string, fallback: number): number => {
  const text = String(label || '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (!text) return fallback;
  if (/\b(basement|cellar|lower\s*ground|stilt|ground)\b/.test(text)) return 0;
  if (/\bfirst\b/.test(text)) return 1;
  if (/\bsecond\b/.test(text)) return 2;
  if (/\bthird\b/.test(text)) return 3;
  if (/\bfourth\b/.test(text)) return 4;
  if (/\bfifth\b/.test(text)) return 5;

  const numeric = text.match(/\b(?:level|lvl|floor|flr)\s*[-_:]?\s*(\d{1,2})\b/);
  if (numeric?.[1]) {
    const parsed = Number(numeric[1]);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return fallback;
};

const deriveFloorCropPlans = (
  layoutHints: BlueprintLayoutHints | null,
  imageWidth: number,
  imageHeight: number
): FloorCropPlan[] => {
  if (!layoutHints || imageWidth <= 0 || imageHeight <= 0) return [];

  const anchors = (layoutHints.floorLabelAnchors || [])
    .map((anchor, index) => {
      const bbox = polygonToBoundingBox(anchor?.polygon || []);
      if (!bbox) return null;
      const [, y0, , y1] = bbox;
      const cy = (y0 + y1) / 2;
      return {
        text: String(anchor?.text || '').trim(),
        centerY: cy,
        level: floorLabelToLevel(String(anchor?.text || ''), index),
      };
    })
    .filter((entry): entry is NonNullable<typeof entry> =>
      !!entry &&
      Number.isFinite(entry.centerY) &&
      entry.centerY >= 0 &&
      entry.centerY <= imageHeight
    )
    .sort((a, b) => a.centerY - b.centerY);

  if (anchors.length < 2) return [];

  const deduped: typeof anchors = [];
  const minGap = Math.max(40, imageHeight * 0.06);
  for (const anchor of anchors) {
    const last = deduped[deduped.length - 1];
    if (!last || Math.abs(anchor.centerY - last.centerY) > minGap) {
      deduped.push(anchor);
      continue;
    }
    if ((anchor.text || '').length > (last.text || '').length) {
      deduped[deduped.length - 1] = anchor;
    }
  }

  if (deduped.length < 2) return [];

  const plans: FloorCropPlan[] = [];
  const usedLevels = new Set<number>();
  for (let i = 0; i < deduped.length; i += 1) {
    const current = deduped[i];
    const prev = deduped[i - 1];
    const next = deduped[i + 1];
    const top = i === 0 ? 0 : Math.max(0, Math.round((prev.centerY + current.centerY) / 2));
    const bottom = i === deduped.length - 1
      ? imageHeight
      : Math.min(imageHeight, Math.round((current.centerY + next.centerY) / 2));
    const bandHeight = bottom - top;
    if (bandHeight < Math.max(120, imageHeight * 0.14)) continue;

    let level = Number.isFinite(current.level) ? current.level : i;
    while (usedLevels.has(level)) level += 1;
    usedLevels.add(level);

    plans.push({
      label: current.text || `Floor ${level}`,
      level,
      top,
      height: bandHeight,
    });
  }

  return plans.slice(0, 6);
};

async function cropImageBand(base64Image: string, top: number, height: number): Promise<string | null> {
  if (sharpUnsupported) return null;

  try {
    const sharpModule = await dynamicImport('sharp');
    const sharp = sharpModule?.default ?? sharpModule;
    if (typeof sharp !== 'function') {
      throw new Error('Sharp module is invalid.');
    }

    const inputBuffer = Buffer.from(stripDataUrl(base64Image), 'base64');
    if (!inputBuffer.length) return null;
    const instance = sharp(inputBuffer, { limitInputPixels: false }).rotate();
    const metadata = await instance.metadata();
    const width = Number(metadata?.width || 0);
    const imageHeight = Number(metadata?.height || 0);
    if (width <= 0 || imageHeight <= 0) return null;

    const safeTop = Math.max(0, Math.min(imageHeight - 1, Math.floor(top)));
    const maxHeight = imageHeight - safeTop;
    const safeHeight = Math.max(1, Math.min(maxHeight, Math.floor(height)));
    if (safeHeight < Math.max(96, imageHeight * 0.12)) return null;

    const cropped = await sharp(inputBuffer, { limitInputPixels: false })
      .rotate()
      .extract({ left: 0, top: safeTop, width, height: safeHeight })
      .png({ compressionLevel: 9 })
      .toBuffer();
    return ensureDataUrlPng(cropped.toString('base64'));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (isModuleImportError(message)) {
      sharpUnsupported = true;
      if (!sharpWarned) {
        sharpWarned = true;
        console.warn('[Infralith Vision Engine] Sharp not installed. Multi-floor crop decomposition disabled.');
      }
      return null;
    }
    return null;
  }
}

const remapFloorLevelAndIds = (
  payload: GeometricReconstruction,
  targetLevel: number,
  prefix: string
): GeometricReconstruction => {
  const wallIdMap = new Map<string, string>();
  const roomIdMap = new Map<string, string>();
  const walls = (payload.walls || []).map((wall) => {
    const nextId = `${prefix}w-${String(wall.id)}`;
    wallIdMap.set(String(wall.id), nextId);
    return {
      ...wall,
      id: nextId,
      floor_level: targetLevel,
    };
  });

  const rooms = (payload.rooms || []).map((room) => {
    const nextId = `${prefix}r-${String(room.id)}`;
    roomIdMap.set(String(room.id), nextId);
    return {
      ...room,
      id: nextId,
      floor_level: targetLevel,
    };
  });

  const doors = (payload.doors || []).map((door) => ({
    ...door,
    id: `${prefix}d-${String(door.id)}`,
    host_wall_id: wallIdMap.get(String(door.host_wall_id)) || `${prefix}w-${String(door.host_wall_id)}`,
    floor_level: targetLevel,
  }));

  const windows = (payload.windows || []).map((win) => ({
    ...win,
    id: `${prefix}win-${String(win.id)}`,
    host_wall_id: wallIdMap.get(String(win.host_wall_id)) || `${prefix}w-${String(win.host_wall_id)}`,
    floor_level: targetLevel,
  }));

  const furnitures = (payload.furnitures || []).map((item) => ({
    ...item,
    id: `${prefix}f-${String(item.id)}`,
    room_id: item.room_id != null
      ? (roomIdMap.get(String(item.room_id)) || `${prefix}r-${String(item.room_id)}`)
      : item.room_id,
    floor_level: targetLevel,
  }));

  const wallSolids = (payload.wallSolids || []).map((solid) => ({
    ...solid,
    id: `${prefix}ws-${String(solid.id)}`,
    source_wall_id: solid.source_wall_id != null
      ? (wallIdMap.get(String(solid.source_wall_id)) || `${prefix}w-${String(solid.source_wall_id)}`)
      : solid.source_wall_id,
    floor_level: targetLevel,
  }));

  return {
    ...payload,
    walls,
    wallSolids,
    rooms,
    doors,
    windows,
    furnitures,
    roof: undefined,
    conflicts: (payload.conflicts || []).map((conflict) => ({
      ...conflict,
      description: `[floor:${targetLevel}] ${conflict.description}`,
    })),
    meta: {
      ...payload.meta,
      floor_count: 1,
    },
  };
};

const combineFloorReconstructions = (
  floorResults: Array<{ level: number; label: string; payload: GeometricReconstruction }>
): GeometricReconstruction | null => {
  if (floorResults.length === 0) return null;
  const ordered = [...floorResults].sort((a, b) => a.level - b.level);
  const first = ordered[0].payload;
  const maxLevel = Math.max(...ordered.map((item) => item.level));

  const combined: GeometricReconstruction = {
    ...first,
    meta: {
      ...(first.meta || {}),
      floor_count: Math.max(1, maxLevel + 1),
    },
    walls: [],
    wallSolids: [],
    doors: [],
    windows: [],
    rooms: [],
    furnitures: [],
    roof: undefined,
    topology_checks: undefined,
    conflicts: [],
  };

  for (const entry of ordered) {
    const prefix = `fl${entry.level}-`;
    const remapped = remapFloorLevelAndIds(entry.payload, entry.level, prefix);
    combined.walls.push(...(remapped.walls || []));
    combined.wallSolids?.push(...(remapped.wallSolids || []));
    combined.doors.push(...(remapped.doors || []));
    combined.windows.push(...(remapped.windows || []));
    combined.rooms.push(...(remapped.rooms || []));
    combined.furnitures?.push(...(remapped.furnitures || []));
    combined.conflicts.push(...(remapped.conflicts || []));
  }

  if ((combined.wallSolids || []).length === 0) {
    combined.wallSolids = undefined;
  }

  return combined;
};

async function attemptSegmentedMultiFloorReconstruction(
  basePrompt: string,
  structuralImage: string,
  fallbackImage: string,
  layoutHints: BlueprintLayoutHints | null,
  widthHint: number,
  heightHint: number,
  traceId: string
): Promise<GeometricReconstruction | null> {
  const { width, height } = resolveHintImageSize(layoutHints, widthHint, heightHint);
  const plans = deriveFloorCropPlans(layoutHints, width, height);
  if (plans.length < 2) return null;

  traceLog('Infralith Vision Engine', traceId, '4/9', 'attempting segmented multi-floor reconstruction', {
    plannedBands: plans.length,
    plans: plans.map((plan) => ({ level: plan.level, label: plan.label, top: plan.top, height: plan.height })),
  }, 'warn');

  const floorResults: Array<{ level: number; label: string; payload: GeometricReconstruction }> = [];
  const decompositionConflicts: GeometricReconstruction['conflicts'] = [];

  for (const plan of plans) {
    const cropped =
      (await cropImageBand(structuralImage, plan.top, plan.height)) ||
      (await cropImageBand(fallbackImage, plan.top, plan.height));
    if (!cropped) {
      decompositionConflicts.push({
        type: 'structural',
        severity: 'medium',
        description: `Unable to crop floor band for label "${plan.label}".`,
        location: [0, 0],
      });
      continue;
    }

    const floorPrompt = `${basePrompt}

FLOOR-FOCUSED EXTRACTION OVERRIDE:
- This image is a crop associated with label "${plan.label}".
- Reconstruct only this single floor plan from this cropped image.
- Set all returned floor_level values to 0 in this response.
- Do not mix geometry from other floors outside this crop.
`;

    try {
      let floorResult = await generateAzureVisionObject<GeometricReconstruction>(floorPrompt, cropped);
      const floorFidelity = evaluateReconstructionFidelity(floorResult, null);
      if (floorFidelity.shouldRetry && (floorResult?.walls?.length || 0) < 8) {
        const strictFloorPrompt = buildBlueprintRetryPrompt(floorPrompt, floorFidelity.reasons);
        floorResult = await generateAzureVisionObject<GeometricReconstruction>(strictFloorPrompt, cropped);
      }

      if (!hasNonEmptyWalls(floorResult)) {
        decompositionConflicts.push({
          type: 'structural',
          severity: 'high',
          description: `No wall geometry detected for floor label "${plan.label}" during segmented reconstruction.`,
          location: [0, 0],
        });
        continue;
      }

      floorResults.push({
        level: plan.level,
        label: plan.label,
        payload: normalizeReconstructionGeometry(floorResult),
      });
    } catch (error) {
      decompositionConflicts.push({
        type: 'structural',
        severity: 'high',
        description: `Segmented reconstruction failed for "${plan.label}": ${error instanceof Error ? error.message : String(error)}`,
        location: [0, 0],
      });
    }
  }

  if (floorResults.length < 2) return null;
  const combined = combineFloorReconstructions(floorResults);
  if (!combined) return null;
  combined.conflicts = [...(combined.conflicts || []), ...decompositionConflicts];
  traceLog('Infralith Vision Engine', traceId, '5/9', 'segmented multi-floor reconstruction assembled', summarizeReconstruction(combined));
  return combined;
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
      thickness: nearBoundary ? 0.23 : 0.115,
      height: 2.8,
      color: nearBoundary ? '#f5e6d3' : '#faf7f2',
      is_exterior: nearBoundary,
      floor_level: 0,
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
      floor_color: '#e8d5b7',
      floor_level: 0,
    });
    roomCounter++;
    if (rooms.length >= 150) break;
  }

  const dxfDebugImage = await renderDxfPreviewCanvas(walls, traceId);

  const reconstruction: GeometricReconstruction = {
    building_name: 'DXF Reconstruction',
    exterior_color: '#f5e6d3',
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
  const requiredSemanticMentions = extractRequiredSemanticMentionKeys(layoutHints);
  if (requiredSemanticMentions.length > 0) {
    traceLog('Infralith Vision Engine', traceId, '1/9', 'semantic anchors detected from blueprint text', {
      requiredSemanticMentions: describeSemanticMentionKeys(requiredSemanticMentions),
      count: requiredSemanticMentions.length,
    }, 'warn');
  }
  // STAGE 2: Send image + layout hints to the AI Vision model
  const prompt = buildBlueprintVisionPrompt(layoutHints);
  try {
    traceLog('Infralith Vision Engine', traceId, '2/9', 'sending blueprint + hints to Azure Vision');
    let result = await generateAzureVisionObject<GeometricReconstruction>(prompt, structuralInputImage);
    traceLog('Infralith Vision Engine', traceId, '3/9', 'AI reconstruction received', summarizeReconstruction(result));

    let bestResult = result;
    let bestScore = scoreReconstructionDensity(result, layoutHints);
    let bestOpenings = getOpeningCount(result);
    let bestCandidateLabel = 'initial';
    let bestHighSeverityConflicts = (result?.conflicts || []).filter((conflict) => conflict?.severity === 'high').length;
    let bestFidelity = evaluateReconstructionFidelity(result, layoutHints);
    let bestMissingSemanticMentions = getMissingSemanticMentionKeys(requiredSemanticMentions, result).length;

    const promoteBestCandidate = (
      candidate: GeometricReconstruction | null | undefined,
      label: string,
      options?: {
        minScoreGain?: number;
        allowOpeningBoost?: boolean;
        allowFidelityBoost?: boolean;
        allowConflictBoost?: boolean;
        allowSemanticBoost?: boolean;
      }
    ) => {
      if (!hasNonEmptyWalls(candidate)) return false;
      const minScoreGain = options?.minScoreGain ?? 2;
      const allowOpeningBoost = options?.allowOpeningBoost ?? true;
      const allowFidelityBoost = options?.allowFidelityBoost ?? true;
      const allowConflictBoost = options?.allowConflictBoost ?? true;
      const allowSemanticBoost = options?.allowSemanticBoost ?? true;

      const candidateScore = scoreReconstructionDensity(candidate, layoutHints);
      const candidateOpenings = getOpeningCount(candidate);
      const candidateFidelity = evaluateReconstructionFidelity(candidate, layoutHints);
      const candidateHighSeverityConflicts = (candidate?.conflicts || []).filter((conflict) => conflict?.severity === 'high').length;
      const candidateMissingSemanticMentions = getMissingSemanticMentionKeys(requiredSemanticMentions, candidate).length;
      const candidateRooms = candidate?.rooms?.length || 0;
      const candidateWalls = candidate?.walls?.length || 0;
      const bestRooms = bestResult?.rooms?.length || 0;
      const bestWalls = bestResult?.walls?.length || 0;

      const scoreImproved = candidateScore > bestScore + minScoreGain;
      const openingImproved =
        allowOpeningBoost &&
        candidateScore >= bestScore - 1 &&
        candidateOpenings > bestOpenings + 2;
      const fidelityImproved =
        allowFidelityBoost &&
        candidateFidelity.reasons.length + 1 < bestFidelity.reasons.length &&
        candidateScore >= bestScore - 1;
      const conflictImproved =
        allowConflictBoost &&
        candidateHighSeverityConflicts + 1 < bestHighSeverityConflicts &&
        candidateScore >= bestScore - 0.75;
      const semanticImproved =
        allowSemanticBoost &&
        candidateMissingSemanticMentions + 1 < bestMissingSemanticMentions &&
        candidateScore >= bestScore - 2;
      const structuralDetailImproved =
        candidateScore >= bestScore - 0.5 &&
        (candidateRooms > bestRooms + 2 || candidateWalls > bestWalls + 4);

      if (!(scoreImproved || openingImproved || fidelityImproved || conflictImproved || semanticImproved || structuralDetailImproved)) {
        return false;
      }

      bestResult = candidate;
      bestScore = candidateScore;
      bestOpenings = candidateOpenings;
      bestFidelity = candidateFidelity;
      bestHighSeverityConflicts = candidateHighSeverityConflicts;
      bestMissingSemanticMentions = candidateMissingSemanticMentions;
      bestCandidateLabel = label;
      return true;
    };

    const maxRetries = 2;
    let retryCount = 0;
    let fidelity = bestFidelity;
    while (fidelity.shouldRetry && retryCount < maxRetries) {
      retryCount += 1;
      const retryImage = retryCount % 2 === 1 ? imageUrl : structuralInputImage;
      const strictPrompt = buildBlueprintRetryPrompt(prompt, fidelity.reasons);
      traceLog('Infralith Vision Engine', traceId, '4/9', 'underfit detected, retrying with stricter constraints', {
        retryCount,
        maxRetries,
        imageVariant: retryImage === imageUrl ? 'original' : 'preprocessed',
        reasons: fidelity.reasons,
      }, 'warn');
      result = await generateAzureVisionObject<GeometricReconstruction>(strictPrompt, retryImage);
      traceLog('Infralith Vision Engine', traceId, '4/9', 'retry reconstruction received', {
        retryCount,
        ...summarizeReconstruction(result),
      });

      promoteBestCandidate(result, `retry-${retryCount}`, { minScoreGain: 2 });
      fidelity = evaluateReconstructionFidelity(result, layoutHints);
    }

    if (bestResult !== result || bestCandidateLabel !== 'initial') {
      traceLog('Infralith Vision Engine', traceId, '5/9', 'selected strongest retry candidate before post-processing', {
        selected: bestCandidateLabel,
        bestScore,
        bestOpenings,
      }, 'warn');
      result = bestResult;
    }
    fidelity = evaluateReconstructionFidelity(result, layoutHints);

    if (fidelity.shouldRetry) {
      traceLog('Infralith Vision Engine', traceId, '5/9', 'fidelity gaps remain after retries; proceeding with deterministic normalization', {
        reasons: fidelity.reasons,
      }, 'warn');
    }

    const initialMissingSemanticMentions = getMissingSemanticMentionKeys(requiredSemanticMentions, bestResult);
    if (requiredSemanticMentions.length > 0 && initialMissingSemanticMentions.length > 0) {
      const requiredLabels = describeSemanticMentionKeys(requiredSemanticMentions);
      const missingLabels = describeSemanticMentionKeys(initialMissingSemanticMentions);
      traceLog('Infralith Vision Engine', traceId, '5/9', 'semantic enforcement pass triggered', {
        requiredLabels,
        missingLabels,
      }, 'warn');

      const semanticPromptSeed = `${prompt}

SEMANTIC ANCHOR ENFORCEMENT (OCR-CONDITIONED):
- Blueprint text indicates these spaces/components: ${requiredLabels.join(', ')}.
- Ensure each mentioned space is represented in output when geometric evidence exists.
- Represent spaces primarily via rooms[].name (e.g., Kitchen, Staircase, Bedroom, WC, Utility, Garage).
- Preserve structural geometry/topology; improve semantics without collapsing walls.
- If a mentioned space cannot be localized confidently, add an explicit high-severity conflict naming the missing space.
`;
      const semanticPrompt = buildBlueprintRetryPrompt(
        semanticPromptSeed,
        [
          `Missing semantic anchors in current output: ${missingLabels.join(', ')}.`,
          'Recover missing room/function labels while preserving existing geometry.',
        ]
      );

      try {
        const semanticCandidate = await generateAzureVisionObject<GeometricReconstruction>(semanticPrompt, imageUrl);
        if (hasNonEmptyWalls(semanticCandidate)) {
          const promotedSemantic = promoteBestCandidate(semanticCandidate, 'semantic-enforcement', {
            minScoreGain: 0.6,
            allowOpeningBoost: true,
            allowFidelityBoost: true,
            allowConflictBoost: true,
            allowSemanticBoost: true,
          });
          if (promotedSemantic) {
            result = bestResult;
            const remaining = describeSemanticMentionKeys(getMissingSemanticMentionKeys(requiredSemanticMentions, bestResult));
            traceLog('Infralith Vision Engine', traceId, '5/9', 'semantic enforcement improved reconstruction', {
              selected: bestCandidateLabel,
              bestScore,
              remainingMissingSemantic: remaining,
              ...summarizeReconstruction(bestResult),
            }, 'warn');
          } else {
            traceLog('Infralith Vision Engine', traceId, '5/9', 'semantic enforcement kept as fallback; current candidate remained stronger', {
              selected: bestCandidateLabel,
              bestScore,
              missingSemantic: missingLabels,
            }, 'warn');
          }
        }
      } catch (error) {
        traceLog('Infralith Vision Engine', traceId, '5/9', 'semantic enforcement pass failed; continuing with current reconstruction', {
          reason: error instanceof Error ? error.message : String(error),
        }, 'warn');
      }
    }

    const missingAfterSemanticPass = getMissingSemanticMentionKeys(requiredSemanticMentions, bestResult);
    const stairsRequired = requiredSemanticMentions.includes('stairs');
    const stairsMissing = missingAfterSemanticPass.includes('stairs');
    if (stairsRequired && stairsMissing && estimateResultFloorCount(bestResult) >= 2) {
      traceLog('Infralith Vision Engine', traceId, '5/9', 'staircase-specific enforcement triggered', {
        missingSemantic: describeSemanticMentionKeys(missingAfterSemanticPass),
      }, 'warn');

      const stairPromptSeed = `${prompt}

VERTICAL CIRCULATION ENFORCEMENT:
- Blueprint evidence indicates staircase/up-down circulation.
- Recover staircase core explicitly as one of:
  1) room name containing "Stair", "Staircase", or "Stair Hall", OR
  2) furniture/object type containing "stair" attached to the correct floor_level.
- Preserve current wall/room topology and avoid deleting valid geometry.
- If stair location is ambiguous, keep geometry conservative and add explicit high-severity conflict mentioning staircase uncertainty.
`;
      const stairPrompt = buildBlueprintRetryPrompt(
        stairPromptSeed,
        [
          'Staircase is expected from blueprint annotations but missing in current output.',
          'Recover stairs/landing semantics without collapsing interior layout.',
        ]
      );

      try {
        const stairCandidate = await generateAzureVisionObject<GeometricReconstruction>(stairPrompt, imageUrl);
        if (hasNonEmptyWalls(stairCandidate)) {
          const promotedStairCandidate = promoteBestCandidate(stairCandidate, 'staircase-enforcement', {
            minScoreGain: 0.4,
            allowOpeningBoost: true,
            allowFidelityBoost: true,
            allowConflictBoost: true,
            allowSemanticBoost: true,
          });

          if (promotedStairCandidate && hasSemanticMentionKey(bestResult, 'stairs')) {
            result = bestResult;
            traceLog('Infralith Vision Engine', traceId, '5/9', 'staircase enforcement improved reconstruction', {
              selected: bestCandidateLabel,
              bestScore,
              bestOpenings,
              ...summarizeReconstruction(bestResult),
            }, 'warn');
          } else {
            traceLog('Infralith Vision Engine', traceId, '5/9', 'staircase enforcement kept as fallback; current candidate remained stronger', {
              selected: bestCandidateLabel,
              bestScore,
            }, 'warn');
          }
        }
      } catch (error) {
        traceLog('Infralith Vision Engine', traceId, '5/9', 'staircase enforcement failed; continuing with current reconstruction', {
          reason: error instanceof Error ? error.message : String(error),
        }, 'warn');
      }
    }

    const stairSymbolRecoveryNeeded = shouldAttemptStairSymbolRecovery(layoutHints, bestResult, requiredSemanticMentions);
    if (stairSymbolRecoveryNeeded) {
      traceLog('Infralith Vision Engine', traceId, '5/9', 'non-text stair-symbol recovery triggered for multi-floor layout', {
        inferredFloorCount: estimateResultFloorCount(bestResult),
        floorSignals: estimateFloorHintCount(layoutHints),
      }, 'warn');

      const stairSymbolPromptSeed = `${prompt}

NON-TEXT STAIR SYMBOL RECOVERY:
- Detect staircase/vertical-circulation from drawing geometry and symbols even when no text label is present.
- Use visual patterns such as repeated narrow parallel treads, stair well cores, turn landings, and directional stair arrows.
- Represent detected stairs via room names containing "Stair"/"Staircase" and/or furniture/object entries containing "stair".
- Preserve existing valid walls, rooms, doors, and windows. Do not collapse geometry.
- If a plausible stair core exists but exact boundary is uncertain, keep conservative geometry and emit an explicit medium/high conflict.
`;
      const stairSymbolPrompt = buildBlueprintRetryPrompt(
        stairSymbolPromptSeed,
        [
          'Multi-floor blueprint likely requires vertical circulation but current output lacks staircase semantics.',
          'Recover stairs from visual symbol patterns, not only text labels.',
        ]
      );

      try {
        const stairSymbolCandidate = await generateAzureVisionObject<GeometricReconstruction>(stairSymbolPrompt, imageUrl);
        if (hasNonEmptyWalls(stairSymbolCandidate)) {
          const promotedStairSymbol = promoteBestCandidate(stairSymbolCandidate, 'stair-symbol-recovery', {
            minScoreGain: 0.3,
            allowOpeningBoost: true,
            allowFidelityBoost: true,
            allowConflictBoost: true,
            allowSemanticBoost: true,
          });

          if (promotedStairSymbol && hasSemanticMentionKey(bestResult, 'stairs')) {
            result = bestResult;
            traceLog('Infralith Vision Engine', traceId, '5/9', 'non-text stair-symbol recovery improved reconstruction', {
              selected: bestCandidateLabel,
              bestScore,
              bestOpenings,
              ...summarizeReconstruction(bestResult),
            }, 'warn');
          } else {
            traceLog('Infralith Vision Engine', traceId, '5/9', 'non-text stair-symbol recovery kept as fallback; current candidate remained stronger', {
              selected: bestCandidateLabel,
              bestScore,
            }, 'warn');
          }
        }
      } catch (error) {
        traceLog('Infralith Vision Engine', traceId, '5/9', 'non-text stair-symbol recovery failed; continuing with current reconstruction', {
          reason: error instanceof Error ? error.message : String(error),
        }, 'warn');
      }
    }

    if (shouldAttemptInteriorLayoutRecovery(bestResult, layoutHints)) {
      const interiorSignal = analyzeInteriorLayoutSignal(bestResult);
      traceLog('Infralith Vision Engine', traceId, '5/9', 'interior layout refinement triggered to avoid placeholder partitions', {
        denseFloors: interiorSignal.denseFloors,
        gridLikeFloors: interiorSignal.gridLikeFloors,
        averageInteriorWallsPerFloor: Number(interiorSignal.averageInteriorWallsPerFloor.toFixed(2)),
        reasons: interiorSignal.reasons,
      }, 'warn');

      const interiorPromptSeed = `${prompt}

INTERIOR PARTITION REFINEMENT:
- Current reconstruction appears over-regularized with repetitive equal-size room blocks.
- Reconstruct interior walls and room polygons from visible wall-line evidence on each floor.
- Do not clone the same split grid across floors unless the drawing explicitly matches.
- Preserve validated exterior shell, scale, and floor_count while improving interior partition placement.
- Keep stairs/bathrooms/circulation spaces when evidence exists.
- If a boundary is uncertain, keep geometry conservative and emit explicit conflict instead of forcing symmetric quadrants.
`;
      const recoveryDiagnostics = interiorSignal.reasons.length > 0
        ? interiorSignal.reasons
        : ['Interior partition placement appears underfit and overly repetitive; refine using visible line evidence only.'];
      const interiorPrompt = buildBlueprintRetryPrompt(interiorPromptSeed, recoveryDiagnostics.slice(0, 4));

      try {
        const interiorCandidate = await generateAzureVisionObject<GeometricReconstruction>(interiorPrompt, structuralInputImage);
        if (hasNonEmptyWalls(interiorCandidate)) {
          const promotedInterior = promoteBestCandidate(interiorCandidate, 'interior-layout-recovery', {
            minScoreGain: 0.4,
            allowOpeningBoost: true,
            allowFidelityBoost: true,
            allowConflictBoost: true,
            allowSemanticBoost: true,
          });
          if (promotedInterior) {
            result = bestResult;
            traceLog('Infralith Vision Engine', traceId, '5/9', 'interior layout refinement improved reconstruction', {
              selected: bestCandidateLabel,
              bestScore,
              bestOpenings,
              ...summarizeReconstruction(bestResult),
            }, 'warn');
          } else {
            traceLog('Infralith Vision Engine', traceId, '5/9', 'interior layout refinement kept as fallback; current candidate remained stronger', {
              selected: bestCandidateLabel,
              bestScore,
              bestOpenings,
            }, 'warn');
          }
        }
      } catch (error) {
        traceLog('Infralith Vision Engine', traceId, '5/9', 'interior layout refinement failed; continuing with current reconstruction', {
          reason: error instanceof Error ? error.message : String(error),
        }, 'warn');
      }
    }

    if (shouldAttemptRoomDimensionRecovery(bestResult, layoutHints)) {
      const dimensionAssessment = estimateRoomDimensionAlignment(layoutHints, bestResult);
      traceLog('Infralith Vision Engine', traceId, '5/9', 'room dimension-position enforcement triggered', {
        hintCount: dimensionAssessment.hintCount,
        matchedCount: dimensionAssessment.matchedCount,
        mismatches: dimensionAssessment.mismatches.length,
      }, 'warn');

      const dimensionPromptSeed = `${prompt}

ROOM DIMENSION + POSITION ENFORCEMENT:
- Blueprint contains room-size annotations (width x depth). Match room polygons to these dimensions where visible.
- Place each room polygon near the annotated location and on the corresponding floor block.
- Preserve validated exterior shell, floor_count, and structural graph while correcting interior room sizes/positions.
- Do not fabricate rooms that are not supported by drawing evidence.
- If any dimension annotation cannot be localized confidently, keep conservative geometry and emit explicit conflict with that annotation text.
`;
      const diagnostics = dimensionAssessment.reasons.length > 0
        ? dimensionAssessment.reasons
        : ['Room dimension hints are not matching current room polygon sizes/positions.'];
      const dimensionPrompt = buildBlueprintRetryPrompt(dimensionPromptSeed, diagnostics.slice(0, 4));

      try {
        const dimensionCandidate = await generateAzureVisionObject<GeometricReconstruction>(dimensionPrompt, imageUrl);
        if (hasNonEmptyWalls(dimensionCandidate)) {
          const promotedDimension = promoteBestCandidate(dimensionCandidate, 'room-dimension-enforcement', {
            minScoreGain: 0.3,
            allowOpeningBoost: true,
            allowFidelityBoost: true,
            allowConflictBoost: true,
            allowSemanticBoost: true,
          });
          if (promotedDimension) {
            result = bestResult;
            traceLog('Infralith Vision Engine', traceId, '5/9', 'room dimension-position enforcement improved reconstruction', {
              selected: bestCandidateLabel,
              bestScore,
              bestOpenings,
              ...summarizeReconstruction(bestResult),
            }, 'warn');
          } else {
            traceLog('Infralith Vision Engine', traceId, '5/9', 'room dimension-position enforcement kept as fallback; current candidate remained stronger', {
              selected: bestCandidateLabel,
              bestScore,
              bestOpenings,
            }, 'warn');
          }
        }
      } catch (error) {
        traceLog('Infralith Vision Engine', traceId, '5/9', 'room dimension-position enforcement failed; continuing with current reconstruction', {
          reason: error instanceof Error ? error.message : String(error),
        }, 'warn');
      }
    }

    if (shouldAttemptOpeningRecovery(result, layoutHints)) {
      const baseScore = scoreReconstructionDensity(result, layoutHints);
      const baseOpenings = getOpeningCount(result);
      const openingRecoveryPromptSeed = `${prompt}

OPENING-RECOVERY OVERRIDE:
- Preserve all valid walls/rooms from the blueprint and avoid collapsing geometry.
- Detect visible door symbols, arc swings, wall gaps, and window spans across all floors.
- Populate doors[] and windows[] with proper host_wall_id mapping to reconstructed walls.
- Prefer low-confidence openings over returning empty openings arrays when evidence exists.
`;
      const openingRecoveryPrompt = buildBlueprintRetryPrompt(
        openingRecoveryPromptSeed,
        [
          `Current reconstruction has ${result?.walls?.length || 0} wall(s), ${result?.rooms?.length || 0} room(s), but only ${result?.doors?.length || 0} door(s) and ${result?.windows?.length || 0} window(s).`,
          'Recover openings without dropping wall or room topology.',
        ]
      );

      traceLog('Infralith Vision Engine', traceId, '5/9', 'opening recovery pass triggered', {
        baseScore,
        baseOpenings,
      }, 'warn');

      try {
        const openingCandidate = await generateAzureVisionObject<GeometricReconstruction>(openingRecoveryPrompt, imageUrl);
        if (hasNonEmptyWalls(openingCandidate)) {
          const mergedCandidate = mergeOpeningsFromRecovery(result, openingCandidate);
          const openingCandidateScore = scoreReconstructionDensity(openingCandidate, layoutHints);
          const openingCandidateCount = getOpeningCount(openingCandidate);
          const mergedScore = scoreReconstructionDensity(mergedCandidate, layoutHints);
          const mergedOpenings = getOpeningCount(mergedCandidate);

          const promotedOpeningPass = promoteBestCandidate(openingCandidate, 'opening-pass', {
            minScoreGain: 1.5,
            allowOpeningBoost: true,
            allowFidelityBoost: true,
            allowConflictBoost: true,
          });
          const promotedMergedPass = promoteBestCandidate(mergedCandidate, 'opening-merge', {
            minScoreGain: 0.8,
            allowOpeningBoost: true,
            allowFidelityBoost: true,
            allowConflictBoost: true,
          });

          if (promotedOpeningPass || promotedMergedPass) {
            result = bestResult;
            traceLog('Infralith Vision Engine', traceId, '5/9', 'opening recovery improved selected reconstruction', {
              selected: bestCandidateLabel,
              baseScore,
              chosenScore: bestScore,
              baseOpenings,
              chosenOpenings: bestOpenings,
              ...summarizeReconstruction(result),
            }, 'warn');
          } else {
            traceLog('Infralith Vision Engine', traceId, '5/9', 'opening recovery kept as fallback only; base result remained stronger', {
              baseScore,
              openingCandidateScore,
              mergedScore,
              baseOpenings,
              openingCandidateCount,
              mergedOpenings,
            }, 'warn');
          }
        }
      } catch (error) {
        traceLog('Infralith Vision Engine', traceId, '5/9', 'opening recovery pass failed; continuing with current reconstruction', {
          reason: error instanceof Error ? error.message : String(error),
        }, 'warn');
      }
    }

    const hintedFloorCount = estimateFloorHintCount(layoutHints);
    const inferredFloorCount = estimateResultFloorCount(result);
    const sparseMultiFloorShell = isLikelySparseMultiFloorShell(result, hintedFloorCount);
    const interiorLayoutSignal = analyzeInteriorLayoutSignal(result);
    const placeholderInterior = interiorLayoutSignal.placeholder;
    const dimensionAlignmentSignal = estimateRoomDimensionAlignment(layoutHints, result);
    const significantDimensionMismatch = dimensionAlignmentSignal.shouldRetry && dimensionAlignmentSignal.hintCount >= 2;
    const densityFloorCount = Math.max(1, inferredFloorCount);
    const roomDensityPerFloor = (result?.rooms?.length || 0) / densityFloorCount;
    const wallDensityPerFloor = (result?.walls?.length || 0) / densityFloorCount;
    const lowRoomDensity = hintedFloorCount >= 2 && roomDensityPerFloor < 1.4;
    const lowWallDensity = hintedFloorCount >= 2 && wallDensityPerFloor < 4.8 && roomDensityPerFloor < 2.2;
    const shouldAttemptSegmentation =
      hintedFloorCount >= 2 &&
      (inferredFloorCount <= 1 || sparseMultiFloorShell || lowRoomDensity || lowWallDensity || placeholderInterior || significantDimensionMismatch);

    if (shouldAttemptSegmentation) {
      const monolithicScore = scoreReconstructionDensity(result, layoutHints);
      traceLog('Infralith Vision Engine', traceId, '5/9', 'segmentation candidate triggered for multi-floor quality recovery', {
        hintedFloorCount,
        inferredFloorCount,
        sparseMultiFloorShell,
        lowRoomDensity,
        lowWallDensity,
        placeholderInterior,
        significantDimensionMismatch,
        interiorReasons: interiorLayoutSignal.reasons,
        dimensionMismatchCount: dimensionAlignmentSignal.mismatches.length,
        roomDensityPerFloor,
        wallDensityPerFloor,
        monolithicScore,
      }, 'warn');
      const segmentedResult = await attemptSegmentedMultiFloorReconstruction(
        prompt,
        structuralInputImage,
        imageUrl,
        layoutHints,
        preprocessed.width,
        preprocessed.height,
        traceId
      );
      if (segmentedResult && hasNonEmptyWalls(segmentedResult)) {
        const segmentedScore = scoreReconstructionDensity(segmentedResult, layoutHints);
        const promotedSegmented = promoteBestCandidate(segmentedResult, 'segmented-floor-recovery', {
          minScoreGain: 4,
          allowOpeningBoost: true,
          allowFidelityBoost: true,
          allowConflictBoost: true,
        });
        if (promotedSegmented) {
          traceLog('Infralith Vision Engine', traceId, '5/9', 'segmented multi-floor recovery replaced monolithic output', {
            hintedFloorCount,
            previousFloorCount: inferredFloorCount,
            recoveredFloorCount: estimateResultFloorCount(bestResult),
            monolithicScore,
            segmentedScore: bestScore,
            ...summarizeReconstruction(bestResult),
          }, 'warn');
          result = bestResult;
        } else {
          traceLog('Infralith Vision Engine', traceId, '5/9', 'segmented result kept as fallback only; monolithic output scored higher', {
            hintedFloorCount,
            inferredFloorCount,
            monolithicScore,
            segmentedScore,
          }, 'warn');
        }
      } else {
        traceLog('Infralith Vision Engine', traceId, '5/9', 'segmented multi-floor recovery did not produce a valid replacement', {
          hintedFloorCount,
          inferredFloorCount,
        }, 'warn');
      }
    }

    const consensusEligible = shouldRunConsensusEnsemble(bestResult, layoutHints, bestScore);
    if (consensusEligible) {
      traceLog('Infralith Vision Engine', traceId, '5/9', 'consensus ensemble triggered for cross-blueprint robustness', {
        consensusRuns: VISION_CONSENSUS_RUNS,
        minScoreTarget: VISION_CONSENSUS_MIN_SCORE,
        selected: bestCandidateLabel,
        bestScore,
        bestOpenings,
      }, 'warn');

      for (let consensusRun = 2; consensusRun <= VISION_CONSENSUS_RUNS; consensusRun += 1) {
        const consensusReasons = buildConsensusRecoveryReasons(bestResult, layoutHints, bestScore);
        const consensusPrompt = consensusReasons.length > 0
          ? buildBlueprintRetryPrompt(prompt, consensusReasons)
          : prompt;
        const consensusImage = consensusRun % 2 === 0 ? imageUrl : structuralInputImage;
        const consensusLabel = `consensus-${consensusRun}`;

        try {
          const consensusCandidate = await generateAzureVisionObject<GeometricReconstruction>(consensusPrompt, consensusImage);
          if (!hasNonEmptyWalls(consensusCandidate)) {
            traceLog('Infralith Vision Engine', traceId, '5/9', 'consensus candidate returned no wall geometry', {
              consensusLabel,
              imageVariant: consensusImage === imageUrl ? 'original' : 'preprocessed',
            }, 'warn');
            continue;
          }

          const consensusScore = scoreReconstructionDensity(consensusCandidate, layoutHints);
          const consensusOpenings = getOpeningCount(consensusCandidate);
          const mergedConsensus = mergeOpeningsFromRecovery(bestResult, consensusCandidate);
          const mergedConsensusScore = scoreReconstructionDensity(mergedConsensus, layoutHints);
          const mergedConsensusOpenings = getOpeningCount(mergedConsensus);

          const promotedRaw = promoteBestCandidate(consensusCandidate, consensusLabel, {
            minScoreGain: 1.6,
            allowOpeningBoost: true,
            allowFidelityBoost: true,
            allowConflictBoost: true,
          });
          const promotedMerged = promoteBestCandidate(mergedConsensus, `${consensusLabel}-merge`, {
            minScoreGain: 0.6,
            allowOpeningBoost: true,
            allowFidelityBoost: true,
            allowConflictBoost: true,
          });

          if (promotedRaw || promotedMerged) {
            result = bestResult;
            traceLog('Infralith Vision Engine', traceId, '5/9', 'consensus round improved selected reconstruction', {
              consensusLabel,
              selected: bestCandidateLabel,
              bestScore,
              bestOpenings,
              consensusScore,
              consensusOpenings,
              mergedConsensusScore,
              mergedConsensusOpenings,
              ...summarizeReconstruction(bestResult),
            }, 'warn');
          } else {
            traceLog('Infralith Vision Engine', traceId, '5/9', 'consensus round kept as fallback; current best remained stronger', {
              consensusLabel,
              selected: bestCandidateLabel,
              bestScore,
              bestOpenings,
              consensusScore,
              consensusOpenings,
              mergedConsensusScore,
              mergedConsensusOpenings,
            }, 'warn');
          }

          const postConsensusFidelity = evaluateReconstructionFidelity(bestResult, layoutHints);
          const targetOpenings = Math.max(2, Math.floor((bestResult?.rooms?.length || 0) * 0.3));
          if (!postConsensusFidelity.shouldRetry && bestScore >= VISION_CONSENSUS_MIN_SCORE && bestOpenings >= targetOpenings) {
            traceLog('Infralith Vision Engine', traceId, '5/9', 'consensus early-stop condition reached', {
              consensusLabel,
              selected: bestCandidateLabel,
              bestScore,
              bestOpenings,
              targetOpenings,
            }, 'warn');
            break;
          }
        } catch (error) {
          traceLog('Infralith Vision Engine', traceId, '5/9', 'consensus round failed; continuing with current best', {
            consensusLabel,
            reason: error instanceof Error ? error.message : String(error),
          }, 'warn');
        }
      }

      result = bestResult;
    }

    if (!hasNonEmptyWalls(result)) {
      throw new Error("Engineering Synthesis Failed: GPT-4o Vision could not construct a valid geometric structure from the provided blueprint. Please ensure the image is a clear architectural floor plan.");
    }
    result = normalizeReconstructionGeometry(result);
    result = inferRoofFromWallFootprint(result);
    traceLog('Infralith Vision Engine', traceId, '6/9', 'applying deterministic building-code validation');
    let validatedResult = applyBuildingCodes(result);
    const unresolvedSemanticMentions = getMissingSemanticMentionKeys(requiredSemanticMentions, validatedResult);
    const multiFloorExpected = hasMultiFloorExpectation(layoutHints, validatedResult);
    const stairsResolved = hasSemanticMentionKey(validatedResult, 'stairs');
    const unresolvedMentions = [...unresolvedSemanticMentions];
    if (multiFloorExpected && !stairsResolved && !unresolvedMentions.includes('stairs')) {
      unresolvedMentions.push('stairs');
    }
    if ((requiredSemanticMentions.length > 0 || multiFloorExpected) && unresolvedMentions.length > 0) {
      const location =
        validatedResult?.rooms?.[0]?.polygon?.[0] ||
        validatedResult?.walls?.[0]?.start ||
        [0, 0];
      validatedResult = {
        ...validatedResult,
        conflicts: [
          ...(validatedResult.conflicts || []),
          {
            type: 'structural',
            severity: 'high',
            description: `Blueprint semantics indicate ${describeSemanticMentionKeys(unresolvedMentions).join(', ')}, but these spaces/components were not resolved in the generated interior layout.`,
            location: [Number(location[0] || 0), Number(location[1] || 0)] as [number, number],
          },
        ],
      };
      traceLog('Infralith Vision Engine', traceId, '7/9', 'semantic coverage gap persisted after generation', {
        unresolved: describeSemanticMentionKeys(unresolvedMentions),
      }, 'warn');
    }
    const dimensionAlignment = estimateRoomDimensionAlignment(layoutHints, validatedResult);
    if (dimensionAlignment.hintCount >= 2 && dimensionAlignment.mismatches.length > 0) {
      const firstMismatch = dimensionAlignment.mismatches[0];
      const ratio = dimensionAlignment.mismatches.length / Math.max(1, dimensionAlignment.hintCount);
      const severity: 'medium' | 'high' = ratio >= 0.5 ? 'high' : 'medium';
      const location =
        firstMismatch?.hintCenter ||
        validatedResult?.rooms?.[0]?.polygon?.[0] ||
        validatedResult?.walls?.[0]?.start ||
        [0, 0];
      const mismatchLabels = dimensionAlignment.mismatches
        .slice(0, 2)
        .map((item) => `"${item.hintText}"`)
        .join(', ');
      validatedResult = {
        ...validatedResult,
        conflicts: [
          ...(validatedResult.conflicts || []),
          {
            type: 'structural',
            severity,
            description: `Room dimension/position alignment mismatch for ${dimensionAlignment.mismatches.length}/${dimensionAlignment.hintCount} parsed room-dimension hint(s)${mismatchLabels ? ` (examples: ${mismatchLabels})` : ''}.`,
            location: [Number(location[0] || 0), Number(location[1] || 0)] as [number, number],
          },
        ],
      };
      traceLog('Infralith Vision Engine', traceId, '7/9', 'room dimension-position mismatch persisted after generation', {
        hintCount: dimensionAlignment.hintCount,
        mismatches: dimensionAlignment.mismatches.length,
      }, 'warn');
    }
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
    const normalized = applyBuildingCodes(inferRoofFromWallFootprint(normalizeReconstructionGeometry(result)));
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
