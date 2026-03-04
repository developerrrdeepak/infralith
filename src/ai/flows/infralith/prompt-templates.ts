import type { BlueprintLayoutHints } from "@/ai/azure-ai";

const PROMPT_DIMENSION_ANCHOR_LIMIT = 24;
const PROMPT_LINE_BBOX_LIMIT = 48;
const PROMPT_LINE_TEXT_LIMIT = 48;

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

const FLOOR_LABEL_PATTERNS: Array<{ key: string; regex: RegExp; floorKey?: string; }> = [
  { key: "BASEMENT", regex: /\b(basement|cellar|lower\s*ground|b\/?f)\b/i, floorKey: "L-1" },
  { key: "STILT", regex: /\b(stilt\s*floor)\b/i, floorKey: "L0" },
  { key: "GROUND", regex: /\b(ground\s*floor|ground\b|g\/?f\b)\b/i, floorKey: "L0" },
  { key: "FIRST", regex: /\b(first\s*floor|1st\s*floor|ff\b|f\/?f\b)\b/i, floorKey: "L1" },
  { key: "SECOND", regex: /\b(second\s*floor|2nd\s*floor)\b/i, floorKey: "L2" },
  { key: "THIRD", regex: /\b(third\s*floor|3rd\s*floor)\b/i, floorKey: "L3" },
  { key: "FOURTH", regex: /\b(fourth\s*floor|4th\s*floor)\b/i, floorKey: "L4" },
  { key: "TERRACE", regex: /\b(terrace\s*floor|roof\s*floor|terrace\b)\b/i },
];

const FLOOR_LEVEL_CAPTURE_PATTERNS: RegExp[] = [
  /\b(?:level|lvl|floor|flr|storey|story)\s*[-_:]?\s*([a-z0-9]+)\b/gi,
  /\b([a-z0-9]+)\s*(?:level|lvl|floor|flr|storey|story)\b/gi,
  /\b(?:l|f)\s*[-_:]?\s*(\d{1,2})\b/gi,
];

const ROMAN_TO_INT: Record<string, number> = {
  i: 1,
  ii: 2,
  iii: 3,
  iv: 4,
  v: 5,
  vi: 6,
  vii: 7,
  viii: 8,
  ix: 9,
  x: 10,
};

const parseFloorToken = (tokenRaw: string): string | null => {
  const token = String(tokenRaw || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9+-]/g, "");
  if (!token) return null;
  if (token === "g" || token === "gf" || token === "ground") return "L0";
  if (token === "b" || token === "bf" || token === "basement" || token === "cellar") return "L-1";
  const roman = ROMAN_TO_INT[token];
  if (Number.isFinite(roman)) return `L${roman}`;
  const numeric = Number(token);
  if (Number.isFinite(numeric) && numeric >= -3 && numeric <= 30) return `L${Math.trunc(numeric)}`;
  return null;
};

const collectFloorKeysFromText = (rawText: string): string[] => {
  const text = String(rawText || "").replace(/\s+/g, " ").trim();
  if (!text) return [];
  const detected = new Set<string>();
  for (const pattern of FLOOR_LABEL_PATTERNS) {
    if (pattern.regex.test(text)) detected.add(pattern.floorKey || pattern.key);
  }
  for (const baseRegex of FLOOR_LEVEL_CAPTURE_PATTERNS) {
    const regex = new RegExp(baseRegex.source, baseRegex.flags);
    for (const match of text.matchAll(regex)) {
      const floorKey = parseFloorToken(match?.[1] || "");
      if (floorKey) detected.add(floorKey);
    }
  }
  return [...detected];
};

const inferFloorLabelsFromHints = (layoutHints: BlueprintLayoutHints | null): string[] => {
  if (!layoutHints) return [];
  const sourceTexts = [
    ...(layoutHints.lineTexts || []),
    ...(layoutHints.dimensionAnchors || []).map((anchor) => String(anchor?.text || "")),
  ];
  const detected = new Set<string>();
  for (const rawText of sourceTexts) {
    for (const floorKey of collectFloorKeysFromText(rawText)) {
      detected.add(floorKey);
    }
  }
  return [...detected];
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
      bbox: polygonToBoundingBox(anchor?.polygon || []),
    }))
    .filter((anchor) => Array.isArray(anchor.bbox));

  const lineBBoxes = (layoutHints.linePolygons || [])
    .slice(0, PROMPT_LINE_BBOX_LIMIT)
    .map((polygon) => polygonToBoundingBox(polygon))
    .filter((bbox): bbox is [number, number, number, number] => Array.isArray(bbox));

  const lineTexts = (layoutHints.lineTexts || [])
    .slice(0, PROMPT_LINE_TEXT_LIMIT)
    .map((text) => String(text || "").replace(/\s+/g, " ").trim().slice(0, 120))
    .filter(Boolean);

  return JSON.stringify({
    pageCount: layoutHints.pageCount || pageSummary.length,
    pages: pageSummary,
    linePolygonCount: layoutHints.linePolygons?.length || 0,
    sampledLineBBoxes: lineBBoxes,
    sampledLineTexts: lineTexts,
    dimensionAnchorCount: layoutHints.dimensionAnchors?.length || 0,
    sampledDimensionAnchors: dimensionAnchors,
  }, null, 2);
};

