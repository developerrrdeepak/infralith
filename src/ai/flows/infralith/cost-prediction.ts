'use server';

import { generateAzureObject } from '@/ai/azure-ai';
import { z } from 'zod';

/**
 * Cost Prediction Agent — estimates budget based on material quantities and market rates
 */
export async function predictCost(inputData: string) {
    const prompt = `
        Act as a Construction Financial Strategist. 
        Generate a high-fidelity Capital Expenditure (CAPEX) estimate for the following project.
        
        DATA SOURCE:
        ${inputData}

        Requirements:
        1. Calculate total project cost based on CURRENT localized market rates for India.
        2. Provide a granular breakdown: Materials, Logistics, Labor, and Contingency (15%).
        3. Estimate project duration and critical path milestones.

        Return JSON:
        {
          "total": number,
          "currency": "INR",
          "breakdown": [
            { "category": "String", "amount": number, "percentage": number }
          ],
          "duration": "Timeline string",
          "confidenceScore": number (0-1)
        }
    `;

    const schema = z.object({
        total: z.number(),
        currency: z.string(),
        breakdown: z.array(z.object({
            category: z.string(),
            amount: z.number(),
            percentage: z.number()
        })),
        duration: z.string(),
        confidenceScore: z.number()
    });

    try {
        const result = await generateAzureObject<any>(prompt, schema);
        return {
            total: result?.total || 0,
            currency: result?.currency || 'INR',
            breakdown: (result?.breakdown || []).map((b: any) => ({
                category: b?.category || 'General Works',
                amount: b?.amount || 0,
                percentage: b?.percentage || 0
            })),
            duration: result?.duration || '18-24 months',
            confidenceScore: result?.confidenceScore || 0.85
        };
    } catch (error) {
        console.error("Cost Prediction Error:", error);
        throw error;
    }
}
