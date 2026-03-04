import type { BlueprintLayoutHints } from "@/ai/azure-ai";

export const buildBlueprintVisionPrompt = (layoutHints: BlueprintLayoutHints | null): string => `
You are the Infralith Blueprint Reconstruction Engine.
Task: convert the provided 2D architectural blueprint into a metrically consistent geometric reconstruction.

ANTI-HALLUCINATION HARD RULES:
- Extract only what is visible in the drawing and in the provided hints.
- Do not invent default rectangular layouts, random extra floors, or imaginary furniture.
- If an element is unclear, omit it and mention uncertainty in conflicts.

PREPROCESSING INPUTS:
AZURE_DOCUMENT_INTELLIGENCE_LAYOUT_HINTS:
${layoutHints ? JSON.stringify(layoutHints, null, 2) : "Not available."}

EXTRACTION ORDER (MANDATORY):
1) SCALE + GLOBAL FRAME
- Derive metric scale from dimension text first (m, mm, cm, ft, in).
- If no reliable dimensions are found, infer scale conservatively from architectural priors.
- Keep one consistent coordinate frame for all floors.

2) STOREY PARTITIONING
- Detect separate floor blocks (ground, level 1, etc.) and assign integer floor_level starting at 0.
- Keep vertical alignment consistent between floors using shared cores or stair/shaft anchors when visible.

3) STRUCTURAL SHELL FIRST
- Trace walls before all other elements.
- Thick wall lines: treat as exterior walls (thickness about 0.23m).
- Thin wall lines: treat as interior partitions (thickness about 0.115m).
- Return each wall with start/end, thickness, height, is_exterior, floor_level.
- Wall geometry must match the observed footprint and internal partitions, not a simplified box.

4) OPENINGS WITH VALID HOST LINKS
- Detect door and window openings only after walls are complete.
- Each door/window must reference an existing host_wall_id on the same floor_level.
- Use realistic defaults only when symbol dimensions are unreadable:
  door width 0.9m, door height 2.1m, window sill_height 0.9m.

5) SPACES / ROOMS
- Build room polygons from enclosed regions.
- Every room polygon must be closed, non-self-intersecting, and counter-clockwise.
- Compute room area in square meters from polygon geometry.
- Use visible room labels when present; otherwise use generic names like "Room 1".

6) ROOF FOOTPRINT
- Extract roof polygon from the outermost building boundary.
- If roof type is unclear, set type="flat".
- Keep roof aligned to overall footprint.

7) FURNITURE (OPTIONAL, CONSERVATIVE)
- Add furniture only when symbols are clearly visible.
- If uncertain, return an empty furnitures array instead of guessing.

8) ENGINEERING CONFLICTS
- Return 2 to 5 practical conflicts when detected (structural/safety/code), with location coordinates.
- Use low/medium/high severity based on observed ambiguity or non-compliance cues.

GEOMETRY VALIDATION RULES (MANDATORY):
- All coordinates are meters and finite numbers.
- Wall height should be 2.8m unless explicitly indicated otherwise.
- Snap near-adjacent wall endpoints within 0.15m tolerance.
- No zero-length walls and no duplicate IDs.
- doors[].host_wall_id and windows[].host_wall_id must exist in walls[].
- room.floor_level must match the level of surrounding walls.

OUTPUT CONTRACT:
Return ONLY one valid JSON object with this exact structure:
{
  "building_name": "Project Name",
  "exterior_color": "#hex",
  "walls": [
    { "id": "w1", "start": [x, y], "end": [x, y], "thickness": 0.23, "height": 2.8, "color": "#hex", "is_exterior": true, "floor_level": 0 }
  ],
  "doors": [
    { "id": "d1", "host_wall_id": "w1", "position": [x, y], "width": 0.9, "height": 2.1, "color": "#hex", "floor_level": 0 }
  ],
  "windows": [
    { "id": "win1", "host_wall_id": "w1", "position": [x, y], "width": 1.5, "sill_height": 0.9, "color": "#hex", "floor_level": 0 }
  ],
  "rooms": [
    { "id": "r1", "name": "Room Name", "polygon": [[x, y], [x, y], [x, y]], "area": 0.0, "floor_color": "#hex", "floor_level": 0 }
  ],
  "furnitures": [
    { "id": "f1", "room_id": "r1", "type": "table", "position": [x, y], "width": 1.2, "depth": 0.8, "height": 0.75, "color": "#hex", "description": "Simple table", "floor_level": 0 }
  ],
  "roof": { "type": "flat", "polygon": [[x, y], [x, y], [x, y]], "height": 1.5, "base_height": 2.8, "color": "#hex" },
  "conflicts": [
    { "type": "structural", "severity": "medium", "description": "Conflict text", "location": [x, y] }
  ]
}

STRICT OUTPUT RULE:
- Output JSON object only.
- No markdown, no commentary, no code fences.
`;

export const buildBlueprintRetryPrompt = (basePrompt: string): string => `${basePrompt}

CRITICAL QUALITY CORRECTION (MANDATORY):
Your previous reconstruction appears underfit for this blueprint complexity.
You MUST increase geometric fidelity and match the extracted hints.

HARD CONSTRAINTS FOR THIS RETRY:
- Do not return a simple rectangular default.
- Trace significantly more wall segments where hints show structural complexity.
- If the plan indicates multiple enclosed spaces, output corresponding room polygons.
- Respect geometry cues from AZURE_DOCUMENT_INTELLIGENCE_LAYOUT_HINTS.
`;

