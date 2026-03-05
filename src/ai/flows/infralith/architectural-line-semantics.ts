import type { BlueprintLayoutHints } from "@/ai/azure-ai";
import type { GeometricReconstruction } from "./reconstruction-types";
import {
  type BlueprintLineRecord,
  buildBlueprintLineSemanticsReference,
  getOpeningTextPatterns,
} from "./blueprint-line-database";

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

export const buildArchitecturalLineSemanticsReference = (lineRecords?: BlueprintLineRecord[]): string => {
  return buildBlueprintLineSemanticsReference(lineRecords);
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
  result: GeometricReconstruction,
  options?: {
    lineRecords?: BlueprintLineRecord[];
  }
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

  const openingTextPatterns = getOpeningTextPatterns(options?.lineRecords);
  const doorTextSignals = countTextMatches(lineTexts, openingTextPatterns.doorPatterns);
  const windowTextSignals = countTextMatches(lineTexts, openingTextPatterns.windowPatterns);
  const openingTextSignals = countTextMatches(lineTexts, openingTextPatterns.genericOpeningPatterns);

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
  const openingTextSignalTotal = doorTextSignals + windowTextSignals + openingTextSignals;
  if (openingTextSignalTotal > 0) {
    score += 0.8;
    reasons.push(
      `Blueprint text hints include opening semantics (door=${doorTextSignals}, window=${windowTextSignals}, generic=${openingTextSignals}).`
    );
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
    buildArchitecturalLineSemanticsReference(options?.lineRecords),
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
