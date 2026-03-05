import type { BlueprintLayoutHints } from "@/ai/azure-ai";
import type { GeometricReconstruction } from "./reconstruction-types";

type LineSemanticRule = {
  id: string;
  cue: string;
  meaning: string;
  caution: string;
};

const LINE_SEMANTIC_RULES: LineSemanticRule[] = [
  {
    id: "wall-parallel",
    cue: "two long, near-parallel continuous strokes with stable gap",
    meaning: "likely wall body (exterior or structural partition)",
    caution: "validate continuity at junctions; avoid turning text boxes into walls",
  },
  {
    id: "partition-thin",
    cue: "single thin continuous line in enclosed area",
    meaning: "possible interior partition or fixture edge",
    caution: "do not force as wall without topology support from neighboring junctions",
  },
  {
    id: "door-arc-gap",
    cue: "wall gap plus nearby quarter/half arc or short leaf segment",
    meaning: "door opening with swing direction",
    caution: "if arc is weak but gap is clear, keep low-confidence door instead of dropping",
  },
  {
    id: "window-wall-break",
    cue: "short break/stacked thin lines embedded in exterior wall run",
    meaning: "window span",
    caution: "must attach to host wall; uncertain host should become conflict",
  },
  {
    id: "centerline-chain",
    cue: "dash-dot or chain-like guide line through geometry",
    meaning: "axis/alignment guide, not a wall",
    caution: "never convert centerline directly into wall segment",
  },
  {
    id: "hidden-dashed",
    cue: "uniform dashed line with no enclosing role",
    meaning: "hidden/overhead element",
    caution: "exclude from primary wall graph unless corroborated by other evidence",
  },
  {
    id: "stair-treads",
    cue: "cluster of repeated narrow parallel segments with landing/arrow",
    meaning: "stair flight / vertical circulation",
    caution: "if exact boundary unclear, preserve shell and emit explicit conflict",
  },
];

const normalizeText = (value: unknown): string =>
  String(value || "")
    .toLowerCase()
    .replace(/[_\-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const clampUnit = (value: number) => Math.max(0, Math.min(1, value));

const countTextMatches = (lineTexts: string[], patterns: RegExp[]) => {
  let count = 0;
  for (const text of lineTexts) {
    if (patterns.some((pattern) => pattern.test(text))) count += 1;
  }
  return count;
};

const DOOR_TEXT_PATTERNS = [
  /\bdoor\b/i,
  /\bdr\b/i,
  /\bd\b/i,
  /\bentry\b/i,
  /\bexit\b/i,
];

const WINDOW_TEXT_PATTERNS = [
  /\bwindow\b/i,
  /\bwin\b/i,
  /\bwdw\b/i,
  /\bglaz(?:ed|ing)?\b/i,
];

const OPENING_TEXT_PATTERNS = [
  /\bopening\b/i,
  /\bopn\b/i,
  /\bvoid\b/i,
  /\blintel\b/i,
  /\bsill\b/i,
];

export const buildArchitecturalLineSemanticsReference = (): string => {
  const lines = LINE_SEMANTIC_RULES.map((rule, index) =>
    `${index + 1}. Cue: ${rule.cue} -> Meaning: ${rule.meaning}. Caution: ${rule.caution}.`
  );
  return [
    "ARCHITECTURAL LINE SEMANTICS REFERENCE (CONTEXT-FIRST, NOT TEXT-ONLY):",
    ...lines,
    "Rule: one line does not have a universal meaning in every drawing. Resolve with local topology, host walls, and nearby symbols before classification.",
  ].join("\n");
};

export type OpeningSemanticsAssessment = {
  shouldAttemptRecovery: boolean;
  score: number;
  confidence: number;
  reasons: string[];
  promptGuidance: string;
};

export const assessOpeningSemantics = (
  layoutHints: BlueprintLayoutHints | null,
  result: GeometricReconstruction
): OpeningSemanticsAssessment => {
  const walls = result?.walls?.length || 0;
  const rooms = result?.rooms?.length || 0;
  const openings = (result?.doors?.length || 0) + (result?.windows?.length || 0);
  const floorCount = Math.max(1, Number(result?.meta?.floor_count || 0), ...[
    ...(result?.walls || []).map((w) => Number(w?.floor_level || 0) + 1),
    ...(result?.rooms || []).map((r) => Number(r?.floor_level || 0) + 1),
  ].filter((n) => Number.isFinite(n)));
  const lineCount = layoutHints?.linePolygons?.length || 0;
  const dimensionCount = layoutHints?.dimensionAnchors?.length || 0;
  const semanticCount = layoutHints?.semanticAnchors?.length || 0;
  const lineTexts = (layoutHints?.lineTexts || []).map(normalizeText).filter(Boolean);

  const doorTextSignals = countTextMatches(lineTexts, DOOR_TEXT_PATTERNS);
  const windowTextSignals = countTextMatches(lineTexts, WINDOW_TEXT_PATTERNS);
  const openingTextSignals = countTextMatches(lineTexts, OPENING_TEXT_PATTERNS);

  const expectedOpenings = Math.max(2, Math.round(rooms * 0.55), Math.round(walls * 0.28));
  const openingDeficit = Math.max(0, expectedOpenings - openings);
  const openingsPerFloor = openings / Math.max(1, floorCount);

  let score = 0;
  const reasons: string[] = [];

  if (walls >= 6) {
    score += 0.8;
  }
  if (rooms >= 3) {
    score += 0.8;
  }
  if (lineCount >= 25) {
    score += Math.min(1.4, lineCount / 80);
    reasons.push(`Blueprint has dense line evidence (${lineCount} OCR line boxes), so symbol-based opening recovery is warranted.`);
  }
  if (dimensionCount >= 2 || semanticCount >= 4) {
    score += 0.6;
  }
  if (openingDeficit > 0) {
    score += Math.min(2.6, openingDeficit * 0.45);
    reasons.push(`Openings appear underfit (${openings}/${expectedOpenings} expected from wall-room complexity).`);
  }
  if (openingsPerFloor < 0.9 && walls >= 8) {
    score += 0.9;
    reasons.push(`Openings per floor are low (${openingsPerFloor.toFixed(2)}), suggesting missed door/window symbols.`);
  }
  if (doorTextSignals + windowTextSignals + openingTextSignals > 0) {
    score += 0.8;
  } else if (lineCount >= 25 && openings === 0) {
    score += 1.2;
    reasons.push("No opening text hints found, but geometry-rich plan still requires non-text symbol interpretation.");
  }

  const confidence = clampUnit(score / 6.8);
  const shouldAttemptRecovery = score >= 2.4;

  if (reasons.length === 0 && shouldAttemptRecovery) {
    reasons.push("Wall/room topology indicates likely missing openings even without explicit text labels.");
  }

  const promptGuidance = [
    buildArchitecturalLineSemanticsReference(),
    "OPENING INTERPRETATION BIAS:",
    "- Do not require door/window text labels before inferring openings.",
    "- Prioritize wall-gap plus arc/leaf symbols for doors; prioritize embedded spans in exterior walls for windows.",
    "- Keep uncertain detections as low-confidence openings or explicit conflicts, not silent omission.",
  ].join("\n");

  return {
    shouldAttemptRecovery,
    score: Number(score.toFixed(2)),
    confidence: Number(confidence.toFixed(2)),
    reasons: reasons.slice(0, 4),
    promptGuidance,
  };
};

