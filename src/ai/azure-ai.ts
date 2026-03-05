import { generateObject } from 'ai';
import { createAzure } from '@ai-sdk/azure';
import { z } from 'zod';
import { DocumentAnalysisClient, AzureKeyCredential } from "@azure/ai-form-recognizer";
import { azureRuntime } from './config/azure-runtime';

// Azure OpenAI Configuration
const azureKey = azureRuntime.openAIKey;
const routerDeploymentName = azureRuntime.routerDeploymentName || "model-router";
const topDeploymentName = azureRuntime.topDeploymentName || "gpt-5";
const preferTopModel = azureRuntime.preferTopModel;
const azureResourceName = azureRuntime.resourceName;
const azureEndpoint = azureRuntime.openAIEndpoint;
const azureApiVersion = azureRuntime.openAIApiVersion || '2024-08-01-preview';
const VERBOSE_LOGS = (process.env.INFRALITH_VERBOSE_LOGS || "true").toLowerCase() !== "false";

const parseTimeoutMs = (
    value: string | undefined,
    fallback: number,
    min = 5_000,
    max = 300_000
) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, Math.floor(parsed)));
};

const VISION_GENERATION_TIMEOUT_MS = parseTimeoutMs(process.env.INFRALITH_VISION_GENERATION_TIMEOUT_MS, 95_000);
const TEXT_GENERATION_TIMEOUT_MS = parseTimeoutMs(process.env.INFRALITH_TEXT_GENERATION_TIMEOUT_MS, 60_000);

// Azure Document Intelligence Configuration
const docIntelEndpoint = azureRuntime.docIntelEndpoint;
const docIntelKey = azureRuntime.docIntelKey;

const normalizeAzureBaseUrl = (endpoint: string) => {
    const trimmed = endpoint.trim().replace(/\/+$/, '');
    if (!trimmed) return '';
    if (trimmed.endsWith('/openai')) return trimmed;
    if (trimmed.endsWith('/openai/v1')) return trimmed.replace(/\/v1$/i, '');
    return `${trimmed}/openai`;
};

const azureBaseUrl = normalizeAzureBaseUrl(azureEndpoint);

const azureFixed = createAzure({
    ...(azureBaseUrl ? { baseURL: azureBaseUrl } : { resourceName: azureResourceName }),
    apiKey: azureKey,
    useDeploymentBasedUrls: true,
    apiVersion: azureApiVersion,
});

const summarizeGeometry = (payload: any) => ({
    walls: Array.isArray(payload?.walls) ? payload.walls.length : 0,
    rooms: Array.isArray(payload?.rooms) ? payload.rooms.length : 0,
    doors: Array.isArray(payload?.doors) ? payload.doors.length : 0,
    windows: Array.isArray(payload?.windows) ? payload.windows.length : 0,
    conflicts: Array.isArray(payload?.conflicts) ? payload.conflicts.length : 0,
    hasRoof: !!payload?.roof,
    buildingName: payload?.building_name || 'N/A',
});

const summarizeAsset = (payload: any) => ({
    assetName: payload?.name || 'N/A',
    partCount: Array.isArray(payload?.parts) ? payload.parts.length : 0,
    materials: Array.isArray(payload?.parts)
        ? Array.from(new Set(payload.parts.map((p: any) => p?.material).filter(Boolean))).slice(0, 8)
        : [],
});

const summarizeStructured = (payload: any) => {
    if (Array.isArray(payload?.parts)) {
        return { mode: 'asset', ...summarizeAsset(payload) };
    }
    if (Array.isArray(payload?.walls) || Array.isArray(payload?.rooms) || Array.isArray(payload?.doors) || Array.isArray(payload?.windows)) {
        return { mode: 'geometry', ...summarizeGeometry(payload) };
    }
    if (payload && typeof payload === 'object') {
        return { mode: 'generic', keys: Object.keys(payload).slice(0, 12) };
    }
    return { mode: 'primitive', type: typeof payload };
};

