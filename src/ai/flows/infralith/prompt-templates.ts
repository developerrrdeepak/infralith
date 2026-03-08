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
Goal: convert a 2D floorplan image into a logical, topologically sound geometric reconstruction for BIM pre-processing.

PRIORITY ORDER:
1) Evidence-backed extraction of walls, spaces, and context.
2) Logical topological relationships (what connects to what).
3) Completeness.

ANTI-HALLUCINATION HARD RULES:
- Use only visible drawing evidence plus provided layout hints.
- Do not invent default box layouts, random extra floors, or speculative furniture.
- If evidence is weak, output fewer elements and add explicit conflicts.
- OCR text-line polygons are NOT wall segments. Treat them as weak text-localization hints only.

INPUT EVIDENCE SUMMARY:
AZURE_DOCUMENT_INTELLIGENCE_LAYOUT_HINTS:
${summarizeLayoutHintsForPrompt(layoutHints)}

DYNAMIC PARAMETERS & GEOMETRIC RELAXATION (MANDATORY):
- DYNAMIC INFERENCE: Do NOT use hardcoded heights or thicknesses. Dynamically infer wall heights, thicknesses, and door dimensions based on the apparent building scale/type (e.g., 2.8m height for residential, 3.6m for commercial).
- RELAXED MATH: You are an architect, not a constraint solver. Provide approximate[x, y] coordinates that define logical placement. Do not attempt perfect trigonometric snapping or strict Counter-Clockwise polygon ordering. The downstream deterministic math engine will post-process, snap endpoints, and order polygons perfectly. Focus strictly on logical relationships.

MANDATORY PIPELINE:
1) NORMALIZE + SCALE + GLOBAL FRAME
- Detect dominant drawing orientation and normalize mentally to a consistent axis.
- Derive scale from readable dimensions first (m, mm, cm, ft, in) and preserve proportional consistency across rooms.
- Keep one global coordinate frame across all floors.

1.5) EVIDENCE WEIGHTING (STRICT)
- Highest confidence: visible wall lines, junctions, and opening symbols.
- Medium confidence: readable dimension annotations and room labels.
- Lowest confidence: OCR text line boxes.

ARCHITECTURAL SEMANTICS:
${buildArchitecturalLineSemanticsReference(options?.lineRecords)}

2) STRUCTURAL GRAPH FIRST
- Identify primary exterior and interior walls. Provide approximate start and end points.
- Preserve non-Manhattan edges when evidence supports them; do not force orthogonality if the building is curved or angled.

3) FLOOR PARTITIONING
- Separate distinct floor blocks and assign integer floor_level from 0.

4) OPENINGS AFTER STABLE WALLS
- Detect doors/windows only after walls are mapped.
- Every opening must reference an existing host_wall_id on the same floor_level.
- Infer realistic dimensions dynamically based on context (e.g., standard door width ~0.9m, but commercial lobbies may be 2.0m).

5) ROOM POLYGONS & FOOTPRINTS
- Outline logical room perimeters using approximate points. (The math engine will close and sort them).
- Derive footprint profile from the outer wall polygon: shape class (compact/elongated/irregular).
- Do NOT collapse L/U/T/courtyard/trapezoid/polygonal footprints into a simple rectangle unless explicitly drawn that way.
- Align room sizes to explicitly parsed dimension text pairs (e.g. 3.5m x 4.2m) when available.

6) ROOF FOOTPRINT
- Set roof polygon based on the outer building shell.
- Infer roof type from footprint profile dynamically (elongated -> likely gable, compact -> likely hip, irregular -> flat).

7) QUALITY GATES & MISSING-INFO IMPUTATION
- All coordinates must be finite numbers in meters.
- No duplicate IDs across elements.
- Infer minimally required elements from topological priors (e.g., at least one entry door, windows for habitable rooms). Keep confidence scores lower (0.25-0.55) for imputed items and document the assumption in a conflict note.

OUTPUT CONTRACT:
Return ONLY one valid JSON object matching exactly this structure:
{
  "meta": {
    "unit": "m|cm|mm|ft|in|unknown",
    "scale_m_per_px": "inferred float",
    "scale_confidence": "float 0-1",
    "rotation_deg": 0,
    "floor_count": "integer"
  },
  "building_name": "Project Name",
  "exterior_color": "#hex",
  "walls": [
    { "id": "w1", "start":[x, y], "end": [x, y], "thickness": "inferred float", "height": "inferred float", "confidence": "float 0-1", "color": "#hex", "is_exterior": true, "floor_level": 0 }
  ],
  "doors":[
    { "id": "d1", "host_wall_id": "w1", "position": [x, y], "width": "inferred float", "height": "inferred float", "swing": "left|right|unknown", "confidence": "float 0-1", "color": "#hex", "floor_level": 0 }
  ],
  "windows":[
    { "id": "win1", "host_wall_id": "w1", "position": [x, y], "width": "inferred float", "sill_height": "inferred float", "confidence": "float 0-1", "color": "#hex", "floor_level": 0 }
  ],
  "rooms":[
    { "id": "r1", "name": "Room Name", "polygon": [[x, y], [x, y], [x, y]], "area": "inferred float", "confidence": "float 0-1", "floor_color": "#hex", "floor_level": 0 }
  ],
  "furnitures":[
    { "id": "f1", "room_id": "r1", "type": "table", "position": [x, y], "width": "inferred float", "depth": "inferred float", "height": "inferred float", "color": "#hex", "description": "Detailed description", "floor_level": 0 }
  ],
  "roof": { "type": "flat|gable|hip", "polygon": [[x, y], [x, y], [x, y]], "height": "inferred float", "base_height": "inferred float", "color": "#hex" },
  "topology_checks": {
    "closed_wall_loops": true,
    "self_intersections": 0,
    "dangling_walls": 0,
    "unhosted_openings": 0,
    "room_polygon_validity_pass": true
  },
  "conflicts":[
    { "type": "structural", "severity": "medium", "description": "Conflict text", "location":[x, y] }
  ]
}

