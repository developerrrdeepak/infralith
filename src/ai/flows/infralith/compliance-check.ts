'use server';

import { generateAzureObject } from '@/ai/azure-ai';
import { z } from 'zod';

const NOT_AVAILABLE_TEXT = 'Not available in provided document data';

const clamp01 = (value: unknown, fallback: number): number => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(0, Math.min(1, parsed));
};

const asText = (value: unknown): string => String(value ?? '').replace(/\s+/g, ' ').trim();

const extractCitationIds = (...values: unknown[]): string[] => {
    const found = new Set<string>();
    for (const value of values) {
        const text = asText(value);
        if (!text) continue;
        const matches = text.match(/\bR\d+\b/gi) || [];
        for (const match of matches) {
            found.add(match.toUpperCase());
        }
    }
    return [...found];
};

const normalizeOverallStatus = (value: unknown): 'Pass' | 'Warning' | 'Fail' => {
    const normalized = asText(value).toLowerCase();
    if (normalized === 'pass') return 'Pass';
    if (normalized === 'fail') return 'Fail';
    if (normalized === 'warning' || normalized === 'warn') return 'Warning';
    return 'Warning';
};

const normalizeSeverity = (value: unknown): 'Critical' | 'Warning' => {
    const normalized = asText(value).toLowerCase();
    if (normalized === 'critical' || normalized === 'high' || normalized.includes('critical')) return 'Critical';
    return 'Warning';
};

type ComplianceOptions = {
    allowedCitationIds?: string[];
    requireCitations?: boolean;
};

/**
 * Compliance Agent - verifies blueprint against Indian building codes.
 */
export async function checkCompliance(inputData: string, retrievalContext?: string, options?: ComplianceOptions) {
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
        ruleId: z.union([z.string(), z.number()]).optional(),
        rule: z.union([z.string(), z.number()]).optional(),
        clause: z.union([z.string(), z.number()]).optional(),
        code: z.union([z.string(), z.number()]).optional(),
        regulationRef: z.union([z.string(), z.number()]).optional(),
        severity: z.string().optional(),
        level: z.string().optional(),
        riskCategory: z.string().optional(),
        location: z.string().optional(),
        area: z.string().optional(),
        section: z.string().optional(),
        requiredValue: z.union([z.string(), z.number()]).optional(),
        required: z.union([z.string(), z.number()]).optional(),
        expectedValue: z.union([z.string(), z.number()]).optional(),
        codeRequirement: z.union([z.string(), z.number()]).optional(),
        measuredValue: z.union([z.string(), z.number()]).optional(),
        observedValue: z.union([z.string(), z.number()]).optional(),
        actualValue: z.union([z.string(), z.number()]).optional(),
        evidence: z.union([z.string(), z.number()]).optional(),
        rationale: z.union([z.string(), z.number()]).optional(),
        proof: z.union([z.string(), z.number()]).optional(),
        description: z.union([z.string(), z.number()]).optional(),
        finding: z.union([z.string(), z.number()]).optional(),
        issue: z.union([z.string(), z.number()]).optional(),
        comment: z.union([z.string(), z.number()]).optional(),
        action: z.union([z.string(), z.number()]).optional(),
        recommendation: z.union([z.string(), z.number()]).optional(),
        mitigation: z.union([z.string(), z.number()]).optional(),
        confidence: z.union([z.number(), z.string()]).optional(),
        score: z.union([z.number(), z.string()]).optional(),
        citationIds: z.array(z.string()).optional(),
    }).passthrough();

    const schema = z.object({
        overallStatus: z.string().optional(),
        status: z.string().optional(),
        violations: z.array(violationSchema).optional(),
        findings: z.array(violationSchema).optional(),
        issues: z.array(violationSchema).optional(),
    }).passthrough();

    try {
        const result = schema.parse(await generateAzureObject<any>(prompt, schema));
        const allowedCitationIds = new Set((options?.allowedCitationIds || []).map((id) => String(id || '').trim()).filter(Boolean));
        const requireCitations = !!options?.requireCitations && allowedCitationIds.size > 0;
        const rawViolations = (Array.isArray(result.violations) ? result.violations
            : Array.isArray(result.findings) ? result.findings
                : Array.isArray(result.issues) ? result.issues
                    : []).slice(0, 32);

        const violations = rawViolations.map((v) => {
            const severity = normalizeSeverity(v.severity || v.level || v.riskCategory);
            const rawCitationIds = [
                ...(Array.isArray(v.citationIds) ? v.citationIds : []),
                ...extractCitationIds(
                    v.evidence,
                    v.rationale,
                    v.proof,
                    v.description,
                    v.finding,
                    v.issue,
                    v.comment,
                    v.action,
                    v.recommendation,
                    v.mitigation
                ),
            ];
            const citationIds = rawCitationIds
                .map((id) => String(id || '').trim().toUpperCase())
                .filter((id, index, arr) => id.length > 0 && arr.indexOf(id) === index)
                .filter((id) => allowedCitationIds.size === 0 || allowedCitationIds.has(id));

            if (requireCitations && citationIds.length === 0) {
                throw new Error(`Compliance finding "${asText(v.ruleId || v.rule || v.clause || v.code || 'Unknown')}" is missing grounded citation ids.`);
            }

            return {
                ruleId: asText(v.ruleId || v.rule || v.clause || v.code || v.regulationRef || NOT_AVAILABLE_TEXT) || NOT_AVAILABLE_TEXT,
                severity,
                location: asText(v.location || v.area || v.section || NOT_AVAILABLE_TEXT) || NOT_AVAILABLE_TEXT,
                requiredValue: asText(v.requiredValue || v.required || v.expectedValue || v.codeRequirement || v.comment || NOT_AVAILABLE_TEXT) || NOT_AVAILABLE_TEXT,
                measuredValue: asText(v.measuredValue || v.observedValue || v.actualValue || NOT_AVAILABLE_TEXT) || NOT_AVAILABLE_TEXT,
                evidence: asText(v.evidence || v.rationale || v.proof || NOT_AVAILABLE_TEXT) || NOT_AVAILABLE_TEXT,
                description: asText(v.description || v.finding || v.issue || NOT_AVAILABLE_TEXT) || NOT_AVAILABLE_TEXT,
                comment: asText(v.comment || v.action || v.recommendation || v.mitigation || NOT_AVAILABLE_TEXT) || NOT_AVAILABLE_TEXT,
                confidence: Number.isFinite(Number(v.confidence ?? v.score))
                    ? clamp01(v.confidence ?? v.score, 0.5)
                    : undefined,
                citationIds,
            };
        });

        return {
            overallStatus: normalizeOverallStatus(result.overallStatus || result.status),
            violations,
        };
    } catch (error) {
        console.error('Compliance Check Error:', error);
        throw error;
    }
}
