'use server';

import { WorkflowResult, DevOpsInsight, ModelVersion, ApprovalStep, ConstructionControlGate } from './types';
import { parseBlueprint } from './blueprint-parser';
import { checkCompliance } from './compliance-check';
import { analyzeRisk } from './risk-analysis';
import { predictCost } from './cost-prediction';
import { runDevOpsAgent } from './devops-agent';
import { formatRagPromptContext, retrieveConstructionContext } from './rag-retrieval';
import { getServerSession } from 'next-auth/next';
import { authOptions } from '@/lib/auth';

const ORCHESTRATOR_VERSION = '3.0.0'; // Bumped for Native OpenCV.js Migration
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
const ALLOWED_UPLOAD_EXTENSIONS = new Set(['.pdf', '.doc', '.docx', '.png', '.jpg', '.jpeg', '.webp']);
const NOT_AVAILABLE_TEXT = 'Not available in provided document data';

function paramHash(): string {
    const seed = `blueprint-parser-v3|opencv-js-native|compliance-is456-nbc2016|risk-seismic-v2|cost-capex-india|devops-github-v1|${ORCHESTRATOR_VERSION}`;
    let h = 0;
    for (let i = 0; i < seed.length; i++) { h = (h << 5) - h + seed.charCodeAt(i); h |= 0; }
    return Math.abs(h).toString(16).toUpperCase();
}

