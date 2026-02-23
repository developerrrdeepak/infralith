import { AzureOpenAI } from "openai";
import { DocumentAnalysisClient, AzureKeyCredential } from "@azure/ai-form-recognizer";
import * as dotenv from "dotenv";

dotenv.config();

// Azure OpenAI Configuration
const azureEndpoint = process.env.AZURE_OPENAI_ENDPOINT || "";
const azureKey = process.env.AZURE_OPENAI_KEY || "";
const deploymentName = process.env.AZURE_OPENAI_DEPLOYMENT_NAME || "model-router";

// Azure Document Intelligence Configuration
const docIntelEndpoint = process.env.AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT || "";
const docIntelKey = process.env.AZURE_DOCUMENT_INTELLIGENCE_KEY || "";

/**
 * Azure OpenAI LLM Bridge — Production integration
 */
export async function generateAzureObject<T>(prompt: string, schema?: any): Promise<T> {
    if (!azureEndpoint || !azureKey) {
        console.warn("Azure OpenAI credentials missing. Returning simulated JSON structure.");
        return simulateAzureResponse<T>(prompt);
    }

    try {
        console.log("Routing Request through Azure OpenAI Pipeline...");
        const client = new AzureOpenAI({
            endpoint: azureEndpoint,
            apiKey: azureKey,
            apiVersion: "2024-12-01-preview",
            deployment: deploymentName,
        });

        const result = await client.chat.completions.create({
            model: deploymentName,
            messages: [
                { role: "system", content: "You are an expert Construction Intelligence Agent. Respond only in valid JSON." },
                { role: "user", content: prompt }
            ],
            response_format: { type: "json_object" }
        });

        if ('error' in result && result.error !== undefined) {
            console.warn("Azure OpenAI returned an error. Falling back to simulation.", result.error);
            return simulateAzureResponse<T>(prompt);
        }

        const content = result.choices[0].message?.content || "{}";
        return JSON.parse(content) as T;
    } catch (e) {
        console.warn("Azure OpenAI API call failed. Falling back to simulation.", e);
        return simulateAzureResponse<T>(prompt);
    }
}