export const buildBlueprintVisionPrompt = (layoutHints: BlueprintLayoutHints | null): string => `
You are Infralith Blueprint Reconstruction Engine v5.
Goal: convert a 2D floorplan image into a metrically consistent, topologically valid geometric reconstruction for BIM pre-processing.

DETECTED_FLOOR_LABELS_FROM_LAYOUT_HINTS: ${JSON.stringify(inferFloorLabelsFromHints(layoutHints))}

PRIORITY ORDER:
1) Geometric correctness and topology validity.
2) Evidence-backed extraction.
3) Completeness.

ANTI-HALLUCINATION HARD RULES:
- Use only visible drawing evidence plus provided layout hints.
- Do not invent default box layouts, random extra floors, or speculative furniture.
- If evidence is weak, output fewer elements and add explicit conflicts.
- Prefer "unknown by omission" over wrong geometry.

INPUT EVIDENCE SUMMARY:
AZURE_DOCUMENT_INTELLIGENCE_LAYOUT_HINTS:
${summarizeLayoutHintsForPrompt(layoutHints)}

MANDATORY PIPELINE:
1) NORMALIZE + SCALE + GLOBAL FRAME
- Detect dominant drawing orientation and normalize mentally to a consistent axis.
- Derive scale from readable dimensions first (m, mm, cm, ft, in).
- If scale is inferred from priors, keep geometry conservative and add a scale-related conflict.
- Keep one global coordinate frame across all floors.

2) STRUCTURAL GRAPH FIRST (JUNCTION -> EDGE -> WALL)
- Detect wall junction candidates and wall edge candidates first.
- Build walls from the graph, then snap near-junction endpoints within 0.15m.
- Preserve non-Manhattan edges when evidence supports them; do not force orthogonality.
- Remove duplicates, zero-length edges, and obvious overlaps.

3) FLOOR PARTITIONING
- Separate distinct floor blocks and assign integer floor_level from 0.
- Keep floor-local geometry consistent in a shared global frame.
- If vertical alignment between floors is uncertain, add conflict instead of guessing hidden structure.
- If line texts include labels like "GROUND FLOOR", "FIRST FLOOR", "SECOND FLOOR", "TERRACE", "STILT", "BASEMENT", map each detected floor to a distinct floor_level.
- Do not collapse all entities to floor_level=0 when multiple floor labels are present.
- meta.floor_count MUST equal the count of distinct floor_level values present across walls/rooms/doors/windows.

4) OPENINGS AFTER STABLE WALLS
- Detect doors/windows only after walls are stable.
- Every opening must reference an existing host_wall_id on the same floor_level.
- If host wall is ambiguous, omit opening and record conflict.
- If an opening dimension is unreadable, omit that opening and record conflict.

5) ROOM POLYGONS
- Build room polygons only from enclosed wall regions.
- Room polygons must be closed, non-self-intersecting, and counter-clockwise.
- Compute room area from polygon geometry (m^2).
- Use visible labels when available; otherwise use deterministic names ("Room 1", "Room 2", ...).

6) ROOF FOOTPRINT
- Only include roof when roof evidence is explicit in the blueprint.
- If roof geometry/type is unclear, return roof as null and add a conflict.

7) FURNITURE POLICY
- Furniture is optional and conservative.
- Include only clearly observed furniture; otherwise return an empty furnitures array.

8) QUALITY GATES (MANDATORY)
- All coordinates must be finite numbers in meters.
- No duplicate IDs across walls/doors/windows/rooms/furnitures.
- No dangling zero-length walls.
- All doors/windows must have valid host_wall_id.
- Emit confidence in [0,1] for walls, doors, windows, and rooms when estimable.
- If any major gate is uncertain or fails, add conflict with precise location.

9) CONFLICTS
- Conflicts must use type in {"structural","safety","code"} and severity in {"low","medium","high"}.
- Include concise, actionable descriptions tied to uncertainty, topology, or scale reliability.

OUTPUT CONTRACT:
Return ONLY one valid JSON object matching exactly this structure:
{
  "meta": {
    "unit": "m|cm|mm|ft|in|unknown|null",
    "scale_m_per_px": <number|null>,
    "scale_confidence": <number|null>,
    "rotation_deg": <number|null>,
    "floor_count": <integer|null>
  },
  "building_name": <string|null>,
  "exterior_color": <string|null>,
  "walls": [
    { "id": <string|number>, "start": [x, y], "end": [x, y], "thickness": <number>, "height": <number>, "confidence": <number|null>, "color": <string|null>, "is_exterior": <boolean>, "floor_level": <integer> }
  ],
  "doors": [
    { "id": <string|number>, "host_wall_id": <string|number>, "position": [x, y], "width": <number>, "height": <number>, "swing": "left|right|unknown|null", "confidence": <number|null>, "color": <string|null>, "floor_level": <integer> }
  ],
  "windows": [
    { "id": <string|number>, "host_wall_id": <string|number>, "position": [x, y], "width": <number>, "sill_height": <number>, "confidence": <number|null>, "color": <string|null>, "floor_level": <integer> }
  ],
  "rooms": [
    { "id": <string|number>, "name": <string>, "polygon": [[x, y], [x, y], [x, y]], "area": <number>, "confidence": <number|null>, "floor_color": <string|null>, "floor_level": <integer> }
  ],
  "furnitures": [
    { "id": <string|number>, "room_id": <string|number>, "type": <string>, "position": [x, y], "width": <number>, "depth": <number>, "height": <number>, "color": <string|null>, "description": <string>, "floor_level": <integer> }
  ],
  "roof": { "type": "flat|gable|hip", "polygon": [[x, y], [x, y], [x, y]], "height": <number>, "base_height": <number>, "color": <string|null> } | null,
  "topology_checks": {
    "closed_wall_loops": <boolean|null>,
    "self_intersections": <integer|null>,
    "dangling_walls": <integer|null>,
    "unhosted_openings": <integer|null>,
    "room_polygon_validity_pass": <boolean|null>
  } | null,
  "conflicts": [
    { "type": "structural|safety|code", "severity": "low|medium|high", "description": <string>, "location": [x, y] }
  ]
}
- The placeholder tokens above (<number>, <string>, <integer>, etc.) are schema guides, not literal output values.

STRICT OUTPUT RULE:
- Output JSON object only.
- No markdown, no commentary, no code fences.
`;