const LAYOUT_POLYGON_LIMIT = 180;
const LAYOUT_DIMENSION_ANCHOR_LIMIT = 60;
const LAYOUT_LINE_TEXT_LIMIT = 140;
const LAYOUT_FLOOR_LABEL_LIMIT = 36;
const LAYOUT_SEMANTIC_ANCHOR_LIMIT = 96;
const DIMENSION_TEXT_REGEX = /(\d+(\.\d+)?\s?(mm|cm|m|ft|feet|in|inch|\"|')|\d+'\s?\d*\"?)/i;
const FLOOR_LABEL_HINT_REGEX = /\b((?:basement|cellar|lower\s*ground|stilt|ground|first|second|third|fourth|fifth|terrace|roof)\s*floor|(?:level|lvl|floor|flr)\s*[-_:]?\s*[a-z0-9]+|(?:g|b|l|f)\s*[-_:]?\s*\d{1,2})\b/i;
const SEMANTIC_TEXT_REGEX = /\b(?:kitchen|pantry|bed(?:room)?|bdrm|master\s*suite|bath(?:room)?|toilet|wc|powder|lav(?:atory)?|wash(?:room)?|living|family(?:\s*room)?|lounge|great\s*room|dining|breakfast|stair(?:case)?s?|stairwell|up|dn|down|study|office|utility|laundry|service|storage|store(?:room)?|closet|garage|carport|foyer|entry|vestibule|balcony|terrace|patio|den)\b/i;
const DEPLOYMENT_ERROR_PATTERN = /(deployment|model|404|not found|does not exist|unknown deployment|resource not found)/i;

const createTraceId = (prefix: string) =>
    `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

type LogLevel = "log" | "warn" | "error";

const traceLog = (
    component: string,
    traceId: string,
    step: string,
    message: string,
    data?: unknown,
    level: LogLevel = "log"
) => {
    if (!VERBOSE_LOGS && level === "log") return;
    const stamp = new Date().toISOString();
    const prefix = `[${component}] [trace:${traceId}] [${step}] ${stamp} ${message}`;
    if (level === "warn") {
        data === undefined ? console.warn(prefix) : console.warn(prefix, data);
        return;
    }
    if (level === "error") {
        data === undefined ? console.error(prefix) : console.error(prefix, data);
        return;
    }
    data === undefined ? console.log(prefix) : console.log(prefix, data);
};

const ERROR_TEXT_SCAN_LIMIT = 260_000;

type JsonCandidate = {
    text: string;
    strategy: string;
};

const extractErrorText = (error: unknown): string => {
    const candidate = (error as any)?.text;
    if (typeof candidate === "string" && candidate.trim()) return candidate;
    const nested = (error as any)?.responseBody;
    if (typeof nested === "string" && nested.trim()) return nested;
    return "";
};

const stripMarkdownCodeFence = (text: string): string => {
    const trimmed = text.trim();
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced?.[1]) return fenced[1].trim();
    return trimmed;
};

const firstJsonStartIndex = (text: string): number => {
    const obj = text.indexOf("{");
    const arr = text.indexOf("[");
    if (obj === -1) return arr;
    if (arr === -1) return obj;
    return Math.min(obj, arr);
};

const extractBalancedJsonCandidate = (text: string): JsonCandidate | null => {
    const start = firstJsonStartIndex(text);
    if (start < 0) return null;

    const stack: string[] = [];
    let inString = false;
    let escaped = false;
    let end = -1;

    for (let i = start; i < text.length; i++) {
        const ch = text[i];
        if (inString) {
            if (escaped) {
                escaped = false;
                continue;
            }
            if (ch === "\\") {
                escaped = true;
                continue;
            }
            if (ch === "\"") inString = false;
            continue;
        }
        if (ch === "\"") {
            inString = true;
            continue;
        }
        if (ch === "{") {
            stack.push("}");
            continue;
        }
        if (ch === "[") {
            stack.push("]");
            continue;
        }
        if (ch === "}" || ch === "]") {
            if (!stack.length) continue;
            const expected = stack.pop();
            if (expected !== ch) return null;
            if (stack.length === 0) {
                end = i;
                break;
            }
        }
    }

    if (end >= start) {
        return {
            text: text.slice(start, end + 1),
            strategy: "balanced-extract",
        };
    }

    if (!stack.length) return null;
    let suffix = "";
    while (stack.length) suffix += stack.pop();
    return {
        text: `${text.slice(start).trimEnd()}${suffix}`,
        strategy: "balanced-autoclose",
    };
};

const parseCandidateWithSchema = <T>(candidate: string, schema: z.ZodTypeAny): T | null => {
    try {
        const parsed = JSON.parse(candidate);
        const validated = schema.safeParse(parsed);
        if (!validated.success) return null;
        return validated.data as T;
    } catch {
        return null;
    }
};

const recoverStructuredObjectFromErrorText = <T>(
    error: unknown,
    schema: z.ZodTypeAny,
    component: string,
    traceId: string
): T | null => {
    const rawText = extractErrorText(error);
    if (!rawText) return null;

    const capped = rawText.length > ERROR_TEXT_SCAN_LIMIT ? rawText.slice(0, ERROR_TEXT_SCAN_LIMIT) : rawText;
    const stripped = stripMarkdownCodeFence(capped);
    const candidates: JsonCandidate[] = [];
    const balanced = extractBalancedJsonCandidate(stripped);
    if (balanced) candidates.push(balanced);
    if (stripped) candidates.push({ text: stripped, strategy: "raw-text" });

    const seen = new Set<string>();
    for (const candidate of candidates) {
        const normalized = candidate.text.trim();
        if (!normalized || seen.has(normalized)) continue;
        seen.add(normalized);
        const recovered = parseCandidateWithSchema<T>(normalized, schema);
        if (!recovered) continue;
        traceLog(component, traceId, "recovery", "recovered structured object from malformed model output", {
            strategy: candidate.strategy,
            rawChars: rawText.length,
            usedChars: normalized.length,
        }, "warn");
        return recovered;
    }
    return null;
};

const VISION_SYSTEM_PROMPT =
    "You are an expert Architectural Intelligence Agent. Return exactly one valid JSON object that strictly matches the provided schema. No markdown, no comments, no prose, and no trailing characters.";

const TEXT_SYSTEM_PROMPT =
    "You are an expert Engineering Intelligence Agent. Return exactly one valid JSON object that strictly matches the provided schema. No markdown, no comments, no prose, and no trailing characters.";

const toFlatPolygon = (polygon: any): number[] => {
    if (!Array.isArray(polygon)) return [];
    if (polygon.length > 0 && typeof polygon[0] === 'number') {
        return polygon.map((value: number) => Number(value.toFixed(3)));
    }

    const flattened: number[] = [];
    for (const point of polygon) {
        const x = typeof point?.x === 'number' ? point.x : null;
        const y = typeof point?.y === 'number' ? point.y : null;
        if (x == null || y == null) continue;
        flattened.push(Number(x.toFixed(3)), Number(y.toFixed(3)));
    }
    return flattened;
};

export interface BlueprintLayoutHints {
    pageCount: number;
    pages: Array<{
        pageNumber: number;
        width: number;
        height: number;
        unit: string;
        lineCount: number;
        wordCount: number;
    }>;
    linePolygons: number[][];
    dimensionAnchors: Array<{
        text: string;
        polygon: number[];
    }>;
    lineTexts: string[];
    floorLabelAnchors: Array<{
        text: string;
        polygon: number[];
    }>;
    semanticAnchors?: Array<{
        text: string;
        polygon: number[];
    }>;
}

/** Helper to get the model with correct deployment name and settings */
export const getAzureModel = (_isVision = false, deploymentOverride?: string) => {
    if (!azureBaseUrl && !azureResourceName) {
        throw new Error(
            "Azure OpenAI endpoint is not configured. Set AZURE_OPENAI_ENDPOINT or AZURE_OPENAI_RESOURCE_NAME."
        );
    }
    // Must use .chat() because the default goes to the unsupported /responses endpoint
    return azureFixed.chat(deploymentOverride || routerDeploymentName);
};

const getDeploymentOrder = () => {
    const ordered = preferTopModel
        ? [topDeploymentName, routerDeploymentName]
        : [routerDeploymentName];
    return Array.from(new Set(ordered.filter(Boolean)));
};

const isDeploymentLookupError = (error: unknown) => {
    const message = typeof error === "string"
        ? error
        : (error as any)?.message || String(error);
    return DEPLOYMENT_ERROR_PATTERN.test(message);
};

/**
 * Zod Schema for GeometricReconstruction to enforce rigorous JSON parsing via AI SDK
 */
const confidenceScoreSchema = z.number().min(0).max(1);

const GeometricReconstructionSchema = z.object({
    meta: z.object({
        unit: z.enum(["m", "cm", "mm", "ft", "in", "unknown"]).nullable(),
        scale_m_per_px: z.number().nullable(),
        scale_confidence: confidenceScoreSchema.nullable(),
        rotation_deg: z.number().nullable(),
        floor_count: z.number().int().nullable(),
    }).strict(),
    walls: z.array(z.object({
        id: z.union([z.string(), z.number()]),
        start: z.array(z.number()),
        end: z.array(z.number()),
        thickness: z.number(),
        height: z.number(),
        confidence: confidenceScoreSchema.nullable(),
        color: z.string().nullable(),
        is_exterior: z.boolean(),
        floor_level: z.number().describe("0 for Ground, 1 for First Floor, etc."),
    })).describe("List of walls"),
    doors: z.array(z.object({
        id: z.union([z.string(), z.number()]),
        host_wall_id: z.union([z.string(), z.number()]),
        position: z.array(z.number()),
        width: z.number(),
        height: z.number(),
        swing: z.enum(["left", "right", "unknown"]).nullable(),
        confidence: confidenceScoreSchema.nullable(),
        color: z.string().nullable(),
        floor_level: z.number().describe("0 for Ground, 1 for First Floor, etc."),
    })).describe("List of doors"),
    windows: z.array(z.object({
        id: z.union([z.string(), z.number()]),
        host_wall_id: z.union([z.string(), z.number()]),
        position: z.array(z.number()),
        width: z.number(),
        sill_height: z.number(),
        confidence: confidenceScoreSchema.nullable(),
        color: z.string().nullable(),
        floor_level: z.number().describe("0 for Ground, 1 for First Floor, etc."),
    })).describe("List of windows"),
    rooms: z.array(z.object({
        id: z.union([z.string(), z.number()]),
        name: z.string(),
        polygon: z.array(z.array(z.number())),
        area: z.number(),
        confidence: confidenceScoreSchema.nullable(),
        floor_color: z.string().nullable(),
        floor_level: z.number().describe("0 for Ground, 1 for First Floor, etc."),
    })).describe("List of rooms"),
    furnitures: z.array(z.object({
        id: z.union([z.string(), z.number()]),
        room_id: z.union([z.string(), z.number()]),
        type: z.string(),
        position: z.array(z.number()),
        width: z.number(),
        depth: z.number(),
        height: z.number(),
        color: z.string().nullable(),
        description: z.string(),
        floor_level: z.number()
    })).describe("Interior furniture or equipment elements"),
    roof: z.object({
        type: z.enum(['flat', 'gable', 'hip']),
        polygon: z.array(z.array(z.number())),
        height: z.number(),
        base_height: z.number(),
        color: z.string().nullable(),
    }).nullable().describe("Building roof structure (null if no roof)"),
    topology_checks: z.object({
        closed_wall_loops: z.boolean().nullable(),
        self_intersections: z.number().int().nonnegative().nullable(),
        dangling_walls: z.number().int().nonnegative().nullable(),
        unhosted_openings: z.number().int().nonnegative().nullable(),
        room_polygon_validity_pass: z.boolean().nullable(),
    }).nullable().describe("Topological quality checks for geometric validity"),
    conflicts: z.array(z.object({
        type: z.enum(['structural', 'safety', 'code']),
        severity: z.enum(['low', 'medium', 'high']),
        description: z.string(),
        location: z.array(z.number()),
    })).describe("Potential construction issues"),
    building_name: z.string().nullable().describe("Descriptive name of the project"),
    exterior_color: z.string().nullable().describe("Main color of the building exterior"),
});

// GeometricReconstruction type is imported from reconstruction-types.ts in the consumer files

/**
 * Common Logic for Document Intelligence (OCR)
 */
export const getDocumentClient = () => {
    if (!docIntelEndpoint || !docIntelKey) return null;
    return new DocumentAnalysisClient(docIntelEndpoint, new AzureKeyCredential(docIntelKey));
};

type DocIntelProbeOptions = {
    sampleDocumentUrl?: string;
    timeoutMs?: number;
};

export type DocIntelProbeResult = {
    configured: boolean;
    endpointConfigured: boolean;
    keyConfigured: boolean;
    endpointHost: string | null;
    probePerformed: boolean;
    probeSucceeded: boolean;
    pageCount?: number;
    warning?: string;
    error?: string;
};

const toEndpointHost = (endpoint?: string | null) => {
    if (!endpoint) return null;
    try {
        return new URL(endpoint).host;
    } catch {
        return endpoint;
    }
};

const toErrorString = (error: unknown) => {
    if (error instanceof Error) return error.message;
    return String(error);
};

export async function probeDocumentIntelligence(options: DocIntelProbeOptions = {}): Promise<DocIntelProbeResult> {
    const endpointConfigured = !!docIntelEndpoint;
    const keyConfigured = !!docIntelKey;
    const configured = endpointConfigured && keyConfigured;
    const endpointHost = toEndpointHost(docIntelEndpoint);

    if (!configured) {
        return {
            configured,
            endpointConfigured,
            keyConfigured,
            endpointHost,
            probePerformed: false,
            probeSucceeded: false,
            warning: 'Azure Document Intelligence endpoint/key not configured.',
        };
    }

    const client = getDocumentClient();
    if (!client) {
        return {
            configured,
            endpointConfigured,
            keyConfigured,
            endpointHost,
            probePerformed: false,
            probeSucceeded: false,
            warning: 'Document client could not be initialized.',
        };
    }

    const sampleDocumentUrl = options.sampleDocumentUrl?.trim();
    if (!sampleDocumentUrl) {
        return {
            configured,
            endpointConfigured,
            keyConfigured,
            endpointHost,
            probePerformed: false,
            probeSucceeded: true,
            warning: 'No sampleDocumentUrl provided. Credentials format check only.',
        };
    }

    const timeoutMs = Number.isFinite(options.timeoutMs as number)
        ? Math.max(5_000, Number(options.timeoutMs))
        : 20_000;

    try {
        const probePromise = (async () => {
            const poller = await client.beginAnalyzeDocumentFromUrl('prebuilt-layout', sampleDocumentUrl);
            const result: any = await poller.pollUntilDone();
            const pageCount = Array.isArray(result?.pages) ? result.pages.length : 0;
            return pageCount;
        })();

        const timeoutPromise = new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`Probe timed out after ${timeoutMs}ms`)), timeoutMs)
        );

        const pageCount = await Promise.race([probePromise, timeoutPromise]);
        return {
            configured,
            endpointConfigured,
            keyConfigured,
            endpointHost,
            probePerformed: true,
            probeSucceeded: true,
            pageCount,
        };
    } catch (error) {
        return {
            configured,
            endpointConfigured,
            keyConfigured,
            endpointHost,
            probePerformed: true,
            probeSucceeded: false,
            error: toErrorString(error),
        };
    }
}

export async function analyzeBlueprintLayoutFromBase64(base64Image: string): Promise<BlueprintLayoutHints | null> {
    const traceId = createTraceId("layout");
    const client = getDocumentClient();
    if (!client) {
        traceLog("Azure Document Intelligence", traceId, "0/3", "Layout analysis skipped: credentials missing", undefined, "warn");
        return null;
    }

    try {
        const startedAt = Date.now();
        let cleanedBase64 = base64Image;
        if (base64Image.includes('data:image')) {
            cleanedBase64 = base64Image.split('base64,')[1];
        }

        traceLog("Azure Document Intelligence", traceId, "1/3", "preparing prebuilt-layout request", {
            imageChars: cleanedBase64.length,
        });
        const imageBuffer = Buffer.from(cleanedBase64, "base64");
        const poller = await client.beginAnalyzeDocument("prebuilt-layout", imageBuffer);
        traceLog("Azure Document Intelligence", traceId, "2/3", "request submitted, waiting for analysis");
        const result: any = await poller.pollUntilDone();

        if (!result?.pages?.length) {
            traceLog("Azure Document Intelligence", traceId, "3/3", "no pages detected in layout result", undefined, "warn");
            return null;
        }

        const linePolygons: number[][] = [];
        const dimensionAnchors: Array<{ text: string; polygon: number[]; }> = [];
        const lineTexts: string[] = [];
        const floorLabelAnchors: Array<{ text: string; polygon: number[]; }> = [];
        const semanticAnchors: Array<{ text: string; polygon: number[]; }> = [];
        const semanticSeen = new Set<string>();
        const pages = result.pages.map((page: any) => {
            const lines = Array.isArray(page?.lines) ? page.lines : [];
            const words = Array.isArray(page?.words) ? page.words : [];

            for (const line of lines) {
                const polygon = toFlatPolygon(line?.polygon);
                if (linePolygons.length < LAYOUT_POLYGON_LIMIT) {
                    if (polygon.length >= 6) linePolygons.push(polygon);
                }

                const text = typeof line?.content === "string" ? line.content.trim() : "";
                if (text && lineTexts.length < LAYOUT_LINE_TEXT_LIMIT) {
                    lineTexts.push(text.slice(0, 160));
                }
                if (text && DIMENSION_TEXT_REGEX.test(text) && dimensionAnchors.length < LAYOUT_DIMENSION_ANCHOR_LIMIT) {
                    if (polygon.length >= 6) {
                        dimensionAnchors.push({ text, polygon });
                    }
                }
                if (text && FLOOR_LABEL_HINT_REGEX.test(text) && floorLabelAnchors.length < LAYOUT_FLOOR_LABEL_LIMIT) {
                    if (polygon.length >= 6) {
                        floorLabelAnchors.push({ text: text.slice(0, 96), polygon });
                    }
                }
                if (text && SEMANTIC_TEXT_REGEX.test(text) && semanticAnchors.length < LAYOUT_SEMANTIC_ANCHOR_LIMIT) {
                    if (polygon.length >= 6) {
                        const cleanText = text.slice(0, 120);
                        const dedupeKey = `${cleanText.toLowerCase()}|${polygon.join(',')}`;
                        if (!semanticSeen.has(dedupeKey)) {
                            semanticSeen.add(dedupeKey);
                            semanticAnchors.push({ text: cleanText, polygon });
                        }
                    }
                }
            }

            return {
                pageNumber: page?.pageNumber || 0,
                width: typeof page?.width === "number" ? page.width : 0,
                height: typeof page?.height === "number" ? page.height : 0,
                unit: page?.unit || "pixel",
                lineCount: lines.length,
                wordCount: words.length,
            };
        });

        const durationMs = Date.now() - startedAt;
        traceLog("Azure Document Intelligence", traceId, "3/3", `layout analysis complete in ${durationMs}ms`, {
            pages: pages.length,
            polygons: linePolygons.length,
            dimensionAnchors: dimensionAnchors.length,
            semanticAnchors: semanticAnchors.length,
        });

        return {
            pageCount: pages.length,
            pages,
            linePolygons,
            dimensionAnchors,
            lineTexts,
            floorLabelAnchors,
            semanticAnchors,
        };
    } catch (e: any) {
        traceLog("Azure Document Intelligence", traceId, "error", "layout analysis failed", {
            error: e?.message || String(e),
        }, "warn");
        return null;
    }
}

export async function generateAzureVisionObject<T>(prompt: string, base64Image: string, dynamicSchema?: z.ZodType<any>): Promise<T> {
    const traceId = createTraceId("vision");
    if (!azureKey) {
        throw new Error("Azure OpenAI credentials (AZURE_OPENAI_KEY) are not configured. Vision synthesis requires a production key.");
    }

    const deploymentOrder = getDeploymentOrder();
    const startedAt = Date.now();

    try {
        traceLog("Azure Vision via AI SDK", traceId, "1/4", "preparing request", {
            deploymentOrder,
            promptChars: prompt.length,
            hasCustomSchema: !!dynamicSchema,
        });

        let cleanedBase64 = base64Image;
        if (base64Image.includes('data:image')) {
            cleanedBase64 = base64Image.split('base64,')[1];
        }

        traceLog("Azure Vision via AI SDK", traceId, "2/4", "sending vision request to Azure", {
            imageChars: cleanedBase64.length,
            hasCustomSchema: !!dynamicSchema,
        });

        let lastError: unknown = null;
        const schema = dynamicSchema || GeometricReconstructionSchema;
        for (let i = 0; i < deploymentOrder.length; i++) {
            const deployment = deploymentOrder[i];
            const isRouter = deployment === routerDeploymentName;
            traceLog("Azure Vision via AI SDK", traceId, "2/4", "attempting deployment", {
                attempt: i + 1,
                totalAttempts: deploymentOrder.length,
                deployment,
                mode: isRouter ? "router" : "top-model",
            });

            try {
                const result = await generateObject({
                    model: getAzureModel(true, deployment),
                    schema,
                    temperature: 0.1, // Reduced to prevent unclosed JSON from hallucinated extreme details
                    system: VISION_SYSTEM_PROMPT,
                    messages: [
                        {
                            role: "user",
                            content: [
                                { type: "text", text: prompt },
                                { type: "image", image: cleanedBase64 }
                            ]
                        }
                    ]
                });

                const durationMs = Date.now() - startedAt;
                traceLog("Azure Vision via AI SDK", traceId, "3/4", `response received in ${durationMs}ms`, summarizeStructured(result.object));
                traceLog("Azure Vision via AI SDK", traceId, "4/4", "returning structured object");
                return result.object as unknown as T;
            } catch (error: any) {
                const recovered = recoverStructuredObjectFromErrorText<T>(
                    error,
                    schema,
                    "Azure Vision via AI SDK",
                    traceId
                );
                if (recovered) {
                    const durationMs = Date.now() - startedAt;
                    traceLog("Azure Vision via AI SDK", traceId, "3/4", `response recovered in ${durationMs}ms`, summarizeStructured(recovered as any));
                    traceLog("Azure Vision via AI SDK", traceId, "4/4", "returning recovered structured object");
                    return recovered;
                }
                lastError = error;
                const canRetry = i < deploymentOrder.length - 1 && isDeploymentLookupError(error);
                if (!canRetry) throw error;
                traceLog("Azure Vision via AI SDK", traceId, "2/4", "deployment failed; retrying next deployment", {
                    deployment,
                    error: error?.message || String(error),
                }, "warn");
            }
        }

        throw lastError || new Error("Azure Vision request failed for all deployments.");
    } catch (e: any) {
        traceLog("Azure Vision via AI SDK", traceId, "error", "vision request failed", {
            error: e?.message || String(e),
        }, "error");
        throw e;
    }
}

/**
 * Text-only Generation for 3D buildings from description
 */
export async function generateAzureObject<T>(prompt: string, dynamicSchema?: z.ZodType<any>): Promise<T> {
    const traceId = createTraceId("text");
    if (!azureKey) {
        throw new Error("Azure OpenAI credentials (AZURE_OPENAI_KEY) are not configured. Text-to-BIM generation requires a production key.");
    }

    const deploymentOrder = getDeploymentOrder();
    const startedAt = Date.now();

    try {
        traceLog("Azure AI SDK", traceId, "1/3", "preparing text-to-object request", {
            deploymentOrder,
            promptChars: prompt.length,
            hasCustomSchema: !!dynamicSchema,
        });

        let lastError: unknown = null;
        const schema = dynamicSchema || GeometricReconstructionSchema;
        for (let i = 0; i < deploymentOrder.length; i++) {
            const deployment = deploymentOrder[i];
            const isRouter = deployment === routerDeploymentName;
            traceLog("Azure AI SDK", traceId, "1/3", "attempting deployment", {
                attempt: i + 1,
                totalAttempts: deploymentOrder.length,
                deployment,
                mode: isRouter ? "router" : "top-model",
            });

            try {
                const result = await generateObject({
                    model: getAzureModel(false, deployment),
                    schema,
                    temperature: 0.2, // Lower variety for strict structured output without hallucinated massive structures
                    system: TEXT_SYSTEM_PROMPT,
                    prompt: prompt
                });

                const durationMs = Date.now() - startedAt;
                traceLog("Azure AI SDK", traceId, "2/3", `response received in ${durationMs}ms`, summarizeStructured(result.object));
                traceLog("Azure AI SDK", traceId, "3/3", "returning structured object");
                return result.object as unknown as T;
            } catch (error: any) {
                const recovered = recoverStructuredObjectFromErrorText<T>(
                    error,
                    schema,
                    "Azure AI SDK",
                    traceId
                );
                if (recovered) {
                    const durationMs = Date.now() - startedAt;
                    traceLog("Azure AI SDK", traceId, "2/3", `response recovered in ${durationMs}ms`, summarizeStructured(recovered as any));
                    traceLog("Azure AI SDK", traceId, "3/3", "returning recovered structured object");
                    return recovered;
                }
                lastError = error;
                const canRetry = i < deploymentOrder.length - 1 && isDeploymentLookupError(error);
                if (!canRetry) throw error;
                traceLog("Azure AI SDK", traceId, "1/3", "deployment failed; retrying next deployment", {
                    deployment,
                    error: error?.message || String(error),
                }, "warn");
            }
        }

        throw lastError || new Error("Azure text request failed for all deployments.");
    } catch (e: any) {
        traceLog("Azure AI SDK", traceId, "error", "text request failed", {
            error: e?.message || String(e),
        }, "error");
        throw e;
    }
}



/**
 * Analyze Document using Document Intelligence (OCR)
 */
const DATA_URL_PREFIX = /^data:/i;
const HTTP_URL_PREFIX = /^https?:\/\//i;
const LEGACY_DOC_EXTENSION = '.doc';
const DOCUMENT_TEXT_LIMIT = 180_000;

type PreparedDocumentInput =
    | { kind: 'text'; text: string; source: string; }
    | {
        kind: 'binary';
        source: string;
        fileName: string;
        extension: string;
        mimeType: string;
        buffer?: Buffer;
        url?: string;
    };

const normalizeDocumentText = (value: string, maxChars = DOCUMENT_TEXT_LIMIT): string => {
    const normalized = String(value || '')
        .replace(/\r/g, '')
        .replace(/\t/g, ' ')
        .replace(/[ \u00A0]{2,}/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    if (normalized.length <= maxChars) return normalized;
    return `${normalized.slice(0, maxChars)}\n...[TEXT TRIMMED]...`;
};

const getErrorMessage = (error: unknown) =>
    error instanceof Error ? error.message : String(error);

const isMissingModuleError = (message: string) =>
    /module not found|cannot find module|err_module_not_found|can't resolve/i.test(message);

const dynamicImportModule = async (modulePath: string): Promise<any> => {
    const importer = new Function('modulePath', 'return import(modulePath);') as (modulePath: string) => Promise<any>;
    return importer(modulePath);
};

const extractExtension = (fileName: string): string => {
    const lower = fileName.toLowerCase();
    const idx = lower.lastIndexOf('.');
    return idx >= 0 ? lower.slice(idx) : '';
};

const inferMimeTypeFromExtension = (extension: string): string => {
    switch (extension.toLowerCase()) {
        case '.pdf': return 'application/pdf';
        case '.docx': return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
        case '.png': return 'image/png';
        case '.jpg':
        case '.jpeg': return 'image/jpeg';
        case '.webp': return 'image/webp';
        case '.bmp': return 'image/bmp';
        case '.tif':
        case '.tiff': return 'image/tiff';
        case '.txt': return 'text/plain';
        case '.html':
        case '.htm': return 'text/html';
        default: return '';
    }
};

const parseDataUrlMimeType = (value: string): string => {
    const match = value.match(/^data:([^;,]+)[;,]/i);
    return match?.[1]?.toLowerCase() || '';
};

const stripDataUrlBase64 = (value: string): string => {
    const marker = 'base64,';
    const index = value.indexOf(marker);
    if (index === -1) return value;
    return value.slice(index + marker.length);
};

const isPdfInput = (mimeType: string, extension: string, buffer?: Buffer) => {
    if (mimeType.includes('application/pdf') || extension === '.pdf') return true;
    return !!buffer && buffer.length >= 5 && buffer.slice(0, 5).toString('utf8') === '%PDF-';
};

const isDocxInput = (mimeType: string, extension: string, buffer?: Buffer) => {
    if (extension === '.docx') return true;
    if (mimeType.includes('wordprocessingml.document')) return true;
    if (!buffer || buffer.length < 4) return false;
    return buffer[0] === 0x50 && buffer[1] === 0x4B && buffer[2] === 0x03 && buffer[3] === 0x04;
};

const isImageInput = (mimeType: string, extension: string) => {
    if (mimeType.startsWith('image/')) return true;
    return ['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.tif', '.tiff'].includes(extension);
};

const isPlainTextInput = (mimeType: string, extension: string) => {
    if (mimeType.startsWith('text/')) return true;
    return ['.txt', '.md', '.csv', '.json', '.xml', '.html', '.htm'].includes(extension);
};

const fileNameFromUrl = (url: string) => {
    try {
        const parsed = new URL(url);
        const segments = parsed.pathname.split('/').filter(Boolean);
        return segments[segments.length - 1] || 'remote-document';
    } catch {
        return 'remote-document';
    }
};

const prepareDocumentInput = async (input: string | File | ArrayBuffer): Promise<PreparedDocumentInput> => {
    if (typeof input === 'string') {
        const trimmed = input.trim();
        if (!trimmed) {
            throw new Error('Blueprint input is empty.');
        }
        if (HTTP_URL_PREFIX.test(trimmed)) {
            const fileName = fileNameFromUrl(trimmed);
            const extension = extractExtension(fileName);
            return {
                kind: 'binary',
                source: 'url',
                url: trimmed,
                fileName,
                extension,
                mimeType: inferMimeTypeFromExtension(extension),
            };
        }
        if (DATA_URL_PREFIX.test(trimmed)) {
            const mimeType = parseDataUrlMimeType(trimmed);
            const extension = extractExtension(`payload.${mimeType.split('/')[1] || ''}`);
            return {
                kind: 'binary',
                source: 'data-url',
                fileName: `upload${extension}`,
                extension,
                mimeType,
                buffer: Buffer.from(stripDataUrlBase64(trimmed), 'base64'),
            };
        }
        return {
            kind: 'text',
            source: 'raw-string',
            text: normalizeDocumentText(trimmed),
        };
    }

    if (typeof File !== 'undefined' && input instanceof File) {
        const fileName = input.name || 'upload.bin';
        const extension = extractExtension(fileName);
        const mimeType = (input.type || inferMimeTypeFromExtension(extension)).toLowerCase();
        const buffer = Buffer.from(await input.arrayBuffer());
        return {
            kind: 'binary',
            source: 'file',
            fileName,
            extension,
            mimeType,
            buffer,
        };
    }

    const buffer = Buffer.from(input as ArrayBuffer);
    return {
        kind: 'binary',
        source: 'array-buffer',
        fileName: 'upload.bin',
        extension: '',
        mimeType: '',
        buffer,
    };
};

const collectTextFromLayoutResult = (result: any): string => {
    const pages = Array.isArray(result?.pages) ? result.pages : [];
    const tables = Array.isArray(result?.tables) ? result.tables : [];
    const chunks: string[] = [];

    for (const page of pages) {
        const pageNumber = Number(page?.pageNumber || 0);
        const lines = Array.isArray(page?.lines) ? page.lines : [];
        const lineTexts = lines
            .map((line: any) => String(line?.content || '').trim())
            .filter(Boolean);

        if (lineTexts.length > 0) {
            chunks.push(`PAGE ${pageNumber || chunks.length + 1}`);
            chunks.push(...lineTexts);
        }

        const pageTables = tables.filter((table: any) =>
            Array.isArray(table?.boundingRegions) &&
            table.boundingRegions.some((region: any) => Number(region?.pageNumber || 0) === pageNumber)
        );

        pageTables.forEach((table: any, tableIndex: number) => {
            const rowCount = Math.max(1, Number(table?.rowCount || 0));
            const rows: string[][] = Array.from({ length: rowCount }, () => []);
            const cells = Array.isArray(table?.cells) ? table.cells : [];

            for (const cell of cells) {
                const rowIndex = Number(cell?.rowIndex || 0);
                const columnIndex = Number(cell?.columnIndex || 0);
                if (!rows[rowIndex]) rows[rowIndex] = [];
                rows[rowIndex][columnIndex] = String(cell?.content || '').replace(/\s+/g, ' ').trim();
            }

            const renderedRows = rows
                .map((row) => row.filter((value) => value != null && value !== '').join(' | '))
                .filter(Boolean);

            if (renderedRows.length > 0) {
                chunks.push(`TABLE ${tableIndex + 1} PAGE ${pageNumber || chunks.length + 1}`);
                chunks.push(...renderedRows);
            }
        });
    }

    if (chunks.length > 0) {
        return normalizeDocumentText(chunks.join('\n'));
    }

    return normalizeDocumentText(String(result?.content || ''));
};

const extractPdfTextLocally = async (buffer: Buffer): Promise<string | null> => {
    try {
        const module: any = await import('pdf-parse');
        const parse = module?.default || module;
        if (typeof parse !== 'function') return null;
        const parsed = await parse(buffer);
        const text = normalizeDocumentText(String(parsed?.text || ''));
        return text || null;
    } catch (error) {
        const message = getErrorMessage(error);
        if (isMissingModuleError(message)) return null;
        throw error;
    }
};

const extractDocxTextLocally = async (buffer: Buffer): Promise<string | null> => {
    try {
        const module: any = await import('mammoth');
        const mammoth = module?.default || module;
        if (typeof mammoth?.extractRawText !== 'function') return null;
        const result = await mammoth.extractRawText({ buffer });
        const text = normalizeDocumentText(String(result?.value || ''));
        return text || null;
    } catch (error) {
        const message = getErrorMessage(error);
        if (isMissingModuleError(message)) return null;
        throw error;
    }
};

const extractImageTextLocally = async (buffer: Buffer): Promise<string | null> => {
    try {
        const module: any = await dynamicImportModule('tesseract.js');
        const recognize = module?.recognize || module?.default?.recognize;
        if (typeof recognize !== 'function') return null;
        const result = await recognize(buffer, 'eng', { logger: () => undefined });
        const text = normalizeDocumentText(String(result?.data?.text || ''));
        if (text) return text;

        const lines = Array.isArray(result?.data?.lines) ? result.data.lines : [];
        const fallbackText = normalizeDocumentText(
            lines.map((line: any) => String(line?.text || '').trim()).filter(Boolean).join('\n')
        );
        return fallbackText || null;
    } catch (error) {
        const message = getErrorMessage(error);
        if (isMissingModuleError(message)) return null;
        throw error;
    }
};

const extractTextLocally = async (input: Extract<PreparedDocumentInput, { kind: 'binary'; }>): Promise<string | null> => {
    const mimeType = (input.mimeType || '').toLowerCase();
    const extension = (input.extension || '').toLowerCase();
    const buffer = input.buffer;

    if (extension === LEGACY_DOC_EXTENSION) {
        throw new Error('Legacy .doc files are not supported for reliable parsing. Convert to .docx or PDF.');
    }
    if (!buffer || buffer.length === 0) return null;

    if (isPdfInput(mimeType, extension, buffer)) {
        return extractPdfTextLocally(buffer);
    }
    if (isDocxInput(mimeType, extension, buffer)) {
        return extractDocxTextLocally(buffer);
    }
    if (isImageInput(mimeType, extension)) {
        return extractImageTextLocally(buffer);
    }
    if (isPlainTextInput(mimeType, extension)) {
        return normalizeDocumentText(buffer.toString('utf8'));
    }
    return null;
};

export async function analyzeBlueprintDocument(file: string | File | ArrayBuffer): Promise<string> {
    const prepared = await prepareDocumentInput(file);
    if (prepared.kind === 'text') {
        return prepared.text;
    }

    const client = getDocumentClient();
    let azureError: unknown = null;

    if (client) {
        try {
            const startedAt = Date.now();
            const poller = prepared.url
                ? await client.beginAnalyzeDocumentFromUrl('prebuilt-layout', prepared.url)
                : await client.beginAnalyzeDocument('prebuilt-layout', prepared.buffer as Buffer);
            const result: any = await poller.pollUntilDone();
            const text = collectTextFromLayoutResult(result);
            if (text) {
                console.log('[Azure Document Intelligence] OCR extraction complete', {
                    source: prepared.source,
                    fileName: prepared.fileName,
                    chars: text.length,
                    durationMs: Date.now() - startedAt,
                });
                return text;
            }
            throw new Error('Layout analysis completed but no text content was extracted.');
        } catch (error) {
            azureError = error;
            console.warn('[Azure Document Intelligence] OCR extraction failed', {
                source: prepared.source,
                fileName: prepared.fileName,
                error: getErrorMessage(error),
            });
        }
    } else {
        console.warn('[Azure Document Intelligence] credentials missing. Attempting local OCR/text extraction fallback.');
    }

    const localText = await extractTextLocally(prepared);
    if (localText) {
        return localText;
    }

    const azureMessage = azureError ? ` Azure error: ${getErrorMessage(azureError)}` : '';
    throw new Error(
        `Unable to extract blueprint text from "${prepared.fileName}". Configure Azure Document Intelligence credentials or upload a parsable PDF/DOCX/image.${azureMessage}`
    );
}
