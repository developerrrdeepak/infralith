'use server';

import { generateAzureObject } from '@/ai/azure-ai';
import { z } from 'zod';

const NOT_AVAILABLE_TEXT = 'Not available in provided project data';

type RiskAnalysisOptions = {
    allowedCitationIds?: string[];
    requireCitations?: boolean;
};

/**
 * Risk Analysis Agent - identifies hazards and calculates risk index from project data.
 */
export async function analyzeRisk(inputData: string, retrievalContext?: string, options?: RiskAnalysisOptions) {
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
  "citationIds": ["R1", "R2"],
  "hazards": [
    { "type": "Category", "severity": "Level", "description": "Grounded detail", "mitigation": "Action", "citationIds": ["R1"] }
  ]
}
`;

    const schema = z.object({
        riskIndex: z.number().min(0).max(100),
        level: z.enum(['Low', 'Medium', 'High', 'Critical']),
        citationIds: z.array(z.string().trim().min(1)).optional(),
        hazards: z.array(z.object({
            type: z.string().trim().min(1),
            severity: z.string().trim().min(1),
            description: z.string().trim().min(1),
            mitigation: z.string().trim().min(1),
            citationIds: z.array(z.string().trim().min(1)).optional(),
        })).min(1),
    });

    try {
        const result = schema.parse(await generateAzureObject<any>(prompt, schema));
        const allowedCitationIds = new Set((options?.allowedCitationIds || []).map((id) => String(id || '').trim()).filter(Boolean));
        const requireCitations = !!options?.requireCitations && allowedCitationIds.size > 0;
        const filterCitationIds = (ids: unknown): string[] => {
            if (!Array.isArray(ids)) return [];
            return ids
                .map((id) => String(id || '').trim())
                .filter((id) => id.length > 0 && (allowedCitationIds.size === 0 || allowedCitationIds.has(id)));
        };

        const hazards = result.hazards.map((hazard) => {
            const citationIds = filterCitationIds(hazard.citationIds);
            if (requireCitations && citationIds.length === 0) {
                throw new Error(`Risk hazard "${hazard.type}" is missing grounded citation ids.`);
            }
            return {
                type: String(hazard.type || NOT_AVAILABLE_TEXT).trim(),
                severity: String(hazard.severity || NOT_AVAILABLE_TEXT).trim(),
                description: String(hazard.description || NOT_AVAILABLE_TEXT).trim(),
                mitigation: String(hazard.mitigation || NOT_AVAILABLE_TEXT).trim(),
                citationIds,
            };
        });
        const citationIds = filterCitationIds(result.citationIds);
        if (requireCitations && citationIds.length === 0) {
            throw new Error('Risk analysis is missing grounded citation ids.');
        }

        return {
            riskIndex: result.riskIndex,
            level: result.level,
            citationIds,
            hazards,
        };
    } catch (error) {
        console.error('Risk Analysis Error:', error);
        throw error;
    }
}
