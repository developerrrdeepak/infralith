'use server';

import { generateAzureVisionObject, analyzeBlueprintLayoutFromBase64 } from '@/ai/azure-ai';
import type { GeometricReconstruction } from './reconstruction-types';
import { buildBlueprintVisionPrompt } from './prompt-templates';

type AdaptiveConfig = {
  minConfidence: number;
  maxRetries: number;
  adaptiveThreshold: number;
};

const DEFAULT_CONFIG: AdaptiveConfig = {
  minConfidence: 0.95,
  maxRetries: 3,
  adaptiveThreshold: 0.92,
};

export async function generateAdaptive3DModel(
  blueprintBase64: string,
  config: Partial<AdaptiveConfig> = {}
): Promise<GeometricReconstruction> {
  const finalConfig = { ...DEFAULT_CONFIG, ...config };
  
  // Step 1: Analyze blueprint layout
  const layoutHints = await analyzeBlueprintLayoutFromBase64(blueprintBase64);
  
  // Step 2: Build adaptive prompt
  const prompt = buildBlueprintVisionPrompt(layoutHints);
  
  // Step 3: Generate with adaptive refinement
  let result = await generateAzureVisionObject<GeometricReconstruction>(
    prompt,
    blueprintBase64
  );
  
  // Step 4: Validate and refine
  let confidence = calculateModelConfidence(result);
  let retries = 0;
  
  while (confidence < finalConfig.minConfidence && retries < finalConfig.maxRetries) {
    const refinementPrompt = buildRefinementPrompt(result, confidence, layoutHints);
    result = await generateAzureVisionObject<GeometricReconstruction>(
      refinementPrompt,
      blueprintBase64
    );
    confidence = calculateModelConfidence(result);
    retries++;
  }
  
  return result;
}

function calculateModelConfidence(model: GeometricReconstruction): number {
  const weights = {
    walls: 0.3,
    rooms: 0.25,
    doors: 0.15,
    windows: 0.15,
    topology: 0.15,
  };
  
  let score = 0;
  
  // Wall confidence
  if (model.walls?.length > 0) {
    const avgWallConf = model.walls.reduce((sum, w) => sum + (w.confidence || 0.5), 0) / model.walls.length;
    score += avgWallConf * weights.walls;
  }
  
  // Room confidence
  if (model.rooms?.length > 0) {
    const avgRoomConf = model.rooms.reduce((sum, r) => sum + (r.confidence || 0.5), 0) / model.rooms.length;
    score += avgRoomConf * weights.rooms;
  }
  
  // Opening confidence
  const doorConf = model.doors?.length > 0 
    ? model.doors.reduce((sum, d) => sum + (d.confidence || 0.5), 0) / model.doors.length 
    : 0.5;
  const windowConf = model.windows?.length > 0
    ? model.windows.reduce((sum, w) => sum + (w.confidence || 0.5), 0) / model.windows.length
    : 0.5;
  score += doorConf * weights.doors + windowConf * weights.windows;
  
  // Topology confidence
  const topologyScore = model.topology_checks?.closed_wall_loops ? 1 : 0;
  score += topologyScore * weights.topology;
  
  return Math.min(1, score);
}

function buildRefinementPrompt(
  currentModel: GeometricReconstruction,
  confidence: number,
  layoutHints: any
): string {
  const issues: string[] = [];
  
  if (!currentModel.topology_checks?.closed_wall_loops) {
    issues.push('Wall loops are not closed - ensure all exterior walls form complete perimeter');
  }
  
  if (currentModel.walls?.length < 4) {
    issues.push('Insufficient wall segments detected - increase wall detection sensitivity');
  }
  
  if (currentModel.rooms?.length === 0) {
    issues.push('No rooms detected - ensure room polygons are extracted from enclosed wall regions');
  }
  
  return `${buildBlueprintVisionPrompt(layoutHints)}

REFINEMENT REQUIRED (Current confidence: ${(confidence * 100).toFixed(1)}%):
${issues.map((issue, i) => `${i + 1}. ${issue}`).join('\n')}

Focus on improving accuracy by:
- Detecting all visible wall segments with precise endpoints
- Ensuring complete wall loop closure
- Extracting all room polygons from enclosed regions
- Validating all opening placements against host walls
- Maintaining metric consistency across all elements
`;
}
