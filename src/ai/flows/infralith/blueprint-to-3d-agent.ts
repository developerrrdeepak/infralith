'use server';

import { generateAzureVisionObject, generateAzureObject } from '@/ai/azure-ai';

export interface WallGeometry {
  id: string | number;
  start: [number, number];
  end: [number, number];
  thickness: number;
  height: number;
  color?: string; // hex color for the wall
  is_exterior?: boolean;
}

export interface DoorGeometry {
  id: string | number;
  host_wall_id: string | number;
  position: [number, number];
  width: number;
  height: number;
  color?: string;
}

export interface WindowGeometry {
  id: string | number;
  host_wall_id: string | number;
  position: [number, number];
  width: number;
  sill_height: number;
  color?: string;
}

export interface RoomGeometry {
  id: string | number;
  name: string;
  polygon: [number, number][];
  area: number;
  floor_color?: string; // hex color for the floor tile
}

export interface RoofGeometry {
  type: 'flat' | 'gable' | 'hip';
  polygon: [number, number][];
  height: number;      // peak height above wall top
  base_height: number; // wall top height (2.7 usually)
  color?: string;
}

export interface ConstructionConflict {
  type: 'structural' | 'safety' | 'code';
  severity: 'low' | 'medium' | 'high';
  description: string;
  location: [number, number];
}

export interface GeometricReconstruction {
  walls: WallGeometry[];
  doors: DoorGeometry[];
  windows: WindowGeometry[];
  rooms: RoomGeometry[];
  roof?: RoofGeometry;
  conflicts: ConstructionConflict[];
  building_name?: string;
  exterior_color?: string;
}

/**
 * Construction-grade geometric reconstruction engine.
 * Converts 2D architectural floor plans into metrically consistent parametric 3D models.
 */
export async function processBlueprintTo3D(base64Image: string): Promise<GeometricReconstruction> {
  console.log("Infralith Engineering Engine: Initiating spatial synthesis...");

  const prompt = `
    You are a construction-grade geometric reconstruction and structural auditing engine.
    Input: A 2D architectural floor plan.

    Task:
    1. Generate a metrically consistent parametric 3D model with COLORS.
    2. Identify construction issues, structural risks, or code violations.

    Rules:
    - All wall boundaries are structural centerlines.
    - Exterior walls: 0.23m thick. Interior: 0.115m.
    - Wall height: 2.7m.
    - Ensure topological closure. Snap all intersections.
    - Assign realistic colors: exterior walls in cream/beige, interior in lighter tones, floors by room type.

    Color guidelines:
    - Living Room floor: "#e8d5b7" (warm beige)
    - Bedroom floor: "#d4c4a8" (light wood)
    - Kitchen floor: "#c9c9c9" (grey tile)
    - Bathroom floor: "#a8d5e2" (light blue tile)
    - Exterior walls: "#f5e6d3" (cream)
    - Interior walls: "#faf7f2" (off-white)
    - Doors: "#8B4513" (wood brown)
    - Windows: "#87CEEB" (sky blue glass)

    Output JSON:
    {
      "building_name": "Name",
      "exterior_color": "#f5e6d3",
      "walls": [{ "id": "w1", "start": [x,y], "end": [x,y], "thickness": v, "height": v, "color": "#hex", "is_exterior": bool }],
      "doors": [{ "id": "d1", "host_wall_id": "w1", "position": [x,y], "width": v, "height": v, "color": "#hex" }],
      "windows": [{ "id": "win1", "host_wall_id": "w1", "position": [x,y], "width": v, "sill_height": v, "color": "#hex" }],
      "rooms": [{ "id": "r1", "name": "Living Room", "polygon": [[x,y],...], "area": v, "floor_color": "#hex" }],
      "roof": { "type": "gable"|"flat"|"hip", "polygon": [[x,y],...], "height": v, "base_height": 2.7, "color": "#8B4513" },
      "conflicts": [{ "type": "structural", "severity": "medium", "description": "text", "location": [x,y] }]
    }
  `;

  try {
    const result = await generateAzureVisionObject<GeometricReconstruction>(prompt, base64Image);
    if (!result || !result.walls) {
      return generateDemoBungalow();
    }
    return result;
  } catch (e) {
    console.error("Engineering Pipeline Error:", e);
    throw e;
  }
}

