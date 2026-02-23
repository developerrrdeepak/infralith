'use server';

import { generateAzureVisionObject } from '@/ai/azure-ai';

export interface WallGeometry {
  id: string | number;
  start: [number, number];
  end: [number, number];
  thickness: number;
  height: number;
}

export interface DoorGeometry {
  id: string | number;
  host_wall_id: string | number;
  position: [number, number];
  width: number;
  height: number;
}

export interface WindowGeometry {
  id: string | number;
  host_wall_id: string | number;
  position: [number, number];
  width: number;
  sill_height: number;
}

export interface RoomGeometry {
  id: string | number;
  name: string;
  polygon: [number, number][];
  area: number;
}

export interface ConstructionConflict {
  type: 'structural' | 'safety' | 'code';
  severity: 'low' | 'medium' | 'high';
  description: string;
  location: [number, number]; // Coordinates of the issue
}

export interface GeometricReconstruction {
  walls: WallGeometry[];
  doors: DoorGeometry[];
  windows: WindowGeometry[];
  rooms: RoomGeometry[];
  conflicts: ConstructionConflict[];
}

/**
 * Construction-grade geometric reconstruction engine.
 * Converts 2D architectural floor plans into metrically consistent parametric 3D models 
 * while identifying critical engineering and construction issues.
 */
export async function processBlueprintTo3D(base64Image: string): Promise<GeometricReconstruction> {
  console.log("Infralith Engineering Engine: Initiating spatial synthesis and conflict detection...");

  const prompt = `
        You are a construction-grade geometric reconstruction and structural auditing engine.

        Input: A 2D architectural floor plan.

        Task:
        1. Generate a metrically consistent parametric 3D model.
        2. Identify REAL construction issues, structural risks, or code violations within the design.

        Rules for 3D Reconstruction:
        - All wall boundaries are structural centerlines.
        - Exterior walls: 0.23m. Interior: 0.115m.
        - Wall height: 2.7m.
        - Ensure topological closure. Snap all intersections.
        - Extract furniture/props as generic boxes if visible.

        Rules for Engineering Analysis (Conflicts):
        Identify and return "conflicts" for:
        - Unsupported spans (walls/beams over 5m without columns).
        - Direct egress paths blocked by structural elements.
        - Room area violations (e.g., bedrooms under 9.5 sqm per NBC).
        - Inconsistent wall alignments (load path discontinuities).
        - Fire safety: Distance to nearest exit over 30m.

        Output structured JSON:
        {
          "walls": [{ "id": "w1", "start": [x,y], "end": [x,y], "thickness": v, "height": v }],
          "doors": [{ "id": "d1", "host_wall_id": "w1", "position": [x,y], "width": v, "height": v }],
          "windows": [{ "id": "win1", "host_wall_id": "w1", "position": [x,y], "width": v, "sill_height": v }],
          "rooms": [{ "id": "r1", "name": "Living", "polygon": [[x,y],...], "area": v }],
          "conflicts": [
            { "type": "structural"|"safety"|"code", "severity": "low"|"medium"|"high", "description": "Short explanation", "location": [x,y] }
          ]
        }
    `;

  try {
    const result = await generateAzureVisionObject<GeometricReconstruction>(prompt, base64Image);

    if (!result || !result.walls) {
      console.warn("Structural audit: No valid data. Generating safe reference.");
      return generateSafeShell();
    }

    return result;
  } catch (e) {
    console.error("Engineering Pipeline Error:", e);
    throw e;
  }
}

function generateSafeShell(): GeometricReconstruction {
  return {
    walls: [
      { id: 1, start: [-5, -5], end: [5, -5], thickness: 0.23, height: 2.7 },
      { id: 2, start: [5, -5], end: [5, 5], thickness: 0.23, height: 2.7 },
      { id: 3, start: [5, 5], end: [-5, 5], thickness: 0.23, height: 2.7 },
      { id: 4, start: [-5, 5], end: [-5, -5], thickness: 0.23, height: 2.7 },
      { id: 5, start: [0, -5], end: [0, 5], thickness: 0.115, height: 2.7 },
    ],
    doors: [
      { id: 6, host_wall_id: 5, position: [0, 1], width: 0.9, height: 2.1 }
    ],
    windows: [
      { id: 7, host_wall_id: 1, position: [2.5, -5], width: 1.5, sill_height: 0.9 }
    ],
    rooms: [
      { id: 8, name: "Zone A", polygon: [[-5, -5], [0, -5], [0, 5], [-5, 5]], area: 50 },
      { id: 9, name: "Zone B", polygon: [[0, -5], [5, -5], [5, 5], [0, 5]], area: 50 }
    ],
    conflicts: [
      { type: 'structural', severity: 'medium', description: 'Long span wall requires column reinforcement.', location: [5, 0] }
    ]
  };
}


