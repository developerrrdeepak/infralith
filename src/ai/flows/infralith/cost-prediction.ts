'use server';

import { generateAzureObject } from '@/ai/azure-ai';
import { z } from 'zod';

const NOT_AVAILABLE_TEXT = 'Not available in provided project data';

const asText = (value: unknown): string => String(value ?? '').replace(/\s+/g, ' ').trim();

const toNumber = (value: unknown): number | null => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
};

const extractCitationIds = (...values: unknown[]): string[] => {
    const found = new Set<string>();
    for (const value of values) {
        const text = asText(value);
        if (!text) continue;
        const matches = text.match(/\bR\d+\b/gi) || [];
        for (const match of matches) found.add(match.toUpperCase());
    }
    return [...found];
};

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

    const breakdownItemSchema = z.object({
        category: z.union([z.string(), z.number()]).optional(),
        name: z.union([z.string(), z.number()]).optional(),
        item: z.union([z.string(), z.number()]).optional(),
        amount: z.union([z.number(), z.string()]).optional(),
        cost: z.union([z.number(), z.string()]).optional(),
        value: z.union([z.number(), z.string()]).optional(),
        percentage: z.union([z.number(), z.string()]).optional(),
        share: z.union([z.number(), z.string()]).optional(),
        pct: z.union([z.number(), z.string()]).optional(),
        citationIds: z.array(z.string()).optional(),
        notes: z.string().optional(),
    }).passthrough();

    const schema = z.object({
        total: z.union([z.number(), z.string()]).optional(),
        totalEstimatedCost: z.union([z.number(), z.string()]).optional(),
        estimatedTotal: z.union([z.number(), z.string()]).optional(),
        currency: z.string().optional(),
        currencyCode: z.string().optional(),
        breakdown: z.array(breakdownItemSchema).optional(),
        costBreakdown: z.array(breakdownItemSchema).optional(),
        categories: z.array(breakdownItemSchema).optional(),
        duration: z.union([z.string(), z.number()]).optional(),
        timeline: z.union([z.string(), z.number()]).optional(),
        schedule: z.union([z.string(), z.number()]).optional(),
        confidenceScore: z.union([z.number(), z.string()]).optional(),
        confidence: z.union([z.number(), z.string()]).optional(),
        score: z.union([z.number(), z.string()]).optional(),
        assumptions: z.array(z.union([z.string(), z.number()])).optional(),
        notes: z.array(z.union([z.string(), z.number()])).optional(),
        justification: z.array(z.union([z.string(), z.number()])).optional(),
        citationIds: z.array(z.string()).optional(),
    }).passthrough();

    try {
        const result = schema.parse(await generateAzureObject<any>(prompt, schema));
        const allowedCitationIds = new Set((options?.allowedCitationIds || []).map((id) => String(id || '').trim()).filter(Boolean));
        const requireCitations = !!options?.requireCitations && allowedCitationIds.size > 0;
        const filterCitationIds = (ids: unknown): string[] => {
            if (!Array.isArray(ids)) return [];
            return ids
                .map((id) => String(id || '').trim())
                .map((id) => id.toUpperCase())
                .filter((id) => id.length > 0 && (allowedCitationIds.size === 0 || allowedCitationIds.has(id)));
        };

        const totalValue =
            toNumber(result.total) ??
            toNumber(result.totalEstimatedCost) ??
            toNumber(result.estimatedTotal);
        if (totalValue == null || totalValue <= 0) {
            throw new Error('Cost output missing valid total value.');
        }

        const rawBreakdown = Array.isArray(result.breakdown) ? result.breakdown
            : Array.isArray(result.costBreakdown) ? result.costBreakdown
                : Array.isArray(result.categories) ? result.categories
                    : [];
        if (rawBreakdown.length === 0) {
            throw new Error('Cost output missing breakdown categories.');
        }

        let normalizedBreakdown = rawBreakdown.map((item) => {
            const amount = toNumber(item.amount) ?? toNumber(item.cost) ?? toNumber(item.value);
            const percentageRaw = toNumber(item.percentage) ?? toNumber(item.share) ?? toNumber(item.pct);
            const percentage = percentageRaw == null ? null : (percentageRaw <= 1 ? percentageRaw * 100 : percentageRaw);
            const citationIds = filterCitationIds([
                ...(Array.isArray(item.citationIds) ? item.citationIds : []),
                ...extractCitationIds(item.notes, item.category, item.name, item.item),
            ]);

            if (amount == null || amount <= 0) {
                throw new Error(`Cost breakdown "${asText(item.category || item.name || item.item || 'Unknown')}" has invalid amount.`);
            }
            if (requireCitations && citationIds.length === 0) {
                throw new Error(`Cost breakdown category "${asText(item.category || item.name || item.item || 'Unknown')}" is missing grounded citation ids.`);
            }

            return {
                category: asText(item.category || item.name || item.item || NOT_AVAILABLE_TEXT) || NOT_AVAILABLE_TEXT,
                amount,
                percentage,
                citationIds,
            };
        });

        const percentageMissing = normalizedBreakdown.some((row) => row.percentage == null);
        if (percentageMissing) {
            const sum = normalizedBreakdown.reduce((acc, row) => acc + row.amount, 0);
            normalizedBreakdown = normalizedBreakdown.map((row) => ({
                ...row,
                percentage: sum > 0 ? Number(((row.amount / sum) * 100).toFixed(2)) : 0,
            }));
        }

        const normalizedCitationIds = filterCitationIds([
            ...(Array.isArray(result.citationIds) ? result.citationIds : []),
            ...extractCitationIds(
                ...(Array.isArray(result.assumptions) ? result.assumptions : []),
                ...(Array.isArray(result.notes) ? result.notes : []),
                ...(Array.isArray(result.justification) ? result.justification : []),
            ),
        ]);
        if (requireCitations && normalizedCitationIds.length === 0) {
            const unionFromRows = Array.from(new Set(normalizedBreakdown.flatMap((row) => row.citationIds)));
            if (unionFromRows.length === 0) {
                throw new Error('Cost estimate is missing grounded citation ids.');
            }
            normalizedCitationIds.push(...unionFromRows);
        }

        const percentageSum = normalizedBreakdown.reduce((sum, row) => sum + Number(row.percentage || 0), 0);
        if (Math.abs(percentageSum - 100) > 15) {
            throw new Error(`Cost breakdown percentages are inconsistent (sum=${percentageSum.toFixed(2)}).`);
        }

        const amountSum = normalizedBreakdown.reduce((sum, row) => sum + row.amount, 0);
        const tolerance = Math.max(1, totalValue * 0.15);
        if (Math.abs(amountSum - totalValue) > tolerance) {
            throw new Error(`Cost breakdown amounts do not reconcile with total (total=${totalValue}, sum=${amountSum}).`);
        }

        const durationText = asText(result.duration || result.timeline || result.schedule || NOT_AVAILABLE_TEXT) || NOT_AVAILABLE_TEXT;
        const confidenceScore = toNumber(result.confidenceScore) ?? toNumber(result.confidence) ?? toNumber(result.score) ?? 0.5;
        const assumptions = [
            ...(Array.isArray(result.assumptions) ? result.assumptions : []),
            ...(Array.isArray(result.notes) ? result.notes : []),
            ...(Array.isArray(result.justification) ? result.justification : []),
        ]
            .map((item) => asText(item))
            .filter(Boolean);

        return {
            total: totalValue,
            currency: asText(result.currency || result.currencyCode || 'INR') || 'INR',
            breakdown: normalizedBreakdown.map((item) => ({
                category: item.category,
                amount: item.amount,
                percentage: Number(item.percentage || 0),
                citationIds: item.citationIds,
            })),
            duration: durationText,
            confidenceScore: Math.max(0, Math.min(1, confidenceScore)),
            assumptions,
            citationIds: normalizedCitationIds,
        };
    } catch (error) {
        console.error('Cost Prediction Error:', error);
        throw error;
    }
}
