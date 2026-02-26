'use server';

import {
  getDocumentClient,
  generateAzureVisionObject,
  generateAzureObject,
} from "@/ai/azure-ai";
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
    You are the Infralith Engineering Engine—a world-class architectural auditor and spatial synthesis AI.
    Input: A 2D floor plan + Physical Metadata (OpenCV Line Analysis).

    Physical Metadata:
    - Image Dimensions: ${opencvData?.width}x${opencvData?.height}
    - Found Lines: ${JSON.stringify(opencvData?.lines?.slice(0, 150))}

    STRATEGIC TASK:
    1. SPATIAL SYNTHESIS: Fuse the visual blueprint with OpenCV vector lines. MAP the lines to a 3D parametric coordinate system.
    2. MULTI-FLOOR RECONSTRUCTION:
       - Detect separate floor plan blocks (Ground, Level 1, etc.) often shown side-by-side.
       - IMPORTANT: Calculate a 'Building Core Origin' - i.e., find common vertical elements (stairwells, lift shafts, or external corners) and align every floor's (0,0) to that shared core.
       - Walls on Floor 1 must structurally sit above Walls on Floor 0.
    3. METRIC CLARIFICATION: Search for dimension text (e.g., "12'0\"", "3500mm"). Use these to calculate the exact Scale Factor (Pixels to Meters). If no text is found, default to 50px = 1.0m.
    4. STRUCTURAL AUDIT: Proactively identify 3-5 "Conflicts". Look for:
       - Load-bearing walls with no support on the floor below.
       - Door swings that overlap or hit other objects.
       - Inadequate window-to-floor area ratios in habitable rooms.

    GEOMETRIC CONSTRAINTS:
    - Units: Meters (m).
    - Exterior Walls: 0.23m thick, 2.8m height. Interior: 0.115m thick.
    - Topology: SNAP all adjacent wall endpoints (within 0.15m) to ensure a sealed thermal envelope.
    - Floor Slabs: Every room MUST have a closed polygon forming the floor slab.

    LUXURY AESTHETIC PALETTE:
    - Exterior: "#f8f1e7" (Pearl) or "#dcd7cf" (Warm Stone)
    - Living: "#fdfaf6" (Silk), Master Bed: "#e2d1c3" (Oak)
    - Kitchen: "#efeeed" (Marble), Bath: "#d4e2e2" (Slate)
    - Hardware: "#8b4513" (Walnut) for Doors, "#2c3e50" (Midnight) for Windows.

    THINKING PROCESS:
    - Step 1: Mentally 'trace' the connectivity of all walls in the image.
    - Step 2: Validate that room polygons exactly fill the enclosed spaces.
    - Step 3: If Floor 1 exists, verify it doesn't float; it must have a slab and support.
    - Step 4: If the input is too noisy or contradictory to form a safe structure, return a structural conflict explaining why.

    OUTPUT JSON:
    {
      "building_name": "Project Name",
      "exterior_color": "#hex",
      "walls": [{ "id": "w1", "start": [x,y], "end": [x,y], "thickness": 0.23, "height": 2.8, "color": "#hex", "is_exterior": true, "floor_level": level_index }],
      "doors": [{ "id": "d1", "host_wall_id": "w1", "position": [x,y], "width": 0.9, "height": 2.1, "color": "#hex", "floor_level": level_index }],
      "windows": [{ "id": "win1", "host_wall_id": "w1", "position": [x,y], "width": 1.5, "sill_height": 0.9, "color": "#hex", "floor_level": level_index }],
      "rooms": [{ "id": "r1", "name": "Room Name", "polygon": [[x,y],...], "area": num, "floor_color": "#hex", "floor_level": level_index }],
      "roof": { "type": "flat"|"gable"|"hip", "polygon": [[x,y],...], "height": 1.5, "base_height": total_wall_height, "color": "#hex" },
      "conflicts": [{ "type": "structural"|"safety", "severity": "low"|"medium"|"high", "description": "Audit finding", "location": [x,y] }]
    }
  `;

  try {
    const result = await generateAzureVisionObject<GeometricReconstruction>(prompt, base64Image);
    if (!result || !result.walls || result.walls.length === 0) {
      throw new Error("Engineering Synthesis Failed: AI could not construct a valid geometric structure from the provided blueprint.");
    }

    return {
      ...result,
      debug_image: opencvData?.debug_image,
      is_vision_only: !opencvData?.lines || opencvData.lines.length === 0
    };
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
    You are the Infralith Architect AI—the most advanced architectural modeling engine in existence.
    Your task is to dream up a COMPLETE, REALISTIC, and STRUCTURALLY SOUND parametric 3D building based on the user's description.

    User's Vision: "${description}"

    CORE PRINCIPLES:
    1. METRIC PRECISION: Use real-world dimensions (meters). A standard bedroom is ~12-16 sqm, a foyer is ~4-6 sqm.
    2. TOPOLOGICAL INTEGRITY: All walls must form a 100% closed perimeter. No gaps. 
    3. MULTI-LEVEL LOGIC: If the user asks for multiple floors:
       - Floor 1 walls must be logically placed relative to Floor 0 (e.g., above load-bearing walls).
       - Ensure a consistent (0,0) origin across all levels.
    4. LUXURY FINISHES: Use a premium material palette.

    THINKING PROCESS:
    - Step 1: Conceptualize the floor plan as a living space. 
    - Step 2: Validate that all rooms are accessible via doors.
    - Step 3: Ensure windows are on exterior walls only.
    - Step 4: Verify that Floor 1 overlaps Floor 0 correctly to allow for a staircase.
    - Step 5: Final geometric audit—no intersecting walls or floating objects.

    MATERIAL PALETTE (Use these hex codes):
    - Exterior Walls: "#f8f1e7" (Pearl White)
    - Floors: Living="#fdfaf6", Bed="#e2d1c3", Kitchen="#efeeed", Bath="#d4e2e2"
    - Accents: Doors="#8b4513" (Deep Walnut), Windows="#2c3e50" (Midnight Metal)

    GEOMETRIC REQUIREMENTS:
    - Walls: 0.23m (ext) or 0.115m (int) thick. Height: 2.8m per level.
    - Levels: 0 for Ground, 1 for Upper, etc.
    - Rooms: Every indoor space must be defined by a room polygon.

    OUTPUT JSON:
    {
      "building_name": "Premium Project Name",
      "exterior_color": "#f8f1e7",
      "walls": [{ "id": "w1", "start": [x,y], "end": [x,y], "thickness": 0.23, "height": 2.8, "color": "#hex", "is_exterior": true, "floor_level": 0 }],
      "doors": [{ "id": "d1", "host_wall_id": "w1", "position": [x,y], "width": 1.0, "height": 2.1, "color": "#8b4513", "floor_level": 0 }],
      "windows": [{ "id": "win1", "host_wall_id": "w1", "position": [x,y], "width": 1.8, "sill_height": 0.6, "color": "#2c3e50", "floor_level": 0 }],
      "rooms": [{ "id": "r1", "name": "Space Name", "polygon": [[x,y],...], "area": num, "floor_color": "#hex", "floor_level": 0 }],
      "roof": { "type": "flat"|"gable", "polygon": [[x,y],...], "height": 1.5, "base_height": total_wall_height, "color": "#a0522d" },
      "conflicts": []
    }

    Strict Constraint: Only output the JSON object. No narrative text.
  `;

  try {
    const result = await generateAzureObject<GeometricReconstruction>(prompt);
    if (!result || !result.walls || result.walls.length === 0) {
      throw new Error("Architectural Generation Failed: The AI was unable to dream up a valid structure.");
    }
    return result;
  } catch (e) {
    console.error("Text-to-3D Pipeline Error:", e);
    throw e;
  }
}

// Demo fallback removed for high-integrity production environment.