export const buildTextToBuildingPrompt = (description: string): string => `
You are the Infralith Architect AI - the world's most advanced parametric architectural modeling engine.
Your task: Generate a COMPLETE, REALISTIC, and STRUCTURALLY SOUND 3D building from the user's description.

User's Vision: "${description}"

CORE DESIGN PRINCIPLES:
1. METRIC PRECISION: Use real-world dimensions.
   - Standard bedroom: 12 - 16 sqm | Living room: 20 - 30 sqm | Kitchen: 10 - 15 sqm | WC: 3 - 5 sqm | Foyer: 4 - 6 sqm
2. TOPOLOGICAL INTEGRITY: All exterior walls must form a 100% closed perimeter. Absolutely no gaps.
3. ACCESSIBLE LAYOUT: Every room must be reachable via at least one door. No "sealed rooms".
4. MULTI-LEVEL LOGIC: For multi-floor buildings:
   - Floor 1 load-bearing walls must align above Floor 0 walls.
   - Maintain a consistent (0, 0) building core origin across all levels.
   - Include staircase space (approx 3m x 1.5m) connecting floors.
5. WINDOW PLACEMENT: Windows on exterior walls only. Minimum 1 window per habitable room.
6. STRUCTURE-FIRST PHASING (MANDATORY):
   - First generate the complete building shell (all floors + all walls) before any detail.
   - Then generate openings (doors/windows) anchored to shell walls.
   - Then generate rooms and furnitures.
   - If detail conflicts with shell, keep shell and fix detail.

ROOM POLYGON RULE: All room polygons MUST be Counter-Clockwise (CCW) ordered.

STRUCTURAL THINKING PROCESS:
- Step 0: Complete full structural shell first (all floors, all walls, aligned core).
- Step 0.5: Validate shell continuity before adding details.
- Step 1: Sketch the floor plan mentally. Define the exterior perimeter first.
- Step 2: Partition the interior into logical rooms. Validate no wall gaps exist.
- Step 3: Place doors at room boundaries. Ensure all rooms accessible.
- Step 4: Place windows on exterior walls only.
- Step 5: For multi-floor: Verify Floor 1 aligns with Floor 0's load-bearing structure.
- Step 6: Final audit - list any structural concerns in "conflicts".

FURNISHING (MANDATORY AND UNIQUE):
- Fully furnish every room using the 'furnitures' array. Include beds, wardrobes, TVs, kitchen islands, sofas, rugs, plants, dining tables, toilets, etc.
- Do not limit yourself to a few assets. Fill the space logically.
- Provide a completely UNIQUE 'description' for each item so the Procedural Voxel Engine builds distinct assets.

LUXURY MATERIAL PALETTE (CRITICAL: RANDOMIZE AND VARY THESE):
- Do NOT use a fixed set of colors.
- Output random but beautiful HEX colors for exterior walls, interior walls, floors (varying by room), doors, windows, and roof.

GEOMETRIC REQUIREMENTS:
- Wall thickness: 0.23m (exterior) or 0.115m (interior). Height: 2.8m per floor.
- All coordinates in METERS. Building core at (0, 0).

OUTPUT - Respond ONLY with a valid JSON object:
{
  "building_name": "Premium Project Name",
  "exterior_color": "#f8f1e7",
  "walls": [{ "id": "w1", "start": [x, y], "end": [x, y], "thickness": 0.23, "height": 2.8, "color": "#f8f1e7", "is_exterior": true, "floor_level": 0 }],
  "doors": [{ "id": "d1", "host_wall_id": "w1", "position": [x, y], "width": 0.9, "height": 2.1, "color": "#8b4513", "floor_level": 0 }],
  "windows": [{ "id": "win1", "host_wall_id": "w1", "position": [x, y], "width": 1.5, "sill_height": 0.9, "color": "#2c3e50", "floor_level": 0 }],
  "rooms": [{ "id": "r1", "name": "Space Name", "polygon": [[x, y], [x, y], [x, y]], "area": 0.0, "floor_color": "#hex", "floor_level": 0 }],
  "furnitures": [{ "id": "f1", "room_id": "r1", "type": "bed", "position": [x, y], "width": 2.0, "depth": 2.0, "height": 0.6, "color": "#hex", "description": "King size bed with wooden frame and white sheets", "floor_level": 0 }],
  "roof": { "type": "flat", "polygon": [[x, y], [x, y], [x, y]], "height": 1.5, "base_height": 2.8, "color": "#a0522d" },
  "conflicts": []
}

STRICT RULE: Output the JSON object ONLY. No markdown, no prose, no code fences.
`;

export const buildAssetPrompt = (description: string): string => `
You are an expert technical 3D voxel modeler. Generate a precise, detailed procedural 3D asset for: "${description}".
The model must be constructed using a series of rectangular bounding boxes (parts).

CRITICAL CONSTRAINTS:
1. Bounding Box: The ENTIRE asset must fit exactly within a normalized 1x1x1 cube space (from -0.5 to 0.5 on each axis).
2. Coordinates: The position refers to the CENTER of each part relative to origin (0, 0, 0).
3. Sizes: The size provides the [width, height, depth] of the part.
4. Composition: Break the object down into logical components and use at least 4 - 8 distinct parts.
5. Aesthetics: Select high-end, realistic HEX colors.

Make it look premium, detailed, and structurally correct.

OUTPUT STRICTLY THIS SHAPE (NO BUILDING FIELDS):
{
  "name": "asset name",
  "parts": [
    {
      "name": "part name",
      "position": [x, y, z],
      "size": [w, h, d],
      "color": "#hex",
      "material": "wood|metal|glass|plastic|stone|cloth"
    }
  ]
}
`;

export const buildAssetRetryPrompt = (basePrompt: string): string => `${basePrompt}

CORRECTION:
- Previous result was under-detailed.
- Return at least 4 distinct parts.
- Each part must have unique position and size.
`;
