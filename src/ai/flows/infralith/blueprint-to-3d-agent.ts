'use server';

import {
  generateAzureVisionObject,
  generateAzureObject,
} from "@/ai/azure-ai";
import {
  GeometricReconstruction,
  AIAsset,
} from './reconstruction-types';
import { applyBuildingCodes } from './building-codes';
import { z } from 'zod';

export const AIAssetSchema = z.object({
  name: z.string(),
  parts: z.array(z.object({
    name: z.string(),
    position: z.array(z.number()),
    size: z.array(z.number()),
    color: z.string(),
    material: z.enum(['wood', 'metal', 'glass', 'plastic', 'stone', 'cloth'])
  }))
});

/**
 * Construction-grade geometric reconstruction engine.
 * Converts 2D architectural floor plans into metrically consistent parametric 3D models.
 * Uses Azure OpenAI GPT-4o Vision to process base64 encoded blueprint images.
 */
export async function processBlueprintTo3D(imageUrl: string): Promise<GeometricReconstruction> {
  console.log("[Infralith Vision Engine] Routing blueprint to Azure OpenAI Vision...");

  const prompt = `
    You are the Infralith Engineering Engine—a world-class architectural auditor and spatial synthesis AI powered by advanced computer vision.
    You will analyze the provided 2D architectural floor plan image with the precision of a licensed structural engineer.

    CORE VISION ANALYSIS PROTOCOL:
    1. VISUAL WALL TRACING: Scan the image systematically. Identify every dark continuous line segment as a wall.
       - Thick lines = Exterior walls (0.23m thickness)
       - Thin lines = Interior partition walls (0.115m thickness)
       - Trace each wall's start and end coordinates in METERS using the image as a reference plane.

    2. STRATEGIC DIMENSION EXTRACTION:
       - ANCHOR SEARCH: Locate any numeric labels (e.g., "4.5m", "12'0\"", "3600mm"). Use these as ground-truth anchors to set the global Scale Factor.
       - CONTEXTUAL VALIDATION: If a room label reads "Master Bed (4.5m x 3.8m)", ENFORCE those values as absolute truth.
       - BLUR MITIGATION: If text is unreadable, reverse-engineer the scale from "Standard Architectural Ratios":
         * Standard interior door = 0.9m wide
         * Kitchen counter depth = 0.6m
         * Standard staircase width = 1.2m

    3. MULTI-FLOOR RECONSTRUCTION:
       - BUILDING CORE ORIGIN: Identify shared vertical shafts (stairs, lift shafts, or prominent structural corners) visible across all floor blocks.
       - ALIGNMENT: Assign these core anchors to coordinate (0, 0). All other walls are positioned relative to this origin.
       - VERTICAL STACKING: If the image contains multiple floor plan blocks (Ground + Level 1, etc.), stack them by floor_level (0, 1, 2...).
       - STRUCTURAL INTEGRITY CHECK: Flag any upper-floor walls that lack a supporting wall directly below within 0.15m tolerance.

    4. OPENING DETECTION:
       - DOORS: Look for gaps in walls with arc symbols (door swing). Record host_wall_id, center position, width (default 0.9m), height (2.1m).
       - WINDOWS: Look for triple-line symbols in exterior walls. Record host_wall_id, position, width, sill_height (default 0.9m).

    5. ROOM IDENTIFICATION:
       - For each enclosed space, construct a closed COUNTER-CLOCKWISE polygon of (x, y) points.
       - Calculate the enclosed area in square meters.
       - Assign room names from visible labels (e.g., "Bedroom", "Kitchen", "WC").

    LUXURY AESTHETIC PALETTE (apply intelligently):
    - Exterior Walls: "#f8f1e7" (Pearl) | Interior Walls: "#fdfaf6" (Silk)
    - Floors: Living="#fdfaf6", Bedroom="#e2d1c3", Kitchen="#efeeed", Bathroom="#d4e2e2"
    - Doors: "#8b4513" (Deep Walnut) | Windows: "#2c3e50" (Midnight Metal)
    - Roof: "#a0522d" (Terracotta)

    GEOMETRIC CONSTRAINTS (strictly enforce):
    - All coordinates in METERS.
    - Wall height: 2.8m per floor level.
    - SNAP all adjacent wall endpoints within 0.15m to nearest shared point.
    - Every room MUST have a fully closed polygon forming its floor slab.
    - Room polygons MUST be Counter-Clockwise (CCW) ordered to prevent "bow-tie" rendering in Three.js.

    THINKING PROCESS (reason step-by-step before generating output):
    - Step 1: Identify the scale factor from dimension labels or standard ratios.
    - Step 2: Trace all wall segments from the image and convert to metric coordinates.
    - Step 3: Detect all door and window openings. Link each to its host wall.
    - Step 4: Define all enclosed room polygons in CCW order.
    - Step 5: Validate the building core alignment across all floors.
    - Step 6: Perform a structural audit. Generate 2-5 specific, actionable conflict reports.

    OUTPUT — Respond ONLY with a valid JSON object matching this schema exactly:
    {
      "building_name": "Descriptive project name from blueprint title block (or inferred)",
      "exterior_color": "#hex",
      "walls": [{ "id": "w1", "start": [x, y], "end": [x, y], "thickness": 0.23, "height": 2.8, "color": "#hex", "is_exterior": true, "floor_level": 0 }],
      "doors": [{ "id": "d1", "host_wall_id": "w1", "position": [x, y], "width": 0.9, "height": 2.1, "color": "#8b4513", "floor_level": 0 }],
      "windows": [{ "id": "win1", "host_wall_id": "w1", "position": [x, y], "width": 1.5, "sill_height": 0.9, "color": "#2c3e50", "floor_level": 0 }],
      "rooms": [{ "id": "r1", "name": "Room Name", "polygon": [[x, y], ...], "area": 0.0, "floor_color": "#hex", "floor_level": 0 }],
      "roof": { "type": "flat", "polygon": [[x, y], ...], "height": 1.5, "base_height": 2.8, "color": "#a0522d" },
      "conflicts": [{ "type": "structural", "severity": "high", "description": "Specific engineering finding.", "location": [x, y] }]
    }

    STRICT RULE: Output the JSON object ONLY. No markdown, no prose, no code fences.
  `;

  try {
    const result = await generateAzureVisionObject<GeometricReconstruction>(prompt, imageUrl);
    if (!result || !result.walls || result.walls.length === 0) {
      throw new Error("Engineering Synthesis Failed: GPT-4o Vision could not construct a valid geometric structure from the provided blueprint. Please ensure the image is a clear architectural floor plan.");
    }

    // Apply strict deterministic architectural building code checks
    const validatedResult = applyBuildingCodes(result);

    return {
      ...validatedResult,
      is_vision_only: true
    };
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
  console.log("[Infralith Architect Engine] Generating parametric building from description...");

  const prompt = `
    You are the Infralith Architect AI—the world's most advanced parametric architectural modeling engine.
    Your task: Generate a COMPLETE, REALISTIC, and STRUCTURALLY SOUND 3D building from the user's description.

    User's Vision: "${description}"

    CORE DESIGN PRINCIPLES:
    1. METRIC PRECISION: Use real-world dimensions.
       - Standard bedroom: 12-16 sqm | Living room: 20-30 sqm | Kitchen: 10-15 sqm | WC: 3-5 sqm | Foyer: 4-6 sqm
    2. TOPOLOGICAL INTEGRITY: All exterior walls must form a 100% closed perimeter. Absolutely no gaps.
    3. ACCESSIBLE LAYOUT: Every room must be reachable via at least one door. No "sealed rooms".
    4. MULTI-LEVEL LOGIC: For multi-floor buildings:
       - Floor 1 load-bearing walls must align above Floor 0 walls.
       - Maintain a consistent (0, 0) building core origin across all levels.
       - Include staircase space (approx 3m x 1.5m) connecting floors.
    5. WINDOW PLACEMENT: Windows on exterior walls only. Minimum 1 window per habitable room.

    ROOM POLYGON RULE: All room polygons MUST be Counter-Clockwise (CCW) ordered.

    STRUCTURAL THINKING PROCESS:
    - Step 1: Sketch the floor plan mentally. Define the exterior perimeter first.
    - Step 2: Partition the interior into logical rooms. Validate no wall gaps exist.
    - Step 3: Place doors at room boundaries. Ensure all rooms accessible.
    - Step 4: Place windows on exterior walls only.
    - Step 5: For multi-floor: Verify Floor 1 aligns with Floor 0's load-bearing structure.
    - Step 6: Final audit — list any structural concerns in "conflicts".

    LUXURY MATERIAL PALETTE:
    - Exterior Walls: "#f8f1e7" (Pearl White) | Interior: "#fdfaf6" (Silk)
    - Floors: Living="#fdfaf6", Bedroom="#e2d1c3", Kitchen="#efeeed", Bathroom="#d4e2e2"
    - Doors: "#8b4513" (Deep Walnut) | Windows: "#2c3e50" (Midnight Metal) | Roof: "#a0522d"

    GEOMETRIC REQUIREMENTS:
    - Wall thickness: 0.23m (exterior) or 0.115m (interior). Height: 2.8m per floor.
    - All coordinates in METERS. Building core at (0, 0).

    OUTPUT — Respond ONLY with a valid JSON object:
    {
      "building_name": "Premium Project Name",
      "exterior_color": "#f8f1e7",
      "walls": [{ "id": "w1", "start": [x, y], "end": [x, y], "thickness": 0.23, "height": 2.8, "color": "#f8f1e7", "is_exterior": true, "floor_level": 0 }],
      "doors": [{ "id": "d1", "host_wall_id": "w1", "position": [x, y], "width": 0.9, "height": 2.1, "color": "#8b4513", "floor_level": 0 }],
      "windows": [{ "id": "win1", "host_wall_id": "w1", "position": [x, y], "width": 1.5, "sill_height": 0.9, "color": "#2c3e50", "floor_level": 0 }],
      "rooms": [{ "id": "r1", "name": "Space Name", "polygon": [[x, y], ...], "area": 0.0, "floor_color": "#hex", "floor_level": 0 }],
      "roof": { "type": "flat", "polygon": [[x, y], ...], "height": 1.5, "base_height": 2.8, "color": "#a0522d" },
      "conflicts": []
    }

    STRICT RULE: Output the JSON object ONLY. No markdown, no prose, no code fences.
  `;

  try {
    const result = await generateAzureObject<GeometricReconstruction>(prompt);
    if (!result || !result.walls || result.walls.length === 0) {
      throw new Error("Architectural Generation Failed: The AI was unable to synthesize a valid structure from the given description.");
    }
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
  console.log(`[Procedural Voxel Engine] Generating asset: ${description}`);

  const prompt = `
    You are an expert technical 3D voxel modeler. Generate a precise, detailed procedural 3D asset for: "${description}".
    The model must be constructed using a series of rectangular rectangular bounding boxes (parts).

    CRITICAL CONSTRAINTS:
    1. Bounding Box: The ENTIRE asset must fit exactly within a normalized 1x1x1 cube space (from -0.5 to 0.5 on each axis).
    2. Coordinates: The position refers to the CENTER of the part relative to origin (0, 0, 0).
    3. Sizes: The size provides the [width, height, depth] of the part.
    4. Composition: Break the object down into logical components (e.g. for a door: the outer frame, inner door leaf, middle window, door handle, hinges). Use at least 4-8 distinct parts for "enterprise" level detail.
    5. Aesthetics: Select high-end, realistic HEX colors.

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