export const buildBlueprintRetryPrompt = (basePrompt: string): string => `${basePrompt}

CRITICAL QUALITY RECOVERY (MANDATORY):
Previous result appears underfit or topologically weak.
Regenerate with higher structural fidelity while staying evidence-bound.

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
You are Infralith Architect Engine.
Task: generate production-grade building geometry from the user description.

User Description: "${description}"

MANDATORY RULES:
- No canned templates, mock layouts, or hardcoded showcase examples.
- Derive structure directly from the user description.
- If a required detail is missing, use conservative assumptions and record each assumption as a conflict.
- Keep all coordinates in meters.

STRUCTURAL QUALITY GATES:
1. Build structural shell first: all floors + exterior/interior walls.
2. Keep walls topologically valid: no zero-length walls, no duplicate wall IDs, no disconnected shells.
3. Then add openings: every door/window must have a valid host_wall_id on the same floor_level.
4. Then add rooms: enclosed, non-self-intersecting polygons only (CCW ordering).
5. Multi-floor integrity:
   - Keep distinct floor_level partitions.
   - Keep vertical alignment of load-bearing structure where feasible.
   - Set meta.floor_count to number of distinct floor_level values in output.
6. Roof policy:
   - Include roof only if user description clearly asks for it.
   - If uncertain, return roof as null and add a conflict.

OUTPUT CONTRACT:
Return JSON only using this schema shape:
{
  "meta": {
    "unit": "m|cm|mm|ft|in|unknown|null",
    "scale_m_per_px": <number|null>,
    "scale_confidence": <number|null>,
    "rotation_deg": <number|null>,
    "floor_count": <integer|null>
  },
  "building_name": <string|null>,
  "exterior_color": <string|null>,
  "walls": [
    { "id": <string|number>, "start": [x, y], "end": [x, y], "thickness": <number>, "height": <number>, "confidence": <number|null>, "color": <string|null>, "is_exterior": <boolean>, "floor_level": <integer> }
  ],
  "doors": [
    { "id": <string|number>, "host_wall_id": <string|number>, "position": [x, y], "width": <number>, "height": <number>, "swing": "left|right|unknown|null", "confidence": <number|null>, "color": <string|null>, "floor_level": <integer> }
  ],
  "windows": [
    { "id": <string|number>, "host_wall_id": <string|number>, "position": [x, y], "width": <number>, "sill_height": <number>, "confidence": <number|null>, "color": <string|null>, "floor_level": <integer> }
  ],
  "rooms": [
    { "id": <string|number>, "name": <string>, "polygon": [[x, y], [x, y], [x, y]], "area": <number>, "confidence": <number|null>, "floor_color": <string|null>, "floor_level": <integer> }
  ],
  "furnitures": [
    { "id": <string|number>, "room_id": <string|number>, "type": <string>, "position": [x, y], "width": <number>, "depth": <number>, "height": <number>, "color": <string|null>, "description": <string>, "floor_level": <integer> }
  ],
  "roof": { "type": "flat|gable|hip", "polygon": [[x, y], [x, y], [x, y]], "height": <number>, "base_height": <number>, "color": <string|null> } | null,
  "conflicts": [
    { "type": "structural|safety|code", "severity": "low|medium|high", "description": <string>, "location": [x, y] }
  ]
}
- Placeholder tokens (<number>, <string>, etc.) are guides, not literal values.

STRICT OUTPUT:
- JSON object only.
- No markdown, no prose, no code fences.
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