/**
 * Generate a 3D building from a text description.
 * Users describe their desired building and the AI generates full parametric geometry with colors.
 */
export async function generateBuildingFromDescription(description: string): Promise<GeometricReconstruction> {
  console.log("Infralith Architect Engine: Generating building from text description...");

  const prompt = `
    You are an expert architectural modeling engine. A user will describe a building they want.
    Generate a COMPLETE, REALISTIC parametric 3D floor plan for the described structure.

    User's description: "${description}"

    Requirements:
    1. Create ALL walls with precise start/end coordinates forming a closed, connected floor plan.
    2. Place doors at logical entry/exit points between rooms.
    3. Place windows on exterior walls.
    4. Define room polygons matching the enclosed wall areas.
    5. Add a roof structure.
    6. Assign realistic, beautiful colors to everything.
    7. All coordinates should be in meters, centered around origin (0,0).
    8. Make the structure architecturally plausible and to realistic scale.

    Color palette to use:
    - Exterior walls: "#f5e6d3" (cream) or "#e8dcc8" (sand)
    - Interior walls: "#faf7f2" (off-white)
    - Living Room floor: "#e8d5b7" (warm beige)
    - Bedroom floor: "#d4c4a8" (light wood)
    - Kitchen floor: "#c9c9c9" (grey tile)
    - Bathroom floor: "#a8d5e2" (light blue tile)
    - Doors: "#8B4513" (wood brown)
    - Windows: "#87CEEB" (sky blue)
    - Roof: "#a0522d" (terracotta/brown)

    Output JSON:
    {
      "building_name": "Name of the building",
      "exterior_color": "#f5e6d3",
      "walls": [{ "id": "w1", "start": [x,y], "end": [x,y], "thickness": 0.23, "height": 2.7, "color": "#hex", "is_exterior": true }],
      "doors": [{ "id": "d1", "host_wall_id": "w1", "position": [x,y], "width": 0.9, "height": 2.1, "color": "#8B4513" }],
      "windows": [{ "id": "win1", "host_wall_id": "w1", "position": [x,y], "width": 1.2, "sill_height": 0.9, "color": "#87CEEB" }],
      "rooms": [{ "id": "r1", "name": "Living Room", "polygon": [[x,y],...], "area": 25, "floor_color": "#e8d5b7" }],
      "roof": { "type": "gable", "polygon": [[x,y],...], "height": 1.5, "base_height": 2.7, "color": "#a0522d" },
      "conflicts": []
    }

    Make sure to:
    - Create a complete, realistic structure.
    - All walls must connect properly (topological closure).
    - Room polygons must match enclosed wall areas exactly.
    - Scale should be realistic (bedrooms ~12-15 sqm, living rooms ~20-30 sqm, kitchens ~10-15 sqm).
    - Include at least one main entrance door.
    - Only output valid JSON, no explanation.
  `;

  try {
    const result = await generateAzureObject<GeometricReconstruction>(prompt);
    if (!result || !result.walls || result.walls.length === 0) {
      return generateDemoBungalow(description);
    }
    return result;
  } catch (e) {
    console.error("Text-to-3D Pipeline Error:", e);
    return generateDemoBungalow(description);
  }
}

/**
 * Generate a realistic demo bungalow with colors for fallback/demo.
 */
