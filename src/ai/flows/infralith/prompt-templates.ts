import type { BlueprintLayoutHints } from "@/ai/azure-ai";
import type { BlueprintLineRecord } from "./blueprint-line-database";
import { buildArchitecturalLineSemanticsReference } from "./architectural-line-semantics";

const PROMPT_DIMENSION_ANCHOR_LIMIT = 24;
const PROMPT_LINE_BBOX_LIMIT = 48;
const PROMPT_LINE_TEXT_LIMIT = 22;
const PROMPT_FLOOR_LABEL_LIMIT = 10;
const PROMPT_SEMANTIC_ANCHOR_LIMIT = 24;

const toFinite = (value: unknown): number | null => {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

const polygonToBoundingBox = (polygon: number[] | null | undefined): [number, number, number, number] | null => {
  if (!Array.isArray(polygon) || polygon.length < 6) return null;
  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = 0; i < polygon.length - 1; i += 2) {
    const x = toFinite(polygon[i]);
    const y = toFinite(polygon[i + 1]);
    if (x == null || y == null) continue;
    xs.push(x);
    ys.push(y);
  }
  if (xs.length === 0 || ys.length === 0) return null;
  return [
    Number(Math.min(...xs).toFixed(2)),
    Number(Math.min(...ys).toFixed(2)),
    Number(Math.max(...xs).toFixed(2)),
    Number(Math.max(...ys).toFixed(2)),
  ];
};