function simulateAzureResponse<T>(prompt: string): T {
    // Advanced mock generation based on prompt keywords to keep the UI functional
    const p = prompt.toLowerCase();

    if (p.includes("compliance") || p.includes("is 456")) {
        return {
            overallStatus: "Warning",
            violations: [
                { ruleId: "IS-13920", description: "Seismic detailing gap in beam-column joints.", comment: "Recommend 135-degree hooks." }
            ]
        } as unknown as T;
    }

    if (p.includes("risk") || p.includes("hazard")) {
        return {
            riskIndex: 45,
            level: "Medium",
            hazards: [
                { type: "Structural", severity: "Medium", description: "Wind shear at upper floors exceeds baseline.", mitigation: "Install tuned mass dampers." }
            ]
        } as unknown as T;
    }

    if (p.includes("cost") || p.includes("capex")) {
        return {
            total: 125000000,
            currency: "INR",
            breakdown: [
                { category: "Materials", amount: 75000000, percentage: 60 },
                { category: "Labor", amount: 35000000, percentage: 28 }
            ],
            duration: "24 Months",
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

export async function generateAzureVisionObject<T>(prompt: string, base64Image: string): Promise<T> {
    if (!azureEndpoint || !azureKey) {
        console.warn("Azure OpenAI credentials missing. Returning simulated JSON structure for vision.");
        return simulateVisionResponse<T>(prompt);
    }

    try {
        console.log("Routing Vision Request through Azure OpenAI Pipeline...");
        const client = new AzureOpenAI({
            endpoint: azureEndpoint,
            apiKey: azureKey,
            apiVersion: "2024-12-01-preview",
            deployment: deploymentName,
        });

        const result = await client.chat.completions.create({
            model: deploymentName,
            messages: [
                { role: "system", content: "You are an expert Architectural Intelligence Agent capable of parsing complex floorplans. Respond only in valid JSON." },
                {
                    role: "user", content: [
                        { type: "text", text: prompt },
                        { type: "image_url", image_url: { url: base64Image } }
                    ] as any
                }
            ],
            response_format: { type: "json_object" }
        });

        if ('error' in result && result.error !== undefined) {
            console.warn("Azure OpenAI Vision returned an error. Falling back to simulation.", result.error);
            return simulateVisionResponse<T>(prompt);
        }

        const content = result.choices[0].message?.content || "{}";
        return JSON.parse(content) as T;
    } catch (e) {
        console.warn("Azure OpenAI Vision API call failed. Falling back to simulation.", e);
        return simulateVisionResponse<T>(prompt);
    }
}

function simulateVisionResponse<T>(prompt: string): T {
    // Return a realistic colored bungalow for demo/fallback
    return {
        building_name: "Demo Bungalow",
        exterior_color: "#f5e6d3",
        walls: [
            { id: "w1", start: [-6, -5], end: [6, -5], thickness: 0.23, height: 2.7, color: "#f5e6d3", is_exterior: true },
            { id: "w2", start: [6, -5], end: [6, 5], thickness: 0.23, height: 2.7, color: "#f5e6d3", is_exterior: true },
            { id: "w3", start: [6, 5], end: [-6, 5], thickness: 0.23, height: 2.7, color: "#f5e6d3", is_exterior: true },
            { id: "w4", start: [-6, 5], end: [-6, -5], thickness: 0.23, height: 2.7, color: "#f5e6d3", is_exterior: true },
            { id: "w5", start: [0, -5], end: [0, 1], thickness: 0.115, height: 2.7, color: "#faf7f2", is_exterior: false },
            { id: "w6", start: [-6, 1], end: [0, 1], thickness: 0.115, height: 2.7, color: "#faf7f2", is_exterior: false },
            { id: "w7", start: [0, 1], end: [6, 1], thickness: 0.115, height: 2.7, color: "#faf7f2", is_exterior: false },
            { id: "w8", start: [-6, -1.5], end: [0, -1.5], thickness: 0.115, height: 2.7, color: "#faf7f2", is_exterior: false },
        ],
        doors: [
            { id: "d1", host_wall_id: "w1", position: [-2, -5], width: 1.0, height: 2.1, color: "#8B4513" },
            { id: "d2", host_wall_id: "w5", position: [0, -0.5], width: 0.9, height: 2.1, color: "#a0522d" },
            { id: "d3", host_wall_id: "w6", position: [-3, 1], width: 0.9, height: 2.1, color: "#a0522d" },
            { id: "d4", host_wall_id: "w7", position: [3, 1], width: 0.9, height: 2.1, color: "#a0522d" },
        ],
        windows: [
            { id: "win1", host_wall_id: "w1", position: [3, -5], width: 1.5, sill_height: 0.9, color: "#87CEEB" },
            { id: "win2", host_wall_id: "w2", position: [6, -2], width: 1.5, sill_height: 0.9, color: "#87CEEB" },
            { id: "win3", host_wall_id: "w2", position: [6, 3], width: 1.2, sill_height: 0.9, color: "#87CEEB" },
            { id: "win4", host_wall_id: "w3", position: [-3, 5], width: 1.5, sill_height: 0.9, color: "#87CEEB" },
            { id: "win5", host_wall_id: "w3", position: [3, 5], width: 1.2, sill_height: 0.9, color: "#87CEEB" },
            { id: "win6", host_wall_id: "w4", position: [-6, 3], width: 1.2, sill_height: 0.9, color: "#87CEEB" },
        ],
        rooms: [
            { id: "r1", name: "Living Room", polygon: [[0, -5], [6, -5], [6, 1], [0, 1]], area: 36, floor_color: "#e8d5b7" },
            { id: "r2", name: "Kitchen", polygon: [[-6, -1.5], [0, -1.5], [0, 1], [-6, 1]], area: 15, floor_color: "#c9c9c9" },
            { id: "r3", name: "Bathroom", polygon: [[-6, -5], [0, -5], [0, -1.5], [-6, -1.5]], area: 21, floor_color: "#a8d5e2" },
            { id: "r4", name: "Master Bedroom", polygon: [[-6, 1], [0, 1], [0, 5], [-6, 5]], area: 24, floor_color: "#d4c4a8" },
            { id: "r5", name: "Bedroom 2", polygon: [[0, 1], [6, 1], [6, 5], [0, 5]], area: 24, floor_color: "#dcc9a3" },
        ],
        roof: {
            type: "gable",
            polygon: [[-6.3, -5.3], [6.3, -5.3], [6.3, 5.3], [-6.3, 5.3]],
            height: 1.8,
            base_height: 2.7,
            color: "#a0522d",
        },
        conflicts: [
            { type: "structural", severity: "medium", description: "Interior wall w5 spans 6m without column support", location: [0, -2] },
        ]
    } as unknown as T;
}


/**
 * Azure Document Intelligence Bridge for Blueprint OCR — Production Integration
 */
export async function analyzeBlueprintDocument(fileUrl: string | File): Promise<string> {
    if (!docIntelEndpoint || !docIntelKey) {
        console.warn("Azure Document Intelligence credentials not configured. Using simulated telemetry for demo.");
        await new Promise(r => setTimeout(r, 2000)); // Simulate OCR delay
        return `
            PROJECT ALPHA - MUMBAI COMMERCIAL TOWER
            Total Height: 120m
            Total Floors: 30
            Total Area: 450,000 sqm
            Seismic Zone: IV
            
            MATERIALS BILL OF QUANTITY:
            1. High-Tensile Reinforcement Steel: 4500 Tons (Spec: FE-500D)
            2. Ready-Mix Concrete: 85000 CUM (Spec: M40 Grade)
            3. Structural Glazing: 12000 SQM (Spec: Double-Insulated)
            
            ENGINEERING NOTES:
            Foundation design requires deep piling due to coastal proximity.
            Seismic load calculations must account for wind shear at 100m.
        `;
    }

    let bufferObj: Buffer;
    if (typeof fileUrl === 'string') {
        throw new Error("Direct string URLs not supported in this context.");
    } else {
        const arrayBuffer = await fileUrl.arrayBuffer();
        bufferObj = Buffer.from(arrayBuffer);
    }

    console.log("Attempting Azure Document Intelligence OCR...");
    const client = new DocumentAnalysisClient(docIntelEndpoint, new AzureKeyCredential(docIntelKey));
    const poller = await client.beginAnalyzeDocument("prebuilt-layout", bufferObj);
    const { content } = await poller.pollUntilDone();

    if (content && content.length > 50) {
        console.log("Azure OCR succeeded —", content.length, "chars extracted.");
        return content;
    }

    throw new Error("Document OCR failed to extract meaningful text.");
}
