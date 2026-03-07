'use server';

import { generateAzureObject } from '@/ai/azure-ai';
import { z } from 'zod';

const NOT_AVAILABLE_TEXT = 'Not available in provided project data';

/**
 * Cost Prediction Agent - estimates CAPEX from extracted project inputs without hardcoded defaults.
 */
export async function predictCost(inputData: string, retrievalContext?: string) {
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
  "currency": "INR",
  "breakdown": [
    { "category": "String", "amount": number, "percentage": number }
  ],
  "duration": "Timeline string",
  "confidenceScore": number (0-1),
  "assumptions": ["String"]
}
`;

    const schema = z.object({
        total: z.number(),
        currency: z.string(),
        breakdown: z.array(z.object({
            category: z.string(),
            amount: z.number(),
            percentage: z.number(),
        })),
        duration: z.string(),
        confidenceScore: z.number().min(0).max(1),
        assumptions: z.array(z.string()),
    });

    try {
        const result = schema.parse(await generateAzureObject<any>(prompt, schema));
        return {
            total: result.total,
            currency: result.currency,
            breakdown: result.breakdown.map((item) => ({
                category: String(item.category || NOT_AVAILABLE_TEXT).trim(),
                amount: item.amount,
                percentage: item.percentage,
            })),
            duration: String(result.duration || NOT_AVAILABLE_TEXT).trim(),
            confidenceScore: result.confidenceScore,
            assumptions: Array.isArray(result.assumptions)
                ? result.assumptions.map((item) => String(item || '').trim()).filter(Boolean)
                : [],
        };
    } catch (error) {
        console.error('Cost Prediction Error:', error);
        throw error;
    }
}