export async function runInfralithWorkflow(formData: FormData): Promise<WorkflowResult> {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
        throw new Error("Unauthorized: authentication required.");
    }

    const role = session.user.role || "Guest";
    if (role !== "Engineer" && role !== "Admin") {
        throw new Error("Forbidden: Engineer or Admin role required.");
    }

    const startTime = Date.now();
    const runId = `RUN-${startTime.toString(36).toUpperCase()}`;
    console.log(`[${runId}] Infralith Orchestrator v${ORCHESTRATOR_VERSION}: Initiating Native OpenCV.js + AI analysis...`);

    const input = formData.get('file');
    if (!(input instanceof File)) throw new Error("No input blueprint file provided.");
    if (input.size > MAX_UPLOAD_BYTES) {
        throw new Error("Uploaded file exceeds the 100MB limit.");
    }

    const originalFileName = input.name || 'uploaded-document';
    const fileName = originalFileName.toLowerCase();
    const dotIndex = fileName.lastIndexOf('.');
    const extension = dotIndex >= 0 ? fileName.slice(dotIndex) : '';
    if (!ALLOWED_UPLOAD_EXTENSIONS.has(extension)) {
        throw new Error("Unsupported file type. Please upload PDF, DOC, DOCX, PNG, JPG, JPEG, or WEBP.");
    }

    // 1. Context Generation
    const blueprint = await parseBlueprint(input);
    const derivedProjectScope =
        normalizeConflictText(blueprint?.projectScope, '') ||
        normalizeConflictText(originalFileName.replace(/\.[^.]+$/, ''), '');
    const ragQuery = buildRagQuery(blueprint, originalFileName);
    const ragContext = await retrieveConstructionContext(ragQuery, { top: 10 });
    const ragPromptContext = await formatRagPromptContext(ragContext, 8_500);

    // 2. Parallel Domain Expert Analysis
    const [compliance, risk, cost] = await Promise.all([
        checkCompliance(JSON.stringify(blueprint), ragPromptContext),
        analyzeRisk(JSON.stringify(blueprint), ragPromptContext),
        predictCost(JSON.stringify(blueprint), ragPromptContext),
    ]);

    const extractionQuality = buildExtractionQuality(blueprint);
    if (ragContext.diagnostics.warning) {
        extractionQuality.warnings.push(`RAG retrieval warning: ${ragContext.diagnostics.warning}`);
    }
    if (ragContext.diagnostics.errors.length > 0) {
        extractionQuality.warnings.push(`RAG retrieval errors: ${ragContext.diagnostics.errors.slice(0, 2).join(' | ')}`);
    }
    if (ragContext.chunks.length === 0) {
        extractionQuality.warnings.push('No external reference chunks retrieved. Report is grounded only on extracted project data.');
    } else {
        extractionQuality.warnings.push(`RAG grounded with ${ragContext.chunks.length} retrieved chunk(s) across index(es): ${ragContext.diagnostics.indexesQueried.join(', ') || 'N/A'}.`);
    }
    const materialRows = Array.isArray(blueprint?.materials) ? blueprint.materials : [];

    // 3. Map conflicts with grounded fields from compliance output.
    const conflicts = (compliance.violations || []).map((v: any) => {
        const description = normalizeConflictText(v?.description, NOT_AVAILABLE_TEXT);
        const comment = normalizeConflictText(v?.comment, NOT_AVAILABLE_TEXT);
        const measuredValue = normalizeConflictText(v?.measuredValue, description);
        const requiredValue = normalizeConflictText(v?.requiredValue, comment);
        const location = normalizeConflictText(v?.location, inferConflictLocation(`${description} ${comment}`));
        const evidence = normalizeConflictText(v?.evidence, '');
        const confidenceCandidate = Number(v?.confidence);
        const confidenceScore = Number.isFinite(confidenceCandidate)
            ? Number(clamp(confidenceCandidate, 0, 1).toFixed(2))
            : undefined;

        return {
            riskCategory: inferConflictRiskCategory(v, compliance.overallStatus),
            regulationRef: normalizeConflictText(v?.ruleId, NOT_AVAILABLE_TEXT),
            location,
            requiredValue,
            measuredValue,
            evidence,
            confidenceScore,
            citationIds: Array.isArray(v?.citationIds)
                ? v.citationIds.map((id: unknown) => String(id || '').trim()).filter(Boolean)
                : [],
        };
    });

    if (risk.riskIndex > 70) {
        conflicts.push({
            riskCategory: 'Critical',
            regulationRef: 'SAFETY-OVERRIDE',
            location: 'Project-Wide',
            requiredValue: 'Nominal Risk Index (< 50)',
            measuredValue: `Critical index at ${risk.riskIndex}`,
            evidence: `Risk analyzer reported project riskIndex=${risk.riskIndex}.`,
            confidenceScore: 0.9,
            citationIds: [],
        });
    }

    const partialResult: any = {
        projectScope: derivedProjectScope,
        riskReport: risk,
        complianceReport: compliance,
        conflicts: conflicts,
        id: runId
    };

    // 4. Trigger DevOps Agent
    const devOpsInsight = await runDevOpsAgent(partialResult as WorkflowResult);

    // 5. Synthesis
    const insights: DevOpsInsight[] = [
        {
            agentId: 'Structural-Auditor-L4',
            status: compliance.overallStatus === 'Pass' ? 'Optimized' : 'Warning',
            message: compliance.overallStatus === 'Pass'
                ? 'Full alignment with NBC 2016 detected.'
                : `Detected ${compliance.violations.length} discrepancies in code compliance.`,
            actionRequired: compliance.overallStatus !== 'Pass'
        },
        devOpsInsight,
        {
            agentId: 'Risk-Aggregator-Realtime',
            status: risk.level === 'High' || risk.level === 'Critical' ? 'Warning' : 'Optimized',
            message: `Structural stress index at ${risk.riskIndex}%. Mitigation strategies mapped.`,
            actionRequired: risk.riskIndex > 60
        }
    ];

    const deploymentName = process.env.AZURE_OPENAI_DEPLOYMENT_NAME || process.env.AZURE_OPENAI_DEPLOYMENT || 'model-router';

    const modelVersion: ModelVersion = {
        orchestratorVersion: ORCHESTRATOR_VERSION,
        blueprintParserModel: 'azure-doc-intelligence-v4',
        llmModel: 'gpt-4o-2024-11-20',
        deploymentName,
        parameterHash: paramHash(),
        runId,
    };

    const approvalChain: ApprovalStep[] = [
        {
            stepId: `APPR-${runId}-1`,
            role: 'Supervisor',
            status: devOpsInsight.actionRequired ? 'rejected' : 'pending',
        }
    ];

    const complianceFailures = Array.isArray(compliance.violations) ? compliance.violations.length : 0;
    const criticalConflicts = conflicts.filter((item: { riskCategory: string }) => item.riskCategory === 'Critical').length;
    const approvalReadinessScore = clamp(
        Math.round(100 - complianceFailures * 11 - risk.riskIndex * 0.55 - criticalConflicts * 3),
        0,
        100
    );
    const delayImpactDays =
        complianceFailures === 0 && risk.riskIndex < 45
            ? 0
            : Math.max(1, Math.round(complianceFailures * 2 + criticalConflicts * 3 + risk.riskIndex / 28));
    const redesignRequired = criticalConflicts > 1 || risk.riskIndex >= 65 || extractionQuality.coverageScore < 55;
    const complianceScore = clamp(
        Math.round(((compliance.overallStatus === 'Pass' ? 100 : 70) + (100 - risk.riskIndex)) / 2),
        0,
        100
    );
    const constructionControlSummary = buildConstructionControlSummary({
        conflicts,
        blueprint,
        risk,
        cost,
        extractionQuality,
    });

    const result: WorkflowResult = {
        id: `INF-${Date.now().toString().slice(-6)}`,
        timestamp: new Date().toISOString(),
        projectScope: derivedProjectScope,
        role: role === 'Admin' ? 'Admin' : 'Engineer',

        parsedBlueprint: blueprint,
        materials: materialRows,
        complianceReport: compliance,
        riskReport: risk,
        costEstimate: cost,

        devOpsInsights: insights,
        approvalBlockerCount: (devOpsInsight.actionRequired ? 1 : 0) + compliance.violations.filter((v: any) => String(v.ruleId || '').includes('CRITICAL')).length,
        conflicts,

        costImpactEstimate: cost.total,
        currency: cost.currency,
        complianceScore,
        approvalReadinessScore,
        delayImpactDays,
        redesignRequired,
        extractionQuality,
        documentInfo: {
            fileName: originalFileName,
            extension,
            mimeType: input.type || undefined,
            sizeBytes: input.size,
        },
        constructionControlSummary,

        modelVersion,
        approvalChain,
        pipelineLatencyMs: Date.now() - startTime,
    };

    console.log(`[${runId}] Orchestrator: Synthesis Complete in ${result.pipelineLatencyMs}ms via Node.js Native Pipeline.`);
    return result;
}

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