STRICT RULE: Output the JSON object ONLY. No markdown, no prose, no code fences.
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
- Return strictly valid JSON only, same schema as above.
`;

export const buildTextToBuildingPrompt = (description: string): string => `
You are the Infralith Architect AI - the world's most advanced parametric architectural modeling engine.
Your task: Generate a COMPLETE, REALISTIC, and STRUCTURALLY SOUND 3D building from the user's description.

User's Vision: "${description}"

CORE DESIGN PRINCIPLES:
1. METRIC PRECISION: Use real-world dimensions.
   - Standard bedroom: 12 - 16 sqm | Living room: 20 - 30 sqm | Kitchen: 10 - 15 sqm | WC: 3 - 5 sqm | Foyer: 4 - 6 sqm
2. TOPOLOGICAL INTEGRITY: Design a logical exterior shell. Provide approximate [x,y] coordinates; the downstream CAD engine will perfectly snap endpoints, so focus on logical relative placement.
3. ACCESSIBLE LAYOUT: Every room must be reachable via at least one door. No "sealed rooms".
4. MULTI-LEVEL LOGIC: For multi-floor buildings:
   - Floor 1 load-bearing walls must align roughly above Floor 0 walls.
   - Maintain a consistent (0, 0) building core origin across all levels.
   - Include staircase space (approx 3m x 1.5m) connecting floors.
5. WINDOW PLACEMENT: Windows on exterior walls only. Minimum 1 window per habitable room.

GEOMETRIC REQUIREMENTS (DYNAMIC):
- Do not use hardcoded values. Infer dimensions dynamically based on the described building type (e.g., exterior residential walls ~0.2m, commercial ~0.3m. Heights ~2.8m residential, ~3.6m commercial).
- ROOM POLYGONS: Provide logical corner points in any order. The engine will auto-sort the winding order and close gaps.
- All coordinates in METERS. Building core at (0, 0).

FURNISHING (MANDATORY AND UNIQUE):
- Fully furnish every room using the 'furnitures' array. Include beds, wardrobes, TVs, kitchen islands, sofas, rugs, plants, dining tables, toilets, etc.
- Do not limit yourself to a few assets. Fill the space logically.
- Provide a completely UNIQUE 'description' for each item so the Procedural Voxel Engine builds distinct assets.

LUXURY MATERIAL PALETTE (CRITICAL: RANDOMIZE AND VARY THESE):
- Output random but beautiful HEX colors for exterior walls, interior walls, floors (varying by room), doors, windows, and roof.

OUTPUT - Respond ONLY with a valid JSON object:
{
  "building_name": "Premium Project Name",
  "exterior_color": "#f8f1e7",
  "walls": [{ "id": "w1", "start": [x, y], "end": [x, y], "thickness": "inferred float", "height": "inferred float", "color": "#f8f1e7", "is_exterior": true, "floor_level": 0 }],
  "doors":[{ "id": "d1", "host_wall_id": "w1", "position": [x, y], "width": "inferred float", "height": "inferred float", "color": "#8b4513", "floor_level": 0 }],
  "windows": [{ "id": "win1", "host_wall_id": "w1", "position":[x, y], "width": "inferred float", "sill_height": "inferred float", "color": "#2c3e50", "floor_level": 0 }],
  "rooms":[{ "id": "r1", "name": "Space Name", "polygon": [[x, y],[x, y], [x, y]], "area": "inferred float", "floor_color": "#hex", "floor_level": 0 }],
  "furnitures":[{ "id": "f1", "room_id": "r1", "type": "bed", "position": [x, y], "width": 2.0, "depth": 2.0, "height": 0.6, "color": "#hex", "description": "King size bed with wooden frame and white sheets", "floor_level": 0 }],
  "roof": { "type": "flat|gable|hip", "polygon": [[x, y], [x, y], [x, y]], "height": "inferred float", "base_height": "inferred float", "color": "#a0522d" },
  "conflicts":[]
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
      "position":[x, y, z],
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