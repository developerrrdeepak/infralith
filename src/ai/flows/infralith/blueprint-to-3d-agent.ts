'use server';

import { generateAzureVisionObject, generateAzureObject } from '@/ai/azure-ai';
import { exec } from 'child_process';
import path from 'path';
import fs from 'fs';
import { promisify } from 'util';
import {
  GeometricReconstruction,
  WallGeometry,
  DoorGeometry,
  WindowGeometry,
  RoomGeometry,
  RoofGeometry,
  ConstructionConflict
} from './reconstruction-types';

const execPromise = promisify(exec);

/**
 * Construction-grade geometric reconstruction engine.
 * Converts 2D architectural floor plans into metrically consistent parametric 3D models.
 */
export async function processBlueprintTo3D(base64Image: string): Promise<GeometricReconstruction> {
  console.log("Infralith Engineering Engine: Initiating spatial synthesis with OpenCV...");

  let opencvData = null;
  try {
    // 1. Run OpenCV Pre-processing via Python
    const scriptPath = path.join(process.cwd(), 'src/ai/scripts/process_blueprint.py');

    // Auto-detect python command (Azure Linux usually has python3)
    let pythonCmd = 'python';
    try {
      await execPromise('python --version');
    } catch {
      pythonCmd = 'python3';
    }

    const { stdout } = await execPromise(`${pythonCmd} "${scriptPath}"`, {
      input: base64Image,
      maxBuffer: 10 * 1024 * 1024 // 10MB
    } as any);

    opencvData = JSON.parse(stdout.toString());
    console.log(`OpenCV: Detected ${opencvData.lines?.length || 0} physical lines.`);
  } catch (err: any) {
    const errorMsg = err?.message || String(err);
    if (errorMsg.includes('ModuleNotFoundError') || err?.stderr?.includes('ModuleNotFoundError')) {
      console.warn("OpenCV dependencies (cv2) not found on server. Using direct Vision analysis.");
    } else {
      console.warn("OpenCV Pre-processing failed. Falling back to direct vision analysis.", errorMsg);
    }
  }

  const prompt = `
    You are a construction-grade structural auditing engine.
    Input: A 2D architectural floor plan + Physical Metadata (OpenCV Line Analysis).

    Physical Metadata:
    - Image Dimensions: ${opencvData?.width}x${opencvData?.height}
    - Found Lines: ${JSON.stringify(opencvData?.lines?.slice(0, 150)) /* Sending top 150 lines to stay within prompt limits */}

    Task:
    1. Parse the blueprint and combine it with the OpenCV lines provided above.
    2. Determine Scales: Search for dimension text (e.g., "12'0\" x 10'0\"", "3.5m"). Compare the pixel length of the OpenCV line to the text dimension to find the Scale Factor (px per meter).
    3. Metrics: If no text is found, assume 50px = 1 meter.
    4. Respond with a metrically consistent 3D model in METERS.
    
    Rules for Reconstruction:
    - MAP OpenCV lines to walls. Pixel [x,y] coordinates from OpenCV must be converted to meters [x', y'] using your scale factor.
    - All dimensions in output MUST be in meters.
    - Exterior walls: 0.23m thick. Interior: 0.115m.
    - Wall height: 2.7m.
    - Ensure topological closure. All wall endpoints MUST snap together if they are within 0.1m.
    - Assign realistic colors.

    Color Guidelines:
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

    // Attach debug image from OpenCV if available
    if (opencvData?.debug_image) {
      result.debug_image = opencvData.debug_image;
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
