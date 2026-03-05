export type BlueprintLineCategory =
  | "structural"
  | "opening"
  | "annotation"
  | "reference"
  | "circulation"
  | "services"
  | "site"
  | "construction";

export type BlueprintOpeningSignal = "door" | "window" | "generic";

export type BlueprintLineRecord = {
  id: string;
  label: string;
  category: BlueprintLineCategory;
  cue: string;
  meaning: string;
  caution: string;
  aliases?: string[];
  openingSignal?: BlueprintOpeningSignal;
  promptPriority: number;
  wallGraphRole: "candidate" | "context" | "exclude";
};

const BLUEPRINT_LINE_DATABASE: BlueprintLineRecord[] = [
  {
    id: "wall-parallel-double",
    label: "Primary wall body",
    category: "structural",
    cue: "two near-parallel continuous strokes with stable gap",
    meaning: "load-bearing or exterior wall body",
    caution: "preserve junction continuity and reject OCR/text boxes as walls",
    promptPriority: 1,
    wallGraphRole: "candidate",
  },
  {
    id: "wall-single-partition",
    label: "Thin interior partition",
    category: "structural",
    cue: "single thin continuous line inside enclosed zone",
    meaning: "interior partition or light divider",
    caution: "requires graph support from nearby junctions before wall creation",
    promptPriority: 2,
    wallGraphRole: "candidate",
  },
  {
    id: "wall-curtain",
    label: "Curtain/glazed wall run",
    category: "structural",
    cue: "continuous wall edge with repeated glazing ticks or symbols",
    meaning: "non-load-bearing facade partition",
    caution: "treat as envelope component, not always a structural core wall",
    aliases: ["curtain wall", "glazed wall", "storefront"],
    promptPriority: 3,
    wallGraphRole: "candidate",
  },
  {
    id: "door-arc-gap",
    label: "Swing door",
    category: "opening",
    cue: "wall gap plus quarter/half arc or hinged leaf",
    meaning: "door opening with swing direction",
    caution: "if arc is weak but host wall and gap are clear, keep low confidence",
    aliases: ["door", "dr", "entry", "entrance", "exit"],
    openingSignal: "door",
    promptPriority: 4,
    wallGraphRole: "context",
  },
  {
    id: "door-sliding",
    label: "Sliding door",
    category: "opening",
    cue: "opening with parallel sliding tracks instead of swing arc",
    meaning: "sliding or pocket door",
    caution: "anchor to host wall and avoid converting tracks into walls",
    aliases: ["sliding door", "pocket door"],
    openingSignal: "door",
    promptPriority: 5,
    wallGraphRole: "context",
  },
  {
    id: "window-wall-break",
    label: "Window span",
    category: "opening",
    cue: "short wall break or stacked thin lines inside exterior wall run",
    meaning: "window opening segment",
    caution: "must attach to host wall on same floor level",
    aliases: ["window", "win", "wdw", "glazing", "fenestration"],
    openingSignal: "window",
    promptPriority: 6,
    wallGraphRole: "context",
  },
  {
    id: "opening-generic",
    label: "Unspecified opening marker",
    category: "opening",
    cue: "explicit opening note/marker without full door or window symbol",
    meaning: "generic opening requiring host wall reconciliation",
    caution: "emit conflict when type/host cannot be resolved reliably",
    aliases: ["opening", "void", "lintel", "sill", "clear opening"],
    openingSignal: "generic",
    promptPriority: 7,
    wallGraphRole: "context",
  },
  {
    id: "stairs-treads",
    label: "Stair treads",
    category: "circulation",
    cue: "cluster of repeated narrow parallel segments with landing",
    meaning: "stair flight / vertical circulation",
    caution: "do not convert treads into room partitions",
    aliases: ["stair", "staircase", "up", "down"],
    promptPriority: 8,
    wallGraphRole: "context",
  },
  {
    id: "ramp-slope-arrow",
    label: "Ramp slope arrow",
    category: "circulation",
    cue: "linear ramp edge with directional slope arrow",
    meaning: "accessible ramp and movement direction",
    caution: "direction arrow is not a wall segment",
    aliases: ["ramp", "slope"],
    promptPriority: 9,
    wallGraphRole: "context",
  },
  {
    id: "centerline-chain",
    label: "Centerline",
    category: "reference",
    cue: "dash-dot or chain line through geometry",
    meaning: "axis/alignment guide",
    caution: "never convert centerline directly into wall graph edge",
    aliases: ["centerline", "centre line", "cl"],
    promptPriority: 10,
    wallGraphRole: "exclude",
  },
  {
    id: "grid-line",
    label: "Structural grid line",
    category: "reference",
    cue: "long thin reference line ending in grid bubbles/labels",
    meaning: "axis grid for placement and dimensions",
    caution: "use for alignment only; exclude from wall extraction",
    aliases: ["grid", "axis", "gridline"],
    promptPriority: 11,
    wallGraphRole: "exclude",
  },
  {
    id: "dimension-line",
    label: "Dimension line",
    category: "annotation",
    cue: "line with arrows/ticks and numeric annotation",
    meaning: "distance/size measurement",
    caution: "use to calibrate scale; not structural geometry",
    aliases: ["dimension", "dim", "mm", "cm", "ft"],
    promptPriority: 12,
    wallGraphRole: "exclude",
  },
  {
    id: "extension-line",
    label: "Dimension extension line",
    category: "annotation",
    cue: "short perpendicular helper line from object to dimension line",
    meaning: "dimension reference support",
    caution: "never treat extension line as partition",
    aliases: ["extension line", "ext line"],
    promptPriority: 13,
    wallGraphRole: "exclude",
  },
  {
    id: "leader-line",
    label: "Leader/callout line",
    category: "annotation",
    cue: "thin pointer line from text note to element",
    meaning: "annotation connector",
    caution: "annotation leaders are not walls or room boundaries",
    aliases: ["leader", "callout", "note"],
    promptPriority: 14,
    wallGraphRole: "exclude",
  },
  {
    id: "section-cut",
    label: "Section cut line",
    category: "reference",
    cue: "thick cut line with directional arrows and section tags",
    meaning: "section view extraction path",
    caution: "ignore as wall in plan reconstruction",
    aliases: ["section", "sec", "a-a", "b-b"],
    promptPriority: 15,
    wallGraphRole: "exclude",
  },
  {
    id: "elevation-marker",
    label: "Elevation marker",
    category: "reference",
    cue: "circle/arrow marker referencing elevation sheet",
    meaning: "view marker and orientation",
    caution: "marker geometry is metadata, not structure",
    aliases: ["elevation", "elv"],
    promptPriority: 16,
    wallGraphRole: "exclude",
  },
  {
    id: "hidden-dashed",
    label: "Hidden/overhead dashed line",
    category: "reference",
    cue: "uniform dashed line with no enclosure role",
    meaning: "hidden or overhead component",
    caution: "exclude from primary wall graph unless corroborated",
    aliases: ["hidden", "overhead", "dashed"],
    promptPriority: 17,
    wallGraphRole: "exclude",
  },
  {
    id: "break-line",
    label: "Break line",
    category: "annotation",
    cue: "jagged or wavy cut marker indicating truncated view",
    meaning: "drawing extent break",
    caution: "not a physical wall edge",
    aliases: ["break line", "cut line"],
    promptPriority: 18,
    wallGraphRole: "exclude",
  },
  {
    id: "property-boundary",
    label: "Property boundary",
    category: "site",
    cue: "outer site perimeter often dashed and labeled boundary/setback",
    meaning: "plot boundary or legal limit",
    caution: "site boundary is not building shell unless explicitly indicated",
    aliases: ["property line", "plot boundary", "setback"],
    promptPriority: 19,
    wallGraphRole: "context",
  },
  {
    id: "setback-line",
    label: "Setback/building line",
    category: "site",
    cue: "offset boundary line defining no-build zone",
    meaning: "regulatory construction limit",
    caution: "use for conflict checks, not room/wall extraction",
    aliases: ["setback", "building line", "no build"],
    promptPriority: 20,
    wallGraphRole: "exclude",
  },
  {
    id: "demolition-line",
    label: "Demolition line",
    category: "construction",
    cue: "dashed-heavy or coded line indicating removal scope",
    meaning: "to-be-demolished element",
    caution: "do not merge demolition marks with proposed permanent walls",
    aliases: ["demolition", "to be removed", "existing to remove"],
    promptPriority: 21,
    wallGraphRole: "context",
  },
  {
    id: "phasing-new-work",
    label: "New work line",
    category: "construction",
    cue: "line style code indicating proposed new construction",
    meaning: "new-build element in phased drawings",
    caution: "interpret with legend; keep phase context explicit",
    aliases: ["new work", "proposed"],
    promptPriority: 22,
    wallGraphRole: "candidate",
  },
  {
    id: "plumbing-water-line",
    label: "Water supply line",
    category: "services",
    cue: "thin line network connecting wet fixtures, often tagged CW/HW",
    meaning: "plumbing supply routing",
    caution: "services network must not become partitions",
    aliases: ["plumbing", "water line", "cw", "hw"],
    promptPriority: 23,
    wallGraphRole: "exclude",
  },
  {
    id: "drainage-line",
    label: "Drainage/sewer line",
    category: "services",
    cue: "service run often labeled SVP/WP/Drain with arrows",
    meaning: "waste drainage path",
    caution: "use as semantic signal only; exclude from wall graph",
    aliases: ["drain", "sewer", "svp", "wp"],
    promptPriority: 24,
    wallGraphRole: "exclude",
  },
  {
    id: "electrical-conduit",
    label: "Electrical conduit run",
    category: "services",
    cue: "symbolic line routes between electrical points",
    meaning: "electrical circuit/conduit path",
    caution: "ignore for geometry extraction",
    aliases: ["electrical", "conduit", "circuit"],
    promptPriority: 25,
    wallGraphRole: "exclude",
  },
  {
    id: "hvac-duct-centerline",
    label: "HVAC duct run",
    category: "services",
    cue: "duct path with width annotation or diffuser symbols",
    meaning: "air distribution network",
    caution: "treat as MEP overlay, not partitioning geometry",
    aliases: ["hvac", "duct", "diffuser"],
    promptPriority: 26,
    wallGraphRole: "exclude",
  },
  {
    id: "fire-line",
    label: "Fire protection line",
    category: "services",
    cue: "line network tagged sprinkler/hydrant symbols",
    meaning: "fire safety piping layout",
    caution: "semantic utility only for safety checks",
    aliases: ["fire line", "sprinkler", "hydrant"],
    promptPriority: 27,
    wallGraphRole: "exclude",
  },
  {
    id: "landscape-edge",
    label: "Landscape/kerb edge",
    category: "site",
    cue: "outer contour or kerb/path line around building",
    meaning: "site landscaping and circulation edge",
    caution: "do not classify as building wall",
    aliases: ["landscape", "kerb", "pathway"],
    promptPriority: 28,
    wallGraphRole: "exclude",
  },
];