function generateDemoBungalow(description?: string): GeometricReconstruction {
  return {
    building_name: description ? "Custom Bungalow" : "Demo Bungalow",
    exterior_color: "#f5e6d3",
    walls: [
      // Exterior walls
      { id: "w1", start: [-6, -5], end: [6, -5], thickness: 0.23, height: 2.7, color: "#f5e6d3", is_exterior: true },
      { id: "w2", start: [6, -5], end: [6, 5], thickness: 0.23, height: 2.7, color: "#f5e6d3", is_exterior: true },
      { id: "w3", start: [6, 5], end: [-6, 5], thickness: 0.23, height: 2.7, color: "#f5e6d3", is_exterior: true },
      { id: "w4", start: [-6, 5], end: [-6, -5], thickness: 0.23, height: 2.7, color: "#f5e6d3", is_exterior: true },
      // Interior walls
      { id: "w5", start: [0, -5], end: [0, 1], thickness: 0.115, height: 2.7, color: "#faf7f2", is_exterior: false },
      { id: "w6", start: [-6, 1], end: [0, 1], thickness: 0.115, height: 2.7, color: "#faf7f2", is_exterior: false },
      { id: "w7", start: [0, 1], end: [6, 1], thickness: 0.115, height: 2.7, color: "#faf7f2", is_exterior: false },
      { id: "w8", start: [-6, -1.5], end: [0, -1.5], thickness: 0.115, height: 2.7, color: "#faf7f2", is_exterior: false },
    ],
    doors: [
      { id: "d1", host_wall_id: "w1", position: [-2, -5], width: 1.0, height: 2.1, color: "#8B4513" }, // Main entrance
      { id: "d2", host_wall_id: "w5", position: [0, -0.5], width: 0.9, height: 2.1, color: "#a0522d" }, // Living to bedroom
      { id: "d3", host_wall_id: "w6", position: [-3, 1], width: 0.9, height: 2.1, color: "#a0522d" }, // Kitchen door
      { id: "d4", host_wall_id: "w7", position: [3, 1], width: 0.9, height: 2.1, color: "#a0522d" }, // Bedroom 2 door
      { id: "d5", host_wall_id: "w8", position: [-3, -1.5], width: 0.8, height: 2.1, color: "#a0522d" }, // Bathroom door
    ],
    windows: [
      { id: "win1", host_wall_id: "w1", position: [3, -5], width: 1.5, sill_height: 0.9, color: "#87CEEB" },
      { id: "win2", host_wall_id: "w2", position: [6, -2], width: 1.5, sill_height: 0.9, color: "#87CEEB" },
      { id: "win3", host_wall_id: "w2", position: [6, 3], width: 1.2, sill_height: 0.9, color: "#87CEEB" },
      { id: "win4", host_wall_id: "w3", position: [-3, 5], width: 1.5, sill_height: 0.9, color: "#87CEEB" },
      { id: "win5", host_wall_id: "w3", position: [3, 5], width: 1.2, sill_height: 0.9, color: "#87CEEB" },
      { id: "win6", host_wall_id: "w4", position: [-6, 3], width: 1.2, sill_height: 0.9, color: "#87CEEB" },
    ],
    rooms: [
      { id: "r1", name: "Living Room", polygon: [[0, -5], [6, -5], [6, 1], [0, 1]], area: 36, floor_color: "#e8d5b7" },
      { id: "r2", name: "Kitchen", polygon: [[-6, -1.5], [0, -1.5], [0, 1], [-6, 1]], area: 15, floor_color: "#c9c9c9" },
      { id: "r3", name: "Bathroom", polygon: [[-6, -5], [0, -5], [0, -1.5], [-6, -1.5]], area: 21, floor_color: "#a8d5e2" },
      { id: "r4", name: "Master Bedroom", polygon: [[-6, 1], [0, 1], [0, 5], [-6, 5]], area: 24, floor_color: "#d4c4a8" },
      { id: "r5", name: "Bedroom 2", polygon: [[0, 1], [6, 1], [6, 5], [0, 5]], area: 24, floor_color: "#dcc9a3" },
    ],
    roof: {
      type: "gable",
      polygon: [[-6.3, -5.3], [6.3, -5.3], [6.3, 5.3], [-6.3, 5.3]],
      height: 1.8,
      base_height: 2.7,
      color: "#a0522d",
    },
    conflicts: [],
  };
}
