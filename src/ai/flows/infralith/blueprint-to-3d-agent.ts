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
 * Executes the Python-based OpenCV script to perform initial vectorization.
 * This pre-processes the image to find structural polygons before sending to the AI.
 */
async function runVectorizationScript(base64Image: string): Promise<any> {
  return new Promise((resolve, reject) => {
    // Correctly locate the script within the Next.js server environment
    const scriptPath = path.join(process.cwd(), 'src/ai/scripts/process_blueprint.py');
    const startedAt = Date.now();
    console.log(`[Vectorization] Step 1/4 launching Python script: ${scriptPath}`);
    console.log(`[Vectorization] Input image payload chars=${base64Image.length}`);
    const pythonProcess = spawn('python', [scriptPath]);

    let output = '';
    let errorOutput = '';

    pythonProcess.stdout.on('data', (data) => {
      output += data.toString();
    });

    pythonProcess.stderr.on('data', (data) => {
      errorOutput += data.toString();
    });

    pythonProcess.on('close', (code) => {
      if (code !== 0) {
        console.error(`[Vectorization] Python script error: ${errorOutput} `);
        reject(new Error(`Python script exited with code ${code}: ${errorOutput} `));
      } else {
        try {
          const result = JSON.parse(output);
          if (result.error) {
            reject(new Error(result.error));
          }
          const durationMs = Date.now() - startedAt;
          console.log(`[Vectorization] Step 4/4 success in ${durationMs}ms. line_count=${result.line_count || 0}, segment_count=${result.segment_count || 0}`);
          resolve(result);
        } catch (e) {
          console.error("[Vectorization] Failed to parse Python script output:", output);
          reject(new Error('Failed to parse vectorization output.'));
        }
      }
    });

    pythonProcess.on('error', (err: any) => {
      if (err.code === 'ENOENT') {
        console.warn("[Vectorization] Python executable not found in path. Falling back to AI Vision only.");
        reject(new Error("Python not installed or in PATH."));
      } else {
        console.error("[Vectorization] Python spawn error:", err);
        reject(err);
      }
    });

    // Pipe the large base64 string to the Python script's standard input
    console.log("[Vectorization] Step 2/4 streaming image payload to Python process.");
    pythonProcess.stdin.write(base64Image);
    pythonProcess.stdin.end();
    console.log("[Vectorization] Step 3/4 waiting for vectorization response.");
  });
}

type Segment2D = { start: [number, number]; end: [number, number] };

const DXF_UNIT_TO_METERS: Record<number, number> = {
  1: 0.0254, // inches
  2: 0.3048, // feet
  4: 0.001, // millimeters
  5: 0.01, // centimeters
  6: 1, // meters
};