const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const aliasToWordPattern = (alias: string): RegExp => {
  const normalized = alias.trim().toLowerCase().replace(/\s+/g, " ");
  const source = normalized
    .split(" ")
    .map((chunk) => escapeRegExp(chunk))
    .join("\\s*");
  return new RegExp(`\\b${source}\\b`, "i");
};

const uniqRegExpBySource = (patterns: RegExp[]): RegExp[] => {
  const seen = new Set<string>();
  const output: RegExp[] = [];
  for (const pattern of patterns) {
    const key = `${pattern.source}|${pattern.flags}`;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(pattern);
  }
  return output;
};

export type OpeningTextPatternSet = {
  doorPatterns: RegExp[];
  windowPatterns: RegExp[];
  genericOpeningPatterns: RegExp[];
};

let openingPatternCache: OpeningTextPatternSet | null = null;

export const getBlueprintLineDatabase = (): BlueprintLineRecord[] => [...BLUEPRINT_LINE_DATABASE];

const getEffectiveRules = (records?: BlueprintLineRecord[]): BlueprintLineRecord[] => {
  if (Array.isArray(records) && records.length > 0) {
    return [...records];
  }
  return [...BLUEPRINT_LINE_DATABASE];
};

const sortPromptRules = (records: BlueprintLineRecord[]): BlueprintLineRecord[] =>
  [...records].sort((a, b) => a.promptPriority - b.promptPriority);

