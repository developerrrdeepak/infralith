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
  RoofGeometry,
  SiteReconstruction,
  SiteBuildingReconstruction,
  type BlueprintSheetType,
  type BlueprintPlanRegionHint,
} from './reconstruction-types';
import { getBlueprintLineDatabase, type BlueprintLineRecord } from './blueprint-line-database';
import { applyBuildingCodes } from './building-codes';
import {
  buildAssetPrompt,
  buildAssetRetryPrompt,
  buildBlueprintModelAuditPrompt,
  buildBlueprintModelEditPrompt,
  buildBlueprintRetryPrompt,
  buildBlueprintVisionPrompt,
  buildTextToBuildingPrompt,
} from './prompt-templates';
import { assessOpeningSemantics } from './architectural-line-semantics';
import { getBlueprintLineDbSnapshot } from '@/lib/blueprint-line-db-service';
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

const BlueprintAuditIssueSchema = z.object({
  title: z.string(),
  description: z.string(),
  severity: z.enum(['low', 'medium', 'high']),
  floor_level: z.number().int(),
  location: z.tuple([z.number(), z.number()]),
  context_label: z.string(),
  suggested_edit: z.string(),
  target_ref: z.string(),
}).strict();

const BlueprintAuditResultSchema = z.object({
  summary: z.string(),
  issues: z.array(BlueprintAuditIssueSchema).max(6),
}).strict();

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
  semanticAnchors: payload?.semanticAnchors?.length || 0,
});

