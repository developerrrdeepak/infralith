'use server';

import { analyzeBlueprintDocument, generateAzureObject } from '@/ai/azure-ai';
import { z } from 'zod';

const blueprintParseSchema = z.object({
    projectScope: z.string().optional(),
    projectName: z.string().optional(),
    totalFloors: z.union([z.number(), z.string()]).optional(),
    floors: z.union([z.number(), z.string()]).optional(),
    height: z.union([z.number(), z.string()]).optional(),
    totalArea: z.union([z.number(), z.string()]).optional(),
    area: z.union([z.number(), z.string()]).optional(),
    seismicZone: z.string().optional(),
    zone: z.string().optional(),
    materials: z.array(
        z.object({
            item: z.string().optional(),
            name: z.string().optional(),
            material: z.string().optional(),
            quantity: z.union([z.number(), z.string()]).optional(),
            amount: z.union([z.number(), z.string()]).optional(),
            unit: z.string().optional(),
            measurement: z.string().optional(),
            spec: z.string().optional(),
            specification: z.string().optional(),
            standard: z.string().optional(),
        })
    ).optional(),
});

/**
 * Blueprint Parsing Agent — uses Azure Document Intelligence and GPT-4o
 */
export async function parseBlueprint(file: string | File) {
    // 1. OCR Step
    const ocrText = await analyzeBlueprintDocument(file);

    // 2. Structured Extraction Step
    const prompt = `
        Analyze this blueprint OCR text and extract the structural parameters.
        OCR TEXT:
        ${ocrText}
        
        Extract:
        - projectScope: Full name of the project
        - totalFloors: number
        - height: number (in meters)
        - totalArea: number (in sqm)
        - seismicZone: string (II, III, IV, or V)
        - materials: array of objects { item, quantity, unit, spec }
        
        Respond only in JSON.
    `;

    try {
        const result = await generateAzureObject<z.infer<typeof blueprintParseSchema>>(prompt, blueprintParseSchema);
        const toNumber = (value: unknown, fallback = 0) => {
            const numeric = Number(value);
            return Number.isFinite(numeric) ? numeric : fallback;
        };
        return {
            projectScope: result?.projectScope || result?.projectName || "Construction Project",
            totalFloors: toNumber(result?.totalFloors ?? result?.floors, 0),
            height: toNumber(result?.height, 0),
            totalArea: toNumber(result?.totalArea ?? result?.area, 0),
            seismicZone: result?.seismicZone || result?.zone || "Undefined",
            materials: (result?.materials || []).map((m: any) => ({
                item: m?.item || m?.name || m?.material || 'Unknown Material',
                quantity: m?.quantity || m?.amount || 0,
                unit: m?.unit || m?.measurement || '',
                spec: m?.spec || m?.specification || m?.standard || ''
            }))
        };
    } catch (error) {
        console.error("Blueprint Parser Error:", error);
        throw error;
    }
}