const buildOpeningTextPatternsFromRules = (records: BlueprintLineRecord[]): OpeningTextPatternSet => {
  const doorAliases: string[] = [];
  const windowAliases: string[] = [];
  const genericAliases: string[] = [];

  for (const record of records) {
    if (!record.openingSignal) continue;
    const aliases = record.aliases || [];
    if (record.openingSignal === "door") doorAliases.push(...aliases);
    if (record.openingSignal === "window") windowAliases.push(...aliases);
    if (record.openingSignal === "generic") genericAliases.push(...aliases);
  }

  const doorPatterns = uniqRegExpBySource([
    ...doorAliases.map(aliasToWordPattern),
    /\bdoor\b/i,
    /\bdr\b/i,
    /\bentry\b/i,
    /\bentrance\b/i,
    /\bexit\b/i,
  ]);
  const windowPatterns = uniqRegExpBySource([
    ...windowAliases.map(aliasToWordPattern),
    /\bwindow\b/i,
    /\bwin\b/i,
    /\bwdw\b/i,
    /\bglaz(?:ed|ing)?\b/i,
  ]);
  const genericOpeningPatterns = uniqRegExpBySource([
    ...genericAliases.map(aliasToWordPattern),
    /\bopening\b/i,
    /\bvoid\b/i,
    /\blintel\b/i,
    /\bsill\b/i,
  ]);

  return {
    doorPatterns,
    windowPatterns,
    genericOpeningPatterns,
  };
};

