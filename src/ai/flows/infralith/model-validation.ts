'use server';

import type { GeometricReconstruction } from './reconstruction-types';

export type ValidationResult = {
  passed: boolean;
  accuracy: number;
  issues: ValidationIssue[];
  suggestions: string[];
};

export type ValidationIssue = {
  severity: 'critical' | 'high' | 'medium' | 'low';
  category: 'topology' | 'geometry' | 'semantics' | 'scale';
  description: string;
  location?: [number, number];
  autoFixable: boolean;
};

export async function validateModel(
  model: GeometricReconstruction,
  targetAccuracy = 0.95
): Promise<ValidationResult> {
  const issues: ValidationIssue[] = [];
  
  // 1. Topology validation
  issues.push(...validateTopology(model));
  
  // 2. Geometry validation
  issues.push(...validateGeometry(model));
  
  // 3. Semantic validation
  issues.push(...validateSemantics(model));
  
  // 4. Scale validation
  issues.push(...validateScale(model));
  
  // Calculate accuracy
  const accuracy = calculateAccuracy(model, issues);
  
  // Generate suggestions
  const suggestions = generateSuggestions(issues);
  
  return {
    passed: accuracy >= targetAccuracy,
    accuracy,
    issues,
    suggestions,
  };
}

function validateTopology(model: GeometricReconstruction): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  
  // Check wall loop closure
  if (!model.topology_checks?.closed_wall_loops) {
    issues.push({
      severity: 'critical',
      category: 'topology',
      description: 'Wall loops are not closed - building perimeter is incomplete',
      autoFixable: true,
    });
  }
  
  // Check dangling walls
  if ((model.topology_checks?.dangling_walls || 0) > 0) {
    issues.push({
      severity: 'high',
      category: 'topology',
      description: `${model.topology_checks?.dangling_walls} dangling wall(s) detected`,
      autoFixable: true,
    });
  }
  
  // Check unhosted openings
  if ((model.topology_checks?.unhosted_openings || 0) > 0) {
    issues.push({
      severity: 'high',
      category: 'topology',
      description: `${model.topology_checks?.unhosted_openings} opening(s) without valid host wall`,
      autoFixable: true,
    });
  }
  
  // Check room polygon validity
  if (!model.topology_checks?.room_polygon_validity_pass) {
    issues.push({
      severity: 'high',
      category: 'topology',
      description: 'Invalid room polygon(s) detected',
      autoFixable: true,
    });
  }
  
  return issues;
}

function validateGeometry(model: GeometricReconstruction): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  
  // Check wall count
  if (model.walls.length < 4) {
    issues.push({
      severity: 'critical',
      category: 'geometry',
      description: `Only ${model.walls.length} walls detected - insufficient for valid building`,
      autoFixable: false,
    });
  }
  
  // Check room count
  if (model.rooms.length === 0) {
    issues.push({
      severity: 'high',
      category: 'geometry',
      description: 'No rooms detected',
      autoFixable: false,
    });
  }
  
  // Check wall dimensions
  for (const wall of model.walls) {
    const length = Math.hypot(
      wall.end[0] - wall.start[0],
      wall.end[1] - wall.start[1]
    );
    
    if (length < 0.5) {
      issues.push({
        severity: 'medium',
        category: 'geometry',
        description: `Wall ${wall.id} is too short (${length.toFixed(2)}m)`,
        location: wall.start,
        autoFixable: true,
      });
    }
    
    if (wall.thickness < 0.05 || wall.thickness > 0.5) {
      issues.push({
        severity: 'medium',
        category: 'geometry',
        description: `Wall ${wall.id} has unusual thickness (${wall.thickness}m)`,
        location: wall.start,
        autoFixable: true,
      });
    }
  }
  
  // Check room areas
  for (const room of model.rooms) {
    if (room.area < 2) {
      issues.push({
        severity: 'medium',
        category: 'geometry',
        description: `Room "${room.name}" is too small (${room.area.toFixed(2)}m²)`,
        autoFixable: false,
      });
    }
  }
  
  return issues;
}

function validateSemantics(model: GeometricReconstruction): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  
  // Check for duplicate IDs
  const wallIds = new Set<string>();
  for (const wall of model.walls) {
    const id = String(wall.id);
    if (wallIds.has(id)) {
      issues.push({
        severity: 'critical',
        category: 'semantics',
        description: `Duplicate wall ID: ${id}`,
        autoFixable: true,
      });
    }
    wallIds.add(id);
  }
  
  // Check door-wall relationships
  for (const door of model.doors) {
    const hostWall = model.walls.find(w => String(w.id) === String(door.host_wall_id));
    if (!hostWall) {
      issues.push({
        severity: 'high',
        category: 'semantics',
        description: `Door ${door.id} references non-existent wall ${door.host_wall_id}`,
        location: door.position,
        autoFixable: true,
      });
    }
  }
  
  // Check window-wall relationships
  for (const window of model.windows) {
    const hostWall = model.walls.find(w => String(w.id) === String(window.host_wall_id));
    if (!hostWall) {
      issues.push({
        severity: 'high',
        category: 'semantics',
        description: `Window ${window.id} references non-existent wall ${window.host_wall_id}`,
        location: window.position,
        autoFixable: true,
      });
    }
  }
  
  return issues;
}

