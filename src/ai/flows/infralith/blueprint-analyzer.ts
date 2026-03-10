'use server';

import type { BlueprintLayoutHints } from '@/ai/azure-ai';

export type BlueprintCharacteristics = {
  type: 'residential' | 'commercial' | 'industrial' | 'mixed' | 'unknown';
  complexity: 'simple' | 'moderate' | 'complex' | 'very_complex';
  floorCount: number;
  estimatedArea: number;
  hasNonOrthogonal: boolean;
  hasCurvedWalls: boolean;
  detailLevel: 'low' | 'medium' | 'high';
  confidence: number;
};

export type AdaptiveStrategy = {
  wallDetectionSensitivity: number;
  roomExtractionThreshold: number;
  openingDetectionMode: 'strict' | 'balanced' | 'aggressive';
  scaleEstimationMethod: 'dimension_anchors' | 'statistical' | 'hybrid';
  topologyRepairLevel: 'minimal' | 'moderate' | 'aggressive';
};

export function analyzeBlueprint(
  layoutHints: BlueprintLayoutHints | null
): BlueprintCharacteristics {
  if (!layoutHints) {
    return {
      type: 'unknown',
      complexity: 'simple',
      floorCount: 1,
      estimatedArea: 0,
      hasNonOrthogonal: false,
      hasCurvedWalls: false,
      detailLevel: 'low',
      confidence: 0,
    };
  }
  
  const lineCount = layoutHints.linePolygons?.length || 0;
  const dimensionCount = layoutHints.dimensionAnchors?.length || 0;
  const floorLabelCount = layoutHints.floorLabelAnchors?.length || 0;
  const semanticCount = layoutHints.semanticAnchors?.length || 0;
  
  // Determine complexity
  let complexity: BlueprintCharacteristics['complexity'] = 'simple';
  if (lineCount > 200 || dimensionCount > 30) complexity = 'very_complex';
  else if (lineCount > 100 || dimensionCount > 15) complexity = 'complex';
  else if (lineCount > 50 || dimensionCount > 8) complexity = 'moderate';
  
  // Estimate floor count
  const floorCount = Math.max(1, floorLabelCount || 1);
  
  // Estimate area from line distribution
  const estimatedArea = estimateAreaFromLines(layoutHints);
  
  // Detect non-orthogonal features
  const hasNonOrthogonal = detectNonOrthogonal(layoutHints);
  
  // Detect curved walls
  const hasCurvedWalls = detectCurvedWalls(layoutHints);
  
  // Determine detail level
  let detailLevel: BlueprintCharacteristics['detailLevel'] = 'low';
  if (dimensionCount > 20 && semanticCount > 15) detailLevel = 'high';
  else if (dimensionCount > 10 && semanticCount > 8) detailLevel = 'medium';
  
  // Determine building type
  const type = determineBuildingType(layoutHints);
  
  // Calculate confidence
  const confidence = calculateAnalysisConfidence(layoutHints);
  
  return {
    type,
    complexity,
    floorCount,
    estimatedArea,
    hasNonOrthogonal,
    hasCurvedWalls,
    detailLevel,
    confidence,
  };
}

export function selectAdaptiveStrategy(
  characteristics: BlueprintCharacteristics
): AdaptiveStrategy {
  const strategy: AdaptiveStrategy = {
    wallDetectionSensitivity: 0.5,
    roomExtractionThreshold: 0.5,
    openingDetectionMode: 'balanced',
    scaleEstimationMethod: 'hybrid',
    topologyRepairLevel: 'moderate',
  };
  
  // Adjust based on complexity
  switch (characteristics.complexity) {
    case 'very_complex':
      strategy.wallDetectionSensitivity = 0.7;
      strategy.roomExtractionThreshold = 0.6;
      strategy.openingDetectionMode = 'aggressive';
      strategy.topologyRepairLevel = 'aggressive';
      break;
    case 'complex':
      strategy.wallDetectionSensitivity = 0.6;
      strategy.roomExtractionThreshold = 0.55;
      strategy.openingDetectionMode = 'balanced';
      strategy.topologyRepairLevel = 'moderate';
      break;
    case 'moderate':
      strategy.wallDetectionSensitivity = 0.5;
      strategy.roomExtractionThreshold = 0.5;
      strategy.openingDetectionMode = 'balanced';
      strategy.topologyRepairLevel = 'moderate';
      break;
    case 'simple':
      strategy.wallDetectionSensitivity = 0.4;
      strategy.roomExtractionThreshold = 0.45;
      strategy.openingDetectionMode = 'strict';
      strategy.topologyRepairLevel = 'minimal';
      break;
  }
  
  // Adjust for non-orthogonal features
  if (characteristics.hasNonOrthogonal) {
    strategy.wallDetectionSensitivity = Math.min(0.8, strategy.wallDetectionSensitivity + 0.1);
    strategy.topologyRepairLevel = 'aggressive';
  }
  
  // Adjust for curved walls
  if (characteristics.hasCurvedWalls) {
    strategy.wallDetectionSensitivity = 0.8;
    strategy.topologyRepairLevel = 'aggressive';
  }
  
  // Adjust scale estimation based on detail level
  switch (characteristics.detailLevel) {
    case 'high':
      strategy.scaleEstimationMethod = 'dimension_anchors';
      break;
    case 'medium':
      strategy.scaleEstimationMethod = 'hybrid';
      break;
    case 'low':
      strategy.scaleEstimationMethod = 'statistical';
      break;
  }
  
  return strategy;
}

