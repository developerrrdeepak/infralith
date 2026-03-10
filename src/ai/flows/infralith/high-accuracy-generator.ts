'use client';

import { analyzeBlueprintLayoutFromBase64 } from '@/ai/azure-ai';
import { generateAdaptive3DModel } from './adaptive-3d-engine';
import { validateModel, autoFixModel, type ValidationResult } from './model-validation';
import { analyzeBlueprint, selectAdaptiveStrategy } from './blueprint-analyzer';
import type { GeometricReconstruction } from './reconstruction-types';

export type GenerationResult = {
  model: GeometricReconstruction;
  validation: ValidationResult;
  metadata: {
    blueprintType: string;
    complexity: string;
    floorCount: number;
    processingTime: number;
    iterations: number;
    finalAccuracy: number;
  };
};

export async function generateHighAccuracy3DModel(
  blueprintBase64: string,
  targetAccuracy = 0.95
): Promise<GenerationResult> {
  const startTime = Date.now();
  let iterations = 0;
  
  console.log('🎯 Starting high-accuracy 3D model generation...');
  
  // Step 1: Analyze blueprint
  console.log('📊 Analyzing blueprint characteristics...');
  const layoutHints = await analyzeBlueprintLayoutFromBase64(blueprintBase64);
  const characteristics = analyzeBlueprint(layoutHints);
  const strategy = selectAdaptiveStrategy(characteristics);
  
  console.log(`Blueprint Type: ${characteristics.type}`);
  console.log(`Complexity: ${characteristics.complexity}`);
  console.log(`Estimated Floors: ${characteristics.floorCount}`);
  console.log(`Detail Level: ${characteristics.detailLevel}`);
  
  // Step 2: Generate initial model
  console.log('🏗️ Generating initial 3D model...');
  let model = await generateAdaptive3DModel(blueprintBase64, {
    minConfidence: targetAccuracy,
    maxRetries: 3,
    adaptiveThreshold: targetAccuracy - 0.03,
  });
  iterations++;
  
  // Step 3: Validate and refine
  console.log('✅ Validating model...');
  let validation = await validateModel(model, targetAccuracy);
  
  // Step 4: Auto-fix if needed
  while (!validation.passed && iterations < 5) {
    console.log(`⚠️ Accuracy: ${(validation.accuracy * 100).toFixed(1)}% - Applying fixes...`);
    
    // Auto-fix common issues
    model = await autoFixModel(model);
    
    // Re-validate
    validation = await validateModel(model, targetAccuracy);
    iterations++;
    
    // If still not passing, regenerate with stricter parameters
    if (!validation.passed && iterations < 5) {
      console.log('🔄 Regenerating with enhanced parameters...');
      model = await generateAdaptive3DModel(blueprintBase64, {
        minConfidence: targetAccuracy + 0.02,
        maxRetries: 2,
        adaptiveThreshold: targetAccuracy,
      });
      validation = await validateModel(model, targetAccuracy);
      iterations++;
    }
  }
  
  const processingTime = Date.now() - startTime;
  
  console.log(`✨ Generation complete!`);
  console.log(`Final Accuracy: ${(validation.accuracy * 100).toFixed(1)}%`);
  console.log(`Processing Time: ${(processingTime / 1000).toFixed(1)}s`);
  console.log(`Iterations: ${iterations}`);
  
  return {
    model,
    validation,
    metadata: {
      blueprintType: characteristics.type,
      complexity: characteristics.complexity,
      floorCount: characteristics.floorCount,
      processingTime,
      iterations,
      finalAccuracy: validation.accuracy,
    },
  };
}

export async function generateWithProgressTracking(
  blueprintBase64: string,
  targetAccuracy = 0.95,
  onProgress?: (progress: number, message: string) => void
): Promise<GenerationResult> {
  const startTime = Date.now();
  
  onProgress?.(10, 'Analyzing blueprint...');
  const layoutHints = await analyzeBlueprintLayoutFromBase64(blueprintBase64);
  const characteristics = analyzeBlueprint(layoutHints);
  
  onProgress?.(30, 'Generating 3D model...');
  let model = await generateAdaptive3DModel(blueprintBase64, {
    minConfidence: targetAccuracy,
    maxRetries: 3,
    adaptiveThreshold: targetAccuracy - 0.03,
  });
  
  onProgress?.(60, 'Validating model...');
  let validation = await validateModel(model, targetAccuracy);
  
  let iterations = 1;
  while (!validation.passed && iterations < 5) {
    onProgress?.(60 + (iterations * 8), `Refining model (iteration ${iterations})...`);
    
    model = await autoFixModel(model);
    validation = await validateModel(model, targetAccuracy);
    
    if (!validation.passed && iterations < 5) {
      model = await generateAdaptive3DModel(blueprintBase64, {
        minConfidence: targetAccuracy + 0.02,
        maxRetries: 2,
        adaptiveThreshold: targetAccuracy,
      });
      validation = await validateModel(model, targetAccuracy);
    }
    
    iterations++;
  }
  
  onProgress?.(100, 'Complete!');
  
  const processingTime = Date.now() - startTime;
  
  return {
    model,
    validation,
    metadata: {
      blueprintType: characteristics.type,
      complexity: characteristics.complexity,
      floorCount: characteristics.floorCount,
      processingTime,
      iterations,
      finalAccuracy: validation.accuracy,
    },
  };
}


