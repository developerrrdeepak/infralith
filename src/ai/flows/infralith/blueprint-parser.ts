'use server';

import { analyzeBlueprintDocument, generateAzureObject } from '@/ai/azure-ai';
import { z } from 'zod';

const blueprintParseSchema = z.object({
    projectScope: z.string().nullable(),
    projectName: z.string().nullable(),
    totalFloors: z.union([z.number(), z.string()]).nullable(),
    floors: z.union([z.number(), z.string()]).nullable(),
    height: z.union([z.number(), z.string()]).nullable(),
    totalArea: z.union([z.number(), z.string()]).nullable(),
    area: z.union([z.number(), z.string()]).nullable(),
    seismicZone: z.string().nullable(),
    zone: z.string().nullable(),
    materials: z.array(
        z.object({
            item: z.string().nullable(),
            name: z.string().nullable(),
            material: z.string().nullable(),
            quantity: z.union([z.number(), z.string()]).nullable(),
            amount: z.union([z.number(), z.string()]).nullable(),
            unit: z.string().nullable(),
            measurement: z.string().nullable(),
            spec: z.string().nullable(),
            specification: z.string().nullable(),
            standard: z.string().nullable(),
        })
    ).nullable(),
});

const MAX_OCR_CHARS_FOR_PROMPT = 24000;
const ZONE_BY_NUMBER: Record<string, string> = {
    '2': 'II',
    '3': 'III',
    '4': 'IV',
    '5': 'V',
};

type ParsedMaterial = {
    item: string;
    quantity: number | string;
    unit: string;
    spec: string;
};

type OcrHints = {
    projectScope: string | null;
    totalFloors: number | null;
    height: number | null;
    totalArea: number | null;
    seismicZone: string | null;
    materials: ParsedMaterial[];
};

const clean = (value: string) => value.replace(/\s+/g, ' ').trim();

const extractNumber = (value: unknown): number | null => {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value !== 'string') return null;
    const match = value.replace(/,/g, '').match(/-?\d+(\.\d+)?/);
    if (!match) return null;
    const parsed = Number(match[0]);
    return Number.isFinite(parsed) ? parsed : null;
};

const toFloorCount = (value: unknown, fallback = 0): number => {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return Math.max(0, Math.round(value));
    }

    const text = String(value ?? '').toUpperCase();
    if (!text) return fallback;

    const gPlus = text.match(/\bG\s*\+\s*(\d{1,2})\b/);
    if (gPlus?.[1]) return Math.max(0, Number(gPlus[1]) + 1);

    const parsed = extractNumber(text);
    if (parsed == null) return fallback;
    return Math.max(0, Math.round(parsed));
};