const normalizeConflictText = (value: unknown, fallback: string): string => {
    const normalized = String(value ?? '').replace(/\s+/g, ' ').trim();
    return normalized || fallback;
};

const inferConflictRiskCategory = (
    violation: any,
    overallStatus: 'Pass' | 'Warning' | 'Fail'
): 'Critical' | 'Warning' => {
    const severity = String(violation?.severity || '').toLowerCase();
    const ruleId = String(violation?.ruleId || '').toLowerCase();
    const description = String(violation?.description || '').toLowerCase();
    const measuredValue = String(violation?.measuredValue || '').toLowerCase();

    if (severity === 'critical') return 'Critical';
    if (ruleId.includes('critical') || ruleId.includes('13920')) return 'Critical';
    if (/collapse|life\s*safety|egress|instability|fire/.test(description)) return 'Critical';
    if (/critical|unsafe/.test(measuredValue)) return 'Critical';
    return overallStatus === 'Fail' ? 'Critical' : 'Warning';
};

const hasValue = (value: unknown) => {
    if (typeof value === 'number') return Number.isFinite(value) && value > 0;
    if (typeof value === 'string') return value.trim().length > 0;
    if (Array.isArray(value)) return value.length > 0;
    return value != null;
};

const buildRagQuery = (blueprint: any, originalFileName: string): string => {
    const terms = [
        asSearchTerm(blueprint?.projectScope),
        asSearchTerm(blueprint?.seismicZone),
        asSearchTerm(blueprint?.totalFloors),
        asSearchTerm(blueprint?.height),
        asSearchTerm(blueprint?.totalArea),
        asSearchTerm(originalFileName.replace(/\.[^.]+$/, '')),
    ].filter(Boolean);

    const materialHints = Array.isArray(blueprint?.materials)
        ? blueprint.materials
            .slice(0, 4)
            .map((item: any) => asSearchTerm(item?.item))
            .filter(Boolean)
        : [];

    return [...terms, ...materialHints].join(' ').trim();
};

const asSearchTerm = (value: unknown): string => {
    const text = String(value ?? '').replace(/\s+/g, ' ').trim();
    return text.length > 0 ? text : '';
};

