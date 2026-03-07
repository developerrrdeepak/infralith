'use server';

import { generateAzureObject } from '@/ai/azure-ai';
import { z } from 'zod';

const NOT_AVAILABLE_TEXT = 'Not available in provided project data';

type CostPredictionOptions = {
    allowedCitationIds?: string[];
    requireCitations?: boolean;
};

/**
 * Cost Prediction Agent - estimates CAPEX from extracted project inputs without hardcoded defaults.
 */
export async function predictCost(inputData: string, retrievalContext?: string, options?: CostPredictionOptions) {
    const prompt = `
You are a construction cost auditor.
Use only the provided project JSON data.
Do not invent market datasets, vendor quotes, or quantities.

PROJECT DATA:
${inputData}

RETRIEVED COST REFERENCE CONTEXT:
${retrievalContext || 'No retrieved external context was available.'}

Rules:
- If critical quantity/rate evidence is missing, keep confidence low and explain assumptions.
- If using retrieved references for assumptions, tag them with citation ids like [R2].
- Monetary outputs must be internally consistent (sum of breakdown close to total).
- Return exactly one JSON object (no markdown, no prose).

Output schema:
{
  "total": number,
  "currency": "ISO 4217 code",
  "breakdown": [
    { "category": "String", "amount": number, "percentage": number, "citationIds": ["R1"] }
  ],
  "duration": "Timeline string",
  "confidenceScore": number (0-1),
  "assumptions": ["String"],
  "citationIds": ["R1", "R2"]
}
`;

    const schema = z.object({
        total: z.number().positive(),
        currency: z.string().trim().min(3),
        breakdown: z.array(z.object({
            category: z.string().trim().min(1),
            amount: z.number().positive(),
            percentage: z.number().min(0).max(100),
            citationIds: z.array(z.string().trim().min(1)).optional(),
        })).min(1),
        duration: z.string().trim().min(1),
        confidenceScore: z.number().min(0).max(1),
        assumptions: z.array(z.string()),
        citationIds: z.array(z.string().trim().min(1)).optional(),
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

        const normalizedBreakdown = result.breakdown.map((item) => {
            const citationIds = filterCitationIds(item.citationIds);
            if (requireCitations && citationIds.length === 0) {
                throw new Error(`Cost breakdown category "${item.category}" is missing grounded citation ids.`);
            }
            return {
                category: String(item.category).trim(),
                amount: item.amount,
                percentage: item.percentage,
                citationIds,
            };
        });

        const normalizedCitationIds = filterCitationIds(result.citationIds);
        if (requireCitations && normalizedCitationIds.length === 0) {
            throw new Error('Cost estimate is missing grounded citation ids.');
        }

        const percentageSum = normalizedBreakdown.reduce((sum, row) => sum + row.percentage, 0);
        if (Math.abs(percentageSum - 100) > 7) {
            throw new Error(`Cost breakdown percentages are inconsistent (sum=${percentageSum.toFixed(2)}).`);
        }

        const amountSum = normalizedBreakdown.reduce((sum, row) => sum + row.amount, 0);
        const tolerance = Math.max(1, result.total * 0.07);
        if (Math.abs(amountSum - result.total) > tolerance) {
            throw new Error(`Cost breakdown amounts do not reconcile with total (total=${result.total}, sum=${amountSum}).`);
        }

        return {
            total: result.total,
            currency: result.currency,
            breakdown: normalizedBreakdown.map((item) => ({
                category: String(item.category || NOT_AVAILABLE_TEXT).trim(),
                amount: item.amount,
                percentage: item.percentage,
                citationIds: item.citationIds,
            })),
            duration: String(result.duration || NOT_AVAILABLE_TEXT).trim(),
            confidenceScore: result.confidenceScore,
            assumptions: Array.isArray(result.assumptions)
                ? result.assumptions.map((item) => String(item || '').trim()).filter(Boolean)
                : [],
            citationIds: normalizedCitationIds,
        };
    } catch (error) {
        console.error('Cost Prediction Error:', error);
        throw error;
    }
}