const toFiniteNumber = (value: unknown): number | null => {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

const toDxfPoint = (value: any): [number, number] | null => {
  const x = toFiniteNumber(value?.x);
  const y = toFiniteNumber(value?.y);
  if (x == null || y == null) return null;
  return [x, y];
};

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

const getEntitySegments = (entity: any): Segment2D[] => {
  const type = String(entity?.type || '').toUpperCase();

  if (type === 'LINE') {
    const start = toDxfPoint(entity?.start);
    const end = toDxfPoint(entity?.end);
    if (!start || !end) return [];
    return [{ start, end }];
  }

  if (type !== 'LWPOLYLINE' && type !== 'POLYLINE') {
    return [];
  }

  const vertices = getEntityVertices(entity);
  if (vertices.length < 2) return [];

  const segments: Segment2D[] = [];
  for (let i = 0; i < vertices.length - 1; i++) {
    segments.push({ start: vertices[i], end: vertices[i + 1] });
  }
  if (hasClosedPolylineFlag(entity) && vertices.length >= 3) {
    segments.push({ start: vertices[vertices.length - 1], end: vertices[0] });
  }
  return segments;
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

export async function processDxfTo3D(dxfContent: string): Promise<GeometricReconstruction> {
  const startedAt = Date.now();
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

  const entities = Array.isArray(parsed?.entities) ? parsed.entities : [];
  if (entities.length === 0) {
    throw new Error('DXF has no entities to process.');
  }

  const allSegments = dedupeSegments(entities.flatMap(getEntitySegments));
  if (allSegments.length === 0) {
    throw new Error('DXF parsing completed but no LINE/POLYLINE wall geometry was found.');
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

  const walls: GeometricReconstruction['walls'] = [];
  let wallCounter = 1;
  for (const segment of allSegments) {
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
  }

  if (walls.length === 0) {
    throw new Error('DXF was parsed, but no valid wall segments could be derived.');
  }

  const rooms: GeometricReconstruction['rooms'] = [];
  const closedPolylines = entities
    .map(getClosedPolyline)
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

  const reconstruction: GeometricReconstruction = {
    building_name: 'DXF Reconstruction',
    exterior_color: '#f5e6d3',
    walls,
    doors: [],
    windows: [],
    rooms,
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
    ],
  };

  const validated = applyBuildingCodes(reconstruction);
  const durationMs = Date.now() - startedAt;
  console.log(`[Infralith CAD Engine] DXF conversion complete in ${durationMs}ms.`, summarizeReconstruction(validated));
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
  const startedAt = Date.now();
  console.log('[Infralith CAD Engine] Starting DWG conversion pipeline.');
  const dxfContent = await convertDwgToDxfString(dwgBase64);
  const result = await processDxfTo3D(dxfContent);
  const durationMs = Date.now() - startedAt;
  console.log(`[Infralith CAD Engine] DWG conversion + parsing completed in ${durationMs}ms.`);
  return result;
}


/**
 * Construction-grade geometric reconstruction engine.
 * Converts 2D architectural floor plans into metrically consistent parametric 3D models.
 * Uses a hybrid approach: OpenCV for vectorization and Azure GPT-4o Vision for semantic understanding.
 */
export async function processBlueprintTo3D(imageUrl: string): Promise<GeometricReconstruction> {
  const startedAt = Date.now();
  console.log(`[Infralith Vision Engine] Step 0/9 request received. payloadChars=${imageUrl.length}`);
  console.log("[Infralith Vision Engine] Routing blueprint to Azure OpenAI Vision...");

  // STAGE 1: Pre-process with OpenCV vectorization to get structural hints
  let vectorizationHints = null;
  let debugImage = null;
  let layoutHints: BlueprintLayoutHints | null = null;

  console.log("[Infralith Vision Engine] Step 1/9 running structural pre-processing (OpenCV + Azure prebuilt-layout).");
  const [vectorizationAttempt, layoutAttempt] = await Promise.allSettled([
    runVectorizationScript(imageUrl),
    analyzeBlueprintLayoutFromBase64(imageUrl),
  ]);

  if (vectorizationAttempt.status === "fulfilled") {
    vectorizationHints = buildVectorizationHints(vectorizationAttempt.value);
    debugImage = vectorizationAttempt.value.debug_image;
    console.log("[Infralith Vision Engine] Vectorization output:", {
      ...summarizeVectorizationHints(vectorizationHints),
      hasDebugImage: !!debugImage,
    });
  } else {
    const e: any = vectorizationAttempt.reason;
    console.warn(`[Infralith Vision Engine] Vectorization pre - processing failed: ${e?.message || e}. Falling back to pure vision analysis.`);
  }

  if (layoutAttempt.status === "fulfilled") {
    layoutHints = layoutAttempt.value;
    console.log("[Infralith Vision Engine] Layout hint output:", summarizeLayoutHints(layoutHints));
  } else {
    const e: any = layoutAttempt.reason;
    console.warn(`[Infralith Vision Engine] Layout hint extraction failed: ${e?.message || e}.`);
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

    AZURE DOCUMENT LAYOUT HINTS (PREBUILT-LAYOUT):
    I also extracted OCR line polygons and dimension anchors using Azure Document Intelligence prebuilt-layout. Use these as an additional constraint for wall tracing and scale calibration.
    LAYOUT HINTS:
    ${layoutHints ? JSON.stringify(layoutHints, null, 2) : "Not available."}

    CORE VISION ANALYSIS PROTOCOL:
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

    THINKING PROCESS(reason step - by - step before generating output):
- Step 1: Identify the scale factor from dimension labels or standard ratios.
    - Step 2: Trace all wall segments from the image and convert to metric coordinates.
    - Step 3: Detect all door and window openings.Link each to its host wall.
    - Step 4: Define all enclosed room polygons in CCW order.
    - Step 5: Validate the building core alignment across all floors.
    - Step 6: Perform a structural audit.Generate 2 - 5 specific, actionable conflict reports.

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
    console.log("[Infralith Vision Engine] Step 2/9 sending blueprint + hybrid hints to Azure Vision.");
    let result = await generateAzureVisionObject<GeometricReconstruction>(prompt, imageUrl);
    console.log("[Infralith Vision Engine] Step 3/9 AI reconstruction received.", summarizeReconstruction(result));

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
      console.warn("[Infralith Vision Engine] Step 4/9 underfit detected. Retrying once with stricter anti-generic constraints.");
      result = await generateAzureVisionObject<GeometricReconstruction>(strictPrompt, imageUrl);
      console.log("[Infralith Vision Engine] Retry reconstruction summary:", summarizeReconstruction(result));
    }

    if (shouldRetryForUnderfit(result, vectorizationHints, layoutHints) && vectorizationHints) {
      const vectorFallback = buildVectorFallbackReconstruction(vectorizationHints, layoutHints);
      if (vectorFallback) {
        console.warn("[Infralith Vision Engine] Step 5/9 applying deterministic vector fallback reconstruction.");
        result = vectorFallback;
        console.log("[Infralith Vision Engine] Vector fallback summary:", summarizeReconstruction(result));
      }
    }

    if (!result || !result.walls || result.walls.length === 0) {
      throw new Error("Engineering Synthesis Failed: GPT-4o Vision could not construct a valid geometric structure from the provided blueprint. Please ensure the image is a clear architectural floor plan.");
    }

    // Apply strict deterministic architectural building code checks
    console.log("[Infralith Vision Engine] Step 6/9 applying deterministic building-code validation.");
    const validatedResult = applyBuildingCodes(result);
    console.log("[Infralith Vision Engine] Step 7/9 validation complete.", summarizeReconstruction(validatedResult));

    const finalPayload: GeometricReconstruction = {
      ...validatedResult,
      debug_image: debugImage, // Pass along the debug image from the vectorization step
      is_vision_only: !vectorizationHints // Flag if vectorization failed and we fell back
    };

    console.log("[Infralith Vision Engine] Step 8/9 final payload assembled.", {
      is_vision_only: finalPayload.is_vision_only,
      hasDebugImage: !!finalPayload.debug_image,
      vectorHints: summarizeVectorizationHints(vectorizationHints),
      layoutHints: summarizeLayoutHints(layoutHints),
    });

    const durationMs = Date.now() - startedAt;
    console.log(`[Infralith Vision Engine] Step 9/9 returning reconstruction in ${durationMs}ms. is_vision_only=${finalPayload.is_vision_only}`);
    return finalPayload;
  } catch (e) {
    console.error("[Infralith Vision Engine] Azure Vision Pipeline Error:", e);
    throw e;
  }
}

/**
 * Generate a 3D building from a text description.
 * Uses Azure OpenAI to generate complete parametric geometry with luxury finishes.
 */
export async function generateBuildingFromDescription(description: string): Promise<GeometricReconstruction> {
  const startedAt = Date.now();
  console.log(`[Infralith Architect Engine] Generating parametric building from description. promptSeedChars=${description.length}`);

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

    ROOM POLYGON RULE: All room polygons MUST be Counter - Clockwise(CCW) ordered.

    STRUCTURAL THINKING PROCESS:
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
    const result = await generateAzureObject<GeometricReconstruction>(prompt);
    if (!result || !result.walls || result.walls.length === 0) {
      throw new Error("Architectural Generation Failed: The AI was unable to synthesize a valid structure from the given description.");
    }
    const durationMs = Date.now() - startedAt;
    console.log(`[Infralith Architect Engine] Structured generation completed in ${durationMs}ms.`, summarizeReconstruction(result));
    return result;
  } catch (e) {
    console.error("[Infralith Architect Engine] Text-to-3D Pipeline Error:", e);
    throw e;
  }
}

/**
 * Enterprise Real-Time Asset Generator.
 * Uses Azure OpenAI to procedurally generate a highly detailed 3D asset model made of bounding boxes.
 * This guarantees the models are completely unique and not predefined templates.
 */
export async function generateRealTimeAsset(description: string): Promise<AIAsset> {
  console.log(`[Procedural Voxel Engine] Generating asset: ${description} `);

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
  `;

  try {
    const result = await generateAzureObject<AIAsset>(prompt, AIAssetSchema);
    if (!result || !result.parts || result.parts.length === 0) {
      throw new Error("Asset Generation Failed.");
    }
    return result;
  } catch (e) {
    console.error("[Procedural Voxel Engine] Error calling Azure OpenAI for asset:", e);
    throw e;
  }
}
