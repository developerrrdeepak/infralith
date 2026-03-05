'use server';

import { WorkflowResult, DevOpsInsight, ModelVersion, ApprovalStep } from './types';
import { parseBlueprint } from './blueprint-parser';
import { checkCompliance } from './compliance-check';
import { analyzeRisk } from './risk-analysis';
import { predictCost } from './cost-prediction';
import { runDevOpsAgent } from './devops-agent';
import { getServerSession } from 'next-auth/next';
import { authOptions } from '@/lib/auth';

const ORCHESTRATOR_VERSION = '3.0.0'; // Bumped for Native OpenCV.js Migration
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
const ALLOWED_UPLOAD_EXTENSIONS = new Set(['.pdf', '.doc', '.docx', '.png', '.jpg', '.jpeg', '.webp']);

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

    // 2. Parallel Domain Expert Analysis
    const [compliance, risk, cost] = await Promise.all([
        checkCompliance(JSON.stringify(blueprint)),
        analyzeRisk(JSON.stringify(blueprint)),
        predictCost(JSON.stringify(blueprint))
    ]);

    const extractionQuality = buildExtractionQuality(blueprint);
    const materialRows = Array.isArray(blueprint?.materials) ? blueprint.materials : [];

    // 3. Map Conflicts
    const conflicts = (compliance.violations || []).map((v: any) => ({
        riskCategory: v.ruleId?.includes('13920') || v.ruleId?.includes('CRITICAL') ? 'Critical' : 'Warning',
        regulationRef: v.ruleId || 'IS-456:2000',
        location: inferConflictLocation(v.description || v.comment),
        requiredValue: v.comment || 'Refer cited code tolerance',
        measuredValue: v.description || 'Deviation detected'
    }));

    if (risk.riskIndex > 70) {
        conflicts.push({
            riskCategory: 'Critical',
            regulationRef: 'SAFETY-OVERRIDE',
            location: 'Project-Wide',
            requiredValue: 'Nominal Risk Index (< 50)',
            measuredValue: `Critical index at ${risk.riskIndex}`
        });
    }

    const partialResult: any = {
        projectScope: blueprint.projectScope,
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

    const result: WorkflowResult = {
        id: `INF-${Date.now().toString().slice(-6)}`,
        timestamp: new Date().toISOString(),
        projectScope: blueprint.projectScope,
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

        modelVersion,
        approvalChain,
        pipelineLatencyMs: Date.now() - startTime,
    };

    console.log(`[${runId}] Orchestrator: Synthesis Complete in ${result.pipelineLatencyMs}ms via Node.js Native Pipeline.`);
    return result;
}

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

const hasValue = (value: unknown) => {
    if (typeof value === 'number') return Number.isFinite(value) && value > 0;
    if (typeof value === 'string') return value.trim().length > 0;
    if (Array.isArray(value)) return value.length > 0;
    return value != null;
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
    const warnings: string[] = [];

    if (missingFields.length > 0) {
        warnings.push(`Missing structured extraction: ${missingFields.join(', ')}.`);
    }
    if (!hasValue(blueprint?.materials)) {
        warnings.push('BOQ rows were not confidently extracted. Upload clearer schedule/quantity pages.');
    }
    if (!hasValue(blueprint?.seismicZone) || blueprint?.seismicZone === 'Undefined') {
        warnings.push('Seismic zone is missing or ambiguous in uploaded document.');
    }

    return {
        coverageScore,
        extractedFields,
        missingFields,
        warnings,
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
    return 'Core Structure / Coordination Zone';
};