const toMeters = (value: unknown, fallback = 0): number => {
    const n = extractNumber(value);
    if (n == null) return fallback;

    const text = String(value ?? '').toLowerCase();
    let meters = n;
    if (/\b(ft|feet|foot)\b|\'/.test(text)) meters = n * 0.3048;
    else if (/\bcm\b/.test(text)) meters = n / 100;
    else if (/\bmm\b/.test(text)) meters = n / 1000;

    return Number.isFinite(meters) ? Number(meters.toFixed(3)) : fallback;
};

const toSquareMeters = (value: unknown, fallback = 0): number => {
    const n = extractNumber(value);
    if (n == null) return fallback;

    const text = String(value ?? '').toLowerCase();
    let sqm = n;
    if (/\b(sq\.?\s*ft|sqft|ft2|ft\^2|square feet)\b/.test(text)) sqm = n * 0.092903;
    else if (/\b(sq\.?\s*yd|sqyd|yd2|yd\^2|square yard)\b/.test(text)) sqm = n * 0.836127;
    else if (/\bacre(s)?\b/.test(text)) sqm = n * 4046.8564224;
    else if (/\bha\b|\bhectare(s)?\b/.test(text)) sqm = n * 10000;

    return Number.isFinite(sqm) ? Number(sqm.toFixed(2)) : fallback;
};

const normalizeZone = (value: unknown): string | null => {
    if (value == null) return null;
    const text = String(value).toUpperCase();

    const roman = text.match(/\b(II|III|IV|V)\b/);
    if (roman?.[1]) return roman[1];

    const numeric = text.match(/\b([2-5])\b/);
    if (numeric?.[1]) return ZONE_BY_NUMBER[numeric[1]] || null;

    return null;
};

const uniqueBy = <T>(items: T[], key: (item: T) => string) => {
    const seen = new Set<string>();
    const output: T[] = [];

    for (const item of items) {
        const k = key(item);
        if (!k || seen.has(k)) continue;
        seen.add(k);
        output.push(item);
    }

    return output;
};

const extractHintsFromOcr = (ocrText: string): OcrHints => {
    const lines = ocrText.split(/\n+/).map(clean).filter(Boolean);

    const firstMatch = (patterns: RegExp[]) => {
        for (const line of lines) {
            for (const pattern of patterns) {
                const match = line.match(pattern);
                if (match?.[1]) return clean(match[1]);
            }
        }
        return null;
    };

    const projectScope = firstMatch([
        /(?:project(?:\s*name)?|title|scope)\s*[:\-]\s*(.+)$/i,
        /(?:name\s*of\s*project)\s*[:\-]\s*(.+)$/i,
    ]);

    const floorsText =
        firstMatch([
            /(?:total\s*(?:no\.?\s*of\s*)?floors?|floors?|storeys?|stories?)\s*[:\-]\s*([^\n]+)/i,
        ]) || firstMatch([/\b(G\s*\+\s*\d{1,2})\b/i]);

    const heightText = firstMatch([
        /(?:building\s*)?(?:height|elevation)\s*[:\-]\s*([^\n]+)/i,
    ]);

    const areaText = firstMatch([
        /(?:total\s*area|built[\s-]*up\s*area|project\s*area|plot\s*area|area)\s*[:\-]\s*([^\n]+)/i,
    ]);

    const zoneText = firstMatch([
        /(?:seismic\s*zone|zone)\s*[:\-]\s*([^\n]+)/i,
    ]);

    const rawMaterials: ParsedMaterial[] = [];
    for (const line of lines) {
        if (!/[a-z]/i.test(line) || !/\d/.test(line)) continue;
        if (!/(steel|concrete|cement|rebar|aggregate|sand|brick|block|glass|timber|wood|tile|paint|material)/i.test(line)) continue;
        if (/material\s*bill|bill\s*of\s*quantities|boq|material\s*schedule/i.test(line)) continue;

        const tokens = line.split('|').map(clean).filter(Boolean);
        const item = clean((tokens[0] || line.split(/[,;-]/)[0] || ''));
        if (!item || item.length < 3) continue;

        const qtySource = tokens.find((t, idx) => idx > 0 && /\d/.test(t)) || line;
        const quantity = extractNumber(qtySource) ?? 0;
        const unit = (qtySource.match(/\b(cum|m3|m2|sqm|sq\.?\s*m|tonnes?|tons?|kg|mt|nos?|units?|bags?)\b/i)?.[1] || '').toLowerCase();
        const spec = (line.match(/\b(FE[-\s]?\d+[A-Z]?|M\d{2}|IS[-\s]?\d+)\b/i)?.[1] || '').toUpperCase();

        rawMaterials.push({ item, quantity, unit, spec });
    }

    return {
        projectScope,
        totalFloors: floorsText ? toFloorCount(floorsText, 0) : null,
        height: heightText ? toMeters(heightText, 0) : null,
        totalArea: areaText ? toSquareMeters(areaText, 0) : null,
        seismicZone: normalizeZone(zoneText),
        materials: uniqueBy(rawMaterials, (m) => m.item.toLowerCase()).slice(0, 25),
    };
};

const trimOcr = (ocrText: string) => {
    if (ocrText.length <= MAX_OCR_CHARS_FOR_PROMPT) return ocrText;
    const head = Math.floor(MAX_OCR_CHARS_FOR_PROMPT * 0.65);
    const tail = MAX_OCR_CHARS_FOR_PROMPT - head;
    return `${ocrText.slice(0, head)}\n...[OCR TRIMMED FOR TOKEN SAFETY]...\n${ocrText.slice(-tail)}`;
};

const buildPrompt = (trimmedOcr: string, hints: OcrHints) => `
You are Blueprint Parser v4 for a construction intelligence workflow.
Your output is consumed directly by compliance, risk, and cost agents.

TASK:
Extract structured blueprint metadata from OCR evidence with strict anti-hallucination behavior.

RULES:
1) Use only OCR evidence from this prompt.
2) If any field is unclear, return null (or [] for materials).
3) Do not invent values, dimensions, quantities, standards, or material lines.
4) Normalize:
   - totalFloors as integer count
   - height in meters
   - totalArea in square meters
5) Seismic zone must be canonical when present: II | III | IV | V
6) Materials must be unique explicit BOQ/schedule items only.
7) Return JSON only. No markdown. No explanation.

OUTPUT SHAPE (keys only from this schema):
{
  "projectScope": string|null,
  "projectName": string|null,
  "totalFloors": number|null,
  "floors": number|null,
  "height": number|null,
  "totalArea": number|null,
  "area": number|null,
  "seismicZone": string|null,
  "zone": string|null,
  "materials": [
    {
      "item": string,
      "name": string|null,
      "material": string|null,
      "quantity": number|string|null,
      "amount": number|string|null,
      "unit": string|null,
      "measurement": string|null,
      "spec": string|null,
      "specification": string|null,
      "standard": string|null
    }
  ]
}

HINTS FROM SAME OCR (use only if consistent with OCR):
${JSON.stringify(hints, null, 2)}

OCR TEXT START
${trimmedOcr}
OCR TEXT END
`;

const normalizeResult = (result: z.infer<typeof blueprintParseSchema> | null, hints: OcrHints) => {
    const projectScope =
        (typeof result?.projectScope === 'string' && result.projectScope.trim()) ||
        (typeof result?.projectName === 'string' && result.projectName.trim()) ||
        hints.projectScope ||
        'Construction Project';

    const totalFloors = toFloorCount(result?.totalFloors ?? result?.floors ?? hints.totalFloors, hints.totalFloors ?? 0);
    const height = toMeters(result?.height ?? hints.height, hints.height ?? 0);
    const totalArea = toSquareMeters(result?.totalArea ?? result?.area ?? hints.totalArea, hints.totalArea ?? 0);
    const seismicZone = normalizeZone(result?.seismicZone ?? result?.zone ?? hints.seismicZone) || 'Undefined';

    const parsedMaterials: ParsedMaterial[] = Array.isArray(result?.materials)
        ? result.materials
              .map((m) => {
                  const item = clean(String(m?.item || m?.name || m?.material || ''));
                  if (!item) return null;
                  const quantityRaw = m?.quantity ?? m?.amount;
                  const quantityNum = extractNumber(quantityRaw);
                  return {
                      item,
                      quantity: quantityNum ?? (typeof quantityRaw === 'string' ? quantityRaw : 0),
                      unit: clean(String(m?.unit || m?.measurement || '')).toLowerCase(),
                      spec: clean(String(m?.spec || m?.specification || m?.standard || '')).toUpperCase(),
                  } as ParsedMaterial;
              })
              .filter((m): m is ParsedMaterial => !!m)
        : [];

    const materials = (parsedMaterials.length ? parsedMaterials : hints.materials)
        .map((m) => ({
            item: m.item || 'Unknown Material',
            quantity: m.quantity ?? 0,
            unit: m.unit || '',
            spec: m.spec || '',
        }))
        .slice(0, 25);

    return {
        projectScope,
        totalFloors,
        height,
        totalArea,
        seismicZone,
        materials,
    };
};

/**
 * Blueprint Parsing Agent - uses Azure Document Intelligence and GPT
 */
export async function parseBlueprint(file: string | File) {
    const rawOcrText = await analyzeBlueprintDocument(file);
    const ocrText = String(rawOcrText || '').replace(/\r/g, '').trim();

    if (!ocrText) {
        throw new Error('Blueprint OCR produced empty text. Parser cannot extract structured parameters.');
    }

    const hints = extractHintsFromOcr(ocrText);
    const prompt = buildPrompt(trimOcr(ocrText), hints);
    const result = await generateAzureObject<z.infer<typeof blueprintParseSchema>>(prompt, blueprintParseSchema);
    return normalizeResult(result, hints);
}
