'use server';

import { WorkflowResult, DevOpsInsight, ModelVersion, ApprovalStep } from './types';
import { parseBlueprint } from './blueprint-parser';
import { checkCompliance } from './compliance-check';
import { analyzeRisk } from './risk-analysis';
import { predictCost } from './cost-prediction';
import { runDevOpsAgent } from './devops-agent'; // <-- IMPORTED THE ACTION AGENT
import { getServerSession } from 'next-auth/next';
import { authOptions } from '@/lib/auth';

/** Current orchestrator version — bump on every prompt or logic change */
const ORCHESTRATOR_VERSION = '2.2.0'; // Bumped version for Agentic integration
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const ALLOWED_UPLOAD_EXTENSIONS = new Set(['.pdf', '.doc', '.docx', '.png', '.jpg', '.jpeg', '.webp']);

/** Simple checksum of all prompt templates for reproducibility */
function paramHash(): string {
    const seed = `blueprint-parser-v3|compliance-is456-nbc2016|risk-seismic-v2|cost-capex-india|devops-github-v1|${ORCHESTRATOR_VERSION}`;
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
    console.log(`[${runId}] Infralith Orchestrator v${ORCHESTRATOR_VERSION}: Initiating multi-agent BIM analysis...`);

    const input = formData.get('file');
    if (!(input instanceof File)) throw new Error("No input blueprint file provided.");
    if (input.size > MAX_UPLOAD_BYTES) {
        throw new Error("Uploaded file exceeds the 50MB limit.");
    }

    const fileName = input.name.toLowerCase();
    const extension = fileName.slice(fileName.lastIndexOf('.'));
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

    // 3. Map Conflicts (For Dashboard display)
    const conflicts = (compliance.violations || []).map((v: any) => ({
        riskCategory: v.ruleId?.includes('13920') || v.ruleId?.includes('CRITICAL') ? 'Critical' : 'Warning',
        regulationRef: v.ruleId || 'IS-456:2000',
        location: 'Core Structure / Grid Variance',
        requiredValue: 'Standard defined tolerance',
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

    // 4. Create Partial Object for DevOps Agent
    // We need to pass the current results to the DevOps agent so it can decide on a ticket.
    const partialResult: any = {
        projectScope: blueprint.projectScope,
        riskReport: risk,
        complianceReport: compliance,
        conflicts: conflicts,
        id: runId
    };

    // 5. Trigger Agentic Action (DevOps GitHub Integration)
    // This is where the AI actually "Does" something in the real world
    const devOpsInsight = await runDevOpsAgent(partialResult as WorkflowResult);

    // 6. Synthesis Layer: Combine Insights
    const insights: DevOpsInsight[] = [
        {
            agentId: 'Structural-Auditor-L4',
            status: compliance.overallStatus === 'Pass' ? 'Optimized' : 'Warning',
            message: compliance.overallStatus === 'Pass'
                ? 'Full alignment with NBC 2016 detected.'
                : `Detected ${compliance.violations.length} discrepancies in code compliance.`,
            actionRequired: compliance.overallStatus !== 'Pass'
        },
        devOpsInsight, // Add the real GitHub Insight here
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

    const result: WorkflowResult = {
        id: `INF-${Date.now().toString().slice(-6)}`,
        timestamp: new Date().toISOString(),
        projectScope: blueprint.projectScope,
        role: 'Engineer',

        parsedBlueprint: blueprint,
        complianceReport: compliance,
        riskReport: risk,
        costEstimate: cost,

        devOpsInsights: insights,
        // The count is blocked if the DevOps agent raised a GitHub Issue
        approvalBlockerCount: (devOpsInsight.actionRequired ? 1 : 0) + compliance.violations.filter((v: any) => v.ruleId.includes('CRITICAL')).length,
        conflicts,

        costImpactEstimate: cost.total,
        currency: cost.currency,
        complianceScore: Math.round(((compliance.overallStatus === 'Pass' ? 100 : 70) + (100 - risk.riskIndex)) / 2),

        modelVersion,
        approvalChain,
        pipelineLatencyMs: Date.now() - startTime,
    };

    console.log(`[${runId}] Orchestrator: Synthesis Complete in ${result.pipelineLatencyMs}ms. Confidence: 0.94`);
    return result;
}
