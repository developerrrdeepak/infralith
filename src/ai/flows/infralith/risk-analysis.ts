'use server';

import { generateAzureObject } from '@/ai/azure-ai';
import { z } from 'zod';

const NOT_AVAILABLE_TEXT = 'Not available in provided project data';

/**
 * Risk Analysis Agent - identifies hazards and calculates risk index from project data.
 */
export async function analyzeRisk(inputData: string, retrievalContext?: string) {
    const prompt = `
You are a construction safety risk auditor.
Use only the provided project JSON data.
Do not invent measurements, incidents, or site conditions.

PROJECT DATA:
${inputData}

RETRIEVED REFERENCE CONTEXT:
${retrievalContext || 'No retrieved external context was available.'}

Rules:
- If evidence is missing, state "${NOT_AVAILABLE_TEXT}" explicitly.
- If reference context is used, include citation labels like [R1] in hazard descriptions.
- Keep riskIndex conservative when data is sparse.
- Return exactly one JSON object (no markdown, no prose).

Output schema:
{
  "riskIndex": number (0-100),
  "level": "Low" | "Medium" | "High" | "Critical",
  "hazards": [
    { "type": "Category", "severity": "Level", "description": "Grounded detail", "mitigation": "Action" }
  ]
}
`;

    const schema = z.object({
        riskIndex: z.number().min(0).max(100),
        level: z.enum(['Low', 'Medium', 'High', 'Critical']),
        hazards: z.array(z.object({
            type: z.string(),
            severity: z.string(),
            description: z.string(),
            mitigation: z.string(),
        })),
    });

    try {
        const result = schema.parse(await generateAzureObject<any>(prompt, schema));
        return {
            riskIndex: result.riskIndex,
            level: result.level,
            hazards: result.hazards.map((hazard) => ({
                type: String(hazard.type || NOT_AVAILABLE_TEXT).trim(),
                severity: String(hazard.severity || NOT_AVAILABLE_TEXT).trim(),
                description: String(hazard.description || NOT_AVAILABLE_TEXT).trim(),
                mitigation: String(hazard.mitigation || NOT_AVAILABLE_TEXT).trim(),
            })),
        };
    } catch (error) {
        console.error('Risk Analysis Error:', error);
        throw error;
    }
}
