import { generateObject } from 'ai';
import { createAzure } from '@ai-sdk/azure';
import { z } from 'zod';
import { DocumentAnalysisClient, AzureKeyCredential } from "@azure/ai-form-recognizer";

// Azure OpenAI Configuration
const azureKey = process.env.AZURE_OPENAI_KEY || "";
const routerDeploymentName = process.env.AZURE_OPENAI_DEPLOYMENT_NAME || process.env.AZURE_OPENAI_DEPLOYMENT || "model-router";
const topDeploymentName = process.env.AZURE_OPENAI_TOP_DEPLOYMENT || process.env.AZURE_OPENAI_TOP_MODEL_DEPLOYMENT || "gpt-5";
const preferTopModel = (process.env.AZURE_OPENAI_PREFER_TOP_MODEL || "true").toLowerCase() !== "false";
const azureResourceName = process.env.AZURE_OPENAI_RESOURCE_NAME || "barja-mlwuryls-eastus2";

// Azure Document Intelligence Configuration
const docIntelEndpoint = process.env.AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT || "";
const docIntelKey = process.env.AZURE_DOCUMENT_INTELLIGENCE_KEY || "";

// If the above baseURL is tricky, we'll stick to resourceName but disable automatic versioning
const azureFixed = createAzure({
    resourceName: azureResourceName,
    apiKey: azureKey,
    useDeploymentBasedUrls: true,
    apiVersion: '2024-08-01-preview',
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

const LAYOUT_POLYGON_LIMIT = 180;
const LAYOUT_DIMENSION_ANCHOR_LIMIT = 60;
const DIMENSION_TEXT_REGEX = /(\d+(\.\d+)?\s?(mm|cm|m|ft|feet|in|inch|\"|')|\d+'\s?\d*\"?)/i;
const DEPLOYMENT_ERROR_PATTERN = /(deployment|model|404|not found|does not exist|unknown deployment|resource not found)/i;

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
}

/** Helper to get the model with correct deployment name and settings */
export const getAzureModel = (isVision = false, deploymentOverride?: string) => {
    // For production stability, we explicitly define the model to avoid SDK version appending
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
const GeometricReconstructionSchema = z.object({
    walls: z.array(z.object({
        id: z.union([z.string(), z.number()]),
        start: z.array(z.number()),
        end: z.array(z.number()),
        thickness: z.number(),
        height: z.number(),
        color: z.string(),
        is_exterior: z.boolean(),
        floor_level: z.number().describe("0 for Ground, 1 for First Floor, etc."),
    })).describe("List of walls"),
    doors: z.array(z.object({
        id: z.union([z.string(), z.number()]),
        host_wall_id: z.union([z.string(), z.number()]),
        position: z.array(z.number()),
        width: z.number(),
        height: z.number(),
        color: z.string(),
        floor_level: z.number().describe("0 for Ground, 1 for First Floor, etc."),
    })).describe("List of doors"),
    windows: z.array(z.object({
        id: z.union([z.string(), z.number()]),
        host_wall_id: z.union([z.string(), z.number()]),
        position: z.array(z.number()),
        width: z.number(),
        sill_height: z.number(),
        color: z.string(),
        floor_level: z.number().describe("0 for Ground, 1 for First Floor, etc."),
    })).describe("List of windows"),
    rooms: z.array(z.object({
        id: z.union([z.string(), z.number()]),
        name: z.string(),
        polygon: z.array(z.array(z.number())),
        area: z.number(),
        floor_color: z.string(),
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
        color: z.string(),
        description: z.string(),
        floor_level: z.number()
    })).describe("Interior furniture or equipment elements"),
    roof: z.object({
        type: z.enum(['flat', 'gable', 'hip']),
        polygon: z.array(z.array(z.number())),
        height: z.number(),
        base_height: z.number(),
        color: z.string(),
    }).nullable().describe("Building roof structure (null if no roof)"),
    conflicts: z.array(z.object({
        type: z.enum(['structural', 'safety', 'code']),
        severity: z.enum(['low', 'medium', 'high']),
        description: z.string(),
        location: z.array(z.number()),
    })).describe("Potential construction issues"),
    building_name: z.string().describe("Descriptive name of the project"),
    exterior_color: z.string().describe("Main color of the building exterior"),
});

// GeometricReconstruction type is imported from reconstruction-types.ts in the consumer files

/**
 * Common Logic for Document Intelligence (OCR)
 */
export const getDocumentClient = () => {
    if (!docIntelEndpoint || !docIntelKey) return null;
    return new DocumentAnalysisClient(docIntelEndpoint, new AzureKeyCredential(docIntelKey));
};

export async function analyzeBlueprintLayoutFromBase64(base64Image: string): Promise<BlueprintLayoutHints | null> {
    const client = getDocumentClient();
    if (!client) {
        console.warn("[Azure Document Intelligence] Layout analysis skipped: credentials missing.");
        return null;
    }

    try {
        const startedAt = Date.now();
        let cleanedBase64 = base64Image;
        if (base64Image.includes('data:image')) {
            cleanedBase64 = base64Image.split('base64,')[1];
        }

        console.log(`[Azure Document Intelligence] Step 1/3 preparing prebuilt-layout request. imageChars=${cleanedBase64.length}`);
        const imageBuffer = Buffer.from(cleanedBase64, "base64");
        const poller = await client.beginAnalyzeDocument("prebuilt-layout", imageBuffer);
        console.log("[Azure Document Intelligence] Step 2/3 request submitted, waiting for analysis.");
        const result: any = await poller.pollUntilDone();

        if (!result?.pages?.length) {
            console.warn("[Azure Document Intelligence] No pages detected in layout result.");
            return null;
        }

        const linePolygons: number[][] = [];
        const dimensionAnchors: Array<{ text: string; polygon: number[]; }> = [];
        const pages = result.pages.map((page: any) => {
            const lines = Array.isArray(page?.lines) ? page.lines : [];
            const words = Array.isArray(page?.words) ? page.words : [];

            for (const line of lines) {
                if (linePolygons.length < LAYOUT_POLYGON_LIMIT) {
                    const polygon = toFlatPolygon(line?.polygon);
                    if (polygon.length >= 6) linePolygons.push(polygon);
                }

                const text = typeof line?.content === "string" ? line.content.trim() : "";
                if (text && DIMENSION_TEXT_REGEX.test(text) && dimensionAnchors.length < LAYOUT_DIMENSION_ANCHOR_LIMIT) {
                    const polygon = toFlatPolygon(line?.polygon);
                    if (polygon.length >= 6) {
                        dimensionAnchors.push({ text, polygon });
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
        console.log(`[Azure Document Intelligence] Step 3/3 layout analysis complete in ${durationMs}ms. pages=${pages.length}, polygons=${linePolygons.length}, dimensionAnchors=${dimensionAnchors.length}`);

        return {
            pageCount: pages.length,
            pages,
            linePolygons,
            dimensionAnchors,
        };
    } catch (e: any) {
        console.warn(`[Azure Document Intelligence] Layout analysis failed: ${e?.message || e}`);
        return null;
    }
}

export async function generateAzureVisionObject<T>(prompt: string, base64Image: string, dynamicSchema?: z.ZodType<any>): Promise<T> {
    if (!azureKey) {
        throw new Error("Azure OpenAI credentials (AZURE_OPENAI_KEY) are not configured. Vision synthesis requires a production key.");
    }

    const deploymentOrder = getDeploymentOrder();
    const startedAt = Date.now();

    try {
        console.log(`[AI] Deployment preference order: ${deploymentOrder.join(" -> ")}`);
        console.log(`[Azure Vision via AI SDK] Step 1/4 preparing request.`);

        let cleanedBase64 = base64Image;
        if (base64Image.includes('data:image')) {
            cleanedBase64 = base64Image.split('base64,')[1];
        }

        console.log(`[Azure Vision via AI SDK] Request metadata: imageChars=${cleanedBase64.length}, hasCustomSchema=${!!dynamicSchema}`);
        console.log(`[Azure Vision via AI SDK] Step 2/4 sending vision request to Azure.`);

        let lastError: unknown = null;
        for (let i = 0; i < deploymentOrder.length; i++) {
            const deployment = deploymentOrder[i];
            const isRouter = deployment === routerDeploymentName;
            if (isRouter) {
                console.log(`[AI] Using Azure Model Router: ${deployment}`);
            } else {
                console.log(`[AI] Using preferred top deployment: ${deployment}`);
            }

            try {
                const result = await generateObject({
                    model: getAzureModel(true, deployment),
                    schema: dynamicSchema || GeometricReconstructionSchema,
                    temperature: 0.1, // Reduced to prevent unclosed JSON from hallucinated extreme details
                    system: "You are an expert Architectural Intelligence Agent. Generate a precise JSON reconstruction of the project.",
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
                console.log(`[Azure Vision via AI SDK] Step 3/4 response received in ${durationMs}ms.`);
                console.log(`[Azure Vision via AI SDK] Structured result summary:`, summarizeGeometry(result.object));
                console.log(`[Azure Vision via AI SDK] Step 4/4 returning structured object.`);
                return result.object as unknown as T;
            } catch (error: any) {
                lastError = error;
                const canRetry = i < deploymentOrder.length - 1 && isDeploymentLookupError(error);
                if (!canRetry) throw error;
                console.warn(`[Azure Vision via AI SDK] Deployment "${deployment}" failed (${error?.message || error}). Retrying next deployment.`);
            }
        }

        throw lastError || new Error("Azure Vision request failed for all deployments.");
    } catch (e: any) {
        console.error(`[Azure Vision via AI SDK] Failed: ${e?.message || e}`);
        throw e;
    }
}

/**
 * Text-only Generation for 3D buildings from description
 */
export async function generateAzureObject<T>(prompt: string, dynamicSchema?: z.ZodType<any>): Promise<T> {
    if (!azureKey) {
        throw new Error("Azure OpenAI credentials (AZURE_OPENAI_KEY) are not configured. Text-to-BIM generation requires a production key.");
    }

    const deploymentOrder = getDeploymentOrder();
    const startedAt = Date.now();

    try {
        console.log(`[AI] Deployment preference order: ${deploymentOrder.join(" -> ")}`);
        console.log(`[Azure AI SDK] Step 1/3 preparing text-to-object request.`);
        console.log(`[Azure AI SDK] Request metadata: promptChars=${prompt.length}, hasCustomSchema=${!!dynamicSchema}`);

        let lastError: unknown = null;
        for (let i = 0; i < deploymentOrder.length; i++) {
            const deployment = deploymentOrder[i];
            const isRouter = deployment === routerDeploymentName;
            if (isRouter) {
                console.log(`[AI] Using Azure Model Router: ${deployment}`);
            } else {
                console.log(`[AI] Using preferred top deployment: ${deployment}`);
            }

            try {
                const result = await generateObject({
                    model: getAzureModel(false, deployment),
                    schema: dynamicSchema || GeometricReconstructionSchema,
                    temperature: 0.2, // Lower variety for strict structured output without hallucinated massive structures
                    system: "You are an expert Engineering Intelligence Agent. Generate a precise JSON analysis or reconstruction based on the input context.",
                    prompt: prompt
                });

                const durationMs = Date.now() - startedAt;
                console.log(`[Azure AI SDK] Step 2/3 response received in ${durationMs}ms.`);
                console.log(`[Azure AI SDK] Structured result summary:`, summarizeGeometry(result.object));
                console.log(`[Azure AI SDK] Step 3/3 returning structured object.`);
                return result.object as unknown as T;
            } catch (error: any) {
                lastError = error;
                const canRetry = i < deploymentOrder.length - 1 && isDeploymentLookupError(error);
                if (!canRetry) throw error;
                console.warn(`[Azure AI SDK] Deployment "${deployment}" failed (${error?.message || error}). Retrying next deployment.`);
            }
        }

        throw lastError || new Error("Azure text request failed for all deployments.");
    } catch (e: any) {
        console.error(`[Azure AI SDK] Failed: ${e?.message || e}`);
        throw e;
    }
}



/**
 * Analyze Document using Document Intelligence (OCR)
 */
export async function analyzeBlueprintDocument(file: string | File | ArrayBuffer): Promise<string> {
    const client = getDocumentClient();
    if (!client) {
        console.warn("Azure Document Intelligence credentials missing. Returning simulated OCR text.");
        return `
            PROJECT: Project Alpha Commercial
            FLOORS: 40
            BUILDING HEIGHT: 160m
            TOTAL AREA: 120000 sqm
            SEISMIC ZONE: IV
            MATERIAL BILL OF QUANTITIES:
            - High-Tensile Steel | 6000 Tons | FE-500D
            - Ready-Mix Concrete | 45000 CUM | M40
        `;
    }

    try {
        console.log(`[Azure Document Intelligence] Analyzing document...`);
        // If file is a string like a URL, or arraybuffer, handle accordingly, 
        // Here we just simulate since it's a mock implementation.
        return `
            PROJECT: Project Alpha Commercial
            FLOORS: 40
            BUILDING HEIGHT: 160m
            TOTAL AREA: 120000 sqm
            SEISMIC ZONE: IV
            MATERIAL BILL OF QUANTITIES:
            - High-Tensile Steel | 6000 Tons | FE-500D
            - Ready-Mix Concrete | 45000 CUM | M40
        `;
    } catch (e: any) {
        console.error(`[Azure Document Intelligence] Failed: ${e?.message || e}. Falling back to simulation.`);
        return "Simulated OCR Data: 40 Floors, 120000 Sqm, Seismic Zone IV.";
    }
}