const buildExtractionQuality = (blueprint: any) => {
    const checks: Array<[string, boolean]> = [
        ['projectScope', hasValue(blueprint?.projectScope)],
        ['totalFloors', hasValue(blueprint?.totalFloors)],
        ['height', hasValue(blueprint?.height)],
        ['totalArea', hasValue(blueprint?.totalArea)],
        ['seismicZone', hasValue(blueprint?.seismicZone) && blueprint?.seismicZone !== 'Undefined'],
        ['materials', hasValue(blueprint?.materials)],
    ];

    const extractedFields = checks.filter(([, ok]) => ok).map(([field]) => field);
    const missingFields = checks.filter(([, ok]) => !ok).map(([field]) => field);
    const coverageScore = Math.round((extractedFields.length / checks.length) * 100);
    const criticalFields = new Set(['totalFloors', 'height', 'totalArea', 'seismicZone']);
    const criticalMissingFields = missingFields.filter((field) => criticalFields.has(field));
    const warnings: string[] = [];

    if (missingFields.length > 0) {
        warnings.push(`Missing structured extraction: ${missingFields.join(', ')}.`);
    }
    if (criticalMissingFields.length > 0) {
        warnings.push(`Critical document fields missing for reliable compliance: ${criticalMissingFields.join(', ')}.`);
    }
    if (!hasValue(blueprint?.materials)) {
        warnings.push('BOQ rows were not confidently extracted. Upload clearer schedule/quantity pages.');
    }
    if (!hasValue(blueprint?.seismicZone) || blueprint?.seismicZone === 'Undefined') {
        warnings.push('Seismic zone is missing or ambiguous in uploaded document.');
    }
    if (coverageScore < 70) {
        warnings.push('Low extraction coverage. Report should be manually verified before approval decisions.');
    }

    return {
        coverageScore,
        extractedFields,
        missingFields,
        criticalMissingFields,
        reviewRequired: coverageScore < 70 || criticalMissingFields.length > 0,
        warnings,
        rawTextLength: Number.isFinite(Number(blueprint?._extractionMeta?.ocrChars))
            ? Number(blueprint._extractionMeta.ocrChars)
            : undefined,
    };
};

const gateStatus = (
    condition: { critical?: boolean; warning?: boolean }
): 'Pass' | 'Warning' | 'Critical' => {
    if (condition.critical) return 'Critical';
    if (condition.warning) return 'Warning';
    return 'Pass';
};

const describeTopConflictRefs = (conflicts: WorkflowResult['conflicts']): string => {
    const refs = conflicts
        .map((conflict) => String(conflict?.regulationRef || '').trim())
        .filter(Boolean)
        .slice(0, 3);
    return refs.length > 0 ? refs.join(', ') : 'No regulation references detected';
};

