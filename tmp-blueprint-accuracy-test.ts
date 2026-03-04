import fs from 'node:fs/promises';
import path from 'node:path';
import dotenv from 'dotenv';

dotenv.config({ path: '.env.local' });

type ProcessBlueprintTo3D = typeof import('./src/ai/flows/infralith/blueprint-to-3d-agent').processBlueprintTo3D;
type AnalyzeLayout = typeof import('./src/ai/azure-ai').analyzeBlueprintLayoutFromBase64;

const imageArg = process.argv[2] || 'Screenshot 2026-03-03 070719.png';
const imagePath = path.resolve(imageArg);

const toFinite = (value: unknown): number | null => {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

const countInteriorWalls = (result: Awaited<ReturnType<ProcessBlueprintTo3D>>): number =>
  (result?.walls || []).filter(w => w?.is_exterior === false).length;

const hasStairsInResult = (result: Awaited<ReturnType<ProcessBlueprintTo3D>>): boolean => {
  const stairRegex = /\bstair(?:case)?s?\b|\bstairwell\b|\bup\b|\bdn\b|\bdown\b/i;
  const roomHit = (result?.rooms || []).some(room => stairRegex.test(String(room?.name || '')));
  const furnitureHit = (result?.furnitures || []).some(item =>
    stairRegex.test(String(item?.type || '')) || stairRegex.test(String(item?.description || ''))
  );
  return roomHit || furnitureHit;
};

const estimateRoomDimensionPairHints = (layout: Awaited<ReturnType<AnalyzeLayout>>): number =>
  (layout?.dimensionAnchors || [])
    .map(anchor => String(anchor?.text || ''))
    .filter(text => /[x×]/i.test(text))
    .length;

const inferFloorCount = (result: Awaited<ReturnType<ProcessBlueprintTo3D>>): number => {
  const hinted = Math.max(0, Math.round(toFinite(result?.meta?.floor_count) ?? 0));
  let maxLevel = -1;
  const bump = (value: unknown) => {
    const n = toFinite(value);
    if (n == null) return;
    if (n > maxLevel) maxLevel = n;
  };

  for (const item of result?.walls || []) bump(item.floor_level);
  for (const item of result?.rooms || []) bump(item.floor_level);
  for (const item of result?.doors || []) bump(item.floor_level);
  for (const item of result?.windows || []) bump(item.floor_level);

  return Math.max(1, hinted, maxLevel + 1);
};

const estimateFloorSignals = (layout: Awaited<ReturnType<AnalyzeLayout>>): number => {
  const labels = (layout?.floorLabelAnchors || [])
    .map(anchor => String(anchor?.text || '').trim().toLowerCase())
    .filter(Boolean);

  const normalized = labels.map(label => {
    if (label.includes('third')) return 'third';
    if (label.includes('second')) return 'second';
    if (label.includes('first')) return 'first';
    if (label.includes('ground')) return 'ground';
    const levelMatch = label.match(/(?:level|floor|flr|lvl)\s*[-_:]?\s*([a-z0-9]+)/i);
    return levelMatch?.[1] || label;
  });

  return new Set(normalized).size;
};

const computeAccuracyScore = (
  result: Awaited<ReturnType<ProcessBlueprintTo3D>>,
  layout: Awaited<ReturnType<AnalyzeLayout>>
): number => {
  let score = 0;

  const hasWalls = (result?.walls?.length || 0) >= 8;
  if (hasWalls) score += 25;

  const hasRooms = (result?.rooms?.length || 0) >= 4;
  if (hasRooms) score += 20;

  const inferredFloors = inferFloorCount(result);
  const floorSignals = estimateFloorSignals(layout);
  const floorAligned = floorSignals <= 1 ? inferredFloors >= 1 : inferredFloors >= Math.min(3, floorSignals);
  if (floorAligned) score += 25;

  const topology = result?.topology_checks;
  const topologyGood =
    topology?.closed_wall_loops !== false &&
    (topology?.dangling_walls ?? 0) <= 2 &&
    (topology?.unhosted_openings ?? 0) === 0 &&
    topology?.room_polygon_validity_pass !== false;
  if (topologyGood) score += 15;

  const scaleConfidence = toFinite(result?.meta?.scale_confidence);
  if (scaleConfidence != null) {
    if (scaleConfidence >= 0.7) score += 15;
    else if (scaleConfidence >= 0.3) score += 10;
    else if (scaleConfidence >= 0.1) score += 5;
  }

  return Math.max(0, Math.min(100, Math.round(score)));
};

const run = async () => {
  const { processBlueprintTo3D } = await import('./src/ai/flows/infralith/blueprint-to-3d-agent');
  const { analyzeBlueprintLayoutFromBase64 } = await import('./src/ai/azure-ai');

  const imageBuffer = await fs.readFile(imagePath);
  const base64 = imageBuffer.toString('base64');

  const startedAt = Date.now();
  const layout = await analyzeBlueprintLayoutFromBase64(base64);
  const result = await processBlueprintTo3D(base64);
  const elapsedMs = Date.now() - startedAt;

  const inferredFloorCount = inferFloorCount(result);
  const floorSignals = estimateFloorSignals(layout);
  const accuracyScore = computeAccuracyScore(result, layout);
  const stairsDetected = hasStairsInResult(result);
  const interiorWalls = countInteriorWalls(result);
  const dimensionPairHints = estimateRoomDimensionPairHints(layout);
  const dimensionAlignmentConflicts = (result.conflicts || []).filter(c =>
    /dimension|size|position alignment|room-dimension/i.test(String(c?.description || ''))
  ).length;
  const floorLevels = Array.from(new Set([
    ...(result.walls || []).map(item => Number(item.floor_level || 0)),
    ...(result.rooms || []).map(item => Number(item.floor_level || 0)),
    ...(result.doors || []).map(item => Number(item.floor_level || 0)),
    ...(result.windows || []).map(item => Number(item.floor_level || 0)),
  ])).sort((a, b) => a - b);

  const summary = {
    imagePath,
    elapsedMs,
    accuracyScore,
    walls: result.walls?.length || 0,
    rooms: result.rooms?.length || 0,
    doors: result.doors?.length || 0,
    windows: result.windows?.length || 0,
    interiorWalls,
    stairsDetected,
    floorSignals,
    inferredFloorCount,
    floorLevelStats: floorLevels.map(level => ({
      level,
      walls: (result.walls || []).filter(item => Number(item.floor_level || 0) === level).length,
      rooms: (result.rooms || []).filter(item => Number(item.floor_level || 0) === level).length,
      doors: (result.doors || []).filter(item => Number(item.floor_level || 0) === level).length,
      windows: (result.windows || []).filter(item => Number(item.floor_level || 0) === level).length,
    })),
    roomDimensionHintPairs: dimensionPairHints,
    dimensionAlignmentConflicts,
    metaFloorCount: result.meta?.floor_count ?? null,
    scaleConfidence: result.meta?.scale_confidence ?? null,
    topology: result.topology_checks ?? null,
    highSeverityConflicts: (result.conflicts || []).filter(c => c.severity === 'high').length,
    visionOnly: !!result.is_vision_only,
    layoutHintStats: {
      pageCount: layout?.pageCount || 0,
      linePolygons: layout?.linePolygons?.length || 0,
      dimensionAnchors: layout?.dimensionAnchors?.length || 0,
      floorLabelAnchors: layout?.floorLabelAnchors?.length || 0,
    },
  };

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const artifactDir = path.resolve('artifacts');
  await fs.mkdir(artifactDir, { recursive: true });
  const summaryPath = path.join(artifactDir, `blueprint-accuracy-summary-${stamp}.json`);
  const resultPath = path.join(artifactDir, `blueprint-reconstruction-${stamp}.json`);

  await fs.writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  await fs.writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');

  console.log('=== BLUEPRINT TO 3D ACCURACY TEST ===');
  console.log(JSON.stringify(summary, null, 2));
  console.log(`Summary JSON: ${summaryPath}`);
  console.log(`Reconstruction JSON: ${resultPath}`);
};

run().catch((error) => {
  console.error('Blueprint accuracy test failed.');
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
