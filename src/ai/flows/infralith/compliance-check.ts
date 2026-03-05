'use server';

import { generateAzureObject } from '@/ai/azure-ai';
import { z } from 'zod';

const NOT_AVAILABLE_TEXT = 'Not available in provided document data';

const clamp01 = (value: unknown, fallback: number): number => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(0, Math.min(1, parsed));
};

/**
 * Compliance Agent - verifies blueprint against Indian building codes.
 */
export async function checkCompliance(inputData: string, retrievalContext?: string) {
    const prompt = `
You are a Senior Structural Compliance Auditor.
Evaluate the supplied project data for compliance checks against:
1. IS 456:2000
2. National Building Code (NBC) 2016
3. IS 13920

PROJECT DATA (JSON):
${inputData}

RETRIEVED REFERENCE CONTEXT (CITABLE, MAY BE EMPTY):
${retrievalContext || 'No retrieved external context was available.'}

MANDATORY GROUNDING RULES:
- Use project data as primary evidence. Retrieved references may support code interpretation.
- Do not invent measurements, locations, standards, or clauses.
- If a value is missing/unknown, explicitly use "Not available in provided document data".
- Evidence should cite references as [R#] when using retrieved context.
- Keep confidence conservative:
  - 0.85-1.0 only for explicit numeric evidence.
  - 0.55-0.84 for inference from partial evidence.
  - <=0.54 when data is sparse or ambiguous.

Return one strict JSON object:
{
  "overallStatus": "Pass" | "Warning" | "Fail",
  "violations": [
    {
      "ruleId": "Code/Clause reference",
      "severity": "Critical" | "Warning",
      "location": "Issue location or Not available in provided document data",
      "requiredValue": "Code requirement or Not available in provided document data",
      "measuredValue": "Observed value or Not available in provided document data",
      "evidence": "Grounded evidence from provided data",
      "description": "Finding summary",
      "comment": "Recommended action",
      "confidence": 0-1,
      "citationIds": ["R1", "R2"]
    }
  ]
}
`;

    const violationSchema = z.object({
        ruleId: z.string(),
        severity: z.enum(['Critical', 'Warning']).optional(),
        location: z.string().optional(),
        requiredValue: z.string().optional(),
        measuredValue: z.string().optional(),
        evidence: z.string().optional(),
        description: z.string(),
        comment: z.string(),
        confidence: z.number().min(0).max(1).optional(),
        citationIds: z.array(z.string()).optional(),
    });

    const schema = z.object({
        overallStatus: z.enum(['Pass', 'Warning', 'Fail']),
        violations: z.array(violationSchema).max(32),
    });

    try {
        const result = schema.parse(await generateAzureObject<any>(prompt, schema));
        const violations = result.violations.map((v) => {
            const severity: 'Critical' | 'Warning' = v.severity === 'Critical' ? 'Critical' : 'Warning';
            return {
                ruleId: String(v.ruleId || NOT_AVAILABLE_TEXT).trim() || NOT_AVAILABLE_TEXT,
                severity,
                location: String(v.location || NOT_AVAILABLE_TEXT).trim() || NOT_AVAILABLE_TEXT,
                requiredValue: String(v.requiredValue || v.comment || NOT_AVAILABLE_TEXT).trim() || NOT_AVAILABLE_TEXT,
                measuredValue: String(v.measuredValue || NOT_AVAILABLE_TEXT).trim() || NOT_AVAILABLE_TEXT,
                evidence: String(v.evidence || NOT_AVAILABLE_TEXT).trim() || NOT_AVAILABLE_TEXT,
                description: String(v.description || NOT_AVAILABLE_TEXT).trim() || NOT_AVAILABLE_TEXT,
                comment: String(v.comment || NOT_AVAILABLE_TEXT).trim() || NOT_AVAILABLE_TEXT,
                confidence: Number.isFinite(Number(v.confidence)) ? clamp01(v.confidence, 0.5) : undefined,
                citationIds: Array.isArray(v.citationIds)
                    ? v.citationIds.map((id) => String(id || '').trim()).filter(Boolean)
                    : [],
            };
        });

        return {
            overallStatus: result.overallStatus,
            violations,
        };
    } catch (error) {
        console.error('Compliance Check Error:', error);
        throw error;
    }
}