const buildConstructionControlSummary = ({
    conflicts,
    blueprint,
    risk,
    cost,
    extractionQuality,
}: {
    conflicts: WorkflowResult['conflicts'];
    blueprint: any;
    risk: any;
    cost: any;
    extractionQuality: ReturnType<typeof buildExtractionQuality>;
}): NonNullable<WorkflowResult['constructionControlSummary']> => {
    const criticalConflicts = conflicts.filter((conflict) => conflict.riskCategory === 'Critical').length;
    const warningConflicts = Math.max(0, conflicts.length - criticalConflicts);
    const hasCostBreakdown = Array.isArray(cost?.breakdown) && cost.breakdown.length > 0;
    const hasMaterials = Array.isArray(blueprint?.materials) && blueprint.materials.length > 0;
    const hazards = Array.isArray(risk?.hazards) ? risk.hazards.length : 0;
    const missingFields = extractionQuality.missingFields.length;
    const criticalMissing = extractionQuality.criticalMissingFields?.length || 0;

    const gates: ConstructionControlGate[] = [
        {
            key: 'progress',
            title: 'Progress Control',
            requirement: 'Track current completion, pending activities, and updated forecast every report cycle.',
            status: gateStatus({
                critical: extractionQuality.coverageScore < 55,
                warning: extractionQuality.coverageScore < 75,
            }),
            evidence: `Coverage ${extractionQuality.coverageScore}% | Floors ${blueprint?.totalFloors ?? 'N/A'} | Area ${blueprint?.totalArea ?? 'N/A'} sq.m`,
            action: extractionQuality.coverageScore < 75
                ? 'Attach clearer drawings and baseline schedule snapshot for planned vs actual tracking.'
                : 'Continue periodic progress updates with baseline comparison.',
        },
        {
            key: 'cost',
            title: 'Cost Control',
            requirement: 'Report certified total cost, category breakdown, and duration outlook.',
            status: gateStatus({
                critical: !Number.isFinite(Number(cost?.total)) || Number(cost?.total) <= 0,
                warning: !hasCostBreakdown,
            }),
            evidence: `CAPEX ${Number(cost?.total || 0).toLocaleString()} ${cost?.currency || 'INR'} | Breakdown rows ${hasCostBreakdown ? cost.breakdown.length : 0} | Duration ${cost?.duration || 'N/A'}`,
            action: (!Number.isFinite(Number(cost?.total)) || Number(cost?.total) <= 0 || !hasCostBreakdown)
                ? 'Add signed BOQ rates and package-wise cost split before procurement decisions.'
                : 'Maintain variance tracking against sanctioned estimate.',
        },
        {
            key: 'quality',
            title: 'Quality Control',
            requirement: 'Maintain material specifications, test evidence, and acceptance status in each cycle.',
            status: gateStatus({
                critical: !hasMaterials || criticalMissing >= 2,
                warning: !hasMaterials || missingFields > 0,
            }),
            evidence: `Materials extracted ${hasMaterials ? blueprint.materials.length : 0} | Missing fields ${missingFields} (critical ${criticalMissing})`,
            action: (!hasMaterials || missingFields > 0)
                ? 'Upload schedule/test-sheet pages and map each key material to spec-grade evidence.'
                : 'Continue QC traceability with batch and test references.',
        },
        {
            key: 'safety',
            title: 'Safety & Risk',
            requirement: 'Monitor risk index, active hazards, and mandatory site safety controls.',
            status: gateStatus({
                critical: Number(risk?.riskIndex || 0) >= 70 || String(risk?.level || '').toLowerCase() === 'critical',
                warning: Number(risk?.riskIndex || 0) >= 50 || String(risk?.level || '').toLowerCase() === 'high',
            }),
            evidence: `Risk index ${risk?.riskIndex ?? 'N/A'} (${risk?.level || 'N/A'}) | Hazards ${hazards}`,
            action: Number(risk?.riskIndex || 0) >= 50
                ? 'Issue mitigation owners with due dates and verify closure in next cycle.'
                : 'Keep routine toolbox, hazard log, and permit controls active.',
        },
        {
            key: 'compliance',
            title: 'Code Compliance',
            requirement: 'List code references, observed deviations, and closure actions with confidence.',
            status: gateStatus({
                critical: criticalConflicts > 0,
                warning: warningConflicts > 0,
            }),
            evidence: `Critical ${criticalConflicts} | Warning ${warningConflicts} | Refs ${describeTopConflictRefs(conflicts)}`,
            action: criticalConflicts > 0
                ? 'Close critical code deviations before execution approvals.'
                : warningConflicts > 0
                    ? 'Track warnings to closure with responsible engineer.'
                    : 'No active code non-conformance detected.',
        },
        {
            key: 'document-control',
            title: 'Document Control',
            requirement: 'Ensure latest revision set, readable sheets, and traceable evidence lines.',
            status: gateStatus({
                critical: extractionQuality.reviewRequired && criticalMissing > 0,
                warning: extractionQuality.reviewRequired,
            }),
            evidence: `ReviewRequired ${extractionQuality.reviewRequired ? 'Yes' : 'No'} | OCR chars ${extractionQuality.rawTextLength ?? 'N/A'} | Missing ${missingFields}`,
            action: extractionQuality.reviewRequired
                ? 'Re-upload high-resolution latest revision with explicit labels and stamped tables.'
                : 'Document package is acceptable for AI-assisted reporting.',
        },
    ];

    return {
        reportingStandard: 'Construction control matrix aligned to progress, quality, safety, cost, and code closure.',
        generatedAt: new Date().toISOString(),
        gates,
    };
};

const inferConflictLocation = (description: string) => {
    const text = String(description || '');
    const grid = text.match(/\bgrid\s*[a-z0-9-]+\b/i)?.[0];
    if (grid) return grid.toUpperCase();
    if (/stair|egress|exit/i.test(text)) return 'Egress / Stair Core';
    if (/foundation|footing|soil|settlement/i.test(text)) return 'Foundation Zone';
    if (/beam|column|slab|wall|truss/i.test(text)) return 'Primary Structural Frame';
    if (/fire|smoke|hydrant|sprinkler/i.test(text)) return 'Fire Safety System';
    return NOT_AVAILABLE_TEXT;
};
