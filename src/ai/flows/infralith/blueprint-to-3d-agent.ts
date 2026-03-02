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
});

const LAYOUT_POLYGON_LIMIT = 180;
const LAYOUT_DIMENSION_ANCHOR_LIMIT = 60;
const LAYOUT_DIMENSION_REGEX = /(\d+(\.\d+)?\s?(mm|cm|m|ft|feet|in|inch|\"|')|\d+'\s?\d*\"?)/i;

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

const getLayoutHintMode = (): LayoutHintMode => {
  const raw = (process.env.INFRALITH_LAYOUT_HINT_MODE || 'auto').trim().toLowerCase();
  if (raw === 'azure' || raw === 'local' || raw === 'hybrid' || raw === 'auto') {
    return raw;
  }
  return 'auto';
};

const buildVectorizationHints = (raw: any) => {
  if (!raw) return null;
  const polygons = Array.isArray(raw.lines) ? raw.lines.slice(0, 220) : [];
  const segments = Array.isArray(raw.segments) ? raw.segments.slice(0, 320) : [];
  return {
    image_size: {
      width: typeof raw.width === 'number' ? raw.width : 0,
      height: typeof raw.height === 'number' ? raw.height : 0,
    },
    counts: {
      polygon_count: polygons.length,
      segment_count: segments.length,
    },
    polygons,
    segments,
    threshold_mode: raw.threshold_mode || 'unknown',
  };
};

const summarizeVectorizationHints = (payload: any) => ({
  polygonCount: payload?.counts?.polygon_count || 0,
  segmentCount: payload?.counts?.segment_count || 0,
  thresholdMode: payload?.threshold_mode || 'unknown',
  width: payload?.image_size?.width || 0,
  height: payload?.image_size?.height || 0,
});

type VectorizationResult = {
  width: number;
  height: number;
  lines: Array<Array<[number, number]>>;
  line_count: number;
  segments: Array<[number, number, number, number, number]>;
  segment_count: number;
  threshold_mode: string;
  debug_image?: string;
};

const MAX_VECTOR_POLYGONS = 220;
const MAX_VECTOR_SEGMENTS = 320;

const shouldRetryForUnderfit = (result: GeometricReconstruction, vectorHints: any, layoutHints: BlueprintLayoutHints | null) => {
  const wallCount = result?.walls?.length || 0;
  const roomCount = result?.rooms?.length || 0;
  const vectorSegments = vectorHints?.counts?.segment_count || 0;
  const vectorPolygons = vectorHints?.counts?.polygon_count || 0;
  const layoutLines = layoutHints?.linePolygons?.length || 0;
  const signalStrength = Math.max(vectorSegments, vectorPolygons, layoutLines);

  // If references show complex blueprint but output is too simple, force one stricter retry.
  if (signalStrength >= 40 && wallCount <= 8) return true;
  if (signalStrength >= 60 && roomCount <= 2) return true;
  return false;
};

const parseDimensionMeters = (text: string): number | null => {
  const valueMatch = text.match(/(\d+(\.\d+)?)/);
  if (!valueMatch) return null;
  const value = Number(valueMatch[1]);
  if (!Number.isFinite(value)) return null;
  const unit = text.toLowerCase();
  if (unit.includes('mm')) return value / 1000;
  if (unit.includes('cm')) return value / 100;
  if (unit.includes('ft') || unit.includes('feet') || unit.includes("'")) return value * 0.3048;
  if (unit.includes('"') || unit.includes('in') || unit.includes('inch')) return value * 0.0254;
  return value; // treat as meters when no explicit unit
};

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

  let polygon = convexHull(footprintPoints);
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

const convertPixelsToMeters = (x: number, y: number, minX: number, minY: number, scale: number): [number, number] => {
  const mx = (x - minX) * scale;
  // Flip Y so blueprint top-down image maps to 3D +Z direction consistently.
  const mz = (y - minY) * scale;
  return [Number(mx.toFixed(3)), Number(mz.toFixed(3))];
};

const buildVectorFallbackReconstruction = (vectorHints: any, layoutHints: BlueprintLayoutHints | null): GeometricReconstruction | null => {
  const segments = Array.isArray(vectorHints?.segments) ? vectorHints.segments : [];
  const polygons = Array.isArray(vectorHints?.polygons) ? vectorHints.polygons : [];
  if (segments.length === 0 && polygons.length === 0) return null;

  const allPoints: Array<[number, number]> = [];
  for (const seg of segments) {
    if (!Array.isArray(seg) || seg.length < 4) continue;
    allPoints.push([Number(seg[0]), Number(seg[1])], [Number(seg[2]), Number(seg[3])]);
  }
  for (const poly of polygons) {
    if (!Array.isArray(poly)) continue;
    for (const pt of poly) {
      if (Array.isArray(pt) && pt.length >= 2) {
        allPoints.push([Number(pt[0]), Number(pt[1])]);
      }
    }
  }
  if (allPoints.length === 0) return null;

  const xs = allPoints.map((p) => p[0]);
  const ys = allPoints.map((p) => p[1]);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const widthPx = Math.max(1, maxX - minX);
  const heightPx = Math.max(1, maxY - minY);
  const maxDimPx = Math.max(widthPx, heightPx);

  // Default normalization keeps footprint in a realistic 25m envelope.
  let metersPerPixel = 25 / maxDimPx;
  const firstAnchor = layoutHints?.dimensionAnchors?.[0];
  if (firstAnchor?.text && Array.isArray(firstAnchor.polygon) && firstAnchor.polygon.length >= 6) {
    const anchorMeters = parseDimensionMeters(firstAnchor.text);
    const poly = firstAnchor.polygon;
    const ax1 = Number(poly[0]);
    const ay1 = Number(poly[1]);
    const ax2 = Number(poly[2]);
    const ay2 = Number(poly[3]);
    const anchorPx = Math.hypot(ax2 - ax1, ay2 - ay1);
    if (anchorMeters && anchorPx > 5) {
      const candidateScale = anchorMeters / anchorPx;
      if (Number.isFinite(candidateScale) && candidateScale > 0.001 && candidateScale < 2) {
        metersPerPixel = candidateScale;
      }
    }
  }

  const walls: GeometricReconstruction['walls'] = [];
  let wallId = 1;
  for (const seg of segments) {
    if (!Array.isArray(seg) || seg.length < 4) continue;
    const [x1, y1, x2, y2] = seg;
    const [sx, sz] = convertPixelsToMeters(Number(x1), Number(y1), minX, minY, metersPerPixel);
    const [ex, ez] = convertPixelsToMeters(Number(x2), Number(y2), minX, minY, metersPerPixel);
    const length = Math.hypot(ex - sx, ez - sz);
    if (length < 0.35) continue;

    const nearBoundary =
      Math.abs(Number(x1) - minX) < 8 || Math.abs(Number(x1) - maxX) < 8 ||
      Math.abs(Number(y1) - minY) < 8 || Math.abs(Number(y1) - maxY) < 8 ||
      Math.abs(Number(x2) - minX) < 8 || Math.abs(Number(x2) - maxX) < 8 ||
      Math.abs(Number(y2) - minY) < 8 || Math.abs(Number(y2) - maxY) < 8;

    walls.push({
      id: `vw-${wallId++}`,
      start: [sx, sz],
      end: [ex, ez],
      thickness: nearBoundary ? 0.23 : 0.115,
      height: 2.8,
      color: nearBoundary ? '#f5e6d3' : '#faf7f2',
      is_exterior: nearBoundary,
      floor_level: 0,
    });
    if (walls.length >= 280) break;
  }

  const rooms: GeometricReconstruction['rooms'] = [];
  let roomId = 1;
  for (const poly of polygons) {
    if (!Array.isArray(poly) || poly.length < 3) continue;
    const metricPoints: [number, number][] = poly
      .filter((pt: any) => Array.isArray(pt) && pt.length >= 2)
      .map((pt: any) => convertPixelsToMeters(Number(pt[0]), Number(pt[1]), minX, minY, metersPerPixel));
    if (metricPoints.length < 3) continue;
    let areaSigned = polygonArea(metricPoints);
    let ordered = metricPoints;
    if (areaSigned < 0) {
      ordered = [...metricPoints].reverse();
      areaSigned = -areaSigned;
    }
    if (areaSigned < 2 || areaSigned > 900) continue;

    rooms.push({
      id: `vr-${roomId++}`,
      name: `Room ${roomId - 1}`,
      polygon: ordered,
      area: Number(areaSigned.toFixed(2)),
      floor_color: '#e8d5b7',
      floor_level: 0,
    });
    if (rooms.length >= 120) break;
  }

  if (walls.length === 0) return null;

  return {
    building_name: 'Vector-Reconstructed Blueprint',
    exterior_color: '#f5e6d3',
    walls,
    doors: [],
    windows: [],
    rooms,
    conflicts: [
      {
        type: 'code',
        severity: 'medium',
        description: 'Vector fallback reconstruction used due underfit AI response; verify openings manually.',
        location: [0, 0],
      },
    ],
  };
};

/**
 * Runs structural pre-processing for blueprint vectorization.
 * Preferred engine: OpenCV.js (WASM) in Node runtime.
 * Fallback engine: Python/OpenCV script when OpenCV.js is unavailable.
 */
let openCvModulePromise: Promise<any> | null = null;

function stripDataUrl(value: string): string {
  const marker = 'base64,';
  const idx = value.indexOf(marker);
  return idx >= 0 ? value.slice(idx + marker.length).trim() : value.trim();
}

function decodeBase64ImageBytes(base64Image: string): Uint8Array {
  const payload = stripDataUrl(base64Image);
  const buffer = Buffer.from(payload, 'base64');
  if (!buffer.length) {
    throw new Error('Image payload is empty.');
  }
  return new Uint8Array(buffer);
}

function dedupeVectorSegments(
  segments: Array<[number, number, number, number, number]>,
  quant = 4
): Array<[number, number, number, number, number]> {
  const seen = new Set<string>();
  const deduped: Array<[number, number, number, number, number]> = [];

  for (const [x1, y1, x2, y2, length] of segments) {
    const p1x = Math.round(x1 / quant) * quant;
    const p1y = Math.round(y1 / quant) * quant;
    const p2x = Math.round(x2 / quant) * quant;
    const p2y = Math.round(y2 / quant) * quant;
    const a = `${p1x},${p1y}`;
    const b = `${p2x},${p2y}`;
    const key = a < b ? `${a}|${b}` : `${b}|${a}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push([x1, y1, x2, y2, length]);
  }

  return deduped;
}

function contourMatToPoints(mat: any): Array<[number, number]> {
  const points: Array<[number, number]> = [];
  const data: Int32Array | undefined = mat?.data32S;
  if (!data || data.length < 4) return points;
  for (let i = 0; i + 1 < data.length; i += 2) {
    points.push([data[i], data[i + 1]]);
  }
  return points;
}

async function loadOpenCvModule(): Promise<any> {
  if (!openCvModulePromise) {
    const dynamicImport = new Function('specifier', 'return import(specifier)') as (
      specifier: string
    ) => Promise<any>;
    openCvModulePromise = dynamicImport('@techstark/opencv-js');
  }

  const mod = await openCvModulePromise;
  const cv = mod?.default ?? mod;
  if (!cv) {
    throw new Error('OpenCV.js module did not load.');
  }

  if (cv.Mat) {
    return cv;
  }

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('OpenCV.js runtime initialization timeout.')), 15_000);
    const original = cv.onRuntimeInitialized;
    cv.onRuntimeInitialized = () => {
      clearTimeout(timeout);
      if (typeof original === 'function') {
        try {
          original();
        } catch {
          // ignore callback errors from previous handlers
        }
      }
      resolve();
    };
  });

  if (!cv.Mat) {
    throw new Error('OpenCV.js runtime not ready.');
  }

  return cv;
}

function decodeImageWithOpenCv(cv: any, bytes: Uint8Array): any {
  if (typeof cv.imdecode === 'function') {
    try {
      return cv.imdecode(bytes);
    } catch {
      // continue with Mat-vector fallback
    }
  }

  const byteMat = cv.matFromArray(1, bytes.length, cv.CV_8UC1, Array.from(bytes));
  try {
    return cv.imdecode(byteMat);
  } finally {
    byteMat.delete();
  }
}

async function runOpenCvJsVectorizationScript(base64Image: string, traceId = 'n/a'): Promise<VectorizationResult> {
  const startedAt = Date.now();
  traceLog('Vectorization/OpenCV.js', traceId, '1/4', 'loading OpenCV.js runtime', {
    payloadChars: base64Image.length,
  });
  const cv = await loadOpenCvModule();
  const bytes = decodeBase64ImageBytes(base64Image);

  const disposable: Array<{ delete: () => void }> = [];
  const track = <T extends { delete: () => void }>(value: T): T => {
    disposable.push(value);
    return value;
  };

  try {
    const src = track(decodeImageWithOpenCv(cv, bytes));
    if (!src || src.empty?.()) {
      throw new Error('Could not decode blueprint image with OpenCV.js.');
    }

    const height = Number(src.rows || 0);
    const width = Number(src.cols || 0);

    const gray = track(new cv.Mat());
    cv.cvtColor(src, gray, cv.COLOR_BGR2GRAY);

    const blur = track(new cv.Mat());
    cv.GaussianBlur(gray, blur, new cv.Size(5, 5), 0, 0, cv.BORDER_DEFAULT);

    const otsu = track(new cv.Mat());
    cv.threshold(blur, otsu, 0, 255, cv.THRESH_BINARY_INV + cv.THRESH_OTSU);

    const adaptive = track(new cv.Mat());
    cv.adaptiveThreshold(
      blur,
      adaptive,
      255,
      cv.ADAPTIVE_THRESH_GAUSSIAN_C,
      cv.THRESH_BINARY_INV,
      31,
      7
    );

    const thresh = track(new cv.Mat());
    cv.bitwise_or(otsu, adaptive, thresh);

    const denoised = track(new cv.Mat());
    cv.medianBlur(thresh, denoised, 3);

    const closeKernel = track(cv.Mat.ones(3, 3, cv.CV_8U));
    const closed = track(new cv.Mat());
    cv.morphologyEx(denoised, closed, cv.MORPH_CLOSE, closeKernel, new cv.Point(-1, -1), 2);

    const hKernel = track(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(Math.max(15, Math.floor(width / 60)), 1)));
    const vKernel = track(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(1, Math.max(15, Math.floor(height / 60)))));
    const horizontal = track(new cv.Mat());
    const vertical = track(new cv.Mat());
    cv.morphologyEx(closed, horizontal, cv.MORPH_OPEN, hKernel);
    cv.morphologyEx(closed, vertical, cv.MORPH_OPEN, vKernel);

    const hv = track(new cv.Mat());
    cv.bitwise_or(horizontal, vertical, hv);
    const wallsIsolated = track(new cv.Mat());
    cv.bitwise_or(closed, hv, wallsIsolated);

    const dilateKernel = track(cv.Mat.ones(2, 2, cv.CV_8U));
    cv.dilate(wallsIsolated, wallsIsolated, dilateKernel, new cv.Point(-1, -1), 1);

    const contours = track(new cv.MatVector());
    const hierarchy = track(new cv.Mat());
    cv.findContours(wallsIsolated, contours, hierarchy, cv.RETR_TREE, cv.CHAIN_APPROX_SIMPLE);

    const polygons: Array<Array<[number, number]>> = [];
    const minArea = Math.max(24, Math.floor(0.00003 * width * height));
    const maxArea = Math.floor(0.95 * width * height);

    for (let i = 0; i < contours.size(); i++) {
      const cnt = contours.get(i);
      disposable.push(cnt);

      const area = cv.contourArea(cnt, false);
      if (area < minArea || area > maxArea) continue;

      const perimeter = cv.arcLength(cnt, true);
      if (perimeter < 20) continue;

      const approx = track(new cv.Mat());
      cv.approxPolyDP(cnt, approx, 0.005 * perimeter, true);
      const points = contourMatToPoints(approx);
      if (points.length >= 2) {
        polygons.push(points);
      }
    }

    polygons.sort((a, b) => b.length - a.length);
    const lines = polygons.slice(0, MAX_VECTOR_POLYGONS);

    const minLineLength = Math.max(12, Math.floor(Math.min(width, height) * 0.03));
    const houghLines = track(new cv.Mat());
    cv.HoughLinesP(wallsIsolated, houghLines, 1, Math.PI / 180, 60, minLineLength, 8);

    const rawSegments: Array<[number, number, number, number, number]> = [];
    const lineData: Int32Array | undefined = houghLines?.data32S;
    if (lineData) {
      for (let i = 0; i + 3 < lineData.length; i += 4) {
        const x1 = lineData[i];
        const y1 = lineData[i + 1];
        const x2 = lineData[i + 2];
        const y2 = lineData[i + 3];
        const length = Number(Math.hypot(x2 - x1, y2 - y1).toFixed(2));
        if (length < minLineLength) continue;
        rawSegments.push([x1, y1, x2, y2, length]);
      }
    }

    rawSegments.sort((a, b) => b[4] - a[4]);
    const segments = dedupeVectorSegments(rawSegments).slice(0, MAX_VECTOR_SEGMENTS);
    const durationMs = Date.now() - startedAt;
    traceLog('Vectorization/OpenCV.js', traceId, '4/4', `success in ${durationMs}ms`, {
      lineCount: lines.length,
      segmentCount: segments.length,
      width,
      height,
    });

    return {
      width,
      height,
      lines,
      line_count: lines.length,
      segments,
      segment_count: segments.length,
      threshold_mode: 'hybrid-otsu-adaptive',
    };
  } finally {
    for (const value of disposable.reverse()) {
      try {
        value.delete();
      } catch {
        // ignore cleanup errors
      }
    }
  }
}

async function resolvePythonBinary(): Promise<string | null> {
  const configured = process.env.INFRALITH_PYTHON_BIN?.trim();
  if (configured) {
    if (await commandExists(configured)) {
      return configured;
    }
    console.warn(`[Vectorization] Configured INFRALITH_PYTHON_BIN was not found: ${configured}`);
  }

  const candidates = ['python3', 'python'];
  for (const candidate of candidates) {
    if (await commandExists(candidate)) {
      return candidate;
    }
  }

  return null;
}

async function runPythonVectorizationScript(base64Image: string, traceId = 'n/a'): Promise<VectorizationResult> {
  const pythonBinary = await resolvePythonBinary();
  if (!pythonBinary) {
    traceLog('Vectorization/Python', traceId, '0/4', 'python executable not found, falling back', undefined, 'warn');
    throw new Error("Python not installed or in PATH.");
  }

  return new Promise<VectorizationResult>((resolve, reject) => {
    const scriptPath = path.join(process.cwd(), 'src/ai/scripts/process_blueprint.py');
    const startedAt = Date.now();
    traceLog('Vectorization/Python', traceId, '1/4', 'launching python script', {
      scriptPath,
      pythonBinary,
      payloadChars: base64Image.length,
    });
    const pythonProcess = spawn(pythonBinary, [scriptPath]);

    let output = '';
    let errorOutput = '';
    let settled = false;

    const rejectOnce = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    const resolveOnce = (value: any) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    pythonProcess.stdout.on('data', (data) => {
      output += data.toString();
    });

    pythonProcess.stderr.on('data', (data) => {
      errorOutput += data.toString();
    });

    pythonProcess.on('close', (code) => {
      if (settled) return;
      if (code !== 0) {
        const details = errorOutput.trim() || `exit code ${code}`;
        traceLog('Vectorization/Python', traceId, '4/4', 'python script exited with error', { details, code }, 'error');
        rejectOnce(new Error(`Python script exited with code ${code}: ${details}`));
        return;
      }

      try {
        const result = JSON.parse(output);
        if (result.error) {
          rejectOnce(new Error(result.error));
          return;
        }
        const durationMs = Date.now() - startedAt;
        traceLog('Vectorization/Python', traceId, '4/4', `success in ${durationMs}ms`, {
          lineCount: result.line_count || 0,
          segmentCount: result.segment_count || 0,
          width: result.width || 0,
          height: result.height || 0,
        });
        resolveOnce(result as VectorizationResult);
      } catch {
        traceLog('Vectorization/Python', traceId, '4/4', 'failed to parse python output', { output }, 'error');
        rejectOnce(new Error('Failed to parse vectorization output.'));
      }
    });

    pythonProcess.on('error', (err: any) => {
      if (settled) return;
      if (err.code === 'ENOENT') {
        traceLog('Vectorization/Python', traceId, '2/4', 'python ENOENT during spawn', undefined, 'warn');
        rejectOnce(new Error("Python not installed or in PATH."));
      } else {
        traceLog('Vectorization/Python', traceId, '2/4', 'python spawn error', { err: String(err) }, 'error');
        rejectOnce(err instanceof Error ? err : new Error(String(err)));
      }
    });

    traceLog('Vectorization/Python', traceId, '2/4', 'streaming payload to python process', {
      payloadChars: base64Image.length,
    });
    pythonProcess.stdin.write(base64Image);
    pythonProcess.stdin.end();
    traceLog('Vectorization/Python', traceId, '3/4', 'waiting for python vectorization response');
  });
}

async function runVectorizationScript(base64Image: string, traceId = 'n/a'): Promise<VectorizationResult> {
  const preference = (process.env.INFRALITH_VECTOR_ENGINE || 'opencvjs').trim().toLowerCase();
  const isCloudRuntime = !!process.env.WEBSITE_SITE_NAME || !!process.env.WEBSITE_INSTANCE_ID;
  const allowOpenCvJs = preference !== 'python';
  const allowPython = preference === 'python' || (preference === 'auto' && !isCloudRuntime);

  traceLog('Vectorization', traceId, 'select', 'selecting vectorization engine', {
    preference,
    isCloudRuntime,
    allowOpenCvJs,
    allowPython,
  });

  let openCvError: unknown = null;
  if (allowOpenCvJs) {
    try {
      return await runOpenCvJsVectorizationScript(base64Image, traceId);
    } catch (error) {
      openCvError = error;
      const message = error instanceof Error ? error.message : String(error);
      traceLog('Vectorization', traceId, 'opencvjs', 'OpenCV.js path unavailable', { message }, 'warn');
      if (!allowPython) {
        throw error;
      }
    }
  }

  if (allowPython) {
    try {
      return await runPythonVectorizationScript(base64Image, traceId);
    } catch (pythonError) {
      const message = pythonError instanceof Error ? pythonError.message : String(pythonError);
      const cvMessage = openCvError
        ? ` OpenCV.js error: ${openCvError instanceof Error ? openCvError.message : String(openCvError)}.`
        : '';
      throw new Error(`Vectorization engines failed. Python error: ${message}.${cvMessage}`);
    }
  }

  throw new Error('Vectorization disabled: no engine enabled.');
}

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

  const basePages = (azureHints?.pages?.length || 0) > 0 ? azureHints?.pages : localHints?.pages;
  return {
    pageCount: Math.max(localHints?.pageCount || 0, azureHints?.pageCount || 0, basePages?.length || 0),
    pages: basePages || [],
    linePolygons: mergedLinePolygons,
    dimensionAnchors: mergedAnchors,
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
    return { image: base64Image, source: 'original', width: 0, height: 0 };
  }

  try {
    const dynamicImport = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<any>;
    const sharpModule = await dynamicImport('sharp');
    const sharp = sharpModule?.default ?? sharpModule;
    if (typeof sharp !== 'function') {
      throw new Error('Sharp module is invalid.');
    }

    const inputBuffer = Buffer.from(stripDataUrl(base64Image), 'base64');
    if (!inputBuffer.length) {
      return { image: base64Image, source: 'original', width: 0, height: 0 };
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
    if (/Cannot find module|Cannot find package|ERR_MODULE_NOT_FOUND/i.test(message)) {
      sharpUnsupported = true;
      if (!sharpWarned) {
        sharpWarned = true;
        console.warn('[Infralith Vision Engine] Sharp not installed. Skipping local image pre-processing.');
      }
      traceLog('Preprocess', traceId, 'sharp', 'sharp package missing, fallback to original', undefined, 'warn');
      return { image: base64Image, source: 'original', width: 0, height: 0 };
    }

    traceLog('Preprocess', traceId, 'sharp', 'sharp preprocessing failed, fallback to original', { message }, 'warn');
    return { image: base64Image, source: 'original', width: 0, height: 0 };
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
    const dynamicImport = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<any>;
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

    for (const line of lines) {
      if (linePolygons.length >= LAYOUT_POLYGON_LIMIT) break;
      const polygon = readPolygonFromBoundingBox(line?.bbox);
      if (polygon.length >= 6) {
        linePolygons.push(polygon);
      }

      const text = String(line?.text || '').trim();
      if (text && LAYOUT_DIMENSION_REGEX.test(text) && dimensionAnchors.length < LAYOUT_DIMENSION_ANCHOR_LIMIT) {
        if (polygon.length >= 6) {
          dimensionAnchors.push({ text, polygon });
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
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/Cannot find module|Cannot find package|ERR_MODULE_NOT_FOUND/i.test(message)) {
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
    const dynamicImport = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<any>;
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
    if (/Cannot find module|Cannot find package|ERR_MODULE_NOT_FOUND/i.test(message)) {
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

        const producedPath = outputCandidates.find((candidate) => candidate && candidate.length > 0);
        if (!producedPath) {
          errors.push(`${attempt.name}: no output candidates configured`);
          continue;
        }

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
 * Uses a hybrid approach: OpenCV for vectorization and Azure GPT-4o Vision for semantic understanding.
 */
export async function processBlueprintTo3D(imageUrl: string): Promise<GeometricReconstruction> {
  const traceId = createTraceId('vision');
  const startedAt = Date.now();
  traceLog('Infralith Vision Engine', traceId, '0/9', 'request received', {
    payloadChars: imageUrl.length,
  });
  traceLog('Infralith Vision Engine', traceId, '0/9', 'Routing blueprint to Azure OpenAI Vision');

  // STAGE 1: Pre-process with OpenCV vectorization to get structural hints
  let vectorizationHints = null;
  let debugImage: string | undefined;
  let layoutHints: BlueprintLayoutHints | null = null;

  const layoutHintMode = getLayoutHintMode();
  traceLog('Infralith Vision Engine', traceId, '1/9', 'running structural pre-processing (OpenCV + OCR/layout hints)', {
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

  const [vectorizationAttempt, layoutAttempt] = await Promise.allSettled([
    runVectorizationScript(structuralInputImage, traceId),
    shouldCallAzureLayout ? analyzeBlueprintLayoutFromBase64(structuralInputImage) : Promise.resolve(null),
  ]);

  if (vectorizationAttempt.status === "fulfilled") {
    vectorizationHints = buildVectorizationHints(vectorizationAttempt.value);
    debugImage = vectorizationAttempt.value.debug_image;
    traceLog('Infralith Vision Engine', traceId, '1/9', 'vectorization output', {
      ...summarizeVectorizationHints(vectorizationHints),
      hasDebugImage: !!debugImage,
    });
  } else {
    const e: any = vectorizationAttempt.reason;
    traceLog('Infralith Vision Engine', traceId, '1/9', 'vectorization pre-processing failed, falling back to vision-only', {
      reason: e?.message || String(e),
    }, 'warn');
  }

  if (layoutAttempt.status === "fulfilled") {
    const azureLayoutHints = layoutAttempt.value;
    layoutHints = mergeLayoutHintSources(localLayoutHints, azureLayoutHints);
    traceLog('Infralith Vision Engine', traceId, '1/9', 'layout hint output', {
      source: shouldCallAzureLayout ? (localLayoutHints ? 'merged-local-azure' : 'azure') : (localLayoutHints ? 'local' : 'none'),
      ...summarizeLayoutHints(layoutHints),
    });
  } else {
    const e: any = layoutAttempt.reason;
    layoutHints = localLayoutHints;
    traceLog('Infralith Vision Engine', traceId, '1/9', 'layout hint extraction failed, continuing', {
      reason: e?.message || String(e),
      hasLocalHints: !!localLayoutHints,
    }, 'warn');
  }

  // STAGE 2: Send image and vector hints to the AI Vision model
  const prompt = `
    You are the Infralith Engineering Engine—a world - class architectural auditor and spatial synthesis AI powered by advanced computer vision.
    You will analyze the provided 2D architectural floor plan image with the precision of a licensed structural engineer.

    CRITICAL ANTI - HALLUCINATION DIRECTIVE:
    ABSOLUTELY DO NOT INVENT A "DEFAULT" OR "GENERIC" BUILDING.You MUST perfectly trace and replicate the actual geometric footprint, rooms, walls, and layout visible in the provided image.If the image is complex or unclear, do your absolute best to map ONLY what is visibly there.NEVER fall back to a generic square or pre - made house layout.

    ADDITIONAL CONTEXT(FROM PRE - PROCESSING):
    I have run a computer vision(OpenCV) pre - processing pipeline that extracts:
    - wall polygons
    - straight wall segments
    Use this as a STRONG GEOMETRIC HINT for tracing walls and preserving exact footprint.
    OPENCV VECTOR HINTS:
    ${vectorizationHints ? JSON.stringify(vectorizationHints, null, 2) : "Not available."}

    OCR LAYOUT HINTS (LOCAL/AZURE):
    I also extracted OCR line polygons and dimension anchors from local/Azure layout analyzers. Use these as an additional constraint for wall tracing and scale calibration.
    LAYOUT HINTS:
    ${layoutHints ? JSON.stringify(layoutHints, null, 2) : "Not available."}

    CORE VISION ANALYSIS PROTOCOL:
0. STRUCTURE-FIRST PHASED EXECUTION (MANDATORY):
- PHASE 1 (FULL BUILDING SHELL FIRST): Build the full structural shell first across all detected floors:
  exterior perimeter, interior/load-bearing walls, floor_level assignment, and vertical alignment.
- PHASE 2 (OPENINGS): After shell completion, place doors/windows and bind each to a valid host_wall_id.
- PHASE 3 (SPACES + DETAIL): After openings, compute rooms and furnitures.
- If detail conflicts with structure, preserve structure and adjust/remove the conflicting detail.

1. EXACT VISUAL WALL TRACING: Scan the image systematically.Identify every dark continuous line segment as a wall.
       - Thick lines = Exterior walls(0.23m thickness)
  - Thin lines = Interior partition walls(0.115m thickness)
    - Trace each wall's start and end coordinates in METERS using the image as a reference plane. The generated geometry MUST match the image's overall shape and room divisions exactly.

    2. STRATEGIC DIMENSION EXTRACTION:
- ANCHOR SEARCH: Locate any numeric labels(e.g., "4.5m", "12'0\"", "3600mm").Use these as ground - truth anchors to set the global Scale Factor.
       - CONTEXTUAL VALIDATION: If a room label reads "Master Bed (4.5m x 3.8m)", ENFORCE those values as absolute truth.
       - BLUR MITIGATION: If text is unreadable, reverse - engineer the scale from "Standard Architectural Ratios":
         * Standard interior door = 0.9m wide
  * Kitchen counter depth = 0.6m
    * Standard staircase width = 1.2m

3. MULTI - FLOOR RECONSTRUCTION:
- BUILDING CORE ORIGIN: Identify shared vertical shafts(stairs, lift shafts, or prominent structural corners) visible across all floor blocks.
       - ALIGNMENT: Assign these core anchors to coordinate(0, 0).All other walls are positioned relative to this origin.
       - VERTICAL STACKING: If the image contains multiple floor plan blocks(Ground + Level 1, etc.), stack them by floor_level(0, 1, 2...).
       - STRUCTURAL INTEGRITY CHECK: Flag any upper - floor walls that lack a supporting wall directly below within 0.15m tolerance.

    4. OPENING DETECTION:
- DOORS: Look for gaps in walls with arc symbols(door swing).Record host_wall_id, center position, width(default 0.9m), height(2.1m).
       - WINDOWS: Look for triple - line symbols in exterior walls.Record host_wall_id, position, width, sill_height(default 0.9m).

    5. ROOM IDENTIFICATION & FURNISHING:
- For each enclosed space, construct a closed COUNTER - CLOCKWISE polygon of(x, y) points.
       - Calculate the enclosed area in square meters.
       - Assign room names from visible labels(e.g., "Bedroom", "Kitchen", "WC").
       - DETECT FURNITURE: Look for ANY objects inside rooms(beds, sofas, tables, dining, toilets, kitchen islands, wardrobes, rugs, plants, lamps, TVs).
       - Generate them densely in the 'furnitures' array with approximate metric size(width / depth / height).Type must be the specific item name.Output a completely UNIQUE and highly detailed 'description' for the Procedural Voxel Engine to generate it(e.g. "Minimalist deep blue velvet sofa with silver legs", or "Rustic oak wood round dining table with 4 beige chairs").Create as many varied objects as you can infer from the floor plans.DO NOT limit yourself to a few assets.

    LUXURY AESTHETIC PALETTE(CRITICAL: RANDOMIZE AND VARY THESE):
- Do NOT use the exact same colors every time.Create a cohesive luxury palette specific to THIS building's unique vibe.
  - Pick random but beautiful, harmonious HEX colors for Exterior Walls, Interior Walls, Floors, Doors, Windows, and Roof.
    - Ensure variation(e.g.some buildings are modern dark mode, some are light minimalist, some are warm terracotta).

    GEOMETRIC CONSTRAINTS(strictly enforce):
- All coordinates in METERS.
    - Wall height: 2.8m per floor level.
    - SNAP all adjacent wall endpoints within 0.15m to nearest shared point.
    - Every room MUST have a fully closed polygon forming its floor slab.
    - Room polygons MUST be Counter - Clockwise(CCW) ordered to prevent "bow-tie" rendering in Three.js.
    - Identify the outermost building boundary and ALWAYS map it into roof.polygon.
    - If roof style is unclear, set roof.type="flat" and still return roof.polygon from that outer boundary.

    THINKING PROCESS(reason step - by - step before generating output):
- Step 1: Identify the scale factor from dimension labels or standard ratios.
    - Step 2: Complete full structural shell first for every detected floor (walls + floor_level).
    - Step 3: Detect all door and window openings and link each to its host wall.
    - Step 4: Define all enclosed room polygons in CCW order.
    - Step 5: Validate the building core alignment across all floors.
    - Step 6: Place furnitures after rooms are finalized.
    - Step 7: Perform a structural audit.Generate 2 - 5 specific, actionable conflict reports.

  OUTPUT — Respond ONLY with a valid JSON object matching this schema exactly:
{
  "building_name": "Descriptive project name from blueprint title block (or inferred)",
    "exterior_color": "#hex",
      "walls": [{ "id": "w1", "start": [x, y], "end": [x, y], "thickness": 0.23, "height": 2.8, "color": "#hex", "is_exterior": true, "floor_level": 0 }],
        "doors": [{ "id": "d1", "host_wall_id": "w1", "position": [x, y], "width": 0.9, "height": 2.1, "color": "#8b4513", "floor_level": 0 }],
          "windows": [{ "id": "win1", "host_wall_id": "w1", "position": [x, y], "width": 1.5, "sill_height": 0.9, "color": "#2c3e50", "floor_level": 0 }],
            "rooms": [{ "id": "r1", "name": "Room Name", "polygon": [[x, y], ...], "area": 0.0, "floor_color": "#hex", "floor_level": 0 }],
              "furnitures": [{ "id": "f1", "room_id": "r1", "type": "bed", "position": [x, y], "width": 2.0, "depth": 2.0, "height": 0.6, "color": "#hex", "description": "King size bed with wooden frame and white sheets", "floor_level": 0 }],
                "roof": { "type": "flat", "polygon": [[x, y], ...], "height": 1.5, "base_height": 2.8, "color": "#a0522d" },
  "conflicts": [{ "type": "structural", "severity": "high", "description": "Specific engineering finding.", "location": [x, y] }]
}

    STRICT RULE: Output the JSON object ONLY.No markdown, no prose, no code fences.
  `;

  try {
    traceLog('Infralith Vision Engine', traceId, '2/9', 'sending blueprint + hints to Azure Vision');
    let result = await generateAzureVisionObject<GeometricReconstruction>(prompt, imageUrl);
    traceLog('Infralith Vision Engine', traceId, '3/9', 'AI reconstruction received', summarizeReconstruction(result));

    if (shouldRetryForUnderfit(result, vectorizationHints, layoutHints)) {
      const strictPrompt = `${prompt}

CRITICAL QUALITY CORRECTION (MANDATORY):
Your previous reconstruction appears underfit for this blueprint complexity.
You MUST increase geometric fidelity and match the extracted hints.

HARD CONSTRAINTS FOR THIS RETRY:
- Do not return a simple rectangular default.
- Trace significantly more wall segments where hints show structural complexity.
- If the plan indicates multiple enclosed spaces, output corresponding room polygons.
- Respect line and segment geometry from OPENCV VECTOR HINTS and OCR anchors from LAYOUT HINTS.
`;
      traceLog('Infralith Vision Engine', traceId, '4/9', 'underfit detected, retrying with stricter constraints', undefined, 'warn');
      result = await generateAzureVisionObject<GeometricReconstruction>(strictPrompt, imageUrl);
      traceLog('Infralith Vision Engine', traceId, '4/9', 'retry reconstruction received', summarizeReconstruction(result));
    }

    if (shouldRetryForUnderfit(result, vectorizationHints, layoutHints) && vectorizationHints) {
      const vectorFallback = buildVectorFallbackReconstruction(vectorizationHints, layoutHints);
      if (vectorFallback) {
        traceLog('Infralith Vision Engine', traceId, '5/9', 'applying deterministic vector fallback reconstruction', undefined, 'warn');
        result = vectorFallback;
        traceLog('Infralith Vision Engine', traceId, '5/9', 'vector fallback summary', summarizeReconstruction(result));
      }
    }

    if (!result || !result.walls || result.walls.length === 0) {
      throw new Error("Engineering Synthesis Failed: GPT-4o Vision could not construct a valid geometric structure from the provided blueprint. Please ensure the image is a clear architectural floor plan.");
    }

    result = inferRoofFromWallFootprint(result);

    // Apply strict deterministic architectural building code checks
    traceLog('Infralith Vision Engine', traceId, '6/9', 'applying deterministic building-code validation');
    const validatedResult = applyBuildingCodes(result);
    traceLog('Infralith Vision Engine', traceId, '7/9', 'validation complete', summarizeReconstruction(validatedResult));

    const finalPayload: GeometricReconstruction = {
      ...validatedResult,
      debug_image: debugImage, // Pass along the debug image from the vectorization step
      is_vision_only: !vectorizationHints // Flag if vectorization failed and we fell back
    };

    traceLog('Infralith Vision Engine', traceId, '8/9', 'final payload assembled', {
      is_vision_only: finalPayload.is_vision_only,
      hasDebugImage: !!finalPayload.debug_image,
      vectorHints: summarizeVectorizationHints(vectorizationHints),
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

  const prompt = `
    You are the Infralith Architect AI—the world's most advanced parametric architectural modeling engine.
    Your task: Generate a COMPLETE, REALISTIC, and STRUCTURALLY SOUND 3D building from the user's description.

    User's Vision: "${description}"

    CORE DESIGN PRINCIPLES:
1. METRIC PRECISION: Use real - world dimensions.
       - Standard bedroom: 12 - 16 sqm | Living room: 20 - 30 sqm | Kitchen: 10 - 15 sqm | WC: 3 - 5 sqm | Foyer: 4 - 6 sqm
2. TOPOLOGICAL INTEGRITY: All exterior walls must form a 100 % closed perimeter.Absolutely no gaps.
    3. ACCESSIBLE LAYOUT: Every room must be reachable via at least one door.No "sealed rooms".
    4. MULTI - LEVEL LOGIC: For multi - floor buildings:
- Floor 1 load - bearing walls must align above Floor 0 walls.
       - Maintain a consistent(0, 0) building core origin across all levels.
       - Include staircase space(approx 3m x 1.5m) connecting floors.
    5. WINDOW PLACEMENT: Windows on exterior walls only.Minimum 1 window per habitable room.
    6. STRUCTURE-FIRST PHASING (MANDATORY):
- First generate the complete building shell (all floors + all walls) before any detail.
- Then generate openings (doors/windows) anchored to shell walls.
- Then generate rooms and furnitures.
- If detail conflicts with shell, keep shell and fix detail.

    ROOM POLYGON RULE: All room polygons MUST be Counter - Clockwise(CCW) ordered.

    STRUCTURAL THINKING PROCESS:
- Step 0: Complete full structural shell first (all floors, all walls, aligned core).
- Step 0.5: Validate shell continuity before adding details.
- Step 1: Sketch the floor plan mentally.Define the exterior perimeter first.
    - Step 2: Partition the interior into logical rooms.Validate no wall gaps exist.
    - Step 3: Place doors at room boundaries.Ensure all rooms accessible.
    - Step 4: Place windows on exterior walls only.
    - Step 5: For multi - floor: Verify Floor 1 aligns with Floor 0's load-bearing structure.
  - Step 6: Final audit — list any structural concerns in "conflicts".

    FURNISHING(MANDATORY AND UNIQUE):
- Fully furnish every room using the 'furnitures' array.Include beds, wardrobes, TVs, kitchen islands, sofas, rugs, plants, dining tables, toilets, etc.
    - Do not limit yourself to a few assets.Fill the space logically!
  - Provide a completely UNIQUE 'description' for each item so the Procedural Voxel Engine builds distinct, amazing 3D assets(e.g., "Sleek matte black refrigerator with french doors", "Curved emerald green luxury sofa").

    LUXURY MATERIAL PALETTE(CRITICAL: RANDOMIZE AND VARY THESE):
- Do NOT use a fixed set of colors.Invent a unique, breathtaking, and cohesive aesthetic color palette for THIS specific description.
    - Output random but extremely beautiful HEX colors for exterior walls, interior walls, floors(varying by room), doors, windows, and roof.

    GEOMETRIC REQUIREMENTS:
- Wall thickness: 0.23m(exterior) or 0.115m(interior).Height: 2.8m per floor.
    - All coordinates in METERS.Building core at(0, 0).

  OUTPUT — Respond ONLY with a valid JSON object:
{
  "building_name": "Premium Project Name",
    "exterior_color": "#f8f1e7",
      "walls": [{ "id": "w1", "start": [x, y], "end": [x, y], "thickness": 0.23, "height": 2.8, "color": "#f8f1e7", "is_exterior": true, "floor_level": 0 }],
        "doors": [{ "id": "d1", "host_wall_id": "w1", "position": [x, y], "width": 0.9, "height": 2.1, "color": "#8b4513", "floor_level": 0 }],
          "windows": [{ "id": "win1", "host_wall_id": "w1", "position": [x, y], "width": 1.5, "sill_height": 0.9, "color": "#2c3e50", "floor_level": 0 }],
            "rooms": [{ "id": "r1", "name": "Space Name", "polygon": [[x, y], ...], "area": 0.0, "floor_color": "#hex", "floor_level": 0 }],
              "furnitures": [{ "id": "f1", "room_id": "r1", "type": "bed", "position": [x, y], "width": 2.0, "depth": 2.0, "height": 0.6, "color": "#hex", "description": "King size bed with wooden frame and white sheets", "floor_level": 0 }],
                "roof": { "type": "flat", "polygon": [[x, y], ...], "height": 1.5, "base_height": 2.8, "color": "#a0522d" },
  "conflicts": []
}

    STRICT RULE: Output the JSON object ONLY.No markdown, no prose, no code fences.
  `;

  try {
    traceLog('Infralith Architect Engine', traceId, '1/2', 'sending text-to-bim request');
    const result = await generateAzureObject<GeometricReconstruction>(prompt);
    if (!result || !result.walls || result.walls.length === 0) {
      throw new Error("Architectural Generation Failed: The AI was unable to synthesize a valid structure from the given description.");
    }
    const durationMs = Date.now() - startedAt;
    traceLog('Infralith Architect Engine', traceId, '2/2', `Structured generation completed in ${durationMs}ms`, summarizeReconstruction(result));
    return result;
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

  const prompt = `
    You are an expert technical 3D voxel modeler.Generate a precise, detailed procedural 3D asset for: "${description}".
    The model must be constructed using a series of rectangular rectangular bounding boxes(parts).

    CRITICAL CONSTRAINTS:
1. Bounding Box: The ENTIRE asset must fit exactly within a normalized 1x1x1 cube space(from - 0.5 to 0.5 on each axis).
    2. Coordinates: The position refers to the CENTER of the part relative to origin(0, 0, 0).
    3. Sizes: The size provides the[width, height, depth] of the part.
    4. Composition: Break the object down into logical components(e.g.for a door: the outer frame, inner door leaf, middle window, door handle, hinges).Use at least 4 - 8 distinct parts for "enterprise" level detail.
    5. Aesthetics: Select high - end, realistic HEX colors.

    Make it look extremely premium, detailed, and structurally correct.

    OUTPUT STRICTLY THIS SHAPE (NO BUILDING FIELDS):
    {
      "name": "asset name",
      "parts": [
        {
          "name": "part name",
          "position": [x, y, z],
          "size": [w, h, d],
          "color": "#hex",
          "material": "wood|metal|glass|plastic|stone|cloth"
        }
      ]
    }
  `;

  try {
    traceLog('Procedural Voxel Engine', traceId, '1/3', 'sending text-to-object request');
    let result = await generateAzureObject<AIAsset>(prompt, AIAssetSchema);
    if (!result || !Array.isArray(result.parts) || result.parts.length === 0) {
      throw new Error("Asset Generation Failed.");
    }

    if (result.parts.length < 4) {
      const retryPrompt = `${prompt}

CORRECTION:
- Previous result was under-detailed.
- Return at least 4 distinct parts.
- Each part must have unique position and size.
`;
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
