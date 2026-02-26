'use server';

import { generateAzureObject } from '@/ai/azure-ai';
import { z } from 'zod';

/**
 * Risk Analysis Agent — identifies hazards and calculates Risk Index
 */
export async function analyzeRisk(inputData: string) {
    const prompt = `
        Act as a Predictive Safety Agent specialized in Infrastructure.
        Analyze the following technical project data to identify catastrophic and operational risks.
        
        DATA SOURCE:
        ${inputData}

        Assess:
        1. Geotechnical and seismic vulnerability
        2. Structural load distribution failure points
        3. Operational site safety hazards

        Return a JSON object:
        {
          "riskIndex": number (0-100),
          "level": "Low" | "Medium" | "High" | "Critical",
          "hazards": [
            { "type": "Category", "severity": "Level", "description": "Full detail", "mitigation": "Strategic solution" }
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
            mitigation: z.string()
        }))
    });

    try {
        const result = await generateAzureObject<any>(prompt, schema);
        return {
            riskIndex: result?.riskIndex || 50,
            level: result?.level || 'Medium',
            hazards: (result?.hazards || []).map((h: any) => ({
                type: h?.type || 'Environmental',
                severity: h?.severity || 'Medium',
                description: h?.description || 'Potential structural instability detected.',
                mitigation: h?.mitigation || 'Conduct field stress tests immediately.'
            }))
        };
    } catch (error) {
        console.error("Risk Analysis Error:", error);
        throw error;
    }
}