export const getPromptBlueprintLineRules = (records?: BlueprintLineRecord[]): BlueprintLineRecord[] =>
  sortPromptRules(getEffectiveRules(records));

export const buildBlueprintLineSemanticsReference = (records?: BlueprintLineRecord[]): string => {
  const rules = getPromptBlueprintLineRules(records);
  const lines = rules.map((rule, index) =>
    `${index + 1}. ${rule.label}: Cue=${rule.cue}; Meaning=${rule.meaning}; Caution=${rule.caution}; WallGraph=${rule.wallGraphRole}.`
  );

  return [
    "ARCHITECTURAL LINE SEMANTICS DATABASE (CONTEXT-FIRST, NOT TEXT-ONLY):",
    ...lines,
    `Coverage: ${rules.length} canonical blueprint line families across structural, opening, annotation, reference, circulation, services, site, and construction overlays.`,
    "Rule: one line style does not have universal meaning across all drawings; always resolve with local topology, legends, and host-wall consistency.",
  ].join("\n");
};

export const getOpeningTextPatterns = (records?: BlueprintLineRecord[]): OpeningTextPatternSet => {
  const useDefaultRules = !Array.isArray(records) || records.length === 0;
  if (useDefaultRules) {
    if (openingPatternCache) return openingPatternCache;
    openingPatternCache = buildOpeningTextPatternsFromRules(BLUEPRINT_LINE_DATABASE);
    return openingPatternCache;
  }
  return buildOpeningTextPatternsFromRules(records);
};