const parseDimensionTextToMeters = (value: unknown): number | null => {
  const raw = String(value || '').toLowerCase().replace(/,/g, ' ').trim();
  if (!raw) return null;

  const feetInches = raw.match(/(\d+(?:\.\d+)?)\s*'\s*(\d+(?:\.\d+)?)?/);
  if (feetInches) {
    const feet = Number(feetInches[1] || 0);
    const inches = Number(feetInches[2] || 0);
    const meters = (feet * 0.3048) + (inches * 0.0254);
    return Number.isFinite(meters) && meters > 0 ? Number(meters.toFixed(3)) : null;
  }

  const numeric = raw.match(/-?\d+(?:\.\d+)?/);
  if (!numeric) return null;
  const n = Number(numeric[0]);
  if (!Number.isFinite(n) || n <= 0) return null;

  let meters = n;
  if (/\bmm\b/.test(raw)) meters = n / 1000;
  else if (/\bcm\b/.test(raw)) meters = n / 100;
  else if (/\b(ft|feet|foot)\b|\'/.test(raw)) meters = n * 0.3048;
  else if (/\b(in|inch|inches)\b|\"/.test(raw)) meters = n * 0.0254;

  return Number.isFinite(meters) && meters > 0 ? Number(meters.toFixed(3)) : null;
};

const summarizeLayoutHintsForPrompt = (layoutHints: BlueprintLayoutHints | null) => {
  if (!layoutHints) return "Not available.";

  const pageSummary = (layoutHints.pages || []).map((page) => ({
    pageNumber: page.pageNumber,
    width: Number((page.width || 0).toFixed(2)),
    height: Number((page.height || 0).toFixed(2)),
    unit: page.unit || "pixel",
    lineCount: page.lineCount || 0,
    wordCount: page.wordCount || 0,
  }));

  const dimensionAnchors = (layoutHints.dimensionAnchors || [])
    .slice(0, PROMPT_DIMENSION_ANCHOR_LIMIT)
    .map((anchor) => ({
      text: String(anchor?.text || "").slice(0, 80),
      meters_estimate: parseDimensionTextToMeters(anchor?.text),
      bbox: polygonToBoundingBox(anchor?.polygon || []),
    }))
    .filter((anchor) => Array.isArray(anchor.bbox));

  const lineBBoxes = (layoutHints.linePolygons || [])
    .slice(0, PROMPT_LINE_BBOX_LIMIT)
    .map((polygon) => polygonToBoundingBox(polygon))
    .filter((bbox): bbox is [number, number, number, number] => Array.isArray(bbox));

  const lineTexts = (layoutHints.lineTexts || [])
    .map((text) => String(text || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .slice(0, PROMPT_LINE_TEXT_LIMIT);

  const floorLabels = (layoutHints.floorLabelAnchors || [])
    .slice(0, PROMPT_FLOOR_LABEL_LIMIT)
    .map((anchor) => ({
      text: String(anchor?.text || '').slice(0, 64),
      bbox: polygonToBoundingBox(anchor?.polygon || []),
    }))
    .filter((entry) => Array.isArray(entry.bbox));

  const semanticAnchors = (layoutHints.semanticAnchors || [])
    .slice(0, PROMPT_SEMANTIC_ANCHOR_LIMIT)
    .map((anchor) => ({
      text: String(anchor?.text || '').slice(0, 96),
      bbox: polygonToBoundingBox(anchor?.polygon || []),
    }))
    .filter((entry) => Array.isArray(entry.bbox));

  return JSON.stringify({
    caveat: "OCR line polygons are text-location boxes and are not wall vectors.",
    pageCount: layoutHints.pageCount || pageSummary.length,
    pages: pageSummary,
    ocrTextLineBoxCount: layoutHints.linePolygons?.length || 0,
    sampledOcrTextLineBBoxes: lineBBoxes,
    sampledLineTexts: lineTexts,
    dimensionAnchorCount: layoutHints.dimensionAnchors?.length || 0,
    sampledDimensionAnchors: dimensionAnchors,
    floorLabelAnchorCount: layoutHints.floorLabelAnchors?.length || 0,
    sampledFloorLabelAnchors: floorLabels,
    semanticAnchorCount: layoutHints.semanticAnchors?.length || 0,
    sampledSemanticAnchors: semanticAnchors,
  }, null, 2);
};

export const buildBlueprintVisionPrompt = (
  layoutHints: BlueprintLayoutHints | null,
  options?: {
    lineRecords?: BlueprintLineRecord[];
  }
): string => `
You are Infralith Blueprint Reconstruction Engine v7.
Goal: convert a 2D floorplan image into a metrically consistent, topologically valid geometric reconstruction for BIM pre-processing.

PRIORITY ORDER:
1) Geometric correctness and topology validity.
2) Evidence-backed extraction.
3) Completeness.

ANTI-HALLUCINATION HARD RULES:
- Use only visible drawing evidence plus provided layout hints.
- Do not invent default box layouts, random extra floors, or speculative furniture.
- If evidence is weak, output fewer elements and add explicit conflicts.
- Prefer "unknown by omission" over wrong geometry.
- OCR text-line polygons are NOT wall segments. Treat them as weak text-localization hints only.
- If the sheet mixes floor plans with elevation views, title blocks, area schedules, legends, or project metadata, reconstruct ONLY the actual floor-plan views.
- Ignore facade/elevation artwork, schedule tables, and text blocks such as level summaries unless they directly localize a floor-plan block.

INPUT EVIDENCE SUMMARY:
AZURE_DOCUMENT_INTELLIGENCE_LAYOUT_HINTS:
${summarizeLayoutHintsForPrompt(layoutHints)}

RESEARCH-INFORMED STRATEGY (MANDATORY):
- Graph-first vectorization: infer junctions and wall edges before semantic room naming.
- Coarse-to-fine reconstruction: first outer shell and major partitions, then local walls/openings.
- Topology constraints over raw pixel heuristics: keep planarity, closed loops, and host-linked openings.
- Semantic assignment after geometry: attach room names only after enclosed polygons are stable.

MANDATORY PIPELINE:
1) NORMALIZE + SCALE + GLOBAL FRAME
- Detect dominant drawing orientation and normalize mentally to a consistent axis.
- Derive scale from readable dimensions first (m, mm, cm, ft, in) and preserve proportional consistency across rooms.
- If scale is inferred from priors, keep geometry conservative and add a scale-related conflict.
- Keep one global coordinate frame across all floors.
- When multiple plan blocks exist on one sheet, separate them by plan-block evidence rather than treating the whole page as one monolithic floor.

1.5) EVIDENCE WEIGHTING (STRICT)
- Highest confidence: visible wall lines, junctions, and opening symbols.
- Medium confidence: readable dimension annotations and room labels.
- Lowest confidence: OCR text line boxes (text layout only, not wall geometry).
- Never promote low-confidence text layout hints over clear drawing geometry.

ARCHITECTURAL SEMANTICS (MANDATORY):
${buildArchitecturalLineSemanticsReference(options?.lineRecords)}

2) STRUCTURAL GRAPH FIRST (JUNCTION -> EDGE -> WALL)
- Detect wall junction candidates and wall edge candidates first.
- Build walls from the graph, then snap near-junction endpoints within 0.15m.
- Preserve non-Manhattan edges when evidence supports them; do not force orthogonality.
- Remove duplicates, zero-length edges, and obvious overlaps.
- If two candidate wall paths conflict, prefer the one that preserves larger closed regions and fewer dangling segments.

3) FLOOR PARTITIONING
- Separate distinct floor blocks and assign integer floor_level from 0.
- Keep floor-local geometry consistent in a shared global frame.
- If vertical alignment between floors is uncertain, add conflict instead of guessing hidden structure.

4) OPENINGS AFTER STABLE WALLS
- Detect doors/windows only after walls are stable.
- Every opening must reference an existing host_wall_id on the same floor_level.
- If host wall is ambiguous, omit opening and record conflict.
- Use conservative defaults only if symbol is clearly detected but size text is unreadable:
  door width 0.9m, door height 2.1m, window sill_height 0.9m.
- If door/window text labels are missing, still infer openings from wall-gap + symbol topology; mark low confidence instead of dropping all openings.

5) ROOM POLYGONS
- Build room polygons only from enclosed wall regions.
- Room polygons must be closed, non-self-intersecting, and counter-clockwise.
- Compute room area from polygon geometry (m^2).
- Use visible labels when available; otherwise use deterministic names ("Room 1", "Room 2", ...).
- Keep one room polygon per enclosed region unless explicit evidence shows sub-partitions.
- If room dimension annotations are visible (e.g., 12'x14', 3.5m x 4.2m), align room polygon width/depth and location to those annotations.
- Avoid cloning uniform room-size grids across floors unless the blueprint explicitly shows identical partitions.

5.5) FOOTPRINT + AREA ADAPTATION (MANDATORY)
- Derive footprint profile from outer wall polygon: shape class (compact/elongated/irregular) and usable area.
- Room count and room-size distribution MUST scale with footprint area; do not reuse a fixed template split.
- For elongated footprints, preserve linear zoning/circulation and avoid forcing square room clusters.
- For compact footprints, avoid excessive corridor-heavy partitioning.
- For irregular/non-Manhattan footprints, preserve boundary character and fit room polygons to that geometry.
- Do NOT collapse L/U/T/courtyard/trapezoid/polygonal footprints into a cuboid or simple rectangle unless the drawing is explicitly rectangular.

6) ROOF FOOTPRINT
- Set roof polygon from the outer building shell.
- Keep roof aligned with shell geometry.
- If roof type is unclear, infer from footprint profile (elongated -> likely gable, compact-medium/large -> likely hip, irregular -> flat).

7) FURNITURE POLICY
- Furniture is optional and conservative.
- Include only clearly observed furniture; otherwise return an empty furnitures array.

8) QUALITY GATES (MANDATORY)
- All coordinates must be finite numbers in meters.
- No duplicate IDs across walls/doors/windows/rooms/furnitures.
- No dangling zero-length walls.
- All doors/windows must have valid host_wall_id.
- Emit confidence in [0,1] for walls, doors, windows, and rooms when estimable.
- If dimension anchors are present, avoid trivial single-rectangle fallback unless evidence is truly rectangular.
- If room-level dimension pairs are detected, enforce room size/position alignment to those annotations or add explicit conflict.
- If floor labels suggest multi-floor content, set floor levels consistently or emit explicit high-severity conflict.
- Prefer explicit conflict over geometric guessing when OCR text and drawing lines disagree.
- If any major gate is uncertain or fails, add conflict with precise location.

8.5) MISSING-INFO IMPUTATION POLICY (MANDATORY)
- Blueprint may omit labels/dimensions for many elements. Do not collapse to empty details by default.
- Infer minimally required architectural elements from geometry/topology priors:
  at least one entry door per floor shell where boundary transitions imply access,
  windows on exterior walls for habitable rooms when strong wall-span evidence exists,
  staircase/vertical circulation cues for clear multi-floor layouts.
- Any imputed element must carry lower confidence (typically 0.25-0.55) and preserve host-wall/topology validity.
- For each imputation cluster, add a concise conflict note documenting assumption source ("inferred from topology/symbol geometry due to missing annotation").

9) CONFLICTS
- Conflicts must use type in {"structural","safety","code"} and severity in {"low","medium","high"}.
- Include concise, actionable descriptions tied to uncertainty, topology, or scale reliability.

OUTPUT CONTRACT:
Return ONLY one valid JSON object matching exactly this structure:
{
  "meta": {
    "unit": "m|cm|mm|ft|in|unknown",
    "scale_m_per_px": 0.001,
    "scale_confidence": 0.0,
    "rotation_deg": 0,
    "floor_count": 1
  },
  "building_name": "Project Name",
  "exterior_color": "#hex",
  "walls": [
    { "id": "w1", "start": [x, y], "end": [x, y], "thickness": 0.23, "height": 2.8, "confidence": 0.0, "color": "#hex", "is_exterior": true, "floor_level": 0 }
  ],
  "doors": [
    { "id": "d1", "host_wall_id": "w1", "position": [x, y], "width": 0.9, "height": 2.1, "swing": "left|right|unknown", "confidence": 0.0, "color": "#hex", "floor_level": 0 }
  ],
  "windows": [
    { "id": "win1", "host_wall_id": "w1", "position": [x, y], "width": 1.5, "sill_height": 0.9, "confidence": 0.0, "color": "#hex", "floor_level": 0 }
  ],
  "rooms": [
    { "id": "r1", "name": "Room Name", "polygon": [[x, y], [x, y], [x, y]], "area": 0.0, "confidence": 0.0, "floor_color": "#hex", "floor_level": 0 }
  ],
  "furnitures": [
    { "id": "f1", "room_id": "r1", "type": "table", "position": [x, y], "width": 1.2, "depth": 0.8, "height": 0.75, "color": "#hex", "description": "Simple table", "floor_level": 0 }
  ],
  "roof": { "type": "flat", "polygon": [[x, y], [x, y], [x, y]], "height": 1.5, "base_height": 2.8, "color": "#hex" },
  "topology_checks": {
    "closed_wall_loops": true,
    "self_intersections": 0,
    "dangling_walls": 0,
    "unhosted_openings": 0,
    "room_polygon_validity_pass": true
  },
  "conflicts": [
    { "type": "structural", "severity": "medium", "description": "Conflict text", "location": [x, y] }
  ]
}

STRICT OUTPUT RULE:
- Output JSON object only.
- No markdown, no commentary, no code fences.
`;

export const buildBlueprintRetryPrompt = (basePrompt: string, diagnostics: string[] = []): string => `${basePrompt}

CRITICAL QUALITY RECOVERY (MANDATORY):
Previous result appears underfit or topologically weak.
Regenerate with higher structural fidelity while staying evidence-bound.

RETRY DIAGNOSTICS FROM PREVIOUS OUTPUT:
${diagnostics.length > 0
    ? diagnostics.map((item, index) => `${index + 1}. ${item}`).join('\n')
    : '1. Previous output was structurally underfit against available blueprint evidence.'}

RETRY HARD GATES:
- Do not collapse to a simple rectangle unless evidence is truly rectangular.
- Increase wall segmentation where line evidence indicates additional junctions/partitions.
- Ensure every detected enclosed region becomes a valid room polygon or an explicit conflict.
- Recheck door/window host_wall_id integrity and remove uncertain openings.
- Keep non-Manhattan edges where supported.
- If scale is uncertain, keep geometry conservative and emit a conflict.
- Return strictly valid JSON only, same schema as above.
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