function validateScale(model: GeometricReconstruction): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  
  // Check scale confidence
  const scaleConf = model.meta?.scale_confidence || 0;
  if (scaleConf < 0.7) {
    issues.push({
      severity: 'medium',
      category: 'scale',
      description: `Low scale confidence (${(scaleConf * 100).toFixed(0)}%)`,
      autoFixable: false,
    });
  }
  
  // Check for reasonable building dimensions
  const xs = model.walls.flatMap(w => [w.start[0], w.end[0]]);
  const ys = model.walls.flatMap(w => [w.start[1], w.end[1]]);
  const width = Math.max(...xs) - Math.min(...xs);
  const depth = Math.max(...ys) - Math.min(...ys);
  
  if (width < 3 || depth < 3) {
    issues.push({
      severity: 'high',
      category: 'scale',
      description: `Building dimensions too small (${width.toFixed(1)}m × ${depth.toFixed(1)}m)`,
      autoFixable: false,
    });
  }
  
  if (width > 100 || depth > 100) {
    issues.push({
      severity: 'medium',
      category: 'scale',
      description: `Building dimensions unusually large (${width.toFixed(1)}m × ${depth.toFixed(1)}m)`,
      autoFixable: false,
    });
  }
  
  return issues;
}

function calculateAccuracy(
  model: GeometricReconstruction,
  issues: ValidationIssue[]
): number {
  let score = 1.0;
  
  // Deduct points based on issue severity
  for (const issue of issues) {
    switch (issue.severity) {
      case 'critical':
        score -= 0.15;
        break;
      case 'high':
        score -= 0.08;
        break;
      case 'medium':
        score -= 0.03;
        break;
      case 'low':
        score -= 0.01;
        break;
    }
  }
  
  // Bonus for good topology
  if (model.topology_checks?.closed_wall_loops) score += 0.05;
  if ((model.topology_checks?.dangling_walls || 0) === 0) score += 0.03;
  if ((model.topology_checks?.unhosted_openings || 0) === 0) score += 0.03;
  
  // Bonus for completeness
  if (model.walls.length >= 8) score += 0.02;
  if (model.rooms.length >= 3) score += 0.02;
  if (model.doors.length >= 2) score += 0.01;
  if (model.windows.length >= 2) score += 0.01;
  
  return Math.max(0, Math.min(1, score));
}

function generateSuggestions(issues: ValidationIssue[]): string[] {
  const suggestions: string[] = [];
  
  const criticalIssues = issues.filter(i => i.severity === 'critical');
  if (criticalIssues.length > 0) {
    suggestions.push('Fix critical issues first: ' + criticalIssues.map(i => i.description).join('; '));
  }
  
  const topologyIssues = issues.filter(i => i.category === 'topology');
  if (topologyIssues.length > 0) {
    suggestions.push('Improve topology by ensuring all walls form closed loops and all openings have valid host walls');
  }
  
  const geometryIssues = issues.filter(i => i.category === 'geometry');
  if (geometryIssues.length > 0) {
    suggestions.push('Refine geometry by detecting more wall segments and validating room polygons');
  }
  
  const autoFixable = issues.filter(i => i.autoFixable);
  if (autoFixable.length > 0) {
    suggestions.push(`${autoFixable.length} issue(s) can be automatically fixed`);
  }
  
  return suggestions;
}

export async function autoFixModel(
  model: GeometricReconstruction
): Promise<GeometricReconstruction> {
  let fixed = { ...model };
  
  // Auto-fix duplicate IDs
  fixed = fixDuplicateIds(fixed);
  
  // Auto-fix dangling walls
  fixed = fixDanglingWalls(fixed);
  
  // Auto-fix unhosted openings
  fixed = fixUnhostedOpenings(fixed);
  
  return fixed;
}

function fixDuplicateIds(model: GeometricReconstruction): GeometricReconstruction {
  const seenIds = new Set<string>();
  let counter = 1;
  
  const walls = model.walls.map(wall => {
    let id = String(wall.id);
    if (seenIds.has(id)) {
      id = `${id}-fix-${counter++}`;
    }
    seenIds.add(id);
    return { ...wall, id };
  });
  
  return { ...model, walls };
}

function fixDanglingWalls(model: GeometricReconstruction): GeometricReconstruction {
  // Remove walls shorter than 0.3m
  const walls = model.walls.filter(wall => {
    const length = Math.hypot(
      wall.end[0] - wall.start[0],
      wall.end[1] - wall.start[1]
    );
    return length >= 0.3;
  });
  
  return { ...model, walls };
}

function fixUnhostedOpenings(model: GeometricReconstruction): GeometricReconstruction {
  const wallIds = new Set(model.walls.map(w => String(w.id)));
  
  const doors = model.doors.filter(door => 
    wallIds.has(String(door.host_wall_id))
  );
  
  const windows = model.windows.filter(window => 
    wallIds.has(String(window.host_wall_id))
  );
  
  return { ...model, doors, windows };
}