const LAYOUT_POLYGON_LIMIT = 180;
const LAYOUT_DIMENSION_ANCHOR_LIMIT = 60;
const LAYOUT_LINE_TEXT_LIMIT = 140;
const LAYOUT_FLOOR_LABEL_LIMIT = 36;
const LAYOUT_SEMANTIC_ANCHOR_LIMIT = 96;
const LAYOUT_DIMENSION_REGEX = /(\d+(\.\d+)?\s?(mm|cm|m|ft|feet|in|inch|\"|')|\d+'\s?\d*\"?)/i;
const LAYOUT_FLOOR_LABEL_REGEX = /\b((?:basement|cellar|lower\s*ground|stilt|ground|first|second|third|fourth|fifth|terrace|roof)\s*floor|(?:level|lvl|floor|flr)\s*[-_:]?\s*[a-z0-9]+|(?:g|b|l|f)\s*[-_:]?\s*\d{1,2})\b/i;
const FLOOR_PLAN_CAPTION_NOISE_REGEX = /\b(?:clg|ceiling|height|living|under\s*roof|overall|total|width|depth|job|project|sheet|area|sq(?:uare)?|sr|schedule|legend|detail|elevation|section|notes?|scale)\b|:/i;
const SHEET_ELEVATION_SIGNAL_REGEX = /\b(?:elevation|section|facade|front\s+elev|rear\s+elev|side\s+elev|roof\s+plan|reflected\s+ceiling)\b/i;
const SHEET_METADATA_SIGNAL_REGEX = /\b(?:project|job|sheet|legend|schedule|overall|total\s+living|under\s+roof|clg|notes?|scale|detail)\b/i;
const SHEET_SITE_SIGNAL_REGEX = /\b(?:site\s+plan|plot|road|setback|north\s+arrow|parking|landscape|vicinity|block|lot)\b/i;
const ROOM_SEMANTIC_SIGNAL_REGEX = /\b(?:kitchen|pantry|bed(?:room)?|bdrm|master\s*suite|bath(?:room)?|toilet|wc|powder|lav(?:atory)?|wash(?:room)?|living|family(?:\s*room)?|lounge|great\s*room|dining|breakfast|stair(?:case)?s?|stairwell|study|office|utility|laundry|service|storage|store(?:room)?|closet|garage|carport|foyer|entry|vestibule|balcony|terrace|patio|den)\b/i;

const FLOOR_LEVEL_WORD_TO_NUMBER: Record<string, string> = {
  one: '1',
  two: '2',
  three: '3',
  four: '4',
  five: '5',
  six: '6',
};

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
const VISION_TOTAL_BUDGET_MS = parseTimeoutMs(process.env.INFRALITH_VISION_TOTAL_BUDGET_MS, 175_000, 60_000, 900_000);
const VISION_REQUEST_HARD_BUDGET_MS = parseTimeoutMs(process.env.INFRALITH_VISION_REQUEST_HARD_BUDGET_MS, 220_000, 60_000, 900_000);
const VISION_MIN_PASS_REMAINING_MS = parseTimeoutMs(process.env.INFRALITH_VISION_MIN_PASS_REMAINING_MS, 25_000, 5_000, 120_000);
const VISION_PASS_ESTIMATED_COST_MS = parseTimeoutMs(process.env.INFRALITH_VISION_PASS_ESTIMATED_COST_MS, 60_000, 10_000, 180_000);
const VISION_PASS_TIMEOUT_BUFFER_MS = parseTimeoutMs(process.env.INFRALITH_VISION_PASS_TIMEOUT_BUFFER_MS, 5_000, 1_000, 30_000);
const VISION_MAX_RETRIES = parseBoundedInt(process.env.INFRALITH_VISION_MAX_RETRIES, 1, 0, 3);
const VISION_ORIGINAL_BASELINE_SCORE_OFFSET = parseBoundedFloat(
  process.env.INFRALITH_VISION_ORIGINAL_BASELINE_SCORE_OFFSET,
  5,
  0,
  25
);
const ENABLE_EXPENSIVE_VISION_RECOVERY = asBool(
  process.env.INFRALITH_ENABLE_EXPENSIVE_VISION_RECOVERY,
  process.env.NODE_ENV !== 'production'
);
const SOURCE_DATA_ONLY_3D = asBool(process.env.INFRALITH_3D_SOURCE_ONLY, true);
const NOT_AVAILABLE_3D_TEXT = 'Not available in provided project document';

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
  for (const anchor of layoutHints.semanticAnchors || []) {
    const normalized = normalizeSemanticText(anchor?.text);
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

const normalizeExplicitFloorPlanCaption = (value: string): string | null => {
  const text = value.toLowerCase().replace(/\s+/g, ' ').trim();
  if (!text || FLOOR_PLAN_CAPTION_NOISE_REGEX.test(text)) return null;

  const compact = text.replace(/\s*-\s*plan$/, '').replace(/\s+plan$/, '').trim();
  if (!compact) return null;

  const namedFloor = compact.match(
    /^(basement|cellar|lower\s*ground|stilt|ground|first|second|third|fourth|fifth)\s*floor$/
  );
  if (namedFloor?.[1]) {
    return namedFloor[1].replace(/\s+/g, ' ');
  }

  const roofLike = compact.match(/^(terrace|roof)(?:\s*floor)?$/);
  if (roofLike?.[1]) {
    return roofLike[1];
  }

  const ordinalFloor = compact.match(/^(\d{1,2})(?:st|nd|rd|th)\s*floor$/);
  if (ordinalFloor?.[1]) {
    return `level-${ordinalFloor[1]}`;
  }

  const floorPrefix = compact.match(/^(?:floor|flr)\s*(one|two|three|four|five|six|\d{1,2})$/);
  if (floorPrefix?.[1]) {
    return `level-${FLOOR_LEVEL_WORD_TO_NUMBER[floorPrefix[1]] || floorPrefix[1]}`;
  }

  const levelPrefix = compact.match(/^(?:level|lvl)\s*(one|two|three|four|five|six|\d{1,2})(?:\s*floor)?$/);
  if (levelPrefix?.[1]) {
    return `level-${FLOOR_LEVEL_WORD_TO_NUMBER[levelPrefix[1]] || levelPrefix[1]}`;
  }

  return null;
};

const isExplicitFloorPlanCaption = (value: string): boolean =>
  normalizeExplicitFloorPlanCaption(value) != null;

const estimateExplicitFloorPlanHintCount = (layoutHints: BlueprintLayoutHints | null): number => {
  if (!layoutHints) return 0;

  const labels = new Set<string>();
  for (const anchor of layoutHints.floorLabelAnchors || []) {
    const normalized = normalizeExplicitFloorPlanCaption(String(anchor?.text || ''));
    if (!normalized) continue;
    labels.add(normalized);
    if (labels.size >= 6) break;
  }

  for (const lineText of layoutHints.lineTexts || []) {
    const normalized = normalizeExplicitFloorPlanCaption(String(lineText || ''));
    if (!normalized) continue;
    labels.add(normalized);
    if (labels.size >= 6) break;
  }

  return labels.size;
};

const selectPreferredFloorCaptionAnchors = <T extends { text: string }>(anchors: T[]): T[] => {
  const explicit = anchors.filter((anchor) => isExplicitFloorPlanCaption(anchor.text));
  if (explicit.length >= 2) return explicit;

  const filtered = anchors.filter((anchor) => !FLOOR_PLAN_CAPTION_NOISE_REGEX.test(String(anchor.text || '')));
  if (filtered.length >= 2) return filtered;

  return explicit.length > 0 ? explicit : anchors;
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
  centerPx: [number, number] | null;
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

  const wordBased = text.match(/\b(?:level|lvl|floor|flr)\s*[-_:]?\s*(one|two|three|four|five|six)\b/);
  if (wordBased?.[1]) {
    const parsed = Number(FLOOR_LEVEL_WORD_TO_NUMBER[wordBased[1]] || 0);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }

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

const resolveLayoutHintExtent = (
  layoutHints: BlueprintLayoutHints | null
): { minX: number; minY: number; width: number; height: number } | null => {
  if (!layoutHints) return null;

  const page = layoutHints.pages?.[0];
  const pageWidth = Number(page?.width || 0);
  const pageHeight = Number(page?.height || 0);
  if (Number.isFinite(pageWidth) && Number.isFinite(pageHeight) && pageWidth > 0 && pageHeight > 0) {
    return { minX: 0, minY: 0, width: pageWidth, height: pageHeight };
  }

  const polygons = [
    ...(layoutHints.linePolygons || []),
    ...(layoutHints.dimensionAnchors || []).map((anchor) => anchor.polygon || []),
    ...(layoutHints.floorLabelAnchors || []).map((anchor) => anchor.polygon || []),
  ];

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const polygon of polygons) {
    if (!Array.isArray(polygon)) continue;
    for (let i = 0; i < polygon.length - 1; i += 2) {
      const x = Number(polygon[i]);
      const y = Number(polygon[i + 1]);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }

  if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) {
    return null;
  }

  const width = maxX - minX;
  const height = maxY - minY;
  if (width <= 0 || height <= 0) return null;
  return { minX, minY, width, height };
};

const resolveModelWallBounds = (
  result: GeometricReconstruction
): { minX: number; maxX: number; minY: number; maxY: number } | null => {
  const walls = result?.walls || [];
  if (walls.length === 0) return null;
  const xs: number[] = [];
  const ys: number[] = [];
  for (const wall of walls) {
    const sx = Number(wall?.start?.[0]);
    const sy = Number(wall?.start?.[1]);
    const ex = Number(wall?.end?.[0]);
    const ey = Number(wall?.end?.[1]);
    if (Number.isFinite(sx)) xs.push(sx);
    if (Number.isFinite(ex)) xs.push(ex);
    if (Number.isFinite(sy)) ys.push(sy);
    if (Number.isFinite(ey)) ys.push(ey);
  }
  if (xs.length === 0 || ys.length === 0) return null;
  return {
    minX: Math.min(...xs),
    maxX: Math.max(...xs),
    minY: Math.min(...ys),
    maxY: Math.max(...ys),
  };
};

const mapHintPointToModelSpace = (
  point: [number, number] | null,
  layoutHints: BlueprintLayoutHints | null,
  result: GeometricReconstruction,
  floorRooms: GeometricReconstruction['rooms']
): [number, number] | null => {
  if (!point) return null;
  const layoutExtent = resolveLayoutHintExtent(layoutHints);
  const modelBounds = resolveModelWallBounds(result);
  if (!layoutExtent || !modelBounds) return null;

  const ratioX = (point[0] - layoutExtent.minX) / layoutExtent.width;
  const ratioY = (point[1] - layoutExtent.minY) / layoutExtent.height;
  if (!Number.isFinite(ratioX) || !Number.isFinite(ratioY)) return null;
  const clampedX = Math.max(0, Math.min(1, ratioX));
  const clampedY = Math.max(0, Math.min(1, ratioY));

  const modelWidth = modelBounds.maxX - modelBounds.minX;
  const modelHeight = modelBounds.maxY - modelBounds.minY;
  if (modelWidth <= 0 || modelHeight <= 0) return null;

  const direct: [number, number] = [
    modelBounds.minX + (clampedX * modelWidth),
    modelBounds.minY + (clampedY * modelHeight),
  ];
  const flipped: [number, number] = [
    modelBounds.minX + (clampedX * modelWidth),
    modelBounds.maxY - (clampedY * modelHeight),
  ];

  const roomCenters = floorRooms
    .map((room) => {
      const bounds = collectRoomBounds(room?.polygon || []);
      if (!bounds) return null;
      return [(bounds.minX + bounds.maxX) / 2, (bounds.minY + bounds.maxY) / 2] as [number, number];
    })
    .filter((entry): entry is [number, number] => Array.isArray(entry));
  if (roomCenters.length === 0) return direct;

  const nearestDistance = (candidate: [number, number]) =>
    roomCenters.reduce((best, center) => {
      const distance = Math.hypot(center[0] - candidate[0], center[1] - candidate[1]);
      return Math.min(best, distance);
    }, Number.POSITIVE_INFINITY);

  return nearestDistance(direct) <= nearestDistance(flipped) ? direct : flipped;
};

type LayoutSemanticAnchor = {
  key: SemanticMentionKey;
  text: string;
  centerPx: [number, number];
  floorLevel: number | null;
};

const semanticRoomLabelForKey = (key: SemanticMentionKey): string => {
  switch (key) {
    case 'bathroom':
      return 'BATHROOM / WC';
    case 'stairs':
      return 'STAIR HALL';
    case 'garage':
      return 'GARAGE';
    case 'bedroom':
      return 'BEDROOM';
    case 'living':
      return 'FAMILY / LIVING';
    case 'dining':
      return 'DINING';
    case 'kitchen':
      return 'KITCHEN';
    case 'study':
      return 'STUDY';
    case 'utility':
      return 'UTILITY';
    case 'storage':
      return 'STORAGE';
    case 'foyer':
      return 'FOYER';
    case 'balcony':
      return 'BALCONY';
    case 'den':
      return 'DEN';
    default:
      return String(SEMANTIC_LABEL_BY_KEY[key as SemanticMentionKey] || key || 'space').toUpperCase();
  }
};

const semanticMarkerTypeForKey = (key: SemanticMentionKey): string => {
  switch (key) {
    case 'bathroom':
      return 'bathroom marker';
    case 'stairs':
      return 'stair marker';
    case 'garage':
      return 'garage marker';
    case 'bedroom':
      return 'bedroom marker';
    case 'living':
      return 'living area marker';
    case 'dining':
      return 'dining marker';
    case 'kitchen':
      return 'kitchen marker';
    case 'study':
      return 'study marker';
    case 'utility':
      return 'utility marker';
    case 'storage':
      return 'storage marker';
    case 'foyer':
      return 'entry marker';
    case 'balcony':
      return 'balcony marker';
    case 'den':
      return 'den marker';
    default:
      return `${key} marker`;
  }
};

const semanticKeyFromText = (value: unknown): SemanticMentionKey | null => {
  const text = normalizeSemanticText(value);
  if (!text) return null;
  for (const def of SEMANTIC_MENTION_DEFS) {
    if (def.patterns.some((pattern) => pattern.test(text))) return def.key;
  }
  return null;
};

const collectSemanticAnchorCandidates = (
  layoutHints: BlueprintLayoutHints
): Array<{ text: string; polygon: number[] }> => {
  const candidates: Array<{ text: string; polygon: number[] }> = [];
  const seen = new Set<string>();
  const pushCandidate = (textValue: unknown, polygonValue: unknown) => {
    if (candidates.length >= LAYOUT_SEMANTIC_ANCHOR_LIMIT) return;
    const text = String(textValue || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    if (!text || semanticKeyFromText(text) == null) return;
    if (!Array.isArray(polygonValue) || polygonValue.length < 6) return;
    const polygon = polygonValue
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value));
    if (polygon.length < 6 || polygon.length % 2 !== 0) return;
    const dedupeKey = `${text.toLowerCase()}|${polygon.map((value) => value.toFixed(3)).join(',')}`;
    if (seen.has(dedupeKey)) return;
    seen.add(dedupeKey);
    candidates.push({ text, polygon });
  };

  for (const anchor of layoutHints.semanticAnchors || []) {
    pushCandidate(anchor?.text, anchor?.polygon);
  }

  const lineTexts = layoutHints.lineTexts || [];
  const linePolygons = layoutHints.linePolygons || [];
  const pairedLineCount = Math.min(lineTexts.length, linePolygons.length);
  for (let index = 0; index < pairedLineCount; index += 1) {
    pushCandidate(lineTexts[index], linePolygons[index]);
  }

  return candidates;
};

const collectLayoutSemanticAnchors = (
  layoutHints: BlueprintLayoutHints | null
): LayoutSemanticAnchor[] => {
  if (!layoutHints) return [];
  const floorAnchors = (layoutHints.floorLabelAnchors || [])
    .map((anchor) => {
      const center = flatPolygonCenter(anchor?.polygon || []);
      if (!center) return null;
      const level = parseFloorLabelToLevel(String(anchor?.text || ''));
      if (level == null) return null;
      return {
        level,
        centerY: center[1],
      };
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry != null);

  const anchors: LayoutSemanticAnchor[] = [];
  const seen = new Set<string>();
  const semanticAnchorCandidates = collectSemanticAnchorCandidates(layoutHints);
  for (const anchor of semanticAnchorCandidates) {
    const key = semanticKeyFromText(anchor?.text);
    if (!key) continue;
    const centerPx = flatPolygonCenter(anchor?.polygon || []);
    if (!centerPx) continue;
    let floorLevel: number | null = null;
    if (floorAnchors.length > 0) {
      let best: { level: number; distance: number } | null = null;
      for (const floorAnchor of floorAnchors) {
        const distance = Math.abs(centerPx[1] - floorAnchor.centerY);
        if (!best || distance < best.distance) {
          best = { level: floorAnchor.level, distance };
        }
      }
      floorLevel = best?.level ?? null;
    }
    const text = String(anchor?.text || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    const dedupeKey = `${key}|${floorLevel == null ? 'na' : floorLevel}|${centerPx[0].toFixed(1)}:${centerPx[1].toFixed(1)}|${text.toLowerCase()}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    anchors.push({
      key,
      text,
      centerPx,
      floorLevel,
    });
  }
  return anchors;
};

type SemanticReconciliationResult = {
  result: GeometricReconstruction;
  renamedRooms: number;
  createdMarkers: number;
  resolvedKeys: SemanticMentionKey[];
};

const reconcileMissingSemanticMentionsFromLayout = (
  result: GeometricReconstruction,
  layoutHints: BlueprintLayoutHints | null,
  targetMentions: SemanticMentionKey[]
): SemanticReconciliationResult => {
  const mentions = Array.from(new Set(targetMentions));
  if (mentions.length === 0 || !layoutHints) {
    return {
      result,
      renamedRooms: 0,
      createdMarkers: 0,
      resolvedKeys: [],
    };
  }

  const missingMentions = getMissingSemanticMentionKeys(mentions, result);
  if (missingMentions.length === 0) {
    return {
      result,
      renamedRooms: 0,
      createdMarkers: 0,
      resolvedKeys: [],
    };
  }

  const semanticAnchors = collectLayoutSemanticAnchors(layoutHints);
  if (semanticAnchors.length === 0) {
    return {
      result,
      renamedRooms: 0,
      createdMarkers: 0,
      resolvedKeys: [],
    };
  }

  const updatedRooms = [...(result.rooms || [])];
  const updatedFurnitures = [...(result.furnitures || [])];
  const updatedConflicts = [...(result.conflicts || [])];
  const usedRoomIndices = new Set<number>();
  const usedAnchorIndices = new Set<number>();

  let renamedRooms = 0;
  let createdMarkers = 0;
  const resolvedKeys: SemanticMentionKey[] = [];

  const normalizeRoomCandidateName = (key: SemanticMentionKey, currentName: string): string => {
    const desired = semanticRoomLabelForKey(key);
    if (!currentName) return desired;
    if (semanticKeyFromText(currentName) === key) return currentName;
    if (/^room\s*\d+$/i.test(currentName)) return desired;
    if (semanticKeyFromText(currentName) != null) return currentName;
    return `${desired} / ${currentName.slice(0, 42)}`;
  };

  for (const missingKey of missingMentions) {
    const anchorCandidates = semanticAnchors
      .map((anchor, index) => ({ anchor, index }))
      .filter((entry) => entry.anchor.key === missingKey && !usedAnchorIndices.has(entry.index));
    if (anchorCandidates.length === 0) continue;

    let selectedRoomMatch: {
      roomIndex: number;
      anchorIndex: number;
      mappedCenter: [number, number];
      score: number;
    } | null = null;
    let selectedMarkerAnchor: {
      anchorIndex: number;
      mappedCenter: [number, number];
      floorLevel: number;
      nearestRoomId: string | number | undefined;
      nearestDistance: number;
    } | null = null;

    for (const { anchor, index: anchorIndex } of anchorCandidates) {
      const roomCandidates = updatedRooms
        .map((room, roomIndex) => ({ room, roomIndex }))
        .filter(({ room }) => {
          if (anchor.floorLevel == null) return true;
          return toFloorBucket(room?.floor_level) === toFloorBucket(anchor.floorLevel);
        });
      const floorRooms = roomCandidates.map((entry) => entry.room);
      const mappedCenter = mapHintPointToModelSpace(anchor.centerPx, layoutHints, { ...result, rooms: updatedRooms }, floorRooms);
      if (!mappedCenter) continue;

      let nearestRoomId: string | number | undefined;
      let nearestRoomDistance = Number.POSITIVE_INFINITY;
      for (const { room, roomIndex } of roomCandidates) {
        const bounds = collectRoomBounds(room?.polygon || []);
        if (!bounds) continue;
        const centerX = (bounds.minX + bounds.maxX) / 2;
        const centerY = (bounds.minY + bounds.maxY) / 2;
        const distance = Math.hypot(centerX - mappedCenter[0], centerY - mappedCenter[1]);
        if (distance < nearestRoomDistance) {
          nearestRoomDistance = distance;
          nearestRoomId = updatedRooms[roomIndex]?.id;
        }
      }

      if (selectedMarkerAnchor == null || nearestRoomDistance < selectedMarkerAnchor.nearestDistance) {
        selectedMarkerAnchor = {
          anchorIndex,
          mappedCenter,
          floorLevel: anchor.floorLevel == null ? 0 : toFloorBucket(anchor.floorLevel),
          nearestRoomId,
          nearestDistance: nearestRoomDistance,
        };
      }

      for (const { room, roomIndex } of roomCandidates) {
        if (usedRoomIndices.has(roomIndex)) continue;
        const bounds = collectRoomBounds(room?.polygon || []);
        if (!bounds) continue;

        const existingRoomSemantic = semanticKeyFromText(room?.name);
        if (existingRoomSemantic != null && existingRoomSemantic !== missingKey) continue;

        const area = bounds.area;
        if (missingKey === 'bathroom' && area > 28) continue;
        if (missingKey === 'garage' && area < 10) continue;
        if (missingKey === 'stairs' && area < 1.6) continue;

        const centerX = (bounds.minX + bounds.maxX) / 2;
        const centerY = (bounds.minY + bounds.maxY) / 2;
        const distance = Math.hypot(centerX - mappedCenter[0], centerY - mappedCenter[1]);
        const roomScale = Math.max(1, Math.sqrt(area));
        const maxDistance = missingKey === 'stairs'
          ? Math.max(3.2, roomScale * 1.6)
          : (missingKey === 'garage'
            ? Math.max(4.4, roomScale * 2.0)
            : Math.max(2.6, roomScale * 1.35));
        if (distance > maxDistance) continue;

        const score = distance / maxDistance;
        if (!selectedRoomMatch || score < selectedRoomMatch.score) {
          selectedRoomMatch = {
            roomIndex,
            anchorIndex,
            mappedCenter,
            score,
          };
        }
      }
    }

    if (selectedRoomMatch) {
      const room = updatedRooms[selectedRoomMatch.roomIndex];
      const currentName = String(room?.name || '').trim();
      const nextName = normalizeRoomCandidateName(missingKey, currentName);
      if (nextName && nextName !== currentName) {
        updatedRooms[selectedRoomMatch.roomIndex] = {
          ...room,
          name: nextName,
        };
        renamedRooms += 1;
        updatedConflicts.push({
          type: 'code',
          severity: 'low',
          description: `Mapped semantic label "${semanticRoomLabelForKey(missingKey)}" from blueprint text anchor to room "${nextName}".`,
          location: [
            Number(selectedRoomMatch.mappedCenter[0].toFixed(3)),
            Number(selectedRoomMatch.mappedCenter[1].toFixed(3)),
          ],
        });
      }
      usedRoomIndices.add(selectedRoomMatch.roomIndex);
      usedAnchorIndices.add(selectedRoomMatch.anchorIndex);
      resolvedKeys.push(missingKey);
      continue;
    }

    if (selectedMarkerAnchor) {
      createdMarkers += 1;
      const markerType = semanticMarkerTypeForKey(missingKey);
      updatedFurnitures.push({
        id: `sem-marker-${missingKey}-${createdMarkers}`,
        room_id: selectedMarkerAnchor.nearestRoomId,
        type: markerType,
        position: [
          Number(selectedMarkerAnchor.mappedCenter[0].toFixed(3)),
          Number(selectedMarkerAnchor.mappedCenter[1].toFixed(3)),
        ],
        width: missingKey === 'garage' ? 2.2 : (missingKey === 'stairs' ? 1.8 : 0.9),
        depth: missingKey === 'garage' ? 4.5 : (missingKey === 'stairs' ? 1.8 : 0.9),
        height: missingKey === 'stairs' ? 2.8 : 1.2,
        color: '#9aa3ad',
        description: `Semantic anchor marker inferred for ${semanticRoomLabelForKey(missingKey).toLowerCase()} from blueprint text.`,
        floor_level: selectedMarkerAnchor.floorLevel,
      });
      updatedConflicts.push({
        type: 'code',
        severity: 'low',
        description: `Added semantic marker for "${semanticRoomLabelForKey(missingKey)}" using blueprint anchor location.`,
        location: [
          Number(selectedMarkerAnchor.mappedCenter[0].toFixed(3)),
          Number(selectedMarkerAnchor.mappedCenter[1].toFixed(3)),
        ],
      });
      usedAnchorIndices.add(selectedMarkerAnchor.anchorIndex);
      resolvedKeys.push(missingKey);
    }
  }

  if (renamedRooms === 0 && createdMarkers === 0) {
    return {
      result,
      renamedRooms: 0,
      createdMarkers: 0,
      resolvedKeys: [],
    };
  }

  return {
    result: {
      ...result,
      rooms: updatedRooms,
      furnitures: updatedFurnitures,
      conflicts: updatedConflicts,
    },
    renamedRooms,
    createdMarkers,
    resolvedKeys: Array.from(new Set(resolvedKeys)),
  };
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
  // Normalize OCR separators so `3.5 x 4.2`, `3.5Ã—4.2`, `3.5 by 4.2`, and `3.5*4.2` are parsed consistently.
  const normalized = text
    .replace(/[Ã—âœ•âœ–]/g, 'x')
    .replace(/\bby\b/gi, ' x ')
    .replace(/\s*\*\s*/g, ' x ')
    .replace(/\s+/g, ' ')
    .trim();
  const pairMatch = normalized.match(/(.{0,40}?\d[\d\s.'"\-]*(?:mm|cm|m|ft|feet|foot|in|inch|inches|["'])?)\s*x\s*(\d[\d\s.'"\-]*(?:mm|cm|m|ft|feet|foot|in|inch|inches|["'])?.{0,24})/i);
  if (!pairMatch?.[1] || !pairMatch?.[2]) return null;

  const widthM = parseDimensionTokenMeters(pairMatch[1], normalized);
  const depthM = parseDimensionTokenMeters(pairMatch[2], normalized);
  if (widthM == null || depthM == null) return null;
  if (widthM < 0.4 || depthM < 0.4 || widthM > 40 || depthM > 40) return null;

  return {
    widthM: Number(widthM.toFixed(3)),
    depthM: Number(depthM.toFixed(3)),
  };
};

const extractRoomDimensionHints = (layoutHints: BlueprintLayoutHints | null): RoomDimensionHint[] => {
  if (!layoutHints) return [];
  const hintExtent = resolveLayoutHintExtent(layoutHints);
  const pairDistanceThreshold = hintExtent
    ? Math.max(18, Math.min(hintExtent.width, hintExtent.height) * 0.18)
    : 80;
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
  const singleValueAnchors: Array<{ text: string; valueM: number; centerPx: [number, number]; floorLevel: number | null }> = [];
  const dedupe = new Set<string>();
  const pushHint = (
    text: string,
    widthM: number,
    depthM: number,
    centerPx: [number, number] | null,
    floorLevel: number | null
  ) => {
    const safeW = Number(widthM.toFixed(3));
    const safeD = Number(depthM.toFixed(3));
    if (!Number.isFinite(safeW) || !Number.isFinite(safeD)) return;
    if (safeW < 0.4 || safeD < 0.4 || safeW > 40 || safeD > 40) return;

    const key = [
      Math.min(safeW, safeD).toFixed(2),
      Math.max(safeW, safeD).toFixed(2),
      floorLevel == null ? 'na' : String(floorLevel),
      centerPx ? `${centerPx[0].toFixed(1)}:${centerPx[1].toFixed(1)}` : 'nocenter',
      String(text || '').toLowerCase().trim().slice(0, 80),
    ].join('|');
    if (dedupe.has(key)) return;
    dedupe.add(key);

    hints.push({
      text: String(text || '').trim(),
      widthM: safeW,
      depthM: safeD,
      centerPx,
      floorLevel,
    });
  };

  for (const anchor of layoutHints.dimensionAnchors || []) {
    if (hints.length >= 36) break;
    const text = String(anchor?.text || '');
    const pair = extractDimensionPairFromText(text);
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

    if (pair) {
      pushHint(text, pair.widthM, pair.depthM, center, floorLevel);
      continue;
    }

    if (center) {
      const singleValue = parseDimensionTokenMeters(text, text);
      if (singleValue != null && singleValue >= 0.4 && singleValue <= 40) {
        singleValueAnchors.push({
          text,
          valueM: Number(singleValue.toFixed(3)),
          centerPx: center,
          floorLevel,
        });
      }
    }
  }

  if (singleValueAnchors.length >= 2) {
    for (let i = 0; i < singleValueAnchors.length; i += 1) {
      const a = singleValueAnchors[i];
      for (let j = i + 1; j < singleValueAnchors.length; j += 1) {
        const b = singleValueAnchors[j];
        if (a.floorLevel != null && b.floorLevel != null && a.floorLevel !== b.floorLevel) continue;
        const distancePx = Math.hypot(a.centerPx[0] - b.centerPx[0], a.centerPx[1] - b.centerPx[1]);
        if (!Number.isFinite(distancePx) || distancePx > pairDistanceThreshold) continue;
        const nearEqual = Math.abs(a.valueM - b.valueM) <= Math.max(0.35, Math.min(a.valueM, b.valueM) * 0.08);
        if (nearEqual && Math.max(a.valueM, b.valueM) > 8) continue;
        const centerPx: [number, number] = [
          Number(((a.centerPx[0] + b.centerPx[0]) / 2).toFixed(3)),
          Number(((a.centerPx[1] + b.centerPx[1]) / 2).toFixed(3)),
        ];
        const floorLevel = a.floorLevel ?? b.floorLevel ?? null;
        const pairText = `${a.text} x ${b.text}`.slice(0, 120);
        pushHint(pairText, a.valueM, b.valueM, centerPx, floorLevel);
      }
    }
  }

  // Fallback: parse room-size pairs directly from OCR line text when polygon anchors are sparse.
  if (hints.length < 24) {
    for (const lineText of layoutHints.lineTexts || []) {
      if (hints.length >= 48) break;
      const pair = extractDimensionPairFromText(String(lineText || ''));
      if (!pair) continue;
      pushHint(String(lineText || '').slice(0, 120), pair.widthM, pair.depthM, null, null);
    }
  }

  return hints;
};

const scalePlanarReconstruction = (
  payload: GeometricReconstruction,
  factor: number
): GeometricReconstruction => {
  const safeFactor = Number.isFinite(factor) ? factor : 1;
  if (Math.abs(safeFactor - 1) < 1e-4) return payload;

  const scalePoint = (point: [number, number]): [number, number] => [
    Number((point[0] * safeFactor).toFixed(3)),
    Number((point[1] * safeFactor).toFixed(3)),
  ];

  const scaleLength = (value: unknown, fallback = 0, precision = 3): number => {
    const n = Number(value);
    const base = Number.isFinite(n) ? n : fallback;
    return Number((base * safeFactor).toFixed(precision));
  };

  const scaledWalls = (payload.walls || []).map((wall) => ({
    ...wall,
    start: scalePoint(wall.start),
    end: scalePoint(wall.end),
    thickness: scaleLength(wall.thickness, 0.115),
  }));

  const scaledWallSolids = (payload.wallSolids || []).map((wall) => ({
    ...wall,
    start: scalePoint(wall.start),
    end: scalePoint(wall.end),
    thickness: scaleLength(wall.thickness, 0.115),
  }));

  const scaledDoors = (payload.doors || []).map((door) => ({
    ...door,
    position: scalePoint(door.position),
    width: scaleLength(door.width, 0.9),
  }));

  const scaledWindows = (payload.windows || []).map((win) => ({
    ...win,
    position: scalePoint(win.position),
    width: scaleLength(win.width, 1),
  }));

  const scaledRooms = (payload.rooms || []).map((room) => {
    const polygon = (room.polygon || []).map((point) => scalePoint(point));
    const area = Math.abs(polygonArea(polygon));
    return {
      ...room,
      polygon,
      area: Number(area.toFixed(2)),
    };
  });

  const scaledFurnitures = (payload.furnitures || []).map((item) => ({
    ...item,
    position: scalePoint(item.position),
    width: scaleLength(item.width, 0.6),
    depth: scaleLength(item.depth, 0.6),
  }));

  const scaledRoof = payload.roof
    ? {
      ...payload.roof,
      polygon: (payload.roof.polygon || []).map((point) => scalePoint(point)),
    }
    : payload.roof;

  const scaledConflicts = (payload.conflicts || []).map((conflict) => ({
    ...conflict,
    location: scalePoint(conflict.location),
  }));

  const priorScaleMPerPx = toFiniteScalar(payload.meta?.scale_m_per_px);
  const nextMeta = {
    ...(payload.meta || {}),
    scale_m_per_px: priorScaleMPerPx == null
      ? payload.meta?.scale_m_per_px
      : Number((priorScaleMPerPx * safeFactor).toFixed(10)),
  };

  return {
    ...payload,
    meta: nextMeta,
    walls: scaledWalls,
    wallSolids: scaledWallSolids.length > 0 ? scaledWallSolids : undefined,
    doors: scaledDoors,
    windows: scaledWindows,
    rooms: scaledRooms,
    furnitures: scaledFurnitures,
    roof: scaledRoof,
    conflicts: scaledConflicts,
  };
};

type ScaleReconciliationOutcome = {
  result: GeometricReconstruction;
  applied: boolean;
  factor: number;
  sampleCount: number;
  inlierCount: number;
};

const reconcileScaleFromDimensionHints = (
  payload: GeometricReconstruction,
  layoutHints: BlueprintLayoutHints | null
): ScaleReconciliationOutcome => {
  if (!layoutHints) {
    return { result: payload, applied: false, factor: 1, sampleCount: 0, inlierCount: 0 };
  }
  const rooms = payload?.rooms || [];
  if (rooms.length === 0) {
    return { result: payload, applied: false, factor: 1, sampleCount: 0, inlierCount: 0 };
  }

  const hints = extractRoomDimensionHints(layoutHints);
  if (hints.length < 2) {
    return { result: payload, applied: false, factor: 1, sampleCount: 0, inlierCount: 0 };
  }

  type ScaleSample = { ratio: number; spread: number; hintText: string };
  const samples: ScaleSample[] = [];

  for (const hint of hints) {
    const floorRooms = hint.floorLevel == null
      ? rooms
      : rooms.filter((room) => toFloorBucket(room?.floor_level) === toFloorBucket(hint.floorLevel));
    if (floorRooms.length === 0) continue;

    const mappedHintCenter = mapHintPointToModelSpace(hint.centerPx, layoutHints, payload, floorRooms);
    let best: { ratio: number; spread: number; score: number } | null = null;

    for (const room of floorRooms) {
      const bounds = collectRoomBounds(room?.polygon || []);
      if (!bounds) continue;
      const roomWidth = bounds.maxX - bounds.minX;
      const roomDepth = bounds.maxY - bounds.minY;
      if (roomWidth < 0.35 || roomDepth < 0.35) continue;

      const candidates = [
        { rw: hint.widthM / roomWidth, rd: hint.depthM / roomDepth },
        { rw: hint.widthM / roomDepth, rd: hint.depthM / roomWidth },
      ];

      for (const candidate of candidates) {
        const rw = candidate.rw;
        const rd = candidate.rd;
        if (!Number.isFinite(rw) || !Number.isFinite(rd)) continue;
        if (rw <= 0 || rd <= 0) continue;
        const ratio = Math.sqrt(rw * rd);
        if (!Number.isFinite(ratio) || ratio < 0.45 || ratio > 2.4) continue;

        const spread = Math.abs(Math.log(Math.max(rw, rd) / Math.max(1e-6, Math.min(rw, rd))));
        if (!Number.isFinite(spread)) continue;

        let centerPenalty = 0;
        if (mappedHintCenter) {
          const roomCenterX = (bounds.minX + bounds.maxX) / 2;
          const roomCenterY = (bounds.minY + bounds.maxY) / 2;
          const centerDistance = Math.hypot(roomCenterX - mappedHintCenter[0], roomCenterY - mappedHintCenter[1]);
          centerPenalty = centerDistance / Math.max(2.2, Math.max(hint.widthM, hint.depthM) * 2.2);
        }

        const score = spread + (centerPenalty * 0.2);
        if (!best || score < best.score) {
          best = { ratio, spread, score };
        }
      }
    }

    if (!best) continue;
    if (best.spread > 0.42) continue;
    samples.push({ ratio: best.ratio, spread: best.spread, hintText: hint.text });
  }

  if (samples.length < 2) {
    return { result: payload, applied: false, factor: 1, sampleCount: samples.length, inlierCount: 0 };
  }

  const median = computeMedian(samples.map((sample) => sample.ratio));
  if (median == null) {
    return { result: payload, applied: false, factor: 1, sampleCount: samples.length, inlierCount: 0 };
  }

  const deviations = samples.map((sample) => Math.abs(sample.ratio - median));
  const mad = computeMedian(deviations) ?? 0;
  const deviationLimit = Math.max(0.07, mad * 2.5);
  const inliers = samples.filter((sample) => Math.abs(sample.ratio - median) <= deviationLimit);
  if (inliers.length < 2) {
    return { result: payload, applied: false, factor: 1, sampleCount: samples.length, inlierCount: inliers.length };
  }

  const inlierMedian = computeMedian(inliers.map((sample) => sample.ratio));
  if (inlierMedian == null || !Number.isFinite(inlierMedian)) {
    return { result: payload, applied: false, factor: 1, sampleCount: samples.length, inlierCount: inliers.length };
  }

  const clampedFactor = clampNumber(inlierMedian, 0.78, 1.32);
  if (Math.abs(clampedFactor - 1) < 0.06) {
    return { result: payload, applied: false, factor: 1, sampleCount: samples.length, inlierCount: inliers.length };
  }

  const scaled = scalePlanarReconstruction(payload, clampedFactor);
  const currentScaleConfidence = toFiniteScalar(scaled.meta?.scale_confidence) ?? 0;
  const nextScaleConfidence = Number(
    Math.min(0.97, Math.max(currentScaleConfidence, inliers.length >= 4 ? 0.82 : 0.68)).toFixed(3)
  );
  scaled.meta = {
    ...(scaled.meta || {}),
    scale_confidence: nextScaleConfidence,
  };

  const location =
    scaled.rooms?.[0]?.polygon?.[0] ||
    scaled.walls?.[0]?.start ||
    [0, 0];
  scaled.conflicts = [
    ...(scaled.conflicts || []),
    {
      type: 'code',
      severity: 'low',
      description: `Applied robust scale reconciliation using ${inliers.length}/${samples.length} dimension-hint match(es) (factor ${clampedFactor.toFixed(3)}x).`,
      location: [Number(location[0] || 0), Number(location[1] || 0)] as [number, number],
    },
  ];

  return {
    result: scaled,
    applied: true,
    factor: clampedFactor,
    sampleCount: samples.length,
    inlierCount: inliers.length,
  };
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
    const mappedHintCenter = mapHintPointToModelSpace(hint.centerPx, layoutHints, result, floorRooms);
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
        hintCenter: mappedHintCenter,
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
      if (mappedHintCenter) {
        const centerX = (bounds.minX + bounds.maxX) / 2;
        const centerY = (bounds.minY + bounds.maxY) / 2;
        positionDistance = Math.hypot(centerX - mappedHintCenter[0], centerY - mappedHintCenter[1]);
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
        hintCenter: mappedHintCenter,
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
        hintCenter: mappedHintCenter,
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

const isDoorNearRoomBounds = (
  doorPosition: [number, number],
  bounds: { minX: number; maxX: number; minY: number; maxY: number },
  edgeTolerance = 0.35,
  padding = 0.22
): boolean => {
  const [x, y] = doorPosition;
  if (x < bounds.minX - padding || x > bounds.maxX + padding || y < bounds.minY - padding || y > bounds.maxY + padding) {
    return false;
  }
  const edgeDistance = Math.min(
    Math.abs(x - bounds.minX),
    Math.abs(x - bounds.maxX),
    Math.abs(y - bounds.minY),
    Math.abs(y - bounds.maxY)
  );
  return edgeDistance <= edgeTolerance;
};

const countRoomsWithoutDoorAccess = (result: GeometricReconstruction): number => {
  const rooms = result?.rooms || [];
  const doors = result?.doors || [];
  if (rooms.length === 0) return 0;

  let uncovered = 0;
  for (const room of rooms) {
    const bounds = collectRoomBounds(room?.polygon || []);
    if (!bounds) continue;
    const floor = toFloorBucket(room?.floor_level);
    const hasDoor = doors.some((door) => {
      if (toFloorBucket(door?.floor_level) !== floor) return false;
      const position = asPoint2D(door?.position);
      if (!position) return false;
      return isDoorNearRoomBounds(position, bounds, 0.38, 0.24);
    });
    if (!hasDoor) uncovered += 1;
  }
  return uncovered;
};

const inferDoorsFromRoomTopology = (
  walls: GeometricReconstruction['walls'],
  rooms: GeometricReconstruction['rooms'],
  existingDoors: GeometricReconstruction['doors']
): {
  doors: GeometricReconstruction['doors'];
  inferredCount: number;
  floors: number[];
} => {
  if (!Array.isArray(walls) || walls.length === 0 || !Array.isArray(rooms) || rooms.length === 0) {
    return { doors: existingDoors || [], inferredCount: 0, floors: [] };
  }

  const doors = [...(existingDoors || [])];
  const doorIds = new Set(doors.map((door) => String(door.id)));
  const floorsTouched = new Set<number>();
  let inferredCount = 0;

  const floorLevels = new Set<number>();
  for (const wall of walls) floorLevels.add(toFloorBucket(wall?.floor_level));
  for (const room of rooms) floorLevels.add(toFloorBucket(room?.floor_level));

  for (const floor of [...floorLevels].sort((a, b) => a - b)) {
    const floorWalls = walls.filter((wall) => toFloorBucket(wall?.floor_level) === floor);
    const floorRooms = rooms.filter((room) => toFloorBucket(room?.floor_level) === floor);
    if (floorWalls.length < 4 || floorRooms.length < 2) continue;

    const floorDoors = doors.filter((door) => toFloorBucket(door?.floor_level) === floor);
    const roomBounds = floorRooms
      .map((room) => ({ room, bounds: collectRoomBounds(room?.polygon || []) }))
      .filter((entry): entry is { room: GeometricReconstruction['rooms'][number]; bounds: NonNullable<ReturnType<typeof collectRoomBounds>> } => !!entry.bounds);
    if (roomBounds.length === 0) continue;

    const targetDoorFloorMin = Math.max(1, Math.floor(roomBounds.length * 0.32));
    if (floorDoors.length >= targetDoorFloorMin) continue;

    const uncovered = roomBounds.filter((entry) =>
      !floorDoors.some((door) => {
        const position = asPoint2D(door?.position);
        if (!position) return false;
        return isDoorNearRoomBounds(position, entry.bounds, 0.38, 0.24);
      })
    );
    if (uncovered.length === 0) continue;

    const candidateWalls = floorWalls.filter((wall) => pointDistance(wall.start, wall.end) >= 1);
    if (candidateWalls.length === 0) continue;

    const maxNewDoors = Math.max(1, Math.min(8, targetDoorFloorMin - floorDoors.length + Math.ceil(uncovered.length * 0.4)));
    let newDoorsForFloor = 0;

    for (const entry of uncovered) {
      if (newDoorsForFloor >= maxNewDoors) break;

      let best: { wall: GeometricReconstruction['walls'][number]; midpoint: [number, number]; score: number } | null = null;
      for (const wall of candidateWalls) {
        const midpoint: [number, number] = [
          Number(((wall.start[0] + wall.end[0]) * 0.5).toFixed(3)),
          Number(((wall.start[1] + wall.end[1]) * 0.5).toFixed(3)),
        ];
        const onBoundary = isDoorNearRoomBounds(midpoint, entry.bounds, Math.max(0.24, Number(wall.thickness || 0.115) * 2.4), 0.26);
        if (!onBoundary) continue;

        const nearExisting = doors.some((door) => {
          if (toFloorBucket(door?.floor_level) !== floor) return false;
          if (String(door.host_wall_id) !== String(wall.id)) return false;
          const p = asPoint2D(door?.position);
          return p ? pointDistance(p, midpoint) < 0.9 : false;
        });
        if (nearExisting) continue;

        const boundaryDistance = Math.min(
          Math.abs(midpoint[0] - entry.bounds.minX),
          Math.abs(midpoint[0] - entry.bounds.maxX),
          Math.abs(midpoint[1] - entry.bounds.minY),
          Math.abs(midpoint[1] - entry.bounds.maxY)
        );
        const lengthPenalty = 1 / Math.max(1, pointDistance(wall.start, wall.end));
        const exteriorPenalty = wall.is_exterior === true ? 0.24 : 0;
        const score = boundaryDistance + lengthPenalty + exteriorPenalty;
        if (!best || score < best.score) {
          best = { wall, midpoint, score };
        }
      }

      if (!best) continue;

      const id = buildUniqueId(doorIds, `inferred-door-f${floor}`);
      const inferredDoor: GeometricReconstruction['doors'][number] = {
        id,
        host_wall_id: best.wall.id,
        position: best.midpoint,
        width: 0.9,
        height: 2.1,
        swing: 'unknown',
        confidence: 0.35,
        floor_level: floor,
      };
      doors.push(inferredDoor);
      inferredCount += 1;
      newDoorsForFloor += 1;
      floorsTouched.add(floor);
    }
  }

  return {
    doors,
    inferredCount,
    floors: [...floorsTouched].sort((a, b) => a - b),
  };
};

const NON_HABITABLE_ROOM_REGEX = /\b(bath|toilet|wc|powder|closet|store|storage|utility|laundry|service|stair|staircase|stairwell|lift|elevator|shaft|core|corridor|passage|lobby|foyer|garage|carport|balcony|terrace|patio|verandah?|duct)\b/i;

const isLikelyHabitableRoomName = (value: unknown): boolean => {
  const text = normalizeSemanticText(value);
  if (!text) return true;
  return !NON_HABITABLE_ROOM_REGEX.test(text);
};

const isWallNearRoomBounds = (
  wall: GeometricReconstruction['walls'][number],
  bounds: NonNullable<ReturnType<typeof collectRoomBounds>>
): boolean => {
  const midpoint: [number, number] = [
    Number(((wall.start[0] + wall.end[0]) * 0.5).toFixed(3)),
    Number(((wall.start[1] + wall.end[1]) * 0.5).toFixed(3)),
  ];
  const edgeTolerance = Math.max(0.34, Number(wall.thickness || 0.115) * 2.8);
  if (isDoorNearRoomBounds(midpoint, bounds, edgeTolerance, 0.32)) return true;

  const cornerDistance = Math.min(
    pointToSegmentDistance([bounds.minX, bounds.minY], wall.start, wall.end),
    pointToSegmentDistance([bounds.minX, bounds.maxY], wall.start, wall.end),
    pointToSegmentDistance([bounds.maxX, bounds.minY], wall.start, wall.end),
    pointToSegmentDistance([bounds.maxX, bounds.maxY], wall.start, wall.end)
  );
  return Number.isFinite(cornerDistance) && cornerDistance <= Math.max(0.38, Number(wall.thickness || 0.115) * 3.2);
};

const inferEntryDoorsFromExteriorWalls = (
  walls: GeometricReconstruction['walls'],
  rooms: GeometricReconstruction['rooms'],
  existingDoors: GeometricReconstruction['doors']
): {
  doors: GeometricReconstruction['doors'];
  inferredCount: number;
  floors: number[];
} => {
  if (!Array.isArray(walls) || walls.length === 0) {
    return { doors: existingDoors || [], inferredCount: 0, floors: [] };
  }

  const doors = [...(existingDoors || [])];
  const doorIds = new Set(doors.map((door) => String(door.id)));
  const floorsTouched = new Set<number>();
  let inferredCount = 0;

  const floorLevels = new Set<number>();
  for (const wall of walls) floorLevels.add(toFloorBucket(wall?.floor_level));
  for (const room of rooms || []) floorLevels.add(toFloorBucket(room?.floor_level));

  for (const floor of [...floorLevels].sort((a, b) => a - b)) {
    const floorWalls = walls.filter((wall) => toFloorBucket(wall?.floor_level) === floor);
    const exteriorWalls = floorWalls
      .filter((wall) => wall?.is_exterior === true && pointDistance(wall.start, wall.end) >= 1.25);
    if (exteriorWalls.length === 0) continue;

    const floorDoors = doors.filter((door) => toFloorBucket(door?.floor_level) === floor);
    const hasExteriorDoor = floorDoors.some((door) => {
      const host = floorWalls.find((wall) => String(wall.id) === String(door?.host_wall_id));
      return host?.is_exterior === true;
    });
    if (hasExteriorDoor) continue;

    const roomBounds = (rooms || [])
      .filter((room) => toFloorBucket(room?.floor_level) === floor)
      .map((room) => ({ room, bounds: collectRoomBounds(room?.polygon || []) }))
      .filter((entry): entry is { room: GeometricReconstruction['rooms'][number]; bounds: NonNullable<ReturnType<typeof collectRoomBounds>> } => !!entry.bounds);
    if (roomBounds.length === 0) continue;

    const preferredRoom = roomBounds
      .filter((entry) => isLikelyHabitableRoomName(entry.room?.name))
      .sort((a, b) => b.bounds.area - a.bounds.area)[0] || roomBounds.sort((a, b) => b.bounds.area - a.bounds.area)[0];
    if (!preferredRoom) continue;

    let best: { wall: GeometricReconstruction['walls'][number]; midpoint: [number, number]; score: number } | null = null;
    for (const wall of exteriorWalls) {
      if (!isWallNearRoomBounds(wall, preferredRoom.bounds)) continue;
      const midpoint: [number, number] = [
        Number(((wall.start[0] + wall.end[0]) * 0.5).toFixed(3)),
        Number(((wall.start[1] + wall.end[1]) * 0.5).toFixed(3)),
      ];

      const nearExistingDoor = floorDoors.some((door) => {
        const position = asPoint2D(door?.position);
        return position ? pointDistance(position, midpoint) < 1.1 : false;
      });
      if (nearExistingDoor) continue;

      const center: [number, number] = [
        Number(((preferredRoom.bounds.minX + preferredRoom.bounds.maxX) * 0.5).toFixed(3)),
        Number(((preferredRoom.bounds.minY + preferredRoom.bounds.maxY) * 0.5).toFixed(3)),
      ];
      const roomDistance = pointDistance(center, midpoint);
      const wallLength = pointDistance(wall.start, wall.end);
      const score = roomDistance + (1 / Math.max(1, wallLength));
      if (!best || score < best.score) {
        best = { wall, midpoint, score };
      }
    }

    if (!best) continue;
    const id = buildUniqueId(doorIds, `inferred-entry-door-f${floor}`);
    doors.push({
      id,
      host_wall_id: best.wall.id,
      position: best.midpoint,
      width: 0.95,
      height: 2.1,
      swing: 'unknown',
      confidence: 0.32,
      floor_level: floor,
    });
    inferredCount += 1;
    floorsTouched.add(floor);
  }

  return {
    doors,
    inferredCount,
    floors: [...floorsTouched].sort((a, b) => a - b),
  };
};

const inferInteriorConnectivityDoors = (
  walls: GeometricReconstruction['walls'],
  rooms: GeometricReconstruction['rooms'],
  existingDoors: GeometricReconstruction['doors']
): {
  doors: GeometricReconstruction['doors'];
  inferredCount: number;
  floors: number[];
  unresolvedRooms: Array<{ floor: number; roomId: string | number; roomName: string }>;
} => {
  if (!Array.isArray(walls) || walls.length === 0 || !Array.isArray(rooms) || rooms.length < 2) {
    return { doors: existingDoors || [], inferredCount: 0, floors: [], unresolvedRooms: [] };
  }

  type RoomEntry = {
    index: number;
    room: GeometricReconstruction['rooms'][number];
    bounds: NonNullable<ReturnType<typeof collectRoomBounds>>;
    area: number;
  };

  type DoorBridgeCandidate = {
    wall: GeometricReconstruction['walls'][number];
    position: [number, number];
    score: number;
  };

  const doors = [...(existingDoors || [])];
  const doorIds = new Set(doors.map((door) => String(door.id)));
  const floorsTouched = new Set<number>();
  const unresolvedRooms: Array<{ floor: number; roomId: string | number; roomName: string }> = [];
  let inferredCount = 0;

  const floorLevels = new Set<number>();
  for (const wall of walls) floorLevels.add(toFloorBucket(wall?.floor_level));
  for (const room of rooms) floorLevels.add(toFloorBucket(room?.floor_level));

  const getSharedBoundaryCandidate = (
    a: NonNullable<ReturnType<typeof collectRoomBounds>>,
    b: NonNullable<ReturnType<typeof collectRoomBounds>>
  ): [number, number] | null => {
    const touchTol = 0.46;
    const minOverlap = 0.95;

    const verticalGap = Math.min(
      Math.abs(a.maxX - b.minX),
      Math.abs(b.maxX - a.minX)
    );
    if (verticalGap <= touchTol) {
      const overlapStart = Math.max(a.minY, b.minY);
      const overlapEnd = Math.min(a.maxY, b.maxY);
      const overlap = overlapEnd - overlapStart;
      if (overlap >= minOverlap) {
        const edgeX = Math.abs(a.maxX - b.minX) <= Math.abs(b.maxX - a.minX) ? (a.maxX + b.minX) * 0.5 : (b.maxX + a.minX) * 0.5;
        return [Number(edgeX.toFixed(3)), Number(((overlapStart + overlapEnd) * 0.5).toFixed(3))];
      }
    }

    const horizontalGap = Math.min(
      Math.abs(a.maxY - b.minY),
      Math.abs(b.maxY - a.minY)
    );
    if (horizontalGap <= touchTol) {
      const overlapStart = Math.max(a.minX, b.minX);
      const overlapEnd = Math.min(a.maxX, b.maxX);
      const overlap = overlapEnd - overlapStart;
      if (overlap >= minOverlap) {
        const edgeY = Math.abs(a.maxY - b.minY) <= Math.abs(b.maxY - a.minY) ? (a.maxY + b.minY) * 0.5 : (b.maxY + a.minY) * 0.5;
        return [Number(((overlapStart + overlapEnd) * 0.5).toFixed(3)), Number(edgeY.toFixed(3))];
      }
    }

    return null;
  };

  for (const floor of [...floorLevels].sort((a, b) => a - b)) {
    const floorWalls = walls.filter((wall) => toFloorBucket(wall?.floor_level) === floor);
    if (floorWalls.length < 4) continue;

    const floorRoomBounds = rooms
      .filter((room) => toFloorBucket(room?.floor_level) === floor)
      .map((room) => ({ room, bounds: collectRoomBounds(room?.polygon || []) }))
      .filter((entry): entry is { room: GeometricReconstruction['rooms'][number]; bounds: NonNullable<ReturnType<typeof collectRoomBounds>> } => !!entry.bounds);
    const roomEntries: RoomEntry[] = floorRoomBounds.map((entry, index) => ({
      index,
      room: entry.room,
      bounds: entry.bounds,
      area: entry.bounds.area,
    }));
    if (roomEntries.length < 2) continue;

    const candidateWalls = floorWalls
      .filter((wall) => wall?.is_exterior !== true && pointDistance(wall.start, wall.end) >= 0.9);
    const wallPool = candidateWalls.length > 0
      ? candidateWalls
      : floorWalls.filter((wall) => pointDistance(wall.start, wall.end) >= 0.9);
    if (wallPool.length === 0) continue;

    const wallById = new Map<string, GeometricReconstruction['walls'][number]>();
    for (const wall of floorWalls) wallById.set(String(wall.id), wall);

    const floorDoors = doors.filter((door) => toFloorBucket(door?.floor_level) === floor);

    const resolveDoorRoomIndices = (door: GeometricReconstruction['doors'][number]): number[] => {
      const position = asPoint2D(door?.position);
      if (!position) return [];
      const hostWall = wallById.get(String(door?.host_wall_id));
      const edgeTolerance = Math.max(0.36, Number(hostWall?.thickness || 0.115) * 2.9);

      const linked = roomEntries
        .filter((entry) => isDoorNearRoomBounds(position, entry.bounds, edgeTolerance, 0.3))
        .map((entry) => entry.index);
      return [...new Set(linked)];
    };

    const buildDoorAdjacency = (): Map<number, Set<number>> => {
      const graph = new Map<number, Set<number>>();
      for (const entry of roomEntries) graph.set(entry.index, new Set<number>());

      for (const door of floorDoors) {
        const linkedRooms = resolveDoorRoomIndices(door);
        if (linkedRooms.length < 2) continue;
        for (let i = 0; i < linkedRooms.length; i += 1) {
          for (let j = i + 1; j < linkedRooms.length; j += 1) {
            const a = linkedRooms[i];
            const b = linkedRooms[j];
            graph.get(a)?.add(b);
            graph.get(b)?.add(a);
          }
        }
      }

      return graph;
    };

    const pickSeedRooms = (): Set<number> => {
      const seeds = new Set<number>();

      for (const door of floorDoors) {
        const linkedRooms = resolveDoorRoomIndices(door);
        if (linkedRooms.length === 0) continue;
        const hostWall = wallById.get(String(door?.host_wall_id));
        if (hostWall?.is_exterior === true) {
          for (const roomIndex of linkedRooms) seeds.add(roomIndex);
        }
      }
      if (seeds.size > 0) return seeds;

      for (const door of floorDoors) {
        for (const roomIndex of resolveDoorRoomIndices(door)) seeds.add(roomIndex);
      }
      if (seeds.size > 0) return seeds;

      const entryLikeRoom = roomEntries.find((entry) => /\b(entry|foyer|lobby|vestibule)\b/i.test(normalizeSemanticText(entry.room?.name)));
      if (entryLikeRoom) {
        seeds.add(entryLikeRoom.index);
        return seeds;
      }

      const habitable = roomEntries
        .filter((entry) => isLikelyHabitableRoomName(entry.room?.name))
        .sort((a, b) => b.area - a.area)[0];
      const fallback = habitable || roomEntries.slice().sort((a, b) => b.area - a.area)[0];
      if (fallback) seeds.add(fallback.index);
      return seeds;
    };

    const computeReachableRooms = (
      graph: Map<number, Set<number>>,
      seeds: Set<number>
    ): Set<number> => {
      const reachable = new Set<number>();
      const queue: number[] = [...seeds];
      while (queue.length > 0) {
        const current = queue.shift();
        if (current == null || reachable.has(current)) continue;
        reachable.add(current);
        for (const next of graph.get(current) || []) {
          if (!reachable.has(next)) queue.push(next);
        }
      }
      return reachable;
    };

    const hasDoorForRoom = (entry: RoomEntry): boolean =>
      floorDoors.some((door) => {
        const position = asPoint2D(door?.position);
        return position ? isDoorNearRoomBounds(position, entry.bounds, 0.42, 0.26) : false;
      });

    const buildBridgeCandidate = (
      target: RoomEntry,
      neighbor: RoomEntry,
      neighborReachable: boolean
    ): DoorBridgeCandidate | null => {
      const sharedCandidate = getSharedBoundaryCandidate(target.bounds, neighbor.bounds);
      if (!sharedCandidate) return null;

      let best: { wall: GeometricReconstruction['walls'][number]; position: [number, number]; score: number } | null = null;
      for (const wall of wallPool) {
        const projected = closestPointOnSegment(sharedCandidate, wall.start, wall.end);
        const maxOffset = Math.max(0.34, Number(wall.thickness || 0.115) * 2.8);
        if (!Number.isFinite(projected.distance) || projected.distance > maxOffset) continue;

        const position: [number, number] = [
          Number(projected.point[0].toFixed(3)),
          Number(projected.point[1].toFixed(3)),
        ];
        const nearTarget = isDoorNearRoomBounds(position, target.bounds, maxOffset, 0.28);
        const nearNeighbor = isDoorNearRoomBounds(position, neighbor.bounds, maxOffset, 0.28);
        if (!nearTarget || !nearNeighbor) continue;

        const overlapsExisting = floorDoors.some((door) => {
          const point = asPoint2D(door?.position);
          return point ? pointDistance(point, position) < 0.95 : false;
        });
        if (overlapsExisting) continue;

        const wallLength = pointDistance(wall.start, wall.end);
        if (!Number.isFinite(wallLength) || wallLength < 0.8) continue;
        const sharedDistance = pointDistance(sharedCandidate, position);
        const exteriorPenalty = wall.is_exterior === true ? 0.85 : 0;
        const reachabilityPenalty = neighborReachable ? -0.22 : 0.22;
        const score = projected.distance + sharedDistance * 0.25 + exteriorPenalty + reachabilityPenalty + (1 / Math.max(1, wallLength));
        if (!best || score < best.score) best = { wall, position, score };
      }

      if (!best) return null;
      return {
        wall: best.wall,
        position: best.position,
        score: best.score,
      };
    };

    const maxNewDoors = Math.min(18, Math.max(3, roomEntries.length * 2));
    let newDoorsForFloor = 0;

    let doorGraph = buildDoorAdjacency();
    let seedRooms = pickSeedRooms();
    let reachableRooms = computeReachableRooms(doorGraph, seedRooms);

    while (newDoorsForFloor < maxNewDoors) {
      const disconnected = roomEntries
        .filter((entry) => !reachableRooms.has(entry.index))
        .sort((a, b) => b.area - a.area);
      if (disconnected.length === 0) break;

      let bestCandidate: DoorBridgeCandidate | null = null;
      for (const targetEntry of disconnected) {
        const reachableNeighbors = roomEntries.filter((entry) => entry.index !== targetEntry.index && reachableRooms.has(entry.index));
        const fallbackNeighbors = roomEntries.filter((entry) => entry.index !== targetEntry.index);
        const neighborPool = reachableNeighbors.length > 0 ? reachableNeighbors : fallbackNeighbors;
        if (neighborPool.length === 0) continue;

        for (const neighborEntry of neighborPool) {
          const candidate = buildBridgeCandidate(targetEntry, neighborEntry, reachableRooms.has(neighborEntry.index));
          if (!candidate) continue;
          if (!bestCandidate || candidate.score < bestCandidate.score) {
            bestCandidate = candidate;
          }
        }
      }

      if (!bestCandidate) break;

      const id = buildUniqueId(doorIds, `inferred-conn-door-f${floor}`);
      const inferredDoor: GeometricReconstruction['doors'][number] = {
        id,
        host_wall_id: bestCandidate.wall.id,
        position: bestCandidate.position,
        width: 0.9,
        height: 2.1,
        swing: 'unknown',
        confidence: 0.29,
        floor_level: floor,
      };
      doors.push(inferredDoor);
      floorDoors.push(inferredDoor);
      inferredCount += 1;
      newDoorsForFloor += 1;
      floorsTouched.add(floor);

      doorGraph = buildDoorAdjacency();
      seedRooms = pickSeedRooms();
      reachableRooms = computeReachableRooms(doorGraph, seedRooms);
    }

    const finalGraph = buildDoorAdjacency();
    const finalSeeds = pickSeedRooms();
    const finalReachable = computeReachableRooms(finalGraph, finalSeeds);
    const remaining = roomEntries.filter((entry) => !finalReachable.has(entry.index) || !hasDoorForRoom(entry));
    for (const entry of remaining) {
      unresolvedRooms.push({
        floor,
        roomId: entry.room.id,
        roomName: String(entry.room.name || `Room ${entry.room.id}`),
      });
    }
  }

  return {
    doors,
    inferredCount,
    floors: [...floorsTouched].sort((a, b) => a - b),
    unresolvedRooms,
  };
};

const inferWindowsFromHabitableRoomTopology = (
  walls: GeometricReconstruction['walls'],
  rooms: GeometricReconstruction['rooms'],
  doors: GeometricReconstruction['doors'],
  existingWindows: GeometricReconstruction['windows']
): {
  windows: GeometricReconstruction['windows'];
  inferredCount: number;
  floors: number[];
} => {
  if (!Array.isArray(walls) || walls.length === 0 || !Array.isArray(rooms) || rooms.length === 0) {
    return { windows: existingWindows || [], inferredCount: 0, floors: [] };
  }

  const windows = [...(existingWindows || [])];
  const windowIds = new Set(windows.map((win) => String(win.id)));
  const floorsTouched = new Set<number>();
  let inferredCount = 0;

  const floorLevels = new Set<number>();
  for (const wall of walls) floorLevels.add(toFloorBucket(wall?.floor_level));
  for (const room of rooms) floorLevels.add(toFloorBucket(room?.floor_level));

  for (const floor of [...floorLevels].sort((a, b) => a - b)) {
    const floorWalls = walls.filter((wall) => toFloorBucket(wall?.floor_level) === floor);
    const exteriorWalls = floorWalls
      .filter((wall) => wall?.is_exterior === true && pointDistance(wall.start, wall.end) >= 1.2);
    if (exteriorWalls.length === 0) continue;

    const floorDoors = (doors || []).filter((door) => toFloorBucket(door?.floor_level) === floor);
    const floorWindows = windows.filter((win) => toFloorBucket(win?.floor_level) === floor);
    const habitableRooms = rooms
      .filter((room) => toFloorBucket(room?.floor_level) === floor && isLikelyHabitableRoomName(room?.name))
      .map((room) => ({ room, bounds: collectRoomBounds(room?.polygon || []) }))
      .filter((entry): entry is { room: GeometricReconstruction['rooms'][number]; bounds: NonNullable<ReturnType<typeof collectRoomBounds>> } => !!entry.bounds);
    if (habitableRooms.length === 0) continue;

    const maxNewForFloor = Math.min(10, habitableRooms.length);
    let newForFloor = 0;

    for (const entry of habitableRooms) {
      if (newForFloor >= maxNewForFloor) break;
      const hasWindowAlready = floorWindows.some((win) => {
        const position = asPoint2D(win?.position);
        return position ? isDoorNearRoomBounds(position, entry.bounds, 0.58, 0.28) : false;
      });
      if (hasWindowAlready) continue;

      let best: { wall: GeometricReconstruction['walls'][number]; midpoint: [number, number]; score: number } | null = null;
      for (const wall of exteriorWalls) {
        if (!isWallNearRoomBounds(wall, entry.bounds)) continue;
        const midpoint: [number, number] = [
          Number(((wall.start[0] + wall.end[0]) * 0.5).toFixed(3)),
          Number(((wall.start[1] + wall.end[1]) * 0.5).toFixed(3)),
        ];

        const nearDoor = floorDoors.some((door) => {
          const position = asPoint2D(door?.position);
          return position ? pointDistance(position, midpoint) < 1.15 : false;
        });
        if (nearDoor) continue;

        const nearWindow = floorWindows.some((win) => {
          const position = asPoint2D(win?.position);
          return position ? pointDistance(position, midpoint) < 1.0 : false;
        });
        if (nearWindow) continue;

        const center: [number, number] = [
          Number(((entry.bounds.minX + entry.bounds.maxX) * 0.5).toFixed(3)),
          Number(((entry.bounds.minY + entry.bounds.maxY) * 0.5).toFixed(3)),
        ];
        const roomDistance = pointDistance(center, midpoint);
        const wallLength = pointDistance(wall.start, wall.end);
        const score = roomDistance + (1 / Math.max(1, wallLength));
        if (!best || score < best.score) {
          best = { wall, midpoint, score };
        }
      }

      if (!best) continue;
      const wallLength = pointDistance(best.wall.start, best.wall.end);
      const inferredWidth = Number(Math.min(1.8, Math.max(0.9, wallLength * 0.28)).toFixed(3));
      const id = buildUniqueId(windowIds, `inferred-window-f${floor}`);
      const inferredWindow: GeometricReconstruction['windows'][number] = {
        id,
        host_wall_id: best.wall.id,
        position: best.midpoint,
        width: inferredWidth,
        sill_height: 0.9,
        confidence: 0.31,
        floor_level: floor,
      };
      windows.push(inferredWindow);
      floorWindows.push(inferredWindow);
      inferredCount += 1;
      newForFloor += 1;
      floorsTouched.add(floor);
    }
  }

  return {
    windows,
    inferredCount,
    floors: [...floorsTouched].sort((a, b) => a - b),
  };
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

type OpeningRecoveryDecision = {
  shouldAttempt: boolean;
  reasons: string[];
  semanticScore: number;
  semanticConfidence: number;
  promptGuidance: string;
};

type InteriorRecoveryDecision = {
  shouldAttempt: boolean;
  placeholder: boolean;
  reasons: string[];
  denseFloors: number;
  gridLikeFloors: number;
  averageInteriorWallsPerFloor: number;
  interiorWallCount: number;
  semanticAnchorCount: number;
  dimensionHintCount: number;
  dimensionMismatchCount: number;
};

const shouldAttemptOpeningRecovery = (
  result: GeometricReconstruction,
  layoutHints: BlueprintLayoutHints | null,
  lineRecords?: BlueprintLineRecord[]
): OpeningRecoveryDecision => {
  const semanticAssessment = assessOpeningSemantics(layoutHints, result, { lineRecords });
  const floorSignals = estimateFloorHintCount(layoutHints);
  const inferredFloorCount = Math.max(1, estimateResultFloorCount(result));
  const walls = result?.walls?.length || 0;
  const rooms = result?.rooms?.length || 0;
  const openings = getOpeningCount(result);
  const uncoveredRooms = countRoomsWithoutDoorAccess(result);
  const openingsPerFloor = openings / inferredFloorCount;
  const roomsPerFloor = rooms / inferredFloorCount;
  const reasons: string[] = [...semanticAssessment.reasons];

  const strictMultiFloorEligible =
    Math.max(floorSignals, inferredFloorCount) >= 2 &&
    walls >= 10 &&
    rooms >= 6 &&
    openings < Math.max(6, Math.round(walls * 0.45)) &&
    openingsPerFloor < Math.max(0.7, roomsPerFloor * 0.5);

  const relaxedFallbackEligible =
    walls >= 8 &&
    rooms >= 3 &&
    openings < Math.max(2, Math.round(walls * 0.22));

  const roomAccessibilityEligible =
    rooms >= 3 &&
    uncoveredRooms >= Math.max(1, Math.round(rooms * 0.34));

  const shouldAttempt =
    strictMultiFloorEligible ||
    semanticAssessment.shouldAttemptRecovery ||
    relaxedFallbackEligible ||
    roomAccessibilityEligible;
  if (strictMultiFloorEligible) {
    reasons.push("Multi-floor topology indicates missing openings relative to wall/room density.");
  }
  if (relaxedFallbackEligible && !strictMultiFloorEligible) {
    reasons.push("Relaxed opening gate activated: wall-room complexity suggests likely missed door/window symbols.");
  }
  if (roomAccessibilityEligible) {
    reasons.push(`Detected ${uncoveredRooms} room(s) without nearby door access; recover non-text door symbols using wall-gap and topology cues.`);
  }

  return {
    shouldAttempt,
    reasons: reasons.slice(0, 5),
    semanticScore: semanticAssessment.score,
    semanticConfidence: semanticAssessment.confidence,
    promptGuidance: semanticAssessment.promptGuidance,
  };
};

const assessInteriorLayoutRecovery = (
  result: GeometricReconstruction,
  layoutHints: BlueprintLayoutHints | null
): InteriorRecoveryDecision => {
  const interiorSignal = analyzeInteriorLayoutSignal(result);
  const floorSignals = estimateFloorHintCount(layoutHints);
  const inferredFloorCount = Math.max(1, estimateResultFloorCount(result));
  const walls = result?.walls?.length || 0;
  const rooms = result?.rooms?.length || 0;
  const interiorWallCount = (result?.walls || []).filter((wall) => wall?.is_exterior === false).length;
  const semanticAnchorCount = collectLayoutSemanticAnchors(layoutHints).length;
  const dimensionAssessment = estimateRoomDimensionAlignment(layoutHints, result);
  const dimensionHintCount = dimensionAssessment.hintCount;
  const dimensionMismatchCount = dimensionAssessment.mismatches.length;
  const reasons = [...interiorSignal.reasons];

  if (walls < 8 || rooms < 3) {
    return {
      shouldAttempt: false,
      placeholder: interiorSignal.placeholder,
      reasons: reasons.slice(0, 5),
      denseFloors: interiorSignal.denseFloors,
      gridLikeFloors: interiorSignal.gridLikeFloors,
      averageInteriorWallsPerFloor: interiorSignal.averageInteriorWallsPerFloor,
      interiorWallCount,
      semanticAnchorCount,
      dimensionHintCount,
      dimensionMismatchCount,
    };
  }

  const placeholderDriven =
    interiorSignal.placeholder &&
    (Math.max(floorSignals, inferredFloorCount) >= 2 || interiorSignal.gridLikeFloors >= 1 || rooms >= 6);
  const dimensionDriven =
    dimensionAssessment.shouldRetry &&
    dimensionHintCount >= 2 &&
    dimensionMismatchCount >= Math.max(2, Math.min(5, Math.ceil(dimensionHintCount * 0.4)));
  const semanticDensityDriven =
    semanticAnchorCount >= 4 &&
    rooms < Math.max(2, Math.ceil(semanticAnchorCount * 0.7));
  const lowInteriorWallDensityDriven =
    (dimensionHintCount >= 6 || semanticAnchorCount >= 5) &&
    interiorWallCount < Math.max(3, Math.ceil(rooms * 0.5));

  if (dimensionDriven) {
    reasons.push(
      `Interior wall placement appears inconsistent with room dimension anchors (${dimensionMismatchCount}/${dimensionHintCount} mismatches).`
    );
  }
  if (semanticDensityDriven) {
    reasons.push(
      `Blueprint exposes ${semanticAnchorCount} room/space label anchor(s) but reconstruction only yields ${rooms} room polygon(s); recover room-defining interior partitions.`
    );
  }
  if (lowInteriorWallDensityDriven) {
    reasons.push(
      `Interior wall count (${interiorWallCount}) is low relative to semantic/dimension evidence; likely missing or misplaced partitions.`
    );
  }

  return {
    shouldAttempt: placeholderDriven || dimensionDriven || semanticDensityDriven || lowInteriorWallDensityDriven,
    placeholder: interiorSignal.placeholder,
    reasons: Array.from(new Set(reasons.map((reason) => reason.trim()).filter(Boolean))).slice(0, 6),
    denseFloors: interiorSignal.denseFloors,
    gridLikeFloors: interiorSignal.gridLikeFloors,
    averageInteriorWallsPerFloor: interiorSignal.averageInteriorWallsPerFloor,
    interiorWallCount,
    semanticAnchorCount,
    dimensionHintCount,
    dimensionMismatchCount,
  };
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

const estimateNonOrthogonalWallRatio = (walls: GeometricReconstruction['walls']): number => {
  let nonOrthogonalLength = 0;
  let totalLength = 0;
  for (const wall of walls || []) {
    const dx = Number(wall?.end?.[0] || 0) - Number(wall?.start?.[0] || 0);
    const dz = Number(wall?.end?.[1] || 0) - Number(wall?.start?.[1] || 0);
    const length = Math.hypot(dx, dz);
    if (!Number.isFinite(length) || length < 0.2) continue;
    totalLength += length;

    const angle = Math.abs((Math.atan2(dz, dx) * 180) / Math.PI);
    const normalized = ((angle % 180) + 180) % 180;
    const deviation = Math.min(
      Math.abs(normalized - 0),
      Math.abs(normalized - 90),
      Math.abs(normalized - 180)
    );
    if (deviation >= 10) nonOrthogonalLength += length;
  }
  if (totalLength <= 1e-6) return 0;
  return nonOrthogonalLength / totalLength;
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

type FootprintShapeClass = 'compact' | 'elongated' | 'irregular' | 'complex';
type FootprintSizeClass = 'small' | 'medium' | 'large';
type FootprintProfile = {
  polygon: [number, number][];
  area: number;
  aspectRatio: number;
  compactness: number;
  concavity: number;
  shapeClass: FootprintShapeClass;
  sizeClass: FootprintSizeClass;
  roomMinArea: number;
  roomMaxShare: number;
  recommendedRoofType: RoofGeometry['type'];
};

const polygonPerimeter = (polygon: [number, number][]): number => {
  if (!Array.isArray(polygon) || polygon.length < 2) return 0;
  let perimeter = 0;
  for (let i = 0; i < polygon.length; i += 1) {
    perimeter += pointDistance(polygon[i], polygon[(i + 1) % polygon.length]);
  }
  return perimeter;
};

const computeFootprintProfileFromPolygon = (polygon: [number, number][]): FootprintProfile | null => {
  if (!Array.isArray(polygon) || polygon.length < 3) return null;
  const area = Math.abs(polygonArea(polygon));
  if (!Number.isFinite(area) || area < 4) return null;

  const bounds = collectRoomBounds(polygon);
  if (!bounds) return null;
  const width = Math.max(0.01, bounds.maxX - bounds.minX);
  const depth = Math.max(0.01, bounds.maxY - bounds.minY);
  const aspectRatio = Number((Math.max(width, depth) / Math.max(0.01, Math.min(width, depth))).toFixed(3));

  const perimeter = polygonPerimeter(polygon);
  const compactnessRaw = perimeter > 1e-6 ? (4 * Math.PI * area) / (perimeter * perimeter) : 0;
  const compactness = Number(clampNumber(compactnessRaw, 0, 1).toFixed(3));

  const hull = convexHull(dedupe2DPoints(polygon));
  const hullArea = Math.abs(polygonArea(hull));
  const concavityRaw = hullArea > 1e-6 ? (hullArea - area) / hullArea : 0;
  const concavity = Number(clampNumber(concavityRaw, 0, 0.95).toFixed(3));

  let shapeClass: FootprintShapeClass = 'complex';
  if (concavity >= 0.14 || polygon.length >= 9) shapeClass = 'irregular';
  else if (aspectRatio >= 1.85) shapeClass = 'elongated';
  else if (compactness >= 0.62 && aspectRatio <= 1.35) shapeClass = 'compact';

  const sizeClass: FootprintSizeClass =
    area < 80 ? 'small' : area < 220 ? 'medium' : 'large';

  const baseMinArea =
    sizeClass === 'small' ? 3.4 :
    sizeClass === 'medium' ? 4.8 : 6.4;
  const roomMinArea = Number(
    clampNumber(
      baseMinArea *
      (shapeClass === 'elongated' ? 0.9 : shapeClass === 'irregular' ? 0.86 : shapeClass === 'compact' ? 0.96 : 1),
      2.4,
      12
    ).toFixed(2)
  );

  const roomMaxShare = Number(
    clampNumber(
      shapeClass === 'compact'
        ? 0.72
        : shapeClass === 'elongated'
          ? 0.79
          : shapeClass === 'irregular'
            ? 0.86
            : 0.82,
      0.68,
      0.9
    ).toFixed(3)
  );

  const recommendedRoofType: RoofGeometry['type'] =
    shapeClass === 'irregular'
      ? 'flat'
      : shapeClass === 'elongated'
        ? 'gable'
        : (shapeClass === 'compact' && sizeClass !== 'small')
          ? 'hip'
          : 'gable';

  return {
    polygon,
    area: Number(area.toFixed(2)),
    aspectRatio,
    compactness,
    concavity,
    shapeClass,
    sizeClass,
    roomMinArea,
    roomMaxShare,
    recommendedRoofType,
  };
};

const deriveFootprintProfileFromWalls = (
  walls: GeometricReconstruction['walls']
): FootprintProfile | null => {
  if (!Array.isArray(walls) || walls.length < 3) return null;
  const exteriorWalls = walls.filter((wall) => wall?.is_exterior === true);
  const sourceWalls = exteriorWalls.length >= 3 ? exteriorWalls : walls;
  const points = dedupe2DPoints(
    sourceWalls
      .flatMap((wall) => [wall.start, wall.end])
      .filter((point): point is [number, number] => Array.isArray(point) && point.length >= 2)
  );
  if (points.length < 3) return null;
  let polygon =
    extractConcaveBoundaryFromWalls(sourceWalls.map((wall) => ({ start: wall.start, end: wall.end }))) ||
    convexHull(points);
  if (!polygon || polygon.length < 3) return null;
  if (polygonArea(polygon) < 0) polygon = [...polygon].reverse();
  return computeFootprintProfileFromPolygon(polygon);
};

const estimateMaxWallTopElevation = (walls: GeometricReconstruction['walls']): number => {
  if (!Array.isArray(walls) || walls.length === 0) return 2.8;

  const wallHeightByFloor = new Map<number, number>();
  for (const wall of walls) {
    const floorLevel = toFloorBucket(wall?.floor_level);
    const wallHeightRaw = Number(wall?.height);
    const wallHeight = Math.max(2.2, Number.isFinite(wallHeightRaw) ? wallHeightRaw : 2.8);
    const current = wallHeightByFloor.get(floorLevel) || 0;
    wallHeightByFloor.set(floorLevel, Math.max(current, wallHeight));
  }

  const sampledHeights = [...wallHeightByFloor.values()].filter((height) => Number.isFinite(height) && height > 0);
  const averageHeight =
    sampledHeights.length > 0
      ? sampledHeights.reduce((sum, height) => sum + height, 0) / sampledHeights.length
      : 2.8;
  const fallbackHeight = Math.max(2.2, Number(averageHeight.toFixed(3)));

  const maxFloorLevel = Math.max(0, ...walls.map((wall) => toFloorBucket(wall?.floor_level)));
  const floorBaseByLevel = new Map<number, number>();
  let runningY = 0;
  for (let level = 0; level <= maxFloorLevel; level += 1) {
    floorBaseByLevel.set(level, Number(runningY.toFixed(3)));
    runningY += wallHeightByFloor.get(level) || fallbackHeight;
  }

  let maxWallTop = 0;
  for (const wall of walls) {
    const floorLevel = toFloorBucket(wall?.floor_level);
    const baseY = floorBaseByLevel.get(floorLevel) || 0;
    const wallHeightRaw = Number(wall?.height);
    const wallHeight = Math.max(2.2, Number.isFinite(wallHeightRaw) ? wallHeightRaw : fallbackHeight);
    const baseOffsetRaw = Number(wall?.base_offset);
    const baseOffset = Number.isFinite(baseOffsetRaw) ? baseOffsetRaw : 0;
    maxWallTop = Math.max(maxWallTop, baseY + baseOffset + wallHeight);
  }

  return Number(maxWallTop > 0 ? maxWallTop.toFixed(3) : fallbackHeight.toFixed(3));
};

const inferRoofFromWallFootprint = (payload: GeometricReconstruction): GeometricReconstruction => {
  if (payload.roof || !Array.isArray(payload.walls) || payload.walls.length < 3) {
    return payload;
  }

  const footprintProfile = deriveFootprintProfileFromWalls(payload.walls);
  if (!footprintProfile) return payload;

  const maxWallTopElevation = estimateMaxWallTopElevation(payload.walls);
  const roofType = footprintProfile.recommendedRoofType;
  const roofHeightBase =
    footprintProfile.sizeClass === 'small'
      ? 1.05
      : footprintProfile.sizeClass === 'medium'
        ? 1.35
        : 1.65;
  const roofHeight = Number(
    (
      roofType === 'flat'
        ? roofHeightBase * 0.75
        : roofType === 'hip'
          ? roofHeightBase * 1.08
          : roofHeightBase * 1.0
    ).toFixed(2)
  );
  const nextConflicts = [...(payload.conflicts || [])];
  nextConflicts.push({
    type: 'code',
    severity: 'low',
    description: `Roof profile inferred from footprint (${footprintProfile.shapeClass}, ${footprintProfile.area.toFixed(1)} m2, aspect ${footprintProfile.aspectRatio.toFixed(2)}): selected "${roofType}" roof.`,
    location: footprintProfile.polygon[0],
  });

  return {
    ...payload,
    roof: {
      type: roofType,
      polygon: footprintProfile.polygon,
      height: roofHeight,
      base_height: Number(maxWallTopElevation.toFixed(2)),
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

const computeMedian = (values: number[]): number | null => {
  if (!Array.isArray(values) || values.length === 0) return null;
  const sorted = [...values]
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
};

const repairWallEndpointContinuity = (
  walls: GeometricReconstruction['walls'],
  tolerance = 0.12
): { walls: GeometricReconstruction['walls']; bridgedPairs: number } => {
  if (!Array.isArray(walls) || walls.length < 2) {
    return { walls, bridgedPairs: 0 };
  }

  type EndpointRef = {
    wallIndex: number;
    atStart: boolean;
    point: [number, number];
    directionAway: [number, number];
    length: number;
  };

  const endpointGap = Math.max(0.08, Math.min(0.26, tolerance * 1.6));
  const minJoinAngle = (10 * Math.PI) / 180;
  const maxMoveRatio = 0.24;

  const endpoints: EndpointRef[] = [];
  for (let wallIndex = 0; wallIndex < walls.length; wallIndex += 1) {
    const wall = walls[wallIndex];
    const dx = Number(wall.end?.[0]) - Number(wall.start?.[0]);
    const dz = Number(wall.end?.[1]) - Number(wall.start?.[1]);
    const length = Math.hypot(dx, dz);
    if (!Number.isFinite(length) || length < 1e-6) continue;
    const ux = dx / length;
    const uz = dz / length;

    endpoints.push({
      wallIndex,
      atStart: true,
      point: [Number(wall.start[0]), Number(wall.start[1])],
      directionAway: [ux, uz],
      length,
    });
    endpoints.push({
      wallIndex,
      atStart: false,
      point: [Number(wall.end[0]), Number(wall.end[1])],
      directionAway: [-ux, -uz],
      length,
    });
  }

  if (endpoints.length < 2) return { walls, bridgedPairs: 0 };

  const updateMap = new Map<string, [number, number]>();
  const consumed = new Set<number>();
  let bridgedPairs = 0;

  const endpointKey = (endpoint: EndpointRef) => `${endpoint.wallIndex}:${endpoint.atStart ? 1 : 0}`;

  for (let i = 0; i < endpoints.length; i += 1) {
    if (consumed.has(i)) continue;
    const a = endpoints[i];

    let bestIdx = -1;
    let bestDistance = Number.POSITIVE_INFINITY;

    for (let j = i + 1; j < endpoints.length; j += 1) {
      if (consumed.has(j)) continue;
      const b = endpoints[j];
      if (a.wallIndex === b.wallIndex) continue;

      const distance = pointDistance(a.point, b.point);
      if (!Number.isFinite(distance) || distance > endpointGap) continue;

      const moveA = distance * 0.5;
      const moveB = distance * 0.5;
      if (moveA > (a.length * maxMoveRatio) + 0.03) continue;
      if (moveB > (b.length * maxMoveRatio) + 0.03) continue;

      const dot = clampNumber(
        (a.directionAway[0] * b.directionAway[0]) + (a.directionAway[1] * b.directionAway[1]),
        -1,
        1
      );
      const angle = Math.acos(dot);
      if (!Number.isFinite(angle) || angle < minJoinAngle) continue;

      if (distance < bestDistance) {
        bestDistance = distance;
        bestIdx = j;
      }
    }

    if (bestIdx < 0) continue;
    const b = endpoints[bestIdx];
    const midpoint: [number, number] = [
      Number(((a.point[0] + b.point[0]) / 2).toFixed(3)),
      Number(((a.point[1] + b.point[1]) / 2).toFixed(3)),
    ];
    updateMap.set(endpointKey(a), midpoint);
    updateMap.set(endpointKey(b), midpoint);
    consumed.add(i);
    consumed.add(bestIdx);
    bridgedPairs += 1;
  }

  if (updateMap.size === 0) return { walls, bridgedPairs: 0 };

  const adjustedWalls: GeometricReconstruction['walls'] = walls.map((wall, wallIndex) => {
    const start: [number, number] = updateMap.get(`${wallIndex}:1`) ?? [Number(wall.start[0]), Number(wall.start[1])];
    const end: [number, number] = updateMap.get(`${wallIndex}:0`) ?? [Number(wall.end[0]), Number(wall.end[1])];
    const normalizedStart: [number, number] = [Number(start[0].toFixed(3)), Number(start[1].toFixed(3))];
    const normalizedEnd: [number, number] = [Number(end[0].toFixed(3)), Number(end[1].toFixed(3))];
    return {
      ...wall,
      start: normalizedStart,
      end: normalizedEnd,
    };
  }).filter((wall) => pointDistance(wall.start, wall.end) >= 0.25);

  return { walls: adjustedWalls, bridgedPairs };
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

const cellIndex = (col: number, row: number, cols: number) => (row * cols) + col;

const dedupePolygonPoints = (points: [number, number][]): [number, number][] => {
  if (points.length <= 1) return points;
  const out: [number, number][] = [];
  for (const point of points) {
    const prev = out[out.length - 1];
    if (prev && pointDistance(prev, point) < 1e-5) continue;
    out.push(point);
  }
  if (out.length > 1 && pointDistance(out[0], out[out.length - 1]) < 1e-5) {
    out.pop();
  }
  return out;
};

const simplifyOrthogonalPolygon = (points: [number, number][]): [number, number][] => {
  if (points.length < 4) return points;
  const output: [number, number][] = [];
  const n = points.length;
  const collinearTolerance = 1e-4;
  for (let i = 0; i < n; i += 1) {
    const prev = points[(i - 1 + n) % n];
    const curr = points[i];
    const next = points[(i + 1) % n];
    const v1x = curr[0] - prev[0];
    const v1y = curr[1] - prev[1];
    const v2x = next[0] - curr[0];
    const v2y = next[1] - curr[1];
    const cross = Math.abs((v1x * v2y) - (v1y * v2x));
    if (cross <= collinearTolerance) continue;
    output.push(curr);
  }
  return dedupePolygonPoints(output);
};

const extractLargestBoundaryLoopFromCells = (
  componentCells: Set<number>,
  cols: number,
  rows: number,
  originX: number,
  originY: number,
  cellSize: number
): [number, number][] | null => {
  if (componentCells.size === 0) return null;

  type Edge = { start: [number, number]; end: [number, number] };
  const edges: Edge[] = [];
  const pushEdge = (start: [number, number], end: [number, number]) => {
    edges.push({
      start: [Number(start[0].toFixed(4)), Number(start[1].toFixed(4))],
      end: [Number(end[0].toFixed(4)), Number(end[1].toFixed(4))],
    });
  };
  const hasCell = (col: number, row: number): boolean => {
    if (col < 0 || row < 0 || col >= cols || row >= rows) return false;
    return componentCells.has(cellIndex(col, row, cols));
  };

  for (const index of componentCells) {
    const col = index % cols;
    const row = Math.floor(index / cols);
    const x0 = originX + (col * cellSize);
    const x1 = x0 + cellSize;
    const y0 = originY + (row * cellSize);
    const y1 = y0 + cellSize;

    if (!hasCell(col, row - 1)) pushEdge([x0, y0], [x1, y0]);
    if (!hasCell(col + 1, row)) pushEdge([x1, y0], [x1, y1]);
    if (!hasCell(col, row + 1)) pushEdge([x1, y1], [x0, y1]);
    if (!hasCell(col - 1, row)) pushEdge([x0, y1], [x0, y0]);
  }

  if (edges.length < 4) return null;

  const startMap = new Map<string, number[]>();
  const pointKeyLocal = (point: [number, number]) => `${point[0].toFixed(4)},${point[1].toFixed(4)}`;
  for (let i = 0; i < edges.length; i += 1) {
    const key = pointKeyLocal(edges[i].start);
    const bucket = startMap.get(key) || [];
    bucket.push(i);
    startMap.set(key, bucket);
  }

  const unused = new Set<number>(edges.map((_, i) => i));
  const loops: [number, number][][] = [];

  while (unused.size > 0) {
    const first = unused.values().next().value as number;
    const edge = edges[first];
    const loop: [number, number][] = [edge.start];
    let cursor = edge.end;
    unused.delete(first);

    let guard = 0;
    const guardLimit = edges.length + 10;
    while (guard++ < guardLimit) {
      loop.push(cursor);
      if (pointDistance(cursor, loop[0]) < 1e-5) break;
      const key = pointKeyLocal(cursor);
      const candidates = (startMap.get(key) || []).filter((idx) => unused.has(idx));
      if (candidates.length === 0) break;
      const nextIdx = candidates[0];
      unused.delete(nextIdx);
      cursor = edges[nextIdx].end;
    }

    const deduped = dedupePolygonPoints(loop);
    if (deduped.length >= 3) loops.push(deduped);
  }

  if (loops.length === 0) return null;
  loops.sort((a, b) => Math.abs(polygonArea(b)) - Math.abs(polygonArea(a)));
  let polygon = simplifyOrthogonalPolygon(loops[0]);
  if (polygon.length < 3) return null;
  if (polygonArea(polygon) < 0) polygon = [...polygon].reverse();
  return polygon.map((point) => [Number(point[0].toFixed(3)), Number(point[1].toFixed(3))] as [number, number]);
};

const buildDeterministicRoomsFromWallRaster = (
  walls: GeometricReconstruction['walls'],
  existingRooms: GeometricReconstruction['rooms'],
  floorLevel: number,
  footprintProfile: FootprintProfile | null = null
): GeometricReconstruction['rooms'] => {
  if (!Array.isArray(walls) || walls.length < 4) return [];

  const points = walls.flatMap((wall) => [wall.start, wall.end]);
  const xs = points.map((point) => Number(point?.[0])).filter((value) => Number.isFinite(value));
  const ys = points.map((point) => Number(point?.[1])).filter((value) => Number.isFinite(value));
  if (xs.length === 0 || ys.length === 0) return [];

  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const width = maxX - minX;
  const height = maxY - minY;
  if (width < 2 || height < 2) return [];
  const planArea = footprintProfile?.area || (width * height);
  const minRoomArea = footprintProfile?.roomMinArea || Number(clampNumber(planArea * 0.042, 2.4, 9).toFixed(2));
  const maxRoomAreaShare = footprintProfile?.roomMaxShare || 0.84;
  const maxRoomArea = Math.max(minRoomArea * 1.8, planArea * maxRoomAreaShare);

  const longestSpan = Math.max(width, height);
  let cellSize = Math.max(0.1, Math.min(0.28, longestSpan / 120));
  const margin = cellSize * 2;
  const maxGrid = 280;
  let cols = Math.max(24, Math.ceil((width + margin * 2) / cellSize));
  let rows = Math.max(24, Math.ceil((height + margin * 2) / cellSize));
  if (cols > maxGrid || rows > maxGrid) {
    const scaleUp = Math.max(cols / maxGrid, rows / maxGrid);
    cellSize *= scaleUp;
    cols = Math.max(24, Math.ceil((width + margin * 2) / cellSize));
    rows = Math.max(24, Math.ceil((height + margin * 2) / cellSize));
  }
  if (cols > 320 || rows > 320) return [];

  const originX = minX - margin;
  const originY = minY - margin;
  const blocked = new Uint8Array(cols * rows);

  const markBlocked = (col: number, row: number, radiusCell: number) => {
    for (let dy = -radiusCell; dy <= radiusCell; dy += 1) {
      const ny = row + dy;
      if (ny < 0 || ny >= rows) continue;
      for (let dx = -radiusCell; dx <= radiusCell; dx += 1) {
        const nx = col + dx;
        if (nx < 0 || nx >= cols) continue;
        if ((dx * dx) + (dy * dy) > (radiusCell * radiusCell) + 1) continue;
        blocked[cellIndex(nx, ny, cols)] = 1;
      }
    }
  };

  for (const wall of walls) {
    const sx = Number(wall?.start?.[0]);
    const sy = Number(wall?.start?.[1]);
    const ex = Number(wall?.end?.[0]);
    const ey = Number(wall?.end?.[1]);
    if (![sx, sy, ex, ey].every((value) => Number.isFinite(value))) continue;
    const dx = ex - sx;
    const dy = ey - sy;
    const length = Math.hypot(dx, dy);
    if (length < 0.05) continue;

    const halfThickness = Math.max(0.06, Number(wall.thickness || 0.115) * 0.5);
    const radiusCell = Math.max(1, Math.ceil((halfThickness + (cellSize * 0.7)) / cellSize));
    const samples = Math.max(3, Math.ceil(length / (cellSize * 0.45)));
    for (let step = 0; step <= samples; step += 1) {
      const t = step / samples;
      const px = sx + (dx * t);
      const py = sy + (dy * t);
      const col = Math.floor((px - originX) / cellSize);
      const row = Math.floor((py - originY) / cellSize);
      if (col < 0 || row < 0 || col >= cols || row >= rows) continue;
      markBlocked(col, row, radiusCell);
    }
  }

  const outside = new Uint8Array(cols * rows);
  const queue: number[] = [];
  const pushOutside = (col: number, row: number) => {
    if (col < 0 || row < 0 || col >= cols || row >= rows) return;
    const idx = cellIndex(col, row, cols);
    if (blocked[idx] || outside[idx]) return;
    outside[idx] = 1;
    queue.push(idx);
  };

  for (let col = 0; col < cols; col += 1) {
    pushOutside(col, 0);
    pushOutside(col, rows - 1);
  }
  for (let row = 0; row < rows; row += 1) {
    pushOutside(0, row);
    pushOutside(cols - 1, row);
  }

  let head = 0;
  while (head < queue.length) {
    const idx = queue[head++];
    const col = idx % cols;
    const row = Math.floor(idx / cols);
    pushOutside(col + 1, row);
    pushOutside(col - 1, row);
    pushOutside(col, row + 1);
    pushOutside(col, row - 1);
  }

  const visited = new Uint8Array(cols * rows);
  const existingRoomPool = (existingRooms || []).map((room) => {
    const bounds = collectRoomBounds(room?.polygon || []);
    if (!bounds) return null;
    return {
      id: room.id,
      name: room.name,
      color: room.floor_color,
      center: [
        (bounds.minX + bounds.maxX) / 2,
        (bounds.minY + bounds.maxY) / 2,
      ] as [number, number],
    };
  }).filter((entry): entry is NonNullable<typeof entry> => entry != null);
  const claimedExisting = new Set<string>();

  const rooms: GeometricReconstruction['rooms'] = [];
  let roomCounter = 1;
  for (let idx = 0; idx < visited.length; idx += 1) {
    if (visited[idx] || blocked[idx] || outside[idx]) continue;

    const componentQueue: number[] = [idx];
    visited[idx] = 1;
    const componentCells: number[] = [];
    let qHead = 0;
    while (qHead < componentQueue.length) {
      const current = componentQueue[qHead++];
      componentCells.push(current);
      const col = current % cols;
      const row = Math.floor(current / cols);
      const neighbors = [
        [col + 1, row],
        [col - 1, row],
        [col, row + 1],
        [col, row - 1],
      ] as Array<[number, number]>;
      for (const [nx, ny] of neighbors) {
        if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
        const nIdx = cellIndex(nx, ny, cols);
        if (visited[nIdx] || blocked[nIdx] || outside[nIdx]) continue;
        visited[nIdx] = 1;
        componentQueue.push(nIdx);
      }
    }

    const areaApprox = componentCells.length * cellSize * cellSize;
    if (areaApprox < minRoomArea * 0.8) continue;
    if (areaApprox > maxRoomArea * 1.05) continue;

    const componentSet = new Set(componentCells);
    const polygon = extractLargestBoundaryLoopFromCells(componentSet, cols, rows, originX, originY, cellSize);
    if (!polygon || polygon.length < 3) continue;
    const area = Math.abs(polygonArea(polygon));
    if (!Number.isFinite(area) || area < minRoomArea || area > maxRoomArea) continue;

    const bounds = collectRoomBounds(polygon);
    if (!bounds) continue;
    const center: [number, number] = [
      (bounds.minX + bounds.maxX) / 2,
      (bounds.minY + bounds.maxY) / 2,
    ];

    let name = `Room ${roomCounter}`;
    let floorColor = '#e8d5b7';
    let bestMatch: { id: string; distance: number; name: string; color: string | undefined } | null = null;
    for (const existing of existingRoomPool) {
      const existingKey = String(existing.id);
      if (claimedExisting.has(existingKey)) continue;
      const distance = Math.hypot(existing.center[0] - center[0], existing.center[1] - center[1]);
      if (!bestMatch || distance < bestMatch.distance) {
        bestMatch = {
          id: existingKey,
          distance,
          name: existing.name,
          color: existing.color,
        };
      }
    }
    const semanticDistanceCap = footprintProfile?.shapeClass === 'elongated'
      ? Math.max(2.8, Math.sqrt(area) * 1.08)
      : footprintProfile?.shapeClass === 'irregular'
        ? Math.max(2.7, Math.sqrt(area) * 1.0)
        : Math.max(2.5, Math.sqrt(area) * 0.9);
    if (bestMatch && bestMatch.distance <= semanticDistanceCap) {
      claimedExisting.add(bestMatch.id);
      name = bestMatch.name || name;
      floorColor = bestMatch.color || floorColor;
    }

    rooms.push({
      id: `det-r-${floorLevel}-${roomCounter}`,
      name,
      polygon,
      area: Number(area.toFixed(2)),
      confidence: 0.62,
      floor_color: floorColor,
      floor_level: floorLevel,
    });
    roomCounter += 1;
  }

  return rooms;
};

const shouldUseDeterministicRooms = (
  existingRooms: GeometricReconstruction['rooms'],
  deterministicRooms: GeometricReconstruction['rooms'],
  walls: GeometricReconstruction['walls']
): boolean => {
  if (!Array.isArray(deterministicRooms) || deterministicRooms.length === 0) return false;
  if (!Array.isArray(existingRooms) || existingRooms.length === 0) return deterministicRooms.length >= 1;

  const interiorWallCount = (walls || []).filter((wall) => wall?.is_exterior === false).length;
  if (interiorWallCount < 2) return false;

  const existingUnique = new Set(existingRooms.map((room) => roomPolygonSignature(room?.polygon || []))).size;
  const deterministicUnique = new Set(deterministicRooms.map((room) => roomPolygonSignature(room?.polygon || []))).size;
  const repeatedExisting = existingUnique <= Math.max(2, Math.floor(existingRooms.length / 3));

  if (deterministicRooms.length >= existingRooms.length + 2) return true;
  if (deterministicUnique >= existingUnique + 2 && deterministicRooms.length >= existingRooms.length) return true;
  if (repeatedExisting && deterministicUnique > existingUnique && deterministicRooms.length >= Math.max(2, existingRooms.length - 1)) {
    return true;
  }
  return false;
};

const FURNITURE_CENTER_BIASED_REGEX =
  /\b(dining\s*table|coffee\s*table|center\s*table|table\b|island\b|rug\b|carpet\b|ottoman\b)\b/i;
const FURNITURE_WALL_BIASED_REGEX =
  /\b(bed\b|sofa\b|couch\b|wardrobe\b|cabinet\b|bookshelf\b|shelf\b|tv\b|television\b|desk\b|study\b|counter\b|vanity\b|toilet\b|wc\b|sink\b|basin\b|fridge\b|refrigerator\b|stove\b)\b/i;
const FURNITURE_SKIP_REPOSITION_REGEX = /\b(stair|staircase|stairwell|human|person|plant)\b/i;

const isPointInPolygon = (point: [number, number], polygon: [number, number][]): boolean => {
  if (!Array.isArray(polygon) || polygon.length < 3) return false;
  let inside = false;
  const [px, py] = point;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = Number(polygon[i]?.[0]);
    const yi = Number(polygon[i]?.[1]);
    const xj = Number(polygon[j]?.[0]);
    const yj = Number(polygon[j]?.[1]);
    if (![xi, yi, xj, yj].every((value) => Number.isFinite(value))) continue;

    const intersects =
      yi > py !== yj > py &&
      px < ((xj - xi) * (py - yi)) / ((yj - yi) || 1e-9) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
};

const getPolygonCenter = (polygon: [number, number][]): [number, number] | null => {
  if (!Array.isArray(polygon) || polygon.length === 0) return null;
  let sx = 0;
  let sy = 0;
  let count = 0;
  for (const point of polygon) {
    const x = Number(point?.[0]);
    const y = Number(point?.[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    sx += x;
    sy += y;
    count += 1;
  }
  if (count === 0) return null;
  return [Number((sx / count).toFixed(3)), Number((sy / count).toFixed(3))];
};

const lerpPoint = (from: [number, number], to: [number, number], t: number): [number, number] => [
  from[0] + ((to[0] - from[0]) * t),
  from[1] + ((to[1] - from[1]) * t),
];

const normalizeFurniturePlacement = (
  furnitures: GeometricReconstruction['furnitures'] | undefined,
  walls: GeometricReconstruction['walls'],
  rooms: GeometricReconstruction['rooms'],
  doors: GeometricReconstruction['doors'],
  windows: GeometricReconstruction['windows']
): GeometricReconstruction['furnitures'] => {
  const items = furnitures || [];
  if (items.length === 0 || !Array.isArray(walls) || walls.length === 0) return items;

  const wallsByFloor = new Map<number, GeometricReconstruction['walls']>();
  for (const wall of walls) {
    const floor = toFloorBucket(wall?.floor_level);
    const bucket = wallsByFloor.get(floor) || [];
    bucket.push(wall);
    wallsByFloor.set(floor, bucket);
  }

  const roomCandidatesByFloor = new Map<
    number,
    Array<{
      room: GeometricReconstruction['rooms'][number];
      bounds: NonNullable<ReturnType<typeof collectRoomBounds>>;
      center: [number, number];
    }>
  >();

  for (const room of rooms || []) {
    const bounds = collectRoomBounds(room?.polygon || []);
    const center = getPolygonCenter(room?.polygon || []);
    if (!bounds || !center) continue;
    const floor = toFloorBucket(room?.floor_level);
    const bucket = roomCandidatesByFloor.get(floor) || [];
    bucket.push({ room, bounds, center });
    roomCandidatesByFloor.set(floor, bucket);
  }

  const openingsByFloor = new Map<number, Array<[number, number]>>();
  const addOpening = (floor: number, point: [number, number]) => {
    const bucket = openingsByFloor.get(floor) || [];
    bucket.push(point);
    openingsByFloor.set(floor, bucket);
  };
  for (const door of doors || []) {
    const point = asPoint2D(door?.position);
    if (!point) continue;
    addOpening(toFloorBucket(door?.floor_level), point);
  }
  for (const win of windows || []) {
    const point = asPoint2D(win?.position);
    if (!point) continue;
    addOpening(toFloorBucket(win?.floor_level), point);
  }

  return items.map((item) => {
    const initialPos = asPoint2D(item?.position);
    if (!initialPos) return item;

    const floor = toFloorBucket(item?.floor_level);
    const floorWalls = wallsByFloor.get(floor) || walls;
    if (!Array.isArray(floorWalls) || floorWalls.length === 0) return item;

    const semanticKey = normalizeSemanticText(`${item?.type || ''} ${item?.description || ''}`);
    if (FURNITURE_SKIP_REPOSITION_REGEX.test(semanticKey)) return item;

    const width = Math.max(0.35, Number(item?.width || 0.8));
    const depth = Math.max(0.35, Number(item?.depth || 0.8));
    const halfSpan = Math.max(width, depth) * 0.5;

    const roomCandidates = roomCandidatesByFloor.get(floor) || [];
    let selectedRoom:
      | {
        room: GeometricReconstruction['rooms'][number];
        bounds: NonNullable<ReturnType<typeof collectRoomBounds>>;
        center: [number, number];
      }
      | null = null;

    if (roomCandidates.length > 0) {
      const containing = roomCandidates
        .filter((entry) => isPointInPolygon(initialPos, entry.room.polygon || []))
        .sort((a, b) => a.bounds.area - b.bounds.area);
      if (containing.length > 0) {
        selectedRoom = containing[0];
      } else {
        let bestDistance = Number.POSITIVE_INFINITY;
        for (const entry of roomCandidates) {
          const distance = pointDistance(initialPos, entry.center);
          if (distance < bestDistance) {
            bestDistance = distance;
            selectedRoom = entry;
          }
        }
      }
    }

    let candidatePos: [number, number] = [initialPos[0], initialPos[1]];
    if (selectedRoom) {
      if (FURNITURE_CENTER_BIASED_REGEX.test(semanticKey)) {
        candidatePos = lerpPoint(candidatePos, selectedRoom.center, 0.58);
      } else if (FURNITURE_WALL_BIASED_REGEX.test(semanticKey)) {
        let bestWall:
          | {
            wall: GeometricReconstruction['walls'][number];
            projected: ReturnType<typeof closestPointOnSegment>;
            score: number;
          }
          | null = null;

        const wallPasses = [true, false] as const;
        for (const nearBoundsOnly of wallPasses) {
          for (const wall of floorWalls) {
            const start = asPoint2D(wall?.start);
            const end = asPoint2D(wall?.end);
            if (!start || !end) continue;
            const midpoint: [number, number] = [
              Number(((start[0] + end[0]) * 0.5).toFixed(3)),
              Number(((start[1] + end[1]) * 0.5).toFixed(3)),
            ];
            if (
              nearBoundsOnly &&
              !isDoorNearRoomBounds(
                midpoint,
                selectedRoom.bounds,
                Math.max(0.5, halfSpan * 0.9),
                0.65
              )
            ) {
              continue;
            }
            const projected = closestPointOnSegment(candidatePos, start, end);
            const centerDist = pointDistance(projected.point, selectedRoom.center);
            const score = projected.distance + (centerDist * 0.12);
            if (!bestWall || score < bestWall.score) {
              bestWall = { wall, projected, score };
            }
          }
          if (bestWall) break;
        }

        if (bestWall) {
          const start = asPoint2D(bestWall.wall.start)!;
          const end = asPoint2D(bestWall.wall.end)!;
          const wallDx = end[0] - start[0];
          const wallDy = end[1] - start[1];
          const wallLen = Math.hypot(wallDx, wallDy) || 1;
          const n1: [number, number] = [-wallDy / wallLen, wallDx / wallLen];
          const n2: [number, number] = [wallDy / wallLen, -wallDx / wallLen];
          const towardCenter1 = pointDistance(
            [
              bestWall.projected.point[0] + n1[0] * 0.4,
              bestWall.projected.point[1] + n1[1] * 0.4,
            ],
            selectedRoom.center
          );
          const towardCenter2 = pointDistance(
            [
              bestWall.projected.point[0] + n2[0] * 0.4,
              bestWall.projected.point[1] + n2[1] * 0.4,
            ],
            selectedRoom.center
          );
          const inwardNormal = towardCenter1 <= towardCenter2 ? n1 : n2;
          const inset = Math.max(0.24, (depth * 0.5) + 0.2);
          candidatePos = [
            bestWall.projected.point[0] + inwardNormal[0] * inset,
            bestWall.projected.point[1] + inwardNormal[1] * inset,
          ];
        }
      } else {
        candidatePos = lerpPoint(candidatePos, selectedRoom.center, 0.18);
      }

      const floorOpenings = openingsByFloor.get(floor) || [];
      for (const openingPoint of floorOpenings) {
        const distance = pointDistance(candidatePos, openingPoint);
        const minClearance = Math.max(0.58, halfSpan + 0.28);
        if (!Number.isFinite(distance) || distance >= minClearance) continue;

        let pushX = candidatePos[0] - openingPoint[0];
        let pushY = candidatePos[1] - openingPoint[1];
        let pushLen = Math.hypot(pushX, pushY);
        if (pushLen < 1e-6) {
          pushX = selectedRoom.center[0] - openingPoint[0];
          pushY = selectedRoom.center[1] - openingPoint[1];
          pushLen = Math.hypot(pushX, pushY);
        }
        if (pushLen < 1e-6) continue;
        const pushScale = (minClearance - distance) + 0.05;
        candidatePos = [
          candidatePos[0] + (pushX / pushLen) * pushScale,
          candidatePos[1] + (pushY / pushLen) * pushScale,
        ];
      }

      if (!isPointInPolygon(candidatePos, selectedRoom.room.polygon || [])) {
        for (let i = 0; i < 8; i += 1) {
          candidatePos = lerpPoint(candidatePos, selectedRoom.center, 0.32);
          if (isPointInPolygon(candidatePos, selectedRoom.room.polygon || [])) break;
        }
      }

      if (!isPointInPolygon(candidatePos, selectedRoom.room.polygon || [])) {
        const pad = Math.max(0.18, halfSpan * 0.7);
        candidatePos = [
          Math.max(
            selectedRoom.bounds.minX + pad,
            Math.min(selectedRoom.bounds.maxX - pad, candidatePos[0])
          ),
          Math.max(
            selectedRoom.bounds.minY + pad,
            Math.min(selectedRoom.bounds.maxY - pad, candidatePos[1])
          ),
        ];
      }
    }

    let nearestWall:
      | { wallStart: [number, number]; wallEnd: [number, number]; closest: [number, number]; distance: number }
      | null = null;
    for (const wall of floorWalls) {
      const start = asPoint2D(wall?.start);
      const end = asPoint2D(wall?.end);
      if (!start || !end) continue;
      const projected = closestPointOnSegment(candidatePos, start, end);
      if (!nearestWall || projected.distance < nearestWall.distance) {
        nearestWall = {
          wallStart: start,
          wallEnd: end,
          closest: projected.point,
          distance: projected.distance,
        };
      }
    }

    if (nearestWall) {
      const clearance = Math.max(0.25, Math.min(0.9, Math.max(width, depth) * 0.35));
      if (nearestWall.distance < clearance) {
        let nx = candidatePos[0] - nearestWall.closest[0];
        let ny = candidatePos[1] - nearestWall.closest[1];
        const nLen = Math.hypot(nx, ny);
        if (nLen < 1e-6) {
          const wx = nearestWall.wallEnd[0] - nearestWall.wallStart[0];
          const wy = nearestWall.wallEnd[1] - nearestWall.wallStart[1];
          const wLen = Math.hypot(wx, wy) || 1;
          nx = -wy / wLen;
          ny = wx / wLen;
        } else {
          nx /= nLen;
          ny /= nLen;
        }
        const delta = clearance - nearestWall.distance + 0.02;
        candidatePos = [
          candidatePos[0] + nx * delta,
          candidatePos[1] + ny * delta,
        ];
      }
    }

    return {
      ...item,
      position: [
        Number(candidatePos[0].toFixed(3)),
        Number(candidatePos[1].toFixed(3)),
      ] as [number, number],
    };
  });
};

const normalizeReconstructionGeometry = (payload: GeometricReconstruction): GeometricReconstruction => {
  if (!Array.isArray(payload?.walls) || payload.walls.length === 0) return payload;

  const toFloorLevel = (value: unknown): number => {
    const n = Number(value);
    return Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0;
  };

  const resolveObservedPositiveMetric = (values: unknown[], minValue: number): number | null => {
    const filtered = values
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value) && value >= minValue)
      .sort((a, b) => a - b);
    if (filtered.length === 0) return null;
    const mid = Math.floor(filtered.length / 2);
    return filtered.length % 2 === 0
      ? Number(((filtered[mid - 1] + filtered[mid]) / 2).toFixed(3))
      : Number(filtered[mid].toFixed(3));
  };

  const observedWallThickness = resolveObservedPositiveMetric(payload.walls.map((wall) => wall?.thickness), 0.08);
  const observedWallHeight = resolveObservedPositiveMetric(payload.walls.map((wall) => wall?.height), 2.0);
  const observedDoorWidth = resolveObservedPositiveMetric((payload.doors || []).map((door) => door?.width), 0.55);
  const observedDoorHeight = resolveObservedPositiveMetric((payload.doors || []).map((door) => door?.height), 1.75);
  const observedWindowWidth = resolveObservedPositiveMetric((payload.windows || []).map((win) => win?.width), 0.35);
  const observedWindowSill = resolveObservedPositiveMetric((payload.windows || []).map((win) => win?.sill_height), 0.35);

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

  const nonOrthogonalRatio = estimateNonOrthogonalWallRatio(payload.walls);
  const directionBuckets = countDirectionBuckets(payload.walls);
  const preserveIrregularFootprint = nonOrthogonalRatio >= 0.18 || directionBuckets >= 3;
  const snapTolerance = preserveIrregularFootprint ? 0.08 : 0.12;
  const axisSnapRatio = preserveIrregularFootprint ? 0.07 : 0.2;

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
  let droppedWallsForMissingGeometry = 0;
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

    const parsedThickness = Number(wall.thickness);
    const parsedHeight = Number(wall.height);
    const evidenceThickness = Number.isFinite(parsedThickness) && parsedThickness >= 0.08
      ? parsedThickness
      : observedWallThickness;
    const evidenceHeight = Number.isFinite(parsedHeight) && parsedHeight >= 2.0
      ? parsedHeight
      : observedWallHeight;

    if (SOURCE_DATA_ONLY_3D && (!Number.isFinite(Number(evidenceThickness)) || !Number.isFinite(Number(evidenceHeight)))) {
      droppedWallsForMissingGeometry += 1;
      continue;
    }

    const finalThickness = Number.isFinite(Number(evidenceThickness))
      ? Number(evidenceThickness)
      : Math.max(0.08, Number(wall.thickness || (wall.is_exterior ? 0.23 : 0.115)));
    const finalHeight = Number.isFinite(Number(evidenceHeight))
      ? Number(evidenceHeight)
      : Math.max(2.2, Number(wall.height || 2.8));

    normalizedWalls.push({
      ...wall,
      start,
      end,
      thickness: Number(finalThickness.toFixed(3)),
      height: Number(finalHeight.toFixed(3)),
    });
  }

  if (normalizedWalls.length === 0) return payload;
  const miterResult = applyWallMiterJoins(normalizedWalls, snapTolerance);
  const continuityResult = repairWallEndpointContinuity(miterResult.walls, snapTolerance);
  const finalizedWalls = continuityResult.walls;
  if (finalizedWalls.length === 0) return payload;

  const normalizationConflicts: GeometricReconstruction['conflicts'] = [];
  if (preserveIrregularFootprint && finalizedWalls.length > 0) {
    normalizationConflicts.push({
      type: 'code',
      severity: 'low',
      description: `Detected non-orthogonal footprint evidence (direction buckets=${directionBuckets}, non-orth ratio=${nonOrthogonalRatio.toFixed(2)}); reduced axis snapping to preserve non-cuboidal geometry.`,
      location: finalizedWalls[0].start,
    });
  }

  const wallIdSet = new Set(finalizedWalls.map((wall) => String(wall.id)));
  const wallsById = new Map(finalizedWalls.map((wall) => [String(wall.id), wall]));
  const wallsByFloor = new Map<number, GeometricReconstruction['walls']>();
  for (const wall of finalizedWalls) {
    const floor = toFloorLevel(wall.floor_level);
    const bucket = wallsByFloor.get(floor) || [];
    bucket.push(wall);
    wallsByFloor.set(floor, bucket);
  }

  const wallCandidatesForFloor = (floorLevel: number): GeometricReconstruction['walls'] => {
    const sameFloor = wallsByFloor.get(floorLevel) || [];
    return sameFloor.length > 0 ? sameFloor : finalizedWalls;
  };

  type HostSelection = { id: string | number; distance: number; relaxed: boolean } | null;
  const selectHostWall = (
    position: [number, number],
    floorLevel: number,
    openingWidth: number,
    preferredHostId: string | number | null | undefined
  ): HostSelection => {
    const candidates = wallCandidatesForFloor(floorLevel);
    if (candidates.length === 0) return null;

    type WallScore = { id: string | number; distance: number; relaxed: boolean; score: number };
    const evaluateWall = (wall: GeometricReconstruction['walls'][number], relaxed: boolean): WallScore | null => {
      const hit = closestPointOnSegment(position, wall.start, wall.end);
      const wallLength = pointDistance(wall.start, wall.end);
      if (!Number.isFinite(wallLength) || wallLength < 0.2) return null;

      const halfOpening = Math.max(0.16, openingWidth * 0.5);
      const margin = Math.min(0.45, Math.max(relaxed ? 0.02 : 0.05, (halfOpening + 0.05) / wallLength));
      if (!relaxed && (hit.t < margin || hit.t > 1 - margin)) return null;

      const maxOffset = Math.max(0.12, Number(wall.thickness || 0.115) * (relaxed ? 1.9 : 1.35));
      if (hit.distance > maxOffset) return null;

      const edgePenalty = relaxed
        ? 0
        : Math.abs(0.5 - hit.t) * 0.1;
      const score = hit.distance + edgePenalty;
      return { id: wall.id, distance: hit.distance, relaxed, score };
    };

    const preferred = preferredHostId == null
      ? null
      : wallsById.get(String(preferredHostId));
    if (preferred && toFloorLevel(preferred.floor_level) === floorLevel) {
      const preferredStrict = evaluateWall(preferred, false);
      if (preferredStrict) return preferredStrict;
    }

    const collectBest = (relaxed: boolean): WallScore | null => {
      let best: WallScore | null = null;
      for (const wall of candidates) {
        const candidate = evaluateWall(wall, relaxed);
        if (!candidate) continue;
        if (!best || candidate.score < best.score) best = candidate;
      }
      return best;
    };

    const strictBest = collectBest(false);
    if (strictBest) return strictBest;

    if (preferred) {
      const preferredRelaxed = evaluateWall(preferred, true);
      if (preferredRelaxed) return preferredRelaxed;
    }

    return collectBest(true);
  };

  let reassignedDoorHosts = 0;
  let relaxedDoorHosts = 0;
  let droppedDoors = 0;
  let normalizedDoors: GeometricReconstruction['doors'] = [];
  for (const door of payload.doors || []) {
    const x = Number(door?.position?.[0]);
    const y = Number(door?.position?.[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      droppedDoors += 1;
      continue;
    }
    const position: [number, number] = [Number(x.toFixed(3)), Number(y.toFixed(3))];
    const parsedWidth = Number(door.width);
    const parsedHeight = Number(door.height);
    const evidenceWidth = Number.isFinite(parsedWidth) && parsedWidth >= 0.55
      ? parsedWidth
      : observedDoorWidth;
    const evidenceHeight = Number.isFinite(parsedHeight) && parsedHeight >= 1.75
      ? parsedHeight
      : observedDoorHeight;
    if (SOURCE_DATA_ONLY_3D && (!Number.isFinite(Number(evidenceWidth)) || !Number.isFinite(Number(evidenceHeight)))) {
      droppedDoors += 1;
      continue;
    }
    const width = Number.isFinite(Number(evidenceWidth))
      ? Number(evidenceWidth)
      : Math.max(0.75, Number(door.width || 0.9));
    const height = Number.isFinite(Number(evidenceHeight))
      ? Number(evidenceHeight)
      : Math.max(2.0, Number(door.height || 2.1));
    const floorLevel = toFloorLevel(door.floor_level);
    const preferred = wallIdSet.has(String(door.host_wall_id)) ? door.host_wall_id : null;
    const selectedHost = selectHostWall(position, floorLevel, width, preferred);
    if (!selectedHost) {
      droppedDoors += 1;
      continue;
    }

    if (String(selectedHost.id) !== String(door.host_wall_id)) reassignedDoorHosts += 1;
    if (selectedHost.relaxed) relaxedDoorHosts += 1;
    normalizedDoors.push({
      ...door,
      position,
      host_wall_id: selectedHost.id,
      width: Number(width.toFixed(3)),
      height: Number(height.toFixed(3)),
      floor_level: floorLevel,
    });
  }

  let reassignedWindowHosts = 0;
  let relaxedWindowHosts = 0;
  let droppedWindows = 0;
  let normalizedWindows: GeometricReconstruction['windows'] = [];
  for (const win of payload.windows || []) {
    const x = Number(win?.position?.[0]);
    const y = Number(win?.position?.[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      droppedWindows += 1;
      continue;
    }
    const position: [number, number] = [Number(x.toFixed(3)), Number(y.toFixed(3))];
    const parsedWidth = Number(win.width);
    const parsedSill = Number(win.sill_height);
    const evidenceWidth = Number.isFinite(parsedWidth) && parsedWidth >= 0.35
      ? parsedWidth
      : observedWindowWidth;
    const evidenceSill = Number.isFinite(parsedSill) && parsedSill >= 0.35
      ? parsedSill
      : observedWindowSill;
    if (SOURCE_DATA_ONLY_3D && (!Number.isFinite(Number(evidenceWidth)) || !Number.isFinite(Number(evidenceSill)))) {
      droppedWindows += 1;
      continue;
    }
    const width = Number.isFinite(Number(evidenceWidth))
      ? Number(evidenceWidth)
      : Math.max(0.5, Number(win.width || 1));
    const sillHeight = Number.isFinite(Number(evidenceSill))
      ? Number(evidenceSill)
      : Math.max(0.6, Number(win.sill_height || 0.9));
    const floorLevel = toFloorLevel(win.floor_level);
    const preferred = wallIdSet.has(String(win.host_wall_id)) ? win.host_wall_id : null;
    const selectedHost = selectHostWall(position, floorLevel, width, preferred);
    if (!selectedHost) {
      droppedWindows += 1;
      continue;
    }

    if (String(selectedHost.id) !== String(win.host_wall_id)) reassignedWindowHosts += 1;
    if (selectedHost.relaxed) relaxedWindowHosts += 1;
    normalizedWindows.push({
      ...win,
      position,
      host_wall_id: selectedHost.id,
      width: Number(width.toFixed(3)),
      sill_height: Number(sillHeight.toFixed(3)),
      floor_level: floorLevel,
    });
  }

  if (reassignedDoorHosts + reassignedWindowHosts > 0) {
    normalizationConflicts.push({
      type: 'code',
      severity: 'low',
      description: `Reassigned host walls for ${reassignedDoorHosts} door(s) and ${reassignedWindowHosts} window(s) after geometric validation.`,
      location: finalizedWalls[0].start,
    });
  }

  if (relaxedDoorHosts + relaxedWindowHosts > 0) {
    normalizationConflicts.push({
      type: 'structural',
      severity: 'low',
      description: `Accepted ${relaxedDoorHosts + relaxedWindowHosts} opening(s) with relaxed host offset checks; verify opening placement.`,
      location: finalizedWalls[0].start,
    });
  }

  if (droppedDoors + droppedWindows > 0) {
    normalizationConflicts.push({
      type: 'structural',
      severity: 'medium',
      description: `Dropped ${droppedDoors} door(s) and ${droppedWindows} window(s) due to missing/invalid host wall alignment.`,
      location: finalizedWalls[0].start,
    });
  }

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
  const floorLevel =
    finalizedWalls.length > 0
      ? toFloorLevel(finalizedWalls[0]?.floor_level)
      : (normalizedRooms.length > 0 ? toFloorLevel(normalizedRooms[0]?.floor_level) : 0);
  const footprintProfile = deriveFootprintProfileFromWalls(finalizedWalls);
  const deterministicRooms = buildDeterministicRoomsFromWallRaster(
    finalizedWalls,
    normalizedRooms,
    floorLevel,
    footprintProfile
  );
  const baseDeterministicDecision = shouldUseDeterministicRooms(normalizedRooms, deterministicRooms, finalizedWalls);
  const preserveComplexFootprint =
    preserveIrregularFootprint ||
    footprintProfile?.shapeClass === 'irregular' ||
    countDirectionBuckets(finalizedWalls) >= 3;
  const useDeterministicRooms = preserveComplexFootprint
    ? (baseDeterministicDecision && deterministicRooms.length >= (normalizedRooms.length + 2))
    : baseDeterministicDecision;
  const resolvedRooms = SOURCE_DATA_ONLY_3D ? normalizedRooms : (useDeterministicRooms ? deterministicRooms : normalizedRooms);
  if (!SOURCE_DATA_ONLY_3D) {
    const inferredDoorRecovery = inferDoorsFromRoomTopology(finalizedWalls, resolvedRooms, normalizedDoors);
    normalizedDoors = inferredDoorRecovery.doors;
    if (inferredDoorRecovery.inferredCount > 0 && finalizedWalls.length > 0) {
      normalizationConflicts.push({
        type: 'structural',
        severity: 'low',
        description: `Inferred ${inferredDoorRecovery.inferredCount} low-confidence door(s) from room-boundary topology on floor(s) ${inferredDoorRecovery.floors.join(', ')} because explicit door labels/symbols were sparse.`,
        location: finalizedWalls[0].start,
      });
    }
    const inferredEntryDoorRecovery = inferEntryDoorsFromExteriorWalls(finalizedWalls, resolvedRooms, normalizedDoors);
    normalizedDoors = inferredEntryDoorRecovery.doors;
    if (inferredEntryDoorRecovery.inferredCount > 0 && finalizedWalls.length > 0) {
      normalizationConflicts.push({
        type: 'structural',
        severity: 'low',
        description: `Imputed ${inferredEntryDoorRecovery.inferredCount} entry door(s) on floor(s) ${inferredEntryDoorRecovery.floors.join(', ')} from exterior-wall topology due to missing explicit door annotation.`,
        location: finalizedWalls[0].start,
      });
    }
    const inferredConnectivityDoorRecovery = inferInteriorConnectivityDoors(finalizedWalls, resolvedRooms, normalizedDoors);
    normalizedDoors = inferredConnectivityDoorRecovery.doors;
    if (inferredConnectivityDoorRecovery.inferredCount > 0 && finalizedWalls.length > 0) {
      normalizationConflicts.push({
        type: 'structural',
        severity: 'low',
        description: `Added ${inferredConnectivityDoorRecovery.inferredCount} interior connectivity door(s) on floor(s) ${inferredConnectivityDoorRecovery.floors.join(', ')} to reduce sealed-room circulation gaps.`,
        location: finalizedWalls[0].start,
      });
    }
    if (inferredConnectivityDoorRecovery.unresolvedRooms.length > 0 && finalizedWalls.length > 0) {
      const unresolvedSamples = inferredConnectivityDoorRecovery.unresolvedRooms
        .slice(0, 3)
        .map((entry) => `[F${entry.floor}] ${entry.roomName}`)
        .join(', ');
      normalizationConflicts.push({
        type: 'structural',
        severity: 'medium',
        description: `Detected ${inferredConnectivityDoorRecovery.unresolvedRooms.length} room(s) still lacking clear doorway access after topology imputation${unresolvedSamples ? ` (examples: ${unresolvedSamples})` : ''}.`,
        location: finalizedWalls[0].start,
      });
    }
    const inferredWindowRecovery = inferWindowsFromHabitableRoomTopology(
      finalizedWalls,
      resolvedRooms,
      normalizedDoors,
      normalizedWindows
    );
    normalizedWindows = inferredWindowRecovery.windows;
    if (inferredWindowRecovery.inferredCount > 0 && finalizedWalls.length > 0) {
      normalizationConflicts.push({
        type: 'structural',
        severity: 'low',
        description: `Imputed ${inferredWindowRecovery.inferredCount} habitable-room window(s) on floor(s) ${inferredWindowRecovery.floors.join(', ')} from exterior-wall evidence due to missing explicit window markers.`,
        location: finalizedWalls[0].start,
      });
    }
  }

  const normalizedFurnitures = normalizeFurniturePlacement(
    payload.furnitures,
    finalizedWalls,
    resolvedRooms,
    normalizedDoors,
    normalizedWindows
  );

  const wallSolids = buildServerCutWallSolids(finalizedWalls, normalizedDoors, normalizedWindows);

  const normalized: GeometricReconstruction = {
    ...payload,
    walls: finalizedWalls,
    wallSolids: wallSolids.length > 0 ? wallSolids : undefined,
    doors: normalizedDoors,
    windows: normalizedWindows,
    rooms: resolvedRooms,
    furnitures: normalizedFurnitures,
    conflicts: [
      ...(payload.conflicts || []),
      ...normalizationConflicts,
    ],
  };

  const droppedWalls = payload.walls.length - normalizedWalls.length;
  const droppedDegenerateWalls = Math.max(0, droppedWalls - droppedWallsForMissingGeometry);
  if (droppedWallsForMissingGeometry > 0) {
    normalized.conflicts = [
      ...(normalized.conflicts || []),
      {
        type: 'structural',
        severity: 'medium',
        description: `Dropped ${droppedWallsForMissingGeometry} wall segment(s) because thickness/height evidence was unavailable in source-only mode.`,
        location: normalized.walls[0]?.start || payload.walls[0]?.start || [0, 0],
      },
    ];
  }
  if (droppedDegenerateWalls > 0) {
    normalized.conflicts = [
      ...(normalized.conflicts || []),
      {
        type: 'code',
        severity: 'low',
        description: `Dropped ${droppedDegenerateWalls} degenerate wall segment(s) during geometric normalization.`,
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

  if (continuityResult.bridgedPairs > 0 && normalized.walls.length > 0) {
    normalized.conflicts = [
      ...(normalized.conflicts || []),
      {
        type: 'code',
        severity: 'low',
        description: `Bridged ${continuityResult.bridgedPairs} near-gap wall endpoint pair(s) to improve topology continuity.`,
        location: normalized.walls[0].start,
      },
    ];
  }

  if (!SOURCE_DATA_ONLY_3D && useDeterministicRooms && deterministicRooms.length > 0) {
    const location =
      deterministicRooms[0]?.polygon?.[0] ||
      normalized.rooms?.[0]?.polygon?.[0] ||
      normalized.walls[0]?.start;
    const profileSummary = footprintProfile
      ? ` footprint=${footprintProfile.shapeClass}, area=${footprintProfile.area.toFixed(1)}m2`
      : '';
    normalized.conflicts = [
      ...(normalized.conflicts || []),
      {
        type: 'code',
        severity: 'low',
        description: `Applied deterministic interior partition extraction from wall raster (${deterministicRooms.length} room polygon(s) selected, area-shape adaptive${profileSummary}).`,
        location,
      },
    ];
  }

  return normalized;
};

type ModelBounds2D = {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
};

const getModelBoundsFromWalls = (walls: GeometricReconstruction['walls']): ModelBounds2D | null => {
  if (!Array.isArray(walls) || walls.length === 0) return null;
  const points = walls.flatMap((wall) => [wall.start, wall.end]);
  const xs = points.map((point) => Number(point?.[0])).filter((value) => Number.isFinite(value));
  const ys = points.map((point) => Number(point?.[1])).filter((value) => Number.isFinite(value));
  if (xs.length === 0 || ys.length === 0) return null;
  return {
    minX: Math.min(...xs),
    minY: Math.min(...ys),
    maxX: Math.max(...xs),
    maxY: Math.max(...ys),
  };
};

const getFloorBoundsFromWalls = (
  walls: GeometricReconstruction['walls'],
  floorLevel: number
): ModelBounds2D | null => {
  const floorWalls = (walls || []).filter((wall) => toFloorBucket(wall?.floor_level) === floorLevel);
  if (floorWalls.length === 0) return null;
  return getModelBoundsFromWalls(floorWalls);
};

const FLOOR_ALIGNMENT_CORE_REGEX = /\b(stair|staircase|stairwell|lift|elevator|shaft|core)\b/i;

type FloorAlignmentAnchor = {
  point: [number, number];
  source: 'semantic-core' | 'bounds-center';
};

const averagePoint = (points: [number, number][]): [number, number] | null => {
  if (!Array.isArray(points) || points.length === 0) return null;
  let sx = 0;
  let sy = 0;
  let count = 0;
  for (const point of points) {
    if (!Array.isArray(point) || point.length < 2) continue;
    const x = Number(point[0]);
    const y = Number(point[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    sx += x;
    sy += y;
    count += 1;
  }
  if (count === 0) return null;
  return [Number((sx / count).toFixed(3)), Number((sy / count).toFixed(3))];
};

const collectFloorSemanticCoreAnchors = (
  payload: GeometricReconstruction,
  floorLevel: number
): [number, number][] => {
  const points: [number, number][] = [];

  for (const room of payload?.rooms || []) {
    if (toFloorBucket(room?.floor_level) !== floorLevel) continue;
    if (!FLOOR_ALIGNMENT_CORE_REGEX.test(normalizeSemanticText(room?.name))) continue;
    const center = estimateRoomCenter(room);
    if (center) points.push(center);
  }

  for (const item of payload?.furnitures || []) {
    if (toFloorBucket(item?.floor_level) !== floorLevel) continue;
    const semantic = `${normalizeSemanticText(item?.type)} ${normalizeSemanticText(item?.description)}`;
    if (!FLOOR_ALIGNMENT_CORE_REGEX.test(semantic)) continue;
    const point = asPoint2D(item?.position);
    if (point) points.push([Number(point[0].toFixed(3)), Number(point[1].toFixed(3))]);
  }

  return points;
};

const resolveFloorAlignmentAnchor = (
  payload: GeometricReconstruction,
  floorLevel: number,
  bounds: ModelBounds2D
): FloorAlignmentAnchor => {
  const semanticPoints = collectFloorSemanticCoreAnchors(payload, floorLevel);
  const semanticAnchor = averagePoint(semanticPoints);
  if (semanticAnchor) {
    return {
      point: semanticAnchor,
      source: 'semantic-core',
    };
  }

  return {
    point: [
      Number(((bounds.minX + bounds.maxX) * 0.5).toFixed(3)),
      Number(((bounds.minY + bounds.maxY) * 0.5).toFixed(3)),
    ],
    source: 'bounds-center',
  };
};

const translateBounds = (bounds: ModelBounds2D, dx: number, dy: number): ModelBounds2D => ({
  minX: Number((bounds.minX + dx).toFixed(3)),
  maxX: Number((bounds.maxX + dx).toFixed(3)),
  minY: Number((bounds.minY + dy).toFixed(3)),
  maxY: Number((bounds.maxY + dy).toFixed(3)),
});

const computeBoundsIoU = (a: ModelBounds2D, b: ModelBounds2D): number => {
  const ix = Math.max(0, Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX));
  const iy = Math.max(0, Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY));
  const intersection = ix * iy;
  if (intersection <= 0) return 0;
  const areaA = Math.max(0, (a.maxX - a.minX) * (a.maxY - a.minY));
  const areaB = Math.max(0, (b.maxX - b.minX) * (b.maxY - b.minY));
  const union = areaA + areaB - intersection;
  if (union <= 1e-6) return 0;
  return intersection / union;
};

const translateFloorGeometry = (
  payload: GeometricReconstruction,
  floorLevel: number,
  dx: number,
  dy: number
): GeometricReconstruction => {
  const adjust = (point: [number, number]): [number, number] => [
    Number((point[0] + dx).toFixed(3)),
    Number((point[1] + dy).toFixed(3)),
  ];

  return {
    ...payload,
    walls: (payload.walls || []).map((wall) =>
      toFloorBucket(wall?.floor_level) !== floorLevel
        ? wall
        : {
          ...wall,
          start: adjust(wall.start),
          end: adjust(wall.end),
        }
    ),
    doors: (payload.doors || []).map((door) =>
      toFloorBucket(door?.floor_level) !== floorLevel
        ? door
        : {
          ...door,
          position: adjust(door.position),
        }
    ),
    windows: (payload.windows || []).map((win) =>
      toFloorBucket(win?.floor_level) !== floorLevel
        ? win
        : {
          ...win,
          position: adjust(win.position),
        }
    ),
    rooms: (payload.rooms || []).map((room) =>
      toFloorBucket(room?.floor_level) !== floorLevel
        ? room
        : {
          ...room,
          polygon: (room.polygon || []).map((point) => adjust(point)),
        }
    ),
    furnitures: (payload.furnitures || []).map((item) =>
      toFloorBucket(item?.floor_level) !== floorLevel
        ? item
        : {
          ...item,
          position: adjust(item.position),
        }
    ),
  };
};

const reconcileStackedFloorAlignment = (
  payload: GeometricReconstruction
): {
  result: GeometricReconstruction;
  applied: boolean;
  adjustedFloors: number[];
  translations: Array<{
    floor: number;
    dx: number;
    dy: number;
    shift: number;
    source: 'semantic-core' | 'bounds-center';
    overlapGain: number;
  }>;
} => {
  const walls = payload?.walls || [];
  if (!Array.isArray(walls) || walls.length < 8) {
    return { result: payload, applied: false, adjustedFloors: [], translations: [] };
  }

  const floorLevels = Array.from(new Set(walls.map((wall) => toFloorBucket(wall?.floor_level)))).sort((a, b) => a - b);
  if (floorLevels.length < 2) {
    return { result: payload, applied: false, adjustedFloors: [], translations: [] };
  }

  const baseFloor = floorLevels[0];
  const baseBounds = getFloorBoundsFromWalls(walls, baseFloor);
  if (!baseBounds) {
    return { result: payload, applied: false, adjustedFloors: [], translations: [] };
  }

  const baseWidth = Math.max(0.01, baseBounds.maxX - baseBounds.minX);
  const baseDepth = Math.max(0.01, baseBounds.maxY - baseBounds.minY);
  const baseArea = baseWidth * baseDepth;
  const baseAspect = baseWidth / baseDepth;
  const baseAnchor = resolveFloorAlignmentAnchor(payload, baseFloor, baseBounds);
  const baseDiag = Math.hypot(baseWidth, baseDepth);

  let result = payload;
  const translations: Array<{
    floor: number;
    dx: number;
    dy: number;
    shift: number;
    source: 'semantic-core' | 'bounds-center';
    overlapGain: number;
  }> = [];

  for (const floor of floorLevels.slice(1)) {
    const floorBounds = getFloorBoundsFromWalls(result.walls, floor);
    if (!floorBounds) continue;

    const width = Math.max(0.01, floorBounds.maxX - floorBounds.minX);
    const depth = Math.max(0.01, floorBounds.maxY - floorBounds.minY);
    const area = width * depth;
    const aspect = width / depth;
    const areaRatio = area / Math.max(0.01, baseArea);
    const aspectDelta = Math.abs(aspect - baseAspect);
    const floorAnchor = resolveFloorAlignmentAnchor(result, floor, floorBounds);
    const useSemanticAnchor = baseAnchor.source === 'semantic-core' && floorAnchor.source === 'semantic-core';
    const dx = baseAnchor.point[0] - floorAnchor.point[0];
    const dy = baseAnchor.point[1] - floorAnchor.point[1];
    const shift = Math.hypot(dx, dy);
    const minShiftToFix = useSemanticAnchor
      ? Math.max(0.2, baseDiag * 0.025)
      : Math.max(0.45, baseDiag * 0.06);
    const maxShiftToFix = useSemanticAnchor
      ? Math.max(4.2, baseDiag * 0.6)
      : Math.max(3.5, baseDiag * 0.45);
    const similarFootprint = areaRatio >= 0.62 && areaRatio <= 1.38 && aspectDelta <= 0.55;
    if (!similarFootprint) continue;
    if (!Number.isFinite(shift) || shift < minShiftToFix || shift > maxShiftToFix) continue;

    const overlapBefore = computeBoundsIoU(baseBounds, floorBounds);
    const translatedBounds = translateBounds(floorBounds, dx, dy);
    const overlapAfter = computeBoundsIoU(baseBounds, translatedBounds);
    const overlapGain = overlapAfter - overlapBefore;
    const requiredGain = useSemanticAnchor ? 0.02 : 0.08;
    if (overlapGain < requiredGain) continue;

    result = translateFloorGeometry(result, floor, dx, dy);
    translations.push({
      floor,
      dx: Number(dx.toFixed(3)),
      dy: Number(dy.toFixed(3)),
      shift: Number(shift.toFixed(3)),
      source: useSemanticAnchor ? 'semantic-core' : 'bounds-center',
      overlapGain: Number(overlapGain.toFixed(3)),
    });
  }

  if (translations.length === 0) {
    return { result: payload, applied: false, adjustedFloors: [], translations: [] };
  }

  const firstLocation =
    result?.walls?.find((wall) => toFloorBucket(wall?.floor_level) === translations[0].floor)?.start ||
    result?.walls?.[0]?.start ||
    [0, 0];
  const description = `Auto-aligned shifted upper floors (${translations
    .map((item) => `L${item.floor}: dx=${item.dx}, dy=${item.dy}, anchor=${item.source}, overlap+${item.overlapGain}`)
    .join('; ')}) to improve vertical wall stacking.`;

  result = {
    ...result,
    roof: undefined,
    conflicts: [
      ...(result.conflicts || []),
      {
        type: 'code',
        severity: 'low',
        description,
        location: [Number(firstLocation[0] || 0), Number(firstLocation[1] || 0)] as [number, number],
      },
    ],
  };

  return {
    result,
    applied: true,
    adjustedFloors: translations.map((entry) => entry.floor),
    translations,
  };
};

const isPointInsideBounds = (point: [number, number], bounds: ModelBounds2D, padding = 0): boolean =>
  point[0] >= bounds.minX - padding &&
  point[0] <= bounds.maxX + padding &&
  point[1] >= bounds.minY - padding &&
  point[1] <= bounds.maxY + padding;

const estimateRoomCenter = (room: GeometricReconstruction['rooms'][number]): [number, number] | null => {
  const bounds = collectRoomBounds(room?.polygon || []);
  if (!bounds) return null;
  return [
    Number(((bounds.minX + bounds.maxX) * 0.5).toFixed(3)),
    Number(((bounds.minY + bounds.maxY) * 0.5).toFixed(3)),
  ];
};

const buildWallConnectivityComponents = (
  walls: GeometricReconstruction['walls'],
  tolerance = 0.16
): number[][] => {
  if (!Array.isArray(walls) || walls.length === 0) return [];
  const endpointToWalls = new Map<string, number[]>();
  const addEndpoint = (wallIndex: number, point: [number, number]) => {
    const key = pointKey(snapPoint(point, tolerance));
    const bucket = endpointToWalls.get(key) || [];
    bucket.push(wallIndex);
    endpointToWalls.set(key, bucket);
  };

  for (let wallIndex = 0; wallIndex < walls.length; wallIndex += 1) {
    const wall = walls[wallIndex];
    addEndpoint(wallIndex, wall.start);
    addEndpoint(wallIndex, wall.end);
  }

  const adjacency = new Map<number, Set<number>>();
  const link = (a: number, b: number) => {
    if (a === b) return;
    const left = adjacency.get(a) || new Set<number>();
    left.add(b);
    adjacency.set(a, left);
    const right = adjacency.get(b) || new Set<number>();
    right.add(a);
    adjacency.set(b, right);
  };

  for (const indexes of endpointToWalls.values()) {
    if (indexes.length <= 1) continue;
    for (let i = 0; i < indexes.length; i += 1) {
      for (let j = i + 1; j < indexes.length; j += 1) {
        link(indexes[i], indexes[j]);
      }
    }
  }

  const visited = new Set<number>();
  const components: number[][] = [];
  for (let start = 0; start < walls.length; start += 1) {
    if (visited.has(start)) continue;
    const queue = [start];
    visited.add(start);
    const group: number[] = [];
    while (queue.length > 0) {
      const current = queue.shift() as number;
      group.push(current);
      for (const next of adjacency.get(current) || []) {
        if (visited.has(next)) continue;
        visited.add(next);
        queue.push(next);
      }
    }
    components.push(group);
  }

  components.sort((a, b) => b.length - a.length);
  return components;
};

const countDisconnectedBuildingComponents = (
  walls: GeometricReconstruction['walls'],
  minWalls = 6
): number => {
  const components = buildWallConnectivityComponents(walls, 0.16);
  return components.filter((component) => component.length >= minWalls).length;
};

const decomposeReconstructionIntoSiteBuildings = (
  payload: GeometricReconstruction
): SiteBuildingReconstruction[] => {
  const walls = payload?.walls || [];
  if (!Array.isArray(walls) || walls.length === 0) return [];

  const components = buildWallConnectivityComponents(walls, 0.16)
    .filter((component) => component.length >= 6);
  if (components.length === 0) return [];
  if (components.length === 1) {
    const only = normalizeReconstructionGeometry(payload);
    const onlyProfile = deriveFootprintProfileFromWalls(only.walls);
    const onlyBounds = getModelBoundsFromWalls(only.walls);
    if (!onlyBounds) return [];
    const resolvedSingleName = (only.building_name || '').trim() || NOT_AVAILABLE_3D_TEXT;
    return [{
      id: 'bld-1',
      name: resolvedSingleName,
      footprint_area: Number((onlyProfile?.area || 0).toFixed(2)),
      floor_count: Math.max(1, estimateResultFloorCount(only)),
      bounds: {
        minX: Number(onlyBounds.minX.toFixed(3)),
        minY: Number(onlyBounds.minY.toFixed(3)),
        maxX: Number(onlyBounds.maxX.toFixed(3)),
        maxY: Number(onlyBounds.maxY.toFixed(3)),
      },
      model: applyBuildingCodes(inferRoofFromWallFootprint(only)),
    }];
  }

  const entries: SiteBuildingReconstruction[] = [];
  for (let componentIndex = 0; componentIndex < components.length; componentIndex += 1) {
    const component = components[componentIndex];
    const componentWalls = component.map((index) => walls[index]).filter(Boolean);
    const bounds = getModelBoundsFromWalls(componentWalls);
    if (!bounds) continue;
    const diag = Math.hypot(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY);
    const padding = Math.max(0.35, Math.min(1.4, diag * 0.04));
    const wallIdSet = new Set(componentWalls.map((wall) => String(wall.id)));

    const doors = (payload.doors || []).filter((door) => {
      const hostKnown = wallIdSet.has(String(door.host_wall_id));
      if (hostKnown) return true;
      const pos = asPoint2D(door.position);
      return pos ? isPointInsideBounds(pos, bounds, padding) : false;
    });
    const windows = (payload.windows || []).filter((win) => {
      const hostKnown = wallIdSet.has(String(win.host_wall_id));
      if (hostKnown) return true;
      const pos = asPoint2D(win.position);
      return pos ? isPointInsideBounds(pos, bounds, padding) : false;
    });
    const rooms = (payload.rooms || []).filter((room) => {
      const center = estimateRoomCenter(room);
      return center ? isPointInsideBounds(center, bounds, padding) : false;
    });
    const furnitures = (payload.furnitures || []).filter((item) => {
      const pos = asPoint2D(item.position);
      return pos ? isPointInsideBounds(pos, bounds, padding) : false;
    });

    const baseName = (payload.building_name || '').trim();
    const subModel: GeometricReconstruction = {
      ...payload,
      building_name: baseName ? `${baseName} ${componentIndex + 1}` : NOT_AVAILABLE_3D_TEXT,
      walls: componentWalls,
      wallSolids: undefined,
      doors,
      windows,
      rooms,
      furnitures,
      roof: undefined,
      conflicts: [],
    };

    const normalized = applyBuildingCodes(inferRoofFromWallFootprint(normalizeReconstructionGeometry(subModel)));
    const normalizedBounds = getModelBoundsFromWalls(normalized.walls);
    if (!normalizedBounds) continue;
    const footprintProfile = deriveFootprintProfileFromWalls(normalized.walls);
    entries.push({
      id: `bld-${componentIndex + 1}`,
      name: (normalized.building_name || '').trim() || NOT_AVAILABLE_3D_TEXT,
      footprint_area: Number((footprintProfile?.area || 0).toFixed(2)),
      floor_count: Math.max(1, estimateResultFloorCount(normalized)),
      bounds: {
        minX: Number(normalizedBounds.minX.toFixed(3)),
        minY: Number(normalizedBounds.minY.toFixed(3)),
        maxX: Number(normalizedBounds.maxX.toFixed(3)),
        maxY: Number(normalizedBounds.maxY.toFixed(3)),
      },
      model: normalized,
    });
  }

  entries.sort((a, b) => b.footprint_area - a.footprint_area);
  return entries;
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

  const semanticSeen = new Set<string>();
  const mergedSemanticAnchors: Array<{ text: string; polygon: number[]; }> = [];
  for (const anchor of [...(azureHints?.semanticAnchors || []), ...(localHints?.semanticAnchors || [])]) {
    const text = String(anchor?.text || '').replace(/\s+/g, ' ').trim();
    const polygon = Array.isArray(anchor?.polygon) ? anchor.polygon.map((v) => Number(v.toFixed(2))) : [];
    if (!text || polygon.length < 6) continue;
    const key = `${text.toLowerCase()}|${polygon.join(',')}`;
    if (semanticSeen.has(key)) continue;
    semanticSeen.add(key);
    mergedSemanticAnchors.push({ text: text.slice(0, 120), polygon });
    if (mergedSemanticAnchors.length >= LAYOUT_SEMANTIC_ANCHOR_LIMIT) break;
  }

  const basePages = (azureHints?.pages?.length || 0) > 0 ? azureHints?.pages : localHints?.pages;
  return {
    pageCount: Math.max(localHints?.pageCount || 0, azureHints?.pageCount || 0, basePages?.length || 0),
    pages: basePages || [],
    linePolygons: mergedLinePolygons,
    dimensionAnchors: mergedAnchors,
    lineTexts: mergedLineTexts,
    floorLabelAnchors: mergedFloorLabels,
    semanticAnchors: mergedSemanticAnchors,
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

    const maxDim = Math.max(768, Math.min(4096, Number(process.env.INFRALITH_PREPROCESS_MAX_DIM || 3072)));
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
    const semanticAnchors: Array<{ text: string; polygon: number[]; }> = [];
    const lineTextSeen = new Set<string>();
    const semanticSeen = new Set<string>();
    const isSemanticText = (text: string) =>
      SEMANTIC_MENTION_DEFS.some((def) => def.patterns.some((pattern) => pattern.test(text)));

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
      if (text && isSemanticText(text) && semanticAnchors.length < LAYOUT_SEMANTIC_ANCHOR_LIMIT) {
        if (polygon.length >= 6) {
          const semanticText = text.slice(0, 120);
          const semanticKey = `${semanticText.toLowerCase()}|${polygon.join(',')}`;
          if (!semanticSeen.has(semanticKey)) {
            semanticSeen.add(semanticKey);
            semanticAnchors.push({ text: semanticText, polygon });
          }
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
        if (text && isSemanticText(text) && semanticAnchors.length < LAYOUT_SEMANTIC_ANCHOR_LIMIT) {
          if (polygon.length >= 6) {
            const semanticText = text.slice(0, 120);
            const semanticKey = `${semanticText.toLowerCase()}|${polygon.join(',')}`;
            if (!semanticSeen.has(semanticKey)) {
              semanticSeen.add(semanticKey);
              semanticAnchors.push({ text: semanticText, polygon });
            }
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
      semanticAnchors: semanticAnchors.length,
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
      semanticAnchors,
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
  left: number;
  top: number;
  width: number;
  height: number;
  source: 'cluster' | 'band' | 'whole';
  signalScore: number;
};

type BlueprintSheetAnalysis = {
  kind: BlueprintSheetType;
  confidence: number;
  planRegionCount: number;
  planRegionConfidence: number;
  manualReviewRecommended: boolean;
  reasons: string[];
  regions: Array<BlueprintPlanRegionHint & { source: 'cluster' | 'band' | 'whole'; confidence: number }>;
  explicitPlanCaptionCount: number;
  floorSignalCount: number;
};

type FocusedPlanCrop = {
  left: number;
  top: number;
  width: number;
  height: number;
  regionCount: number;
  confidence: number;
  areaRatio: number;
  reason: string;
};

type BoundingBox2D = [number, number, number, number];

const polygonToBoundingBox = (polygon: number[] | null | undefined): BoundingBox2D | null => {
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

const getBoundingBoxCenter = (bbox: BoundingBox2D): [number, number] => [
  (bbox[0] + bbox[2]) / 2,
  (bbox[1] + bbox[3]) / 2,
];

const getBoundingBoxArea = (bbox: BoundingBox2D): number =>
  Math.max(0, bbox[2] - bbox[0]) * Math.max(0, bbox[3] - bbox[1]);

const mergeBoundingBoxes = (boxes: Array<BoundingBox2D | null | undefined>): BoundingBox2D | null => {
  const valid = boxes.filter((box): box is BoundingBox2D => Array.isArray(box) && box.length === 4);
  if (valid.length === 0) return null;
  return [
    Math.min(...valid.map((box) => box[0])),
    Math.min(...valid.map((box) => box[1])),
    Math.max(...valid.map((box) => box[2])),
    Math.max(...valid.map((box) => box[3])),
  ];
};

const clampBoundingBoxToImage = (
  bbox: BoundingBox2D,
  imageWidth: number,
  imageHeight: number
): BoundingBox2D => {
  const x0 = Math.max(0, Math.min(imageWidth, bbox[0]));
  const y0 = Math.max(0, Math.min(imageHeight, bbox[1]));
  const x1 = Math.max(x0, Math.min(imageWidth, bbox[2]));
  const y1 = Math.max(y0, Math.min(imageHeight, bbox[3]));
  return [x0, y0, x1, y1];
};

const expandBoundingBox = (
  bbox: BoundingBox2D,
  padX: number,
  padY: number,
  imageWidth: number,
  imageHeight: number
): BoundingBox2D =>
  clampBoundingBoxToImage(
    [
      bbox[0] - Math.max(0, padX),
      bbox[1] - Math.max(0, padY),
      bbox[2] + Math.max(0, padX),
      bbox[3] + Math.max(0, padY),
    ],
    imageWidth,
    imageHeight
  );

const boundingBoxesIntersect = (a: BoundingBox2D, b: BoundingBox2D): boolean =>
  !(a[2] <= b[0] || a[0] >= b[2] || a[3] <= b[1] || a[1] >= b[3]);

const computeBoundingBoxIoU = (a: BoundingBox2D, b: BoundingBox2D): number => {
  const overlapW = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
  const overlapH = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const overlap = overlapW * overlapH;
  if (overlap <= 0) return 0;
  const union = getBoundingBoxArea(a) + getBoundingBoxArea(b) - overlap;
  return union > 0 ? overlap / union : 0;
};

const normalizeFloorLabelKey = (value: string): string =>
  String(value || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

const createFloorPlanFromBoundingBox = (
  label: string,
  level: number,
  bbox: BoundingBox2D,
  imageWidth: number,
  imageHeight: number,
  source: FloorCropPlan['source'],
  signalScore: number
): FloorCropPlan | null => {
  const clamped = clampBoundingBoxToImage(bbox, imageWidth, imageHeight);
  const width = Math.max(0, clamped[2] - clamped[0]);
  const height = Math.max(0, clamped[3] - clamped[1]);
  const minWidth = Math.max(120, imageWidth * 0.08);
  const minHeight = Math.max(120, imageHeight * 0.1);
  if (width < minWidth || height < minHeight) return null;
  return {
    label,
    level,
    left: Math.round(clamped[0]),
    top: Math.round(clamped[1]),
    width: Math.round(width),
    height: Math.round(height),
    source,
    signalScore: Number(signalScore.toFixed(3)),
  };
};

const compareFloorPlanStrength = (left: FloorCropPlan, right: FloorCropPlan): number => {
  if (left.signalScore !== right.signalScore) return right.signalScore - left.signalScore;
  const leftArea = left.width * left.height;
  const rightArea = right.width * right.height;
  if (leftArea !== rightArea) return rightArea - leftArea;
  return left.top - right.top;
};

const selectBestFloorPlanPerLevel = (plans: FloorCropPlan[]): FloorCropPlan[] => {
  if (plans.length <= 1) return plans;

  const bestByLevel = new Map<number, FloorCropPlan>();
  for (const plan of plans) {
    const existing = bestByLevel.get(plan.level);
    if (!existing) {
      bestByLevel.set(plan.level, plan);
      continue;
    }

    const existingArea = existing.width * existing.height;
    const nextArea = plan.width * plan.height;
    const preferCurrent =
      plan.signalScore > existing.signalScore + 0.25 ||
      (plan.signalScore >= existing.signalScore - 0.1 && nextArea > existingArea * 1.08) ||
      (plan.signalScore === existing.signalScore && nextArea === existingArea && plan.top < existing.top);
    if (preferCurrent) bestByLevel.set(plan.level, plan);
  }

  return [...bestByLevel.values()]
    .sort((a, b) => (a.level - b.level) || compareFloorPlanStrength(a, b))
    .slice(0, 6);
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

const deriveBandFloorCropPlans = (
  layoutHints: BlueprintLayoutHints | null,
  imageWidth: number,
  imageHeight: number
): FloorCropPlan[] => {
  if (!layoutHints || imageWidth <= 0 || imageHeight <= 0) return [];

  const allAnchors = (layoutHints.floorLabelAnchors || [])
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

  const anchors = selectPreferredFloorCaptionAnchors(allAnchors);

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
      left: 0,
      top,
      width: imageWidth,
      height: bandHeight,
      source: 'band',
      signalScore: 1,
    });
  }

  return selectBestFloorPlanPerLevel(plans);
};

const deriveClusteredFloorCropPlans = (
  layoutHints: BlueprintLayoutHints | null,
  imageWidth: number,
  imageHeight: number
): FloorCropPlan[] => {
  if (!layoutHints || imageWidth <= 0 || imageHeight <= 0) return [];

  const rawAnchors = (layoutHints.floorLabelAnchors || [])
    .map((anchor, index) => {
      const bbox = polygonToBoundingBox(anchor?.polygon || []);
      if (!bbox) return null;
      const [centerX, centerY] = getBoundingBoxCenter(bbox);
      return {
        text: String(anchor?.text || '').trim(),
        labelKey: normalizeFloorLabelKey(String(anchor?.text || '')),
        bbox,
        centerX,
        centerY,
        level: floorLabelToLevel(String(anchor?.text || ''), index),
      };
    })
    .filter((entry): entry is NonNullable<typeof entry> => !!entry)
    .sort((a, b) => (a.centerY - b.centerY) || (a.centerX - b.centerX));

  if (rawAnchors.length < 2) return [];

  const dedupeX = Math.max(24, imageWidth * 0.025);
  const dedupeY = Math.max(18, imageHeight * 0.025);
  const anchors: typeof rawAnchors = [];
  for (const anchor of rawAnchors) {
    const duplicateIndex = anchors.findIndex((existing) =>
      existing.labelKey === anchor.labelKey &&
      Math.abs(existing.centerX - anchor.centerX) <= dedupeX &&
      Math.abs(existing.centerY - anchor.centerY) <= dedupeY
    );
    if (duplicateIndex < 0) {
      anchors.push(anchor);
      continue;
    }
    const existing = anchors[duplicateIndex];
    const existingArea = getBoundingBoxArea(existing.bbox);
    const nextArea = getBoundingBoxArea(anchor.bbox);
    if (nextArea > existingArea || anchor.text.length > existing.text.length) {
      anchors[duplicateIndex] = anchor;
    }
  }

  if (anchors.length < 2) return [];

  const preferredAnchors = selectPreferredFloorCaptionAnchors(anchors);
  if (preferredAnchors.length < 2) return [];

  const dimensionBoxes = (layoutHints.dimensionAnchors || [])
    .map((anchor) => polygonToBoundingBox(anchor?.polygon || []))
    .filter((box): box is BoundingBox2D => !!box);
  const semanticBoxes = (layoutHints.semanticAnchors || [])
    .map((anchor) => polygonToBoundingBox(anchor?.polygon || []))
    .filter((box): box is BoundingBox2D => !!box);
  const lineBoxes = (layoutHints.linePolygons || [])
    .map((polygon) => polygonToBoundingBox(polygon))
    .filter((box): box is BoundingBox2D => !!box);

  const maxAbove = Math.max(140, imageHeight * 0.42);
  const maxBelow = Math.max(90, imageHeight * 0.18);
  const horizontalReach = Math.max(160, imageWidth * 0.18);

  const assignSeedBoxes = (boxes: BoundingBox2D[]) => {
    const assignments = preferredAnchors.map(() => [] as BoundingBox2D[]);
    for (const box of boxes) {
      const [cx, cy] = getBoundingBoxCenter(box);
      let bestIndex = -1;
      let bestScore = Number.POSITIVE_INFINITY;
      for (let anchorIndex = 0; anchorIndex < preferredAnchors.length; anchorIndex += 1) {
        const anchor = preferredAnchors[anchorIndex];
        if (Math.abs(cx - anchor.centerX) > horizontalReach * 1.35) continue;
        const dy = cy - anchor.centerY;
        if (dy < -maxAbove || dy > maxBelow * 1.8) continue;
        const horizontalPenalty = Math.abs(cx - anchor.centerX) / horizontalReach;
        const verticalPenalty = dy <= 0
          ? Math.abs(dy) / maxAbove
          : 0.85 + (dy / Math.max(maxBelow, 1));
        const score = (horizontalPenalty * 1.2) + verticalPenalty;
        if (score > 2.45) continue;
        if (score < bestScore) {
          bestScore = score;
          bestIndex = anchorIndex;
        }
      }
      if (bestIndex >= 0) assignments[bestIndex].push(box);
    }
    return assignments;
  };

  const dimensionAssignments = assignSeedBoxes(dimensionBoxes);
  const semanticAssignments = assignSeedBoxes(semanticBoxes);

  const candidatePlans: FloorCropPlan[] = [];
  for (let index = 0; index < preferredAnchors.length; index += 1) {
    const anchor = preferredAnchors[index];
    const looksLikePlanCaption = isExplicitFloorPlanCaption(anchor.text);
    const seedBoxes = [
      ...dimensionAssignments[index],
      ...semanticAssignments[index],
    ];
    const baseBox = mergeBoundingBoxes([anchor.bbox, ...seedBoxes]);
    if (!baseBox) continue;

    const seedPadX = Math.max(48, imageWidth * 0.035);
    const seedPadY = Math.max(42, imageHeight * 0.03);
    const explorationBox = expandBoundingBox(
      baseBox,
      seedBoxes.length > 0 ? seedPadX * 1.6 : Math.max(seedPadX * 2.4, horizontalReach * 0.9),
      seedBoxes.length > 0 ? seedPadY * 1.7 : Math.max(seedPadY * 2.6, imageHeight * 0.18),
      imageWidth,
      imageHeight
    );

    const lineSupport = lineBoxes.filter((box) => {
      if (!boundingBoxesIntersect(box, explorationBox)) return false;
      const [cx, cy] = getBoundingBoxCenter(box);
      if (Math.abs(cx - anchor.centerX) > horizontalReach * 1.55) return false;
      if (cy > anchor.centerY + maxBelow * 1.6) return false;
      return true;
    });

    if (seedBoxes.length === 0) {
      if (!looksLikePlanCaption) continue;
      if (lineSupport.length < 18) continue;
    }

    const mergedBox = mergeBoundingBoxes([baseBox, ...lineSupport]) || baseBox;
    const paddedBox = expandBoundingBox(
      mergedBox,
      Math.max(36, imageWidth * 0.025),
      Math.max(30, imageHeight * 0.022),
      imageWidth,
      imageHeight
    );
    const signalScore =
      (looksLikePlanCaption ? 10 : 0) +
      (dimensionAssignments[index].length * 6) +
      (semanticAssignments[index].length * 8) +
      (lineSupport.length * 0.12);
    const plan = createFloorPlanFromBoundingBox(
      anchor.text || `Floor ${anchor.level}`,
      anchor.level,
      paddedBox,
      imageWidth,
      imageHeight,
      'cluster',
      signalScore
    );
    if (!plan) continue;
    candidatePlans.push(plan);
  }

  if (candidatePlans.length < 2) return [];

  candidatePlans.sort((a, b) => {
    if (a.level !== b.level) return a.level - b.level;
    return b.signalScore - a.signalScore;
  });

  const filtered: FloorCropPlan[] = [];
  for (const plan of candidatePlans) {
    const planBox: BoundingBox2D = [
      plan.left,
      plan.top,
      plan.left + plan.width,
      plan.top + plan.height,
    ];
    const overlappingIndex = filtered.findIndex((existing) => {
      const existingBox: BoundingBox2D = [
        existing.left,
        existing.top,
        existing.left + existing.width,
        existing.top + existing.height,
      ];
      return computeBoundingBoxIoU(planBox, existingBox) >= 0.52;
    });
    if (overlappingIndex < 0) {
      filtered.push(plan);
      continue;
    }
    const existing = filtered[overlappingIndex];
    const preferCurrent =
      plan.signalScore > existing.signalScore ||
      (plan.signalScore === existing.signalScore && (plan.width * plan.height) > (existing.width * existing.height));
    if (preferCurrent) filtered[overlappingIndex] = plan;
  }

  return selectBestFloorPlanPerLevel(filtered);
};

const deriveRegionGuidedFloorCropPlans = (
  sheetAnalysis: BlueprintSheetAnalysis | null,
  imageWidth: number,
  imageHeight: number
): FloorCropPlan[] => {
  if (!sheetAnalysis || imageWidth <= 0 || imageHeight <= 0) return [];
  if (sheetAnalysis.planRegionConfidence < 0.55) return [];

  const candidatePlans = (sheetAnalysis.regions || [])
    .map((region, index) => {
      const left = toFiniteScalar(region.left);
      const top = toFiniteScalar(region.top);
      const width = toFiniteScalar(region.width);
      const height = toFiniteScalar(region.height);
      const confidence = clampConfidence01(toFiniteScalar(region.confidence) ?? 0);
      if (
        left == null ||
        top == null ||
        width == null ||
        height == null ||
        width <= 1 ||
        height <= 1 ||
        confidence < 0.42
      ) {
        return null;
      }

      const fallbackLevel = floorLabelToLevel(String(region.label || ''), index);
      const level = Number.isFinite(region.level) ? Math.max(0, Math.round(region.level)) : fallbackLevel;
      const bbox: BoundingBox2D = [left, top, left + width, top + height];
      const areaRatio = (width * height) / Math.max(1, imageWidth * imageHeight);
      const source: FloorCropPlan['source'] =
        region.source === 'band' || region.source === 'whole' ? region.source : 'cluster';
      const signalScore =
        (confidence * 24) +
        (isExplicitFloorPlanCaption(region.label) ? 7 : 0) +
        Math.min(3.5, areaRatio * 10) +
        (sheetAnalysis.kind === 'mixed_sheet' && source === 'cluster' ? 2.2 : 0);

      return createFloorPlanFromBoundingBox(
        String(region.label || '').trim() || `Floor ${level + 1}`,
        level,
        bbox,
        imageWidth,
        imageHeight,
        source,
        signalScore
      );
    })
    .filter((plan): plan is FloorCropPlan => !!plan)
    .sort(compareFloorPlanStrength);

  if (candidatePlans.length === 0) return [];
  return selectBestFloorPlanPerLevel(candidatePlans);
};

const deriveFloorCropPlans = (
  layoutHints: BlueprintLayoutHints | null,
  sheetAnalysis: BlueprintSheetAnalysis | null,
  imageWidth: number,
  imageHeight: number
): FloorCropPlan[] => {
  const regionGuided = deriveRegionGuidedFloorCropPlans(sheetAnalysis, imageWidth, imageHeight);
  const clustered = deriveClusteredFloorCropPlans(layoutHints, imageWidth, imageHeight);
  const mergedStructured = selectBestFloorPlanPerLevel([...regionGuided, ...clustered]);
  if (mergedStructured.length >= 2) return mergedStructured;
  if (regionGuided.length >= 2) return regionGuided;
  if (clustered.length >= 2) return clustered;

  const band = deriveBandFloorCropPlans(layoutHints, imageWidth, imageHeight);
  const mergedFallback = selectBestFloorPlanPerLevel([...mergedStructured, ...band]);
  if (mergedFallback.length >= 2) return mergedFallback;
  return band.length > 0 ? band : mergedFallback;
};

const clampConfidence01 = (value: number): number =>
  Number(Math.max(0, Math.min(1, value)).toFixed(3));

const countBlueprintTextSignals = (texts: string[], pattern: RegExp): number =>
  texts.reduce((count, text) => count + (pattern.test(text) ? 1 : 0), 0);

const deriveWholeSheetPlanFallback = (
  layoutHints: BlueprintLayoutHints | null,
  imageWidth: number,
  imageHeight: number
): FloorCropPlan[] => {
  if (!layoutHints || imageWidth <= 0 || imageHeight <= 0) return [];

  const texts = collectLayoutSemanticText(layoutHints);
  const semanticSignalCount = countBlueprintTextSignals(texts, ROOM_SEMANTIC_SIGNAL_REGEX);
  const dimensionSignalCount = layoutHints.dimensionAnchors?.length || 0;
  const elevationSignalCount = countBlueprintTextSignals(texts, SHEET_ELEVATION_SIGNAL_REGEX);
  const metadataSignalCount = countBlueprintTextSignals(texts, SHEET_METADATA_SIGNAL_REGEX);
  const explicitFloorAnchor = (layoutHints.floorLabelAnchors || []).find((anchor) =>
    isExplicitFloorPlanCaption(String(anchor?.text || ''))
  );

  const likelySinglePlanSheet =
    semanticSignalCount >= 3 &&
    dimensionSignalCount >= 2 &&
    elevationSignalCount === 0 &&
    metadataSignalCount <= 3;
  if (!likelySinglePlanSheet) return [];

  return [{
    label: String(explicitFloorAnchor?.text || 'Primary floor plan').trim(),
    level: floorLabelToLevel(String(explicitFloorAnchor?.text || ''), 0),
    left: 0,
    top: 0,
    width: imageWidth,
    height: imageHeight,
    source: 'whole',
    signalScore: Number((10 + (semanticSignalCount * 3) + Math.min(18, dimensionSignalCount * 2)).toFixed(3)),
  }];
};

const derivePlanCropPlansForAnalysis = (
  layoutHints: BlueprintLayoutHints | null,
  imageWidth: number,
  imageHeight: number
): FloorCropPlan[] => {
  const sanitizePlan = (plan: FloorCropPlan): FloorCropPlan | null => {
    const left = toFiniteScalar(plan.left);
    const top = toFiniteScalar(plan.top);
    const width = toFiniteScalar(plan.width);
    const height = toFiniteScalar(plan.height);
    if (
      left == null ||
      top == null ||
      width == null ||
      height == null ||
      width <= 1 ||
      height <= 1 ||
      imageWidth <= 0 ||
      imageHeight <= 0
    ) {
      return null;
    }

    const safeLeft = Math.min(Math.max(0, left), Math.max(0, imageWidth - 1));
    const safeTop = Math.min(Math.max(0, top), Math.max(0, imageHeight - 1));
    const safeWidth = Math.min(Math.max(1, width), Math.max(1, imageWidth - safeLeft));
    const safeHeight = Math.min(Math.max(1, height), Math.max(1, imageHeight - safeTop));
    const safeLevel = Number.isFinite(plan.level) ? Math.max(0, Math.round(plan.level)) : 0;
    const safeSignal = toFiniteScalar(plan.signalScore) ?? 0;
    const safeSource: FloorCropPlan['source'] =
      plan.source === 'band' || plan.source === 'whole' ? plan.source : 'cluster';
    const safeLabel = String(plan.label || '').trim() || `Floor ${safeLevel + 1}`;

    return {
      label: safeLabel,
      level: safeLevel,
      left: Number(safeLeft.toFixed(2)),
      top: Number(safeTop.toFixed(2)),
      width: Number(safeWidth.toFixed(2)),
      height: Number(safeHeight.toFixed(2)),
      source: safeSource,
      signalScore: Number(safeSignal.toFixed(3)),
    };
  };

  const plans = deriveFloorCropPlans(layoutHints, null, imageWidth, imageHeight)
    .map(sanitizePlan)
    .filter((plan): plan is FloorCropPlan => !!plan);
  if (plans.length > 0) return plans;
  return deriveWholeSheetPlanFallback(layoutHints, imageWidth, imageHeight)
    .map(sanitizePlan)
    .filter((plan): plan is FloorCropPlan => !!plan);
};

const sanitizeBlueprintSheetAnalysis = (
  sheetAnalysis: BlueprintSheetAnalysis | null
): BlueprintSheetAnalysis | null => {
  if (!sheetAnalysis) return null;

  const safeRegions = (sheetAnalysis.regions || [])
    .map((region) => {
      const left = toFiniteScalar(region.left);
      const top = toFiniteScalar(region.top);
      const width = toFiniteScalar(region.width);
      const height = toFiniteScalar(region.height);
      const confidence = toFiniteScalar(region.confidence);
      if (
        left == null ||
        top == null ||
        width == null ||
        height == null ||
        confidence == null ||
        width <= 1 ||
        height <= 1
      ) {
        return null;
      }

      return {
        label: String(region.label || '').trim() || `Floor ${Math.max(0, Math.round(region.level || 0)) + 1}`,
        level: Number.isFinite(region.level) ? Math.max(0, Math.round(region.level)) : 0,
        left: Number(left.toFixed(2)),
        top: Number(top.toFixed(2)),
        width: Number(width.toFixed(2)),
        height: Number(height.toFixed(2)),
        source: region.source === 'band' || region.source === 'whole' ? region.source : 'cluster',
        confidence: clampConfidence01(confidence),
      };
    })
    .filter((region): region is BlueprintSheetAnalysis['regions'][number] => !!region)
    .slice(0, 6);

  const kind: BlueprintSheetType =
    sheetAnalysis.kind === 'floor_plan' ||
    sheetAnalysis.kind === 'mixed_sheet' ||
    sheetAnalysis.kind === 'site_plan' ||
    sheetAnalysis.kind === 'elevation_only'
      ? sheetAnalysis.kind
      : 'unknown';

  return {
    kind,
    confidence: clampConfidence01(toFiniteScalar(sheetAnalysis.confidence) ?? 0),
    planRegionCount: safeRegions.length,
    planRegionConfidence: clampConfidence01(toFiniteScalar(sheetAnalysis.planRegionConfidence) ?? 0),
    manualReviewRecommended: Boolean(sheetAnalysis.manualReviewRecommended),
    reasons: (sheetAnalysis.reasons || []).map((reason) => String(reason || '').trim()).filter(Boolean).slice(0, 5),
    regions: safeRegions,
    explicitPlanCaptionCount: Math.max(0, Math.round(toFiniteScalar(sheetAnalysis.explicitPlanCaptionCount) ?? 0)),
    floorSignalCount: Math.max(0, Math.round(toFiniteScalar(sheetAnalysis.floorSignalCount) ?? 0)),
  };
};

const deriveFocusedPlanCrop = (
  sheetAnalysis: BlueprintSheetAnalysis | null,
  imageWidth: number,
  imageHeight: number
): FocusedPlanCrop | null => {
  if (!sheetAnalysis || imageWidth <= 0 || imageHeight <= 0) return null;
  if (sheetAnalysis.kind !== 'mixed_sheet' && sheetAnalysis.kind !== 'floor_plan') return null;
  if (sheetAnalysis.planRegionConfidence < 0.55) return null;

  const candidateRegions = (sheetAnalysis.regions || [])
    .filter((region) =>
      Number.isFinite(region.left) &&
      Number.isFinite(region.top) &&
      Number.isFinite(region.width) &&
      Number.isFinite(region.height) &&
      Number.isFinite(region.confidence) &&
      region.width > 1 &&
      region.height > 1 &&
      region.confidence >= 0.42
    )
    .sort((a, b) =>
      (b.confidence - a.confidence) ||
      ((b.width * b.height) - (a.width * a.height))
    );

  if (candidateRegions.length === 0) return null;

  const regionsToUse =
    sheetAnalysis.kind === 'mixed_sheet'
      ? candidateRegions.slice(0, Math.min(4, candidateRegions.length))
      : [candidateRegions[0]];

  const minLeft = Math.min(...regionsToUse.map((region) => region.left));
  const minTop = Math.min(...regionsToUse.map((region) => region.top));
  const maxRight = Math.max(...regionsToUse.map((region) => region.left + region.width));
  const maxBottom = Math.max(...regionsToUse.map((region) => region.top + region.height));

  const padX = Math.max(28, Math.round(imageWidth * (sheetAnalysis.kind === 'mixed_sheet' ? 0.04 : 0.03)));
  const padY = Math.max(28, Math.round(imageHeight * (sheetAnalysis.kind === 'mixed_sheet' ? 0.04 : 0.03)));
  const left = Math.max(0, minLeft - padX);
  const top = Math.max(0, minTop - padY);
  const right = Math.min(imageWidth, maxRight + padX);
  const bottom = Math.min(imageHeight, maxBottom + padY);
  const width = Math.max(1, right - left);
  const height = Math.max(1, bottom - top);
  const areaRatio = (width * height) / Math.max(1, imageWidth * imageHeight);
  const bestConfidence = Math.max(...regionsToUse.map((region) => region.confidence));

  const meaningfulCrop =
    sheetAnalysis.kind === 'mixed_sheet'
      ? areaRatio < 0.985
      : areaRatio < 0.94;
  if (!meaningfulCrop) return null;

  return {
    left: Number(left.toFixed(2)),
    top: Number(top.toFixed(2)),
    width: Number(width.toFixed(2)),
    height: Number(height.toFixed(2)),
    regionCount: regionsToUse.length,
    confidence: clampConfidence01(bestConfidence),
    areaRatio: Number(areaRatio.toFixed(3)),
    reason:
      sheetAnalysis.kind === 'mixed_sheet'
        ? 'focused union crop over detected plan blocks to suppress elevation/title noise'
        : 'focused crop over strongest detected plan block',
  };
};

const analyzeBlueprintSheet = (
  layoutHints: BlueprintLayoutHints | null,
  imageWidth: number,
  imageHeight: number
): BlueprintSheetAnalysis | null => {
  if (!layoutHints) return null;

  const texts = collectLayoutSemanticText(layoutHints);
  const explicitPlanCaptionCount = estimateExplicitFloorPlanHintCount(layoutHints);
  const floorSignalCount = estimateFloorHintCount(layoutHints);
  const elevationSignalCount = countBlueprintTextSignals(texts, SHEET_ELEVATION_SIGNAL_REGEX);
  const metadataSignalCount = countBlueprintTextSignals(texts, SHEET_METADATA_SIGNAL_REGEX);
  const siteSignalCount = countBlueprintTextSignals(texts, SHEET_SITE_SIGNAL_REGEX);
  const semanticSignalCount = countBlueprintTextSignals(texts, ROOM_SEMANTIC_SIGNAL_REGEX);
  const dimensionSignalCount = layoutHints.dimensionAnchors?.length || 0;
  const planCandidates = derivePlanCropPlansForAnalysis(layoutHints, imageWidth, imageHeight);
  const averageSignalScore =
    planCandidates.length > 0
      ? planCandidates.reduce((sum, plan) => sum + Math.max(0, plan.signalScore), 0) / planCandidates.length
      : 0;

  let kind: BlueprintSheetType = 'unknown';
  if (siteSignalCount >= 3 && explicitPlanCaptionCount === 0 && semanticSignalCount < 5) {
    kind = 'site_plan';
  } else if (elevationSignalCount >= 2 && explicitPlanCaptionCount === 0 && planCandidates.length === 0) {
    kind = 'elevation_only';
  } else if (
    (explicitPlanCaptionCount >= 2 || planCandidates.length >= 2) &&
    (elevationSignalCount >= 1 || metadataSignalCount >= 3 || siteSignalCount >= 2)
  ) {
    kind = 'mixed_sheet';
  } else if (
    explicitPlanCaptionCount >= 1 ||
    (planCandidates.length >= 1 && semanticSignalCount >= 3 && dimensionSignalCount >= 2)
  ) {
    kind = 'floor_plan';
  } else if (elevationSignalCount >= 1 && semanticSignalCount < 3) {
    kind = 'elevation_only';
  }

  const planRegionConfidence = clampConfidence01(
    (planCandidates.length > 0 ? 0.2 : 0) +
    Math.min(0.26, explicitPlanCaptionCount * 0.14) +
    Math.min(0.18, semanticSignalCount * 0.025) +
    Math.min(0.16, dimensionSignalCount * 0.018) +
    Math.min(0.18, averageSignalScore / 70) -
    Math.min(0.2, elevationSignalCount * 0.08) -
    Math.min(0.16, metadataSignalCount * 0.03) -
    (kind === 'mixed_sheet' ? 0.08 : 0) -
    (kind === 'unknown' ? 0.1 : 0)
  );

  const confidence = clampConfidence01(
    planRegionConfidence +
    (kind === 'floor_plan' ? 0.1 : 0) +
    (kind === 'mixed_sheet' ? 0.04 : 0) +
    (kind === 'site_plan' || kind === 'elevation_only' ? -0.08 : 0)
  );

  const regions = planCandidates.map((plan) => {
    const areaRatio = imageWidth > 0 && imageHeight > 0
      ? (plan.width * plan.height) / Math.max(1, imageWidth * imageHeight)
      : 0;
    const regionConfidence = clampConfidence01(
      (plan.source === 'cluster' ? 0.48 : plan.source === 'band' ? 0.36 : 0.3) +
      (isExplicitFloorPlanCaption(plan.label) ? 0.16 : 0) +
      Math.min(0.22, plan.signalScore / 65) +
      Math.min(0.1, areaRatio * 0.35) -
      (kind === 'mixed_sheet' && plan.source === 'whole' ? 0.18 : 0)
    );
    return {
      label: plan.label,
      level: plan.level,
      left: plan.left,
      top: plan.top,
      width: plan.width,
      height: plan.height,
      source: plan.source,
      confidence: regionConfidence,
    };
  });

  const reasons: string[] = [];
  if (kind === 'mixed_sheet') {
    reasons.push('Mixed blueprint sheet detected with floor-plan content plus elevation/metadata noise.');
  } else if (kind === 'site_plan') {
    reasons.push('Sheet appears site/master-plan oriented rather than a single isolated floor plan.');
  } else if (kind === 'elevation_only') {
    reasons.push('Sheet appears dominated by elevation/section style content instead of plan view.');
  }
  if (planCandidates.length === 0) reasons.push('No high-confidence plan region was isolated from the sheet.');
  if (explicitPlanCaptionCount >= 2 && planCandidates.length < explicitPlanCaptionCount) {
    reasons.push('Detected floor captions exceed isolated plan regions, indicating incomplete crop recovery.');
  }
  if (planRegionConfidence < 0.58) {
    reasons.push(`Plan-region detection confidence is low (${Math.round(planRegionConfidence * 100)}%).`);
  }

  const manualReviewRecommended =
    kind === 'mixed_sheet' ||
    kind === 'site_plan' ||
    kind === 'elevation_only' ||
    kind === 'unknown' ||
    planRegionConfidence < 0.58 ||
    (explicitPlanCaptionCount >= 2 && planCandidates.length < explicitPlanCaptionCount);

  return {
    kind,
    confidence,
    planRegionCount: regions.length,
    planRegionConfidence,
    manualReviewRecommended,
    reasons: reasons.slice(0, 5),
    regions: regions.slice(0, 6),
    explicitPlanCaptionCount,
    floorSignalCount,
  };
};

const applySheetAnalysisToResult = (
  payload: GeometricReconstruction,
  sheetAnalysis: BlueprintSheetAnalysis | null
): GeometricReconstruction => {
  if (!sheetAnalysis) return payload;

  const baseLocation =
    payload?.rooms?.[0]?.polygon?.[0] ||
    payload?.walls?.[0]?.start ||
    [0, 0];
  const nextMeta = {
    ...(payload.meta || {}),
    sheet_type: sheetAnalysis.kind,
    sheet_confidence: sheetAnalysis.confidence,
    plan_region_count: sheetAnalysis.planRegionCount,
    plan_region_confidence: sheetAnalysis.planRegionConfidence,
    manual_review_recommended: sheetAnalysis.manualReviewRecommended,
    sheet_analysis_reasons: sheetAnalysis.reasons,
    plan_regions: sheetAnalysis.regions.map((region) => ({
      label: region.label,
      level: region.level,
      left: region.left,
      top: region.top,
      width: region.width,
      height: region.height,
      confidence: region.confidence,
      source: region.source,
    })),
  };

  let sheetConflict: GeometricReconstruction['conflicts'][number] | null = null;
  if (sheetAnalysis.kind === 'mixed_sheet') {
    sheetConflict = {
      type: 'structural',
      severity: sheetAnalysis.planRegionConfidence < 0.5 ? 'high' : 'medium',
      description: `Mixed blueprint sheet detected. Isolated ${sheetAnalysis.planRegionCount} candidate plan region(s) at ${Math.round(sheetAnalysis.planRegionConfidence * 100)}% confidence. Manual crop review is recommended before trusting the generated 3D.`,
      location: [Number(baseLocation[0] || 0), Number(baseLocation[1] || 0)] as [number, number],
    };
  } else if (sheetAnalysis.kind === 'site_plan') {
    sheetConflict = {
      type: 'code',
      severity: 'medium',
      description: 'Sheet appears site/master-plan oriented. Use Site Mode or upload an isolated building floor plan for more reliable 3D generation.',
      location: [Number(baseLocation[0] || 0), Number(baseLocation[1] || 0)] as [number, number],
    };
  } else if (sheetAnalysis.kind === 'elevation_only') {
    sheetConflict = {
      type: 'structural',
      severity: 'high',
      description: 'Sheet appears dominated by elevation/section content instead of a usable floor plan. Upload a plan view or crop the plan block manually.',
      location: [Number(baseLocation[0] || 0), Number(baseLocation[1] || 0)] as [number, number],
    };
  } else if (sheetAnalysis.manualReviewRecommended) {
    sheetConflict = {
      type: 'structural',
      severity: sheetAnalysis.planRegionConfidence < 0.42 ? 'high' : 'medium',
      description: `Plan-region detection confidence is ${Math.round(sheetAnalysis.planRegionConfidence * 100)}%. Manual review is recommended because the sheet layout is ambiguous for fully automatic reconstruction.`,
      location: [Number(baseLocation[0] || 0), Number(baseLocation[1] || 0)] as [number, number],
    };
  }

  return {
    ...payload,
    meta: nextMeta,
    conflicts: sheetConflict
      ? [...(payload.conflicts || []), sheetConflict]
      : [...(payload.conflicts || [])],
  };
};

async function cropImageRect(base64Image: string, left: number, top: number, width: number, height: number): Promise<string | null> {
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
    const imageWidth = Number(metadata?.width || 0);
    const imageHeight = Number(metadata?.height || 0);
    if (imageWidth <= 0 || imageHeight <= 0) return null;

    const safeLeft = Math.max(0, Math.min(imageWidth - 1, Math.floor(left)));
    const safeTop = Math.max(0, Math.min(imageHeight - 1, Math.floor(top)));
    const maxWidth = imageWidth - safeLeft;
    const maxHeight = imageHeight - safeTop;
    const safeWidth = Math.max(1, Math.min(maxWidth, Math.floor(width)));
    const safeHeight = Math.max(1, Math.min(maxHeight, Math.floor(height)));
    if (
      safeWidth < Math.max(96, imageWidth * 0.12) ||
      safeHeight < Math.max(96, imageHeight * 0.12)
    ) {
      return null;
    }

    const cropped = await sharp(inputBuffer, { limitInputPixels: false })
      .rotate()
      .extract({ left: safeLeft, top: safeTop, width: safeWidth, height: safeHeight })
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
  sheetAnalysis: BlueprintSheetAnalysis | null,
  widthHint: number,
  heightHint: number,
  traceId: string
): Promise<GeometricReconstruction | null> {
  const { width, height } = resolveHintImageSize(layoutHints, widthHint, heightHint);
  const plans = deriveFloorCropPlans(layoutHints, sheetAnalysis, width, height);
  if (plans.length < 2) return null;

  traceLog('Infralith Vision Engine', traceId, '4/9', 'attempting segmented multi-floor reconstruction', {
    plannedBands: plans.length,
    plans: plans.map((plan) => ({
      level: plan.level,
      label: plan.label,
      left: plan.left,
      top: plan.top,
      width: plan.width,
      height: plan.height,
      source: plan.source,
      signalScore: plan.signalScore,
    })),
  }, 'warn');

  const floorResults: Array<{ level: number; label: string; payload: GeometricReconstruction }> = [];
  const decompositionConflicts: GeometricReconstruction['conflicts'] = [];

  for (const plan of plans) {
    const cropped =
      (await cropImageRect(structuralImage, plan.left, plan.top, plan.width, plan.height)) ||
      (await cropImageRect(fallbackImage, plan.left, plan.top, plan.width, plan.height));
    if (!cropped) {
      decompositionConflicts.push({
        type: 'structural',
        severity: 'medium',
        description: `Unable to crop floor region for label "${plan.label}".`,
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
    building_name: NOT_AVAILABLE_3D_TEXT,
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
  let sheetAnalysis: BlueprintSheetAnalysis | null = null;
  try {
    sheetAnalysis = sanitizeBlueprintSheetAnalysis(
      analyzeBlueprintSheet(layoutHints, preprocessed.width, preprocessed.height)
    );
    if (sheetAnalysis) {
      traceLog('Infralith Vision Engine', traceId, '1/9', 'heuristic sheet analysis', {
        kind: sheetAnalysis.kind,
        confidence: sheetAnalysis.confidence,
        planRegionCount: sheetAnalysis.planRegionCount,
        planRegionConfidence: sheetAnalysis.planRegionConfidence,
        manualReviewRecommended: sheetAnalysis.manualReviewRecommended,
        reasons: sheetAnalysis.reasons,
      }, sheetAnalysis.manualReviewRecommended ? 'warn' : 'log');
    }
  } catch (error) {
    traceLog('Infralith Vision Engine', traceId, '1/9', 'sheet analysis failed; continuing without review metadata', {
      reason: error instanceof Error ? error.message : String(error),
    }, 'warn');
    sheetAnalysis = null;
  }
  let focusedVisionImage = structuralInputImage;
  const focusedPlanCrop = deriveFocusedPlanCrop(sheetAnalysis, preprocessed.width, preprocessed.height);
  if (focusedPlanCrop) {
    const croppedFocus =
      (await cropImageRect(structuralInputImage, focusedPlanCrop.left, focusedPlanCrop.top, focusedPlanCrop.width, focusedPlanCrop.height)) ||
      (await cropImageRect(imageUrl, focusedPlanCrop.left, focusedPlanCrop.top, focusedPlanCrop.width, focusedPlanCrop.height));
    if (croppedFocus) {
      focusedVisionImage = croppedFocus;
      traceLog('Infralith Vision Engine', traceId, '1/9', 'focused primary vision input from detected plan regions', {
        kind: sheetAnalysis?.kind || 'unknown',
        reason: focusedPlanCrop.reason,
        regionCount: focusedPlanCrop.regionCount,
        confidence: focusedPlanCrop.confidence,
        areaRatio: focusedPlanCrop.areaRatio,
        left: focusedPlanCrop.left,
        top: focusedPlanCrop.top,
        width: focusedPlanCrop.width,
        height: focusedPlanCrop.height,
      }, 'warn');
    } else {
      traceLog('Infralith Vision Engine', traceId, '1/9', 'focused plan crop could not be materialized; continuing with full preprocessed image', {
        reason: focusedPlanCrop.reason,
        regionCount: focusedPlanCrop.regionCount,
        confidence: focusedPlanCrop.confidence,
      }, 'warn');
    }
  }
  const requiredSemanticMentions = extractRequiredSemanticMentionKeys(layoutHints);
  if (requiredSemanticMentions.length > 0) {
    traceLog('Infralith Vision Engine', traceId, '1/9', 'semantic anchors detected from blueprint text', {
      requiredSemanticMentions: describeSemanticMentionKeys(requiredSemanticMentions),
      count: requiredSemanticMentions.length,
    }, 'warn');
  }
  // STAGE 2: Send image + layout hints to the AI Vision model
  let lineRecords = getBlueprintLineDatabase();
  try {
    const lineDbSnapshot = await getBlueprintLineDbSnapshot();
    lineRecords = lineDbSnapshot.records;
    traceLog('Infralith Vision Engine', traceId, '1/9', 'blueprint line semantics snapshot resolved', {
      source: lineDbSnapshot.source,
      writable: lineDbSnapshot.writable,
      records: lineDbSnapshot.records.length,
      updatedAt: lineDbSnapshot.updatedAt,
      schemaVersion: lineDbSnapshot.schemaVersion,
    });
  } catch (error) {
    if (SOURCE_DATA_ONLY_3D) {
      lineRecords = [];
      traceLog('Infralith Vision Engine', traceId, '1/9', 'failed to resolve persisted line semantics DB; continuing with empty semantics in source-only mode', {
        reason: error instanceof Error ? error.message : String(error),
      }, 'warn');
    } else {
      traceLog('Infralith Vision Engine', traceId, '1/9', 'failed to resolve persisted line semantics DB, using bundled defaults', {
        reason: error instanceof Error ? error.message : String(error),
        fallbackRecords: lineRecords.length,
      }, 'warn');
    }
  }
  const prompt = buildBlueprintVisionPrompt(layoutHints, {
    lineRecords,
    sheetAnalysis: sheetAnalysis ? {
      kind: sheetAnalysis.kind,
      confidence: sheetAnalysis.confidence,
      planRegionCount: sheetAnalysis.planRegionCount,
      planRegionConfidence: sheetAnalysis.planRegionConfidence,
      manualReviewRecommended: sheetAnalysis.manualReviewRecommended,
      reasons: sheetAnalysis.reasons,
      regions: sheetAnalysis.regions,
    } : undefined,
  });
  const effectiveBudgetMs = Math.min(VISION_TOTAL_BUDGET_MS, VISION_REQUEST_HARD_BUDGET_MS);
  const getRemainingBudgetMs = () => effectiveBudgetMs - (Date.now() - startedAt);
  traceLog('Infralith Vision Engine', traceId, '2/9', 'vision request budget initialized', {
    configuredBudgetMs: VISION_TOTAL_BUDGET_MS,
    requestHardBudgetMs: VISION_REQUEST_HARD_BUDGET_MS,
    effectiveBudgetMs,
    minRemainingMs: VISION_MIN_PASS_REMAINING_MS,
    estimatedPassCostMs: VISION_PASS_ESTIMATED_COST_MS,
    passTimeoutBufferMs: VISION_PASS_TIMEOUT_BUFFER_MS,
  });
  try {
    traceLog('Infralith Vision Engine', traceId, '2/9', 'sending blueprint + hints to Azure Vision');
    const runVisionPass = async (
      passLabel: string,
      step: string,
      passPrompt: string,
      passImage: string
    ): Promise<GeometricReconstruction> => {
      const remainingMs = getRemainingBudgetMs();
      const timeoutMs = Math.floor(Math.min(
        VISION_PASS_ESTIMATED_COST_MS + 10_000,
        remainingMs - VISION_PASS_TIMEOUT_BUFFER_MS
      ));
      if (!Number.isFinite(timeoutMs) || timeoutMs < 8_000) {
        throw new Error(
          `Skipped ${passLabel}: insufficient remaining request budget (${Math.floor(remainingMs)}ms remaining).`
        );
      }
      return withMonitoredTimeout(
        () => generateAzureVisionObject<GeometricReconstruction>(passPrompt, passImage),
        {
          component: 'Infralith Vision Engine',
          traceId,
          step,
          label: `${passLabel} vision request`,
          timeoutMs,
        }
      );
    };

    let result = await runVisionPass('initial-reconstruction', '2/9', prompt, focusedVisionImage);
    traceLog('Infralith Vision Engine', traceId, '3/9', 'AI reconstruction received', summarizeReconstruction(result));

    let bestResult = result;
    let bestScore = scoreReconstructionDensity(result, layoutHints);
    let bestOpenings = getOpeningCount(result);
    let bestCandidateLabel = 'initial';
    let bestHighSeverityConflicts = (result?.conflicts || []).filter((conflict) => conflict?.severity === 'high').length;
    let bestFidelity = evaluateReconstructionFidelity(result, layoutHints);
    let bestMissingSemanticMentions = getMissingSemanticMentionKeys(requiredSemanticMentions, result).length;

    const canRunVisionPass = (
      passLabel: string,
      optional = true,
      expectedCostMs = VISION_PASS_ESTIMATED_COST_MS
    ): boolean => {
      if (optional && !ENABLE_EXPENSIVE_VISION_RECOVERY) {
        traceLog('Infralith Vision Engine', traceId, '5/9', 'skipping optional recovery pass (disabled by configuration)', {
          passLabel,
          envKey: 'INFRALITH_ENABLE_EXPENSIVE_VISION_RECOVERY',
        }, 'warn');
        return false;
      }
      const elapsedMs = Date.now() - startedAt;
      const remainingMs = getRemainingBudgetMs();
      const requiredRemainingMs = Math.max(VISION_MIN_PASS_REMAINING_MS, expectedCostMs);
      if (remainingMs < requiredRemainingMs) {
        traceLog('Infralith Vision Engine', traceId, '5/9', 'skipping recovery pass due to request time budget', {
          passLabel,
          elapsedMs,
          remainingMs,
          budgetMs: effectiveBudgetMs,
          configuredBudgetMs: VISION_TOTAL_BUDGET_MS,
          expectedCostMs,
          requiredRemainingMs,
          minRemainingMs: VISION_MIN_PASS_REMAINING_MS,
        }, 'warn');
        return false;
      }
      return true;
    };

    const promoteBestCandidate = (
      candidate: GeometricReconstruction | null | undefined,
      label: string,
      options?: {
        minScoreGain?: number;
        allowOpeningBoost?: boolean;
        allowFidelityBoost?: boolean;
        allowConflictBoost?: boolean;
        allowSemanticBoost?: boolean;
        allowFloorBoost?: boolean;
        floorBoostTarget?: number;
        floorBoostScoreTolerance?: number;
      }
    ) => {
      if (!hasNonEmptyWalls(candidate)) return false;
      const minScoreGain = options?.minScoreGain ?? 2;
      const allowOpeningBoost = options?.allowOpeningBoost ?? true;
      const allowFidelityBoost = options?.allowFidelityBoost ?? true;
      const allowConflictBoost = options?.allowConflictBoost ?? true;
      const allowSemanticBoost = options?.allowSemanticBoost ?? true;
      const allowFloorBoost = options?.allowFloorBoost ?? false;
      const floorBoostTarget = Math.max(0, Math.round(options?.floorBoostTarget ?? 0));
      const floorBoostScoreTolerance = Math.max(0, options?.floorBoostScoreTolerance ?? 3);

      const candidateScore = scoreReconstructionDensity(candidate, layoutHints);
      const candidateOpenings = getOpeningCount(candidate);
      const candidateFidelity = evaluateReconstructionFidelity(candidate, layoutHints);
      const candidateHighSeverityConflicts = (candidate?.conflicts || []).filter((conflict) => conflict?.severity === 'high').length;
      const candidateMissingSemanticMentions = getMissingSemanticMentionKeys(requiredSemanticMentions, candidate).length;
      const candidateFloorCount = estimateResultFloorCount(candidate);
      const candidateRooms = candidate?.rooms?.length || 0;
      const candidateWalls = candidate?.walls?.length || 0;
      const bestFloorCount = estimateResultFloorCount(bestResult);
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
      const floorRecovered =
        allowFloorBoost &&
        floorBoostTarget >= 2 &&
        candidateFloorCount >= Math.min(6, floorBoostTarget) &&
        candidateFloorCount > bestFloorCount &&
        candidateScore >= bestScore - floorBoostScoreTolerance &&
        (candidateRooms >= bestRooms + 1 || candidateWalls >= bestWalls + 4);

      if (!(scoreImproved || openingImproved || fidelityImproved || conflictImproved || semanticImproved || structuralDetailImproved || floorRecovered)) {
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

    const baselineScoreGate = Math.max(
      20,
      VISION_CONSENSUS_MIN_SCORE - VISION_ORIGINAL_BASELINE_SCORE_OFFSET
    );
    const shouldTryOriginalBaseline =
      focusedVisionImage !== imageUrl &&
      (bestFidelity.shouldRetry || bestScore < baselineScoreGate);

    if (shouldTryOriginalBaseline && canRunVisionPass('original-image-baseline', false)) {
      traceLog('Infralith Vision Engine', traceId, '3/9', 'running adaptive original-image baseline pass', {
        currentScore: bestScore,
        baselineScoreGate,
        fidelityReasons: bestFidelity.reasons,
      }, 'warn');
      try {
        const originalCandidate = await runVisionPass('original-image-baseline', '3/9', prompt, imageUrl);
        if (hasNonEmptyWalls(originalCandidate)) {
          const promotedOriginal = promoteBestCandidate(originalCandidate, 'original-image-baseline', {
            minScoreGain: 0.8,
            allowOpeningBoost: true,
            allowFidelityBoost: true,
            allowConflictBoost: true,
            allowSemanticBoost: true,
          });
          if (promotedOriginal) {
            result = bestResult;
            traceLog('Infralith Vision Engine', traceId, '3/9', 'original-image baseline improved reconstruction', {
              selected: bestCandidateLabel,
              bestScore,
              bestOpenings,
            }, 'warn');
          }
        }
      } catch (error) {
        traceLog('Infralith Vision Engine', traceId, '3/9', 'original-image baseline failed; continuing current best', {
          reason: error instanceof Error ? error.message : String(error),
        }, 'warn');
      }
    }

    const maxRetries = VISION_MAX_RETRIES;
    let retryCount = 0;
    let fidelity = bestFidelity;
    while (fidelity.shouldRetry && retryCount < maxRetries && canRunVisionPass('strict-retry', false)) {
      retryCount += 1;
      const retryImage = retryCount % 2 === 1 ? imageUrl : focusedVisionImage;
      const strictPrompt = buildBlueprintRetryPrompt(prompt, fidelity.reasons);
      traceLog('Infralith Vision Engine', traceId, '4/9', 'underfit detected, retrying with stricter constraints', {
        retryCount,
        maxRetries,
        imageVariant: retryImage === imageUrl ? 'original' : 'preprocessed',
        reasons: fidelity.reasons,
      }, 'warn');
      result = await runVisionPass(`strict-retry-${retryCount}`, '4/9', strictPrompt, retryImage);
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
    if (requiredSemanticMentions.length > 0 && initialMissingSemanticMentions.length > 0 && canRunVisionPass('semantic-enforcement')) {
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
        const semanticCandidate = await runVisionPass('semantic-enforcement', '5/9', semanticPrompt, focusedVisionImage);
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
    if (stairsRequired && stairsMissing && estimateResultFloorCount(bestResult) >= 2 && canRunVisionPass('staircase-enforcement')) {
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
        const stairCandidate = await runVisionPass('staircase-enforcement', '5/9', stairPrompt, focusedVisionImage);
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
    if (stairSymbolRecoveryNeeded && canRunVisionPass('stair-symbol-recovery')) {
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
        const stairSymbolCandidate = await runVisionPass('stair-symbol-recovery', '5/9', stairSymbolPrompt, focusedVisionImage);
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

    const interiorRecoveryDecision = assessInteriorLayoutRecovery(bestResult, layoutHints);
    if (interiorRecoveryDecision.shouldAttempt && canRunVisionPass('interior-layout-recovery')) {
      traceLog('Infralith Vision Engine', traceId, '5/9', 'interior layout refinement triggered to avoid placeholder partitions', {
        denseFloors: interiorRecoveryDecision.denseFloors,
        gridLikeFloors: interiorRecoveryDecision.gridLikeFloors,
        averageInteriorWallsPerFloor: Number(interiorRecoveryDecision.averageInteriorWallsPerFloor.toFixed(2)),
        interiorWallCount: interiorRecoveryDecision.interiorWallCount,
        semanticAnchorCount: interiorRecoveryDecision.semanticAnchorCount,
        dimensionHintCount: interiorRecoveryDecision.dimensionHintCount,
        dimensionMismatchCount: interiorRecoveryDecision.dimensionMismatchCount,
        reasons: interiorRecoveryDecision.reasons,
      }, 'warn');

      const interiorPromptSeed = `${prompt}

INTERIOR PARTITION REFINEMENT:
- Current reconstruction shows underfit or misplaced interior partitioning.
- Reconstruct interior walls and room polygons from visible wall-line evidence on each floor.
- Preserve validated exterior shell, scale, and floor_count while improving interior partition placement.
- Use room labels and room-size annotations as localization hints for where partitions should separate spaces.
- Interior walls must terminate at real wall junctions or perimeter walls; do not leave floating mid-room wall fragments.
- Do not run a partition through the center of a labeled room unless the drawing clearly shows a wall crossing that space.
- Do not clone the same split grid across floors unless the drawing explicitly matches.
- Keep stairs/bathrooms/circulation spaces when evidence exists.
- If a boundary is uncertain, keep geometry conservative and emit explicit conflict instead of forcing symmetric quadrants.
`;
      const recoveryDiagnostics = interiorRecoveryDecision.reasons.length > 0
        ? interiorRecoveryDecision.reasons
        : ['Interior partition placement appears underfit and overly repetitive; refine using visible line evidence only.'];
      const interiorPrompt = buildBlueprintRetryPrompt(interiorPromptSeed, recoveryDiagnostics.slice(0, 4));

      try {
        const interiorCandidate = await runVisionPass('interior-layout-recovery', '5/9', interiorPrompt, focusedVisionImage);
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

    if (shouldAttemptRoomDimensionRecovery(bestResult, layoutHints) && canRunVisionPass('room-dimension-enforcement')) {
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
        const dimensionCandidate = await runVisionPass('room-dimension-enforcement', '5/9', dimensionPrompt, focusedVisionImage);
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

    const interiorWallPlacementDecision = assessInteriorLayoutRecovery(bestResult, layoutHints);
    if (
      interiorWallPlacementDecision.shouldAttempt &&
      (interiorWallPlacementDecision.dimensionMismatchCount >= 2 || interiorWallPlacementDecision.semanticAnchorCount >= 4) &&
      canRunVisionPass('interior-wall-placement-enforcement')
    ) {
      traceLog('Infralith Vision Engine', traceId, '5/9', 'interior wall placement enforcement triggered', {
        interiorWallCount: interiorWallPlacementDecision.interiorWallCount,
        semanticAnchorCount: interiorWallPlacementDecision.semanticAnchorCount,
        dimensionHintCount: interiorWallPlacementDecision.dimensionHintCount,
        dimensionMismatchCount: interiorWallPlacementDecision.dimensionMismatchCount,
        reasons: interiorWallPlacementDecision.reasons,
      }, 'warn');

      const interiorWallPromptSeed = `${prompt}

INTERIOR WALL PLACEMENT ENFORCEMENT:
- Preserve validated exterior shell, floor_count, scale, and any already-correct major walls.
- Correct interior wall positions using visible partition lines, room labels, and room dimension annotations.
- Shift/add/remove interior wall segments only when supported by visible drawing evidence.
- Interior walls must terminate at real junctions or perimeter walls; avoid floating or center-split wall fragments.
- Use labeled rooms as interior targets: walls should separate labeled spaces, not bisect the center of a labeled room unless a wall line is clearly visible there.
- If a room-size annotation is localizable, adjust nearby interior walls so the enclosed room polygon matches that width/depth as closely as visible evidence allows.
- Prefer fewer evidence-backed partitions over guessed symmetric grids.
- If evidence remains ambiguous, keep the simpler conservative partition and emit explicit conflict instead of guessing.
`;
      const interiorWallDiagnostics = interiorWallPlacementDecision.reasons.length > 0
        ? interiorWallPlacementDecision.reasons
        : ['Interior wall placement is not aligning well with semantic room anchors and dimension annotations.'];
      const interiorWallPrompt = buildBlueprintRetryPrompt(interiorWallPromptSeed, interiorWallDiagnostics.slice(0, 5));

      try {
        const interiorWallCandidate = await runVisionPass('interior-wall-placement-enforcement', '5/9', interiorWallPrompt, focusedVisionImage);
        if (hasNonEmptyWalls(interiorWallCandidate)) {
          const promotedInteriorWalls = promoteBestCandidate(interiorWallCandidate, 'interior-wall-placement-enforcement', {
            minScoreGain: 0.25,
            allowOpeningBoost: true,
            allowFidelityBoost: true,
            allowConflictBoost: true,
            allowSemanticBoost: true,
          });
          if (promotedInteriorWalls) {
            result = bestResult;
            traceLog('Infralith Vision Engine', traceId, '5/9', 'interior wall placement enforcement improved reconstruction', {
              selected: bestCandidateLabel,
              bestScore,
              bestOpenings,
              ...summarizeReconstruction(bestResult),
            }, 'warn');
          } else {
            traceLog('Infralith Vision Engine', traceId, '5/9', 'interior wall placement candidate kept as fallback; current reconstruction remained stronger', {
              selected: bestCandidateLabel,
              bestScore,
              bestOpenings,
            }, 'warn');
          }
        }
      } catch (error) {
        traceLog('Infralith Vision Engine', traceId, '5/9', 'interior wall placement enforcement failed; continuing with current reconstruction', {
          reason: error instanceof Error ? error.message : String(error),
        }, 'warn');
      }
    }

    const openingDecision = shouldAttemptOpeningRecovery(result, layoutHints, lineRecords);
    if (openingDecision.shouldAttempt && canRunVisionPass('opening-recovery')) {
      const baseScore = scoreReconstructionDensity(result, layoutHints);
      const baseOpenings = getOpeningCount(result);
      const openingRecoveryPromptSeed = `${prompt}

${openingDecision.promptGuidance}

OPENING-RECOVERY OVERRIDE:
- Preserve all valid walls/rooms from the blueprint and avoid collapsing geometry.
- Detect visible door symbols, arc swings, wall gaps, and window spans across all floors.
- Populate doors[] and windows[] with proper host_wall_id mapping to reconstructed walls.
- Prefer low-confidence openings over returning empty openings arrays when evidence exists.
- Every uncertain line must be resolved via local topology first; when unresolved, emit conflict instead of suppressing all openings.
`;
      const openingRecoveryPrompt = buildBlueprintRetryPrompt(
        openingRecoveryPromptSeed,
        [
          `Current reconstruction has ${result?.walls?.length || 0} wall(s), ${result?.rooms?.length || 0} room(s), but only ${result?.doors?.length || 0} door(s) and ${result?.windows?.length || 0} window(s).`,
          `Opening semantics score ${openingDecision.semanticScore.toFixed(2)} (confidence ${openingDecision.semanticConfidence.toFixed(2)}).`,
          ...openingDecision.reasons,
          'Recover openings without dropping wall or room topology.',
        ].slice(0, 6)
      );

      traceLog('Infralith Vision Engine', traceId, '5/9', 'opening recovery pass triggered', {
        baseScore,
        baseOpenings,
        semanticScore: openingDecision.semanticScore,
        semanticConfidence: openingDecision.semanticConfidence,
        reasons: openingDecision.reasons,
      }, 'warn');

      try {
        const openingCandidate = await runVisionPass('opening-recovery', '5/9', openingRecoveryPrompt, focusedVisionImage);
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
    } else if (!openingDecision.shouldAttempt) {
      traceLog('Infralith Vision Engine', traceId, '5/9', 'opening recovery not triggered by semantic gate', {
        semanticScore: openingDecision.semanticScore,
        semanticConfidence: openingDecision.semanticConfidence,
        reasons: openingDecision.reasons,
      });
    }

    const hintedFloorCount = estimateFloorHintCount(layoutHints);
    const explicitPlanCaptionCount = estimateExplicitFloorPlanHintCount(layoutHints);
    const detectedPlanRegionCount = sheetAnalysis?.planRegionCount || 0;
    const segmentationFloorSignal = Math.max(hintedFloorCount, explicitPlanCaptionCount, detectedPlanRegionCount);
    const strongPlanCaptionSignal =
      explicitPlanCaptionCount >= 2 ||
      ((sheetAnalysis?.kind === 'mixed_sheet' || sheetAnalysis?.kind === 'floor_plan') &&
        detectedPlanRegionCount >= 2 &&
        (sheetAnalysis?.planRegionConfidence || 0) >= 0.62);
    const inferredFloorCount = estimateResultFloorCount(result);
    const sparseMultiFloorShell = isLikelySparseMultiFloorShell(result, segmentationFloorSignal);
    const interiorLayoutSignal = analyzeInteriorLayoutSignal(result);
    const placeholderInterior = interiorLayoutSignal.placeholder;
    const dimensionAlignmentSignal = estimateRoomDimensionAlignment(layoutHints, result);
    const significantDimensionMismatch = dimensionAlignmentSignal.shouldRetry && dimensionAlignmentSignal.hintCount >= 2;
    const densityFloorCount = Math.max(1, inferredFloorCount);
    const roomDensityPerFloor = (result?.rooms?.length || 0) / densityFloorCount;
    const wallDensityPerFloor = (result?.walls?.length || 0) / densityFloorCount;
    const lowRoomDensity = segmentationFloorSignal >= 2 && roomDensityPerFloor < 1.4;
    const lowWallDensity = segmentationFloorSignal >= 2 && wallDensityPerFloor < 4.8 && roomDensityPerFloor < 2.2;
    const sheetDrivenSegmentation =
      !!sheetAnalysis &&
      sheetAnalysis.kind === 'mixed_sheet' &&
      detectedPlanRegionCount >= 2 &&
      sheetAnalysis.planRegionConfidence >= 0.62;
    const shouldAttemptSegmentation =
      segmentationFloorSignal >= 2 &&
      (
        inferredFloorCount <= 1 ||
        sparseMultiFloorShell ||
        lowRoomDensity ||
        lowWallDensity ||
        placeholderInterior ||
        significantDimensionMismatch ||
        sheetDrivenSegmentation
      );

    if (shouldAttemptSegmentation && canRunVisionPass('segmented-floor-recovery', true, VISION_PASS_ESTIMATED_COST_MS * 3)) {
      const monolithicScore = scoreReconstructionDensity(result, layoutHints);
      traceLog('Infralith Vision Engine', traceId, '5/9', 'segmentation candidate triggered for multi-floor quality recovery', {
        hintedFloorCount,
        explicitPlanCaptionCount,
        detectedPlanRegionCount,
        segmentationFloorSignal,
        strongPlanCaptionSignal,
        sheetDrivenSegmentation,
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
        sheetAnalysis,
        preprocessed.width,
        preprocessed.height,
        traceId
      );
      if (segmentedResult && hasNonEmptyWalls(segmentedResult)) {
        const segmentedScore = scoreReconstructionDensity(segmentedResult, layoutHints);
        const promotedSegmented = promoteBestCandidate(segmentedResult, 'segmented-floor-recovery', {
          minScoreGain: strongPlanCaptionSignal ? 1.2 : 4,
          allowOpeningBoost: true,
          allowFidelityBoost: true,
          allowConflictBoost: true,
          allowFloorBoost: strongPlanCaptionSignal,
          floorBoostTarget: explicitPlanCaptionCount || segmentationFloorSignal,
          floorBoostScoreTolerance: 3.5,
        });
        if (promotedSegmented) {
          traceLog('Infralith Vision Engine', traceId, '5/9', 'segmented multi-floor recovery replaced monolithic output', {
            hintedFloorCount,
            explicitPlanCaptionCount,
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
            explicitPlanCaptionCount,
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

    const consensusEligible =
      shouldRunConsensusEnsemble(bestResult, layoutHints, bestScore) &&
      canRunVisionPass('consensus-ensemble', true, VISION_PASS_ESTIMATED_COST_MS * 2);
    if (consensusEligible) {
      traceLog('Infralith Vision Engine', traceId, '5/9', 'consensus ensemble triggered for cross-blueprint robustness', {
        consensusRuns: VISION_CONSENSUS_RUNS,
        minScoreTarget: VISION_CONSENSUS_MIN_SCORE,
        selected: bestCandidateLabel,
        bestScore,
        bestOpenings,
      }, 'warn');

      for (let consensusRun = 2; consensusRun <= VISION_CONSENSUS_RUNS; consensusRun += 1) {
        if (!canRunVisionPass(`consensus-round-${consensusRun}`, true, VISION_PASS_ESTIMATED_COST_MS)) break;
        const consensusReasons = buildConsensusRecoveryReasons(bestResult, layoutHints, bestScore);
        const consensusPrompt = consensusReasons.length > 0
          ? buildBlueprintRetryPrompt(prompt, consensusReasons)
          : prompt;
        const consensusImage = consensusRun % 2 === 0 ? imageUrl : focusedVisionImage;
        const consensusLabel = `consensus-${consensusRun}`;

        try {
          const consensusCandidate = await runVisionPass(consensusLabel, '5/9', consensusPrompt, consensusImage);
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
    const scaleReconciliation = reconcileScaleFromDimensionHints(result, layoutHints);
    result = scaleReconciliation.result;
    if (scaleReconciliation.applied) {
      traceLog('Infralith Vision Engine', traceId, '6/9', 'dimension-anchored scale reconciliation applied', {
        factor: Number(scaleReconciliation.factor.toFixed(4)),
        sampleCount: scaleReconciliation.sampleCount,
        inlierCount: scaleReconciliation.inlierCount,
      }, 'warn');
    }
    const floorAlignment = reconcileStackedFloorAlignment(result);
    result = floorAlignment.result;
    if (floorAlignment.applied) {
      traceLog('Infralith Vision Engine', traceId, '6/9', 'applied multi-floor stack alignment correction', {
        adjustedFloors: floorAlignment.adjustedFloors,
        translations: floorAlignment.translations,
      }, 'warn');
    }
    result = inferRoofFromWallFootprint(result);
    traceLog('Infralith Vision Engine', traceId, '6/9', 'applying deterministic building-code validation');
    let validatedResult = applyBuildingCodes(result);
    const multiFloorExpected = hasMultiFloorExpectation(layoutHints, validatedResult);
    const semanticTargetMentions = Array.from(new Set<SemanticMentionKey>([
      ...requiredSemanticMentions,
      ...(multiFloorExpected ? ['stairs'] as SemanticMentionKey[] : []),
    ]));

    const semanticReconciliation = reconcileMissingSemanticMentionsFromLayout(
      validatedResult,
      layoutHints,
      semanticTargetMentions
    );
    validatedResult = semanticReconciliation.result;
    if (semanticReconciliation.renamedRooms > 0 || semanticReconciliation.createdMarkers > 0) {
      traceLog('Infralith Vision Engine', traceId, '7/9', 'layout-anchor semantic reconciliation applied', {
        renamedRooms: semanticReconciliation.renamedRooms,
        createdMarkers: semanticReconciliation.createdMarkers,
        resolved: describeSemanticMentionKeys(semanticReconciliation.resolvedKeys),
      }, 'warn');
    }

    const unresolvedMentions = getMissingSemanticMentionKeys(semanticTargetMentions, validatedResult);
    if (semanticTargetMentions.length > 0 && unresolvedMentions.length > 0) {
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

    const disconnectedBuildings = countDisconnectedBuildingComponents(validatedResult.walls, 6);
    if (disconnectedBuildings >= 2) {
      const location =
        validatedResult?.walls?.[0]?.start ||
        validatedResult?.rooms?.[0]?.polygon?.[0] ||
        [0, 0];
      validatedResult = {
        ...validatedResult,
        conflicts: [
          ...(validatedResult.conflicts || []),
          {
            type: 'code',
            severity: 'low',
            description: `Detected ${disconnectedBuildings} disconnected building clusters (likely site/society blueprint). Use site decomposition flow for per-building models.`,
            location: [Number(location[0] || 0), Number(location[1] || 0)] as [number, number],
          },
        ],
      };
      traceLog('Infralith Vision Engine', traceId, '7/9', 'multi-building site signal detected in final geometry', {
        disconnectedBuildings,
      }, 'warn');
    }
    traceLog('Infralith Vision Engine', traceId, '7/9', 'validation complete', summarizeReconstruction(validatedResult));
    let reviewedResult = validatedResult;
    if (sheetAnalysis) {
      try {
        reviewedResult = applySheetAnalysisToResult(validatedResult, sheetAnalysis);
      } catch (error) {
        traceLog('Infralith Vision Engine', traceId, '7/9', 'sheet analysis metadata application failed; returning validated result only', {
          reason: error instanceof Error ? error.message : String(error),
        }, 'warn');
      }
    }
    const finalPayload: GeometricReconstruction = {
      ...reviewedResult,
      is_vision_only: !layoutHints,
    };
    traceLog('Infralith Vision Engine', traceId, '8/9', 'final payload assembled', {
      is_vision_only: finalPayload.is_vision_only,
      sheetType: finalPayload.meta?.sheet_type || 'na',
      planRegionCount: finalPayload.meta?.plan_region_count ?? 0,
      planRegionConfidence: finalPayload.meta?.plan_region_confidence ?? null,
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
 * Site-scale reconstruction mode.
 * Decomposes a society/master-plan blueprint into per-building BIM payloads.
 */
export async function processBlueprintToSite3D(imageUrl: string): Promise<SiteReconstruction> {
  const traceId = createTraceId('site3d');
  const startedAt = Date.now();
  traceLog('Infralith Site Engine', traceId, '0/3', 'starting site decomposition flow');

  const sourceModel = await processBlueprintTo3D(imageUrl);
  const buildings = decomposeReconstructionIntoSiteBuildings(sourceModel);
  const fallbackLocation =
    sourceModel?.walls?.[0]?.start ||
    sourceModel?.rooms?.[0]?.polygon?.[0] ||
    [0, 0];

  const siteConflicts: SiteReconstruction['conflicts'] = [];
  if (buildings.length === 0) {
    siteConflicts.push({
      type: 'structural',
      severity: 'high',
      description: 'Site decomposition failed to isolate valid building clusters from the blueprint.',
      location: [Number(fallbackLocation[0] || 0), Number(fallbackLocation[1] || 0)] as [number, number],
    });
  } else if (buildings.length === 1) {
    siteConflicts.push({
      type: 'code',
      severity: 'low',
      description: 'Single dominant building cluster detected; treated as one-building project.',
      location: [Number(fallbackLocation[0] || 0), Number(fallbackLocation[1] || 0)] as [number, number],
    });
  } else {
    siteConflicts.push({
      type: 'code',
      severity: 'low',
      description: `Detected ${buildings.length} building clusters from site blueprint decomposition.`,
      location: [Number(fallbackLocation[0] || 0), Number(fallbackLocation[1] || 0)] as [number, number],
    });
  }

  const siteResult: SiteReconstruction = {
    site_name: sourceModel.building_name ? `${sourceModel.building_name} Site` : NOT_AVAILABLE_3D_TEXT,
    buildings,
    conflicts: siteConflicts,
    source_model: sourceModel,
  };

  const durationMs = Date.now() - startedAt;
  traceLog('Infralith Site Engine', traceId, '3/3', `site decomposition complete in ${durationMs}ms`, {
    buildings: siteResult.buildings.length,
    conflicts: siteResult.conflicts.length,
  });
  return siteResult;
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

const serializeModelForEditPrompt = (model: GeometricReconstruction): string => JSON.stringify({
  building_name: model.building_name,
  exterior_color: model.exterior_color,
  meta: model.meta,
  walls: model.walls || [],
  doors: model.doors || [],
  windows: model.windows || [],
  rooms: model.rooms || [],
  furnitures: model.furnitures || [],
  roof: model.roof,
  topology_checks: model.topology_checks,
  conflicts: model.conflicts || [],
}, null, 2);

export async function applyPromptEditToReconstruction(
  currentModel: GeometricReconstruction,
  editRequest: string,
  referenceImage?: string | null
): Promise<GeometricReconstruction> {
  const traceId = createTraceId('editbim');
  const startedAt = Date.now();
  const trimmedRequest = String(editRequest || '').trim();
  if (!trimmedRequest) {
    throw new Error('Model edit request is empty.');
  }
  if (!hasNonEmptyWalls(currentModel)) {
    throw new Error('No editable model is loaded yet.');
  }

  const prompt = buildBlueprintModelEditPrompt(
    serializeModelForEditPrompt(currentModel),
    trimmedRequest,
    !!referenceImage
  );

  traceLog('Infralith Edit Engine', traceId, '0/2', 'starting prompt-driven model edit', {
    instructionChars: trimmedRequest.length,
    hasReferenceImage: !!referenceImage,
    walls: currentModel.walls?.length || 0,
    rooms: currentModel.rooms?.length || 0,
  });

  try {
    const edited = referenceImage
      ? await generateAzureVisionObject<GeometricReconstruction>(prompt, referenceImage)
      : await generateAzureObject<GeometricReconstruction>(prompt);

    if (!hasNonEmptyWalls(edited)) {
      throw new Error('Model edit did not return a valid wall graph.');
    }

    const normalized = applyBuildingCodes(inferRoofFromWallFootprint(normalizeReconstructionGeometry(edited)));
    const mergedMeta = {
      ...(currentModel.meta || {}),
      ...(normalized.meta || {}),
    };
    const finalModel: GeometricReconstruction = {
      ...normalized,
      building_name: normalized.building_name || currentModel.building_name,
      exterior_color: normalized.exterior_color || currentModel.exterior_color,
      meta: mergedMeta,
      debug_image: currentModel.debug_image,
      is_vision_only: currentModel.is_vision_only,
    };

    traceLog('Infralith Edit Engine', traceId, '2/2', `model edit completed in ${Date.now() - startedAt}ms`, summarizeReconstruction(finalModel));
    return finalModel;
  } catch (error) {
    traceLog('Infralith Edit Engine', traceId, 'error', 'model edit failed', {
      error: error instanceof Error ? error.message : String(error),
    }, 'error');
    throw error;
  }
}

export async function auditBlueprintAgainstReconstruction(
  currentModel: GeometricReconstruction,
  referenceImage: string
): Promise<z.infer<typeof BlueprintAuditResultSchema>> {
  const traceId = createTraceId('auditbim');
  const startedAt = Date.now();
  if (!referenceImage || !String(referenceImage).trim()) {
    throw new Error('Blueprint audit requires a reference image.');
  }
  if (!hasNonEmptyWalls(currentModel)) {
    throw new Error('No editable model is loaded yet.');
  }

  const prompt = buildBlueprintModelAuditPrompt(serializeModelForEditPrompt(currentModel));
  traceLog('Infralith Audit Engine', traceId, '0/2', 'starting blueprint-vs-model audit', {
    hasReferenceImage: true,
    walls: currentModel.walls?.length || 0,
    rooms: currentModel.rooms?.length || 0,
    conflicts: currentModel.conflicts?.length || 0,
  });

  try {
    const result = await generateAzureVisionObject<z.infer<typeof BlueprintAuditResultSchema>>(
      prompt,
      referenceImage,
      BlueprintAuditResultSchema
    );
    traceLog('Infralith Audit Engine', traceId, '2/2', `audit completed in ${Date.now() - startedAt}ms`, {
      issues: result.issues.length,
      summary: result.summary,
    });
    return result;
  } catch (error) {
    traceLog('Infralith Audit Engine', traceId, 'error', 'blueprint audit failed', {
      error: error instanceof Error ? error.message : String(error),
    }, 'error');
    throw error;
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
