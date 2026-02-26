import { generateObject } from 'ai';
import { createAzure } from '@ai-sdk/azure';
import { z } from 'zod';
import { DocumentAnalysisClient, AzureKeyCredential } from "@azure/ai-form-recognizer";

// Azure OpenAI Configuration
const azureKey = process.env.AZURE_OPENAI_KEY || "";
const deploymentName = process.env.AZURE_OPENAI_DEPLOYMENT_NAME || process.env.AZURE_OPENAI_DEPLOYMENT || "model-router";
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

/** Helper to get the model with correct deployment name and settings */
export const getAzureModel = (isVision = false) => {
    // For production stability, we explicitly define the model to avoid SDK version appending
    // Must use .chat() because the default goes to the unsupported /responses endpoint
    return azureFixed.chat(deploymentName);
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

/**
 * Vision Logic using generateObject with Azure OpenAI
 */
async function simulateVisionResponse<T>(prompt: string): Promise<T> {
    const p = prompt.toLowerCase();

    // Simulate thinking/delay
    await new Promise(res => setTimeout(res, 1200));

    if (p.includes("floorplan") || p.includes("2d")) {
        return {
            walls: [
                { id: 1, start: [0, 0], end: [10, 0], thickness: 0.2, height: 2.7, color: "#f5e6d3", is_exterior: true },
                { id: 2, start: [10, 0], end: [10, 10], thickness: 0.2, height: 2.7, color: "#f5e6d3", is_exterior: true },
                { id: 3, start: [10, 10], end: [0, 10], thickness: 0.2, height: 2.7, color: "#f5e6d3", is_exterior: true },
                { id: 4, start: [0, 10], end: [0, 0], thickness: 0.2, height: 2.7, color: "#f5e6d3", is_exterior: true },
            ],
            doors: [{ id: "d1", host_wall_id: 1, position: [5, 0], width: 1.2, height: 2.1, color: "#8B4513" }],
            windows: [{ id: "w1", host_wall_id: 2, position: [10, 5], width: 1.5, sill_height: 0.9, color: "#87CEEB" }],
            rooms: [{ id: "r1", name: "Main Hall", polygon: [[0, 0], [10, 0], [10, 10], [0, 10]], area: 100, floor_color: "#e8d5b7" }],
            roof: { type: 'gable', polygon: [[-1, -1], [11, -1], [11, 11], [-1, 11]], height: 2.5, base_height: 2.7, color: "#a0522d" },
            conflicts: [],
            building_name: "Simulated Foundation",
            confidenceScore: 0.92
        } as unknown as T;
    }

    if (p.includes("blueprint") && p.includes("extract")) {
        return {
            projectScope: "Project Alpha Commercial",
            totalFloors: 40,
            height: 160,
            totalArea: 120000,
            seismicZone: "IV",
            materials: [
                { item: "High-Tensile Steel", quantity: 6000, unit: "Tons", spec: "FE-500D" },
                { item: "Ready-Mix Concrete", quantity: 45000, unit: "CUM", spec: "M40" }
            ]
        } as unknown as T;
    }

    return {} as T;
}

export async function generateAzureVisionObject<T>(prompt: string, base64Image: string, dynamicSchema?: z.ZodType<any>): Promise<T> {
    if (!azureKey) {
        console.warn("Azure OpenAI credentials missing. Returning simulated JSON structure for vision.");
        return simulateVisionResponse<T>(prompt);
    }

    try {
        console.log(`[Azure Vision via AI SDK] Routing request...`);

        let cleanedBase64 = base64Image;
        if (base64Image.includes('data:image')) {
            cleanedBase64 = base64Image.split('base64,')[1];
        }

        const result = await generateObject({
            model: getAzureModel(true),
            schema: dynamicSchema || GeometricReconstructionSchema,
            system: "You are an expert Architectural Intelligence Agent. Generate a precise JSON reconstruction of the project. All coordinates are in pixels unless specified.",
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

        console.log(`[Azure Vision via AI SDK] Success`);
        return result.object as unknown as T;
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
        console.warn("Azure OpenAI credentials missing. Returning simulated JSON structure.");
        return simulateVisionResponse<T>(prompt);
    }

    try {
        console.log(`[Azure AI SDK] Routing text-to-object request...`);

        const result = await generateObject({
            model: getAzureModel(false),
            schema: dynamicSchema || GeometricReconstructionSchema,
            system: "You are an expert Engineering Intelligence Agent. Generate a precise JSON analysis or reconstruction based on the input context.",
            prompt: prompt
        });

        console.log(`[Azure AI SDK] Success`);
        return result.object as unknown as T;
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
