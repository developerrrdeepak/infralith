'use server';

export interface DevOpsInsight {
    agentId: string;
    status: 'Optimized' | 'Warning' | 'Issue';
    message: string;
    actionRequired: boolean;
    ticketUrl?: string;
}

/** Version metadata attached to every analysis run for reproducibility */
export interface ModelVersion {
    orchestratorVersion: string;    // e.g. '2.1.0'
    blueprintParserModel: string;   // e.g. 'azure-doc-intel-v4'
    llmModel: string;               // e.g. 'gpt-4o-2024-12-01'
    deploymentName: string;         // Azure deployment name
    parameterHash: string;          // Checksum of prompt templates
    runId: string;                  // Unique analysis run ID
}

/** Approval chain for supervisor sign-off */
export interface ApprovalStep {
    stepId: string;
    role: 'Supervisor' | 'Admin';
    status: 'pending' | 'approved' | 'rejected';
    actorId?: string;
    actorName?: string;
    timestamp?: string;
    comment?: string;
}

export interface WorkflowResult {
    id: string;
    timestamp: string;
    projectScope: string;
    role: 'Engineer' | 'Supervisor' | 'Admin';

    // Parsed Blueprint Data
    parsedBlueprint?: {
        totalFloors: number;
        height: number;
        totalArea: number;
        seismicZone: string;
        materials: Array<{ item: string; quantity: number | string; unit: string; spec: string }>;
    };

    // Agent Reports
    complianceReport?: {
        overallStatus: 'Pass' | 'Warning' | 'Fail';
        violations: Array<{ ruleId: string; description: string; comment: string }>;
    };

    riskReport?: {
        riskIndex: number;
        level: 'Low' | 'Medium' | 'High';
        hazards: Array<{ type: string; severity: string; description: string; mitigation: string }>;
    };

    costEstimate?: {
        total: number;
        currency: string;
        breakdown: Array<{ category: string; amount: number; percentage: number }>;
        duration: string;
    };

    // DevOps / Pipeline Info
    devOpsInsights: DevOpsInsight[];
    approvalBlockerCount: number;
    conflicts: Array<{
        riskCategory: string;
        regulationRef: string;
        location: string;
        requiredValue: string;
        measuredValue: string;
    }>;

    // UI Helper fields (sometimes used in different views)
    costImpactEstimate?: number;
    currency?: string;
    complianceScore?: number;

    /** ── ENTERPRISE FIELDS ── */
    modelVersion?: ModelVersion;        // Reproducibility: exact model + params used
    approvalChain?: ApprovalStep[];     // Supervisor approval workflow
    auditEntryId?: string;              // Link back to audit log entry
    pipelineLatencyMs?: number;         // Total orchestration time in ms
}