function estimateAreaFromLines(layoutHints: BlueprintLayoutHints): number {
  const polygons = layoutHints.linePolygons || [];
  if (polygons.length === 0) return 0;
  
  let minX = Infinity, maxX = -Infinity;
  let minY = Infinity, maxY = -Infinity;
  
  for (const polygon of polygons) {
    for (let i = 0; i < polygon.length - 1; i += 2) {
      const x = polygon[i];
      const y = polygon[i + 1];
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
  }
  
  const width = maxX - minX;
  const height = maxY - minY;
  
  // Rough estimate assuming typical scale
  return (width * height) / 10000; // Convert to approximate m²
}

function detectNonOrthogonal(layoutHints: BlueprintLayoutHints): boolean {
  const polygons = layoutHints.linePolygons || [];
  let nonOrthogonalCount = 0;
  
  for (const polygon of polygons.slice(0, 50)) {
    if (polygon.length < 8) continue;
    
    for (let i = 0; i < polygon.length - 3; i += 2) {
      const x1 = polygon[i];
      const y1 = polygon[i + 1];
      const x2 = polygon[i + 2];
      const y2 = polygon[i + 3];
      
      const dx = x2 - x1;
      const dy = y2 - y1;
      const angle = Math.atan2(dy, dx) * (180 / Math.PI);
      const normalized = ((angle % 90) + 90) % 90;
      
      if (normalized > 10 && normalized < 80) {
        nonOrthogonalCount++;
      }
    }
  }
  
  return nonOrthogonalCount > polygons.length * 0.15;
}

function detectCurvedWalls(layoutHints: BlueprintLayoutHints): boolean {
  const polygons = layoutHints.linePolygons || [];
  let curvedCount = 0;
  
  for (const polygon of polygons.slice(0, 30)) {
    if (polygon.length < 12) continue;
    
    // Check for many small segments in sequence (indicates curve)
    let consecutiveSmall = 0;
    for (let i = 0; i < polygon.length - 3; i += 2) {
      const x1 = polygon[i];
      const y1 = polygon[i + 1];
      const x2 = polygon[i + 2];
      const y2 = polygon[i + 3];
      
      const length = Math.hypot(x2 - x1, y2 - y1);
      if (length < 5) {
        consecutiveSmall++;
        if (consecutiveSmall >= 5) {
          curvedCount++;
          break;
        }
      } else {
        consecutiveSmall = 0;
      }
    }
  }
  
  return curvedCount > 3;
}

function determineBuildingType(
  layoutHints: BlueprintLayoutHints
): BlueprintCharacteristics['type'] {
  const texts = layoutHints.lineTexts || [];
  const semantics = layoutHints.semanticAnchors || [];
  
  const allText = [
    ...texts,
    ...semantics.map(s => s.text || ''),
  ].join(' ').toLowerCase();
  
  // Residential indicators
  const residentialKeywords = ['bedroom', 'kitchen', 'living', 'bathroom', 'master', 'suite'];
  const residentialScore = residentialKeywords.filter(k => allText.includes(k)).length;
  
  // Commercial indicators
  const commercialKeywords = ['office', 'conference', 'lobby', 'reception', 'retail', 'store'];
  const commercialScore = commercialKeywords.filter(k => allText.includes(k)).length;
  
  // Industrial indicators
  const industrialKeywords = ['warehouse', 'loading', 'storage', 'factory', 'plant'];
  const industrialScore = industrialKeywords.filter(k => allText.includes(k)).length;
  
  if (residentialScore > commercialScore && residentialScore > industrialScore) {
    return 'residential';
  } else if (commercialScore > residentialScore && commercialScore > industrialScore) {
    return 'commercial';
  } else if (industrialScore > 0) {
    return 'industrial';
  } else if (residentialScore > 0 && commercialScore > 0) {
    return 'mixed';
  }
  
  return 'unknown';
}

function calculateAnalysisConfidence(layoutHints: BlueprintLayoutHints): number {
  let score = 0;
  
  // More lines = higher confidence
  const lineCount = layoutHints.linePolygons?.length || 0;
  score += Math.min(0.3, lineCount / 500);
  
  // Dimension anchors boost confidence
  const dimCount = layoutHints.dimensionAnchors?.length || 0;
  score += Math.min(0.25, dimCount / 40);
  
  // Floor labels boost confidence
  const floorCount = layoutHints.floorLabelAnchors?.length || 0;
  score += Math.min(0.2, floorCount / 10);
  
  // Semantic anchors boost confidence
  const semanticCount = layoutHints.semanticAnchors?.length || 0;
  score += Math.min(0.25, semanticCount / 30);
  
  return Math.min(1, score);
}
