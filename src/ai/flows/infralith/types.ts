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

export interface ConstructionControlGate {
    key: 'progress' | 'cost' | 'quality' | 'safety' | 'compliance' | 'document-control';
    title: string;
    requirement: string;
    status: 'Pass' | 'Warning' | 'Critical';
    evidence: string;
    action: string;
}

export interface WorkflowResult {
    id: string;
    timestamp: string;
    projectScope: string;
    role: 'Engineer' | 'Supervisor' | 'Admin';

    // Parsed Blueprint Data
    parsedBlueprint?: {
        projectScope?: string | null;
        totalFloors: number | null;
        height: number | null;
        totalArea: number | null;
        seismicZone: string | null;
        materials: Array<{ item: string; quantity: number | string; unit: string; spec: string }>;
    };
    materials?: Array<{ item: string; quantity: number | string; unit: string; spec: string }>;

    // Agent Reports
    complianceReport?: {
        overallStatus: 'Pass' | 'Warning' | 'Fail';
        violations: Array<{
            ruleId: string;
            description: string;
            comment: string;
            severity?: 'Critical' | 'Warning';
            location?: string;
            requiredValue?: string;
            measuredValue?: string;
            evidence?: string;
            confidence?: number;
            citationIds?: string[];
        }>;
    };

    riskReport?: {
        riskIndex: number;
        level: 'Low' | 'Medium' | 'High' | 'Critical';
        hazards: Array<{
            type: string;
            severity: string;
            description: string;
            mitigation: string;
            citationIds?: string[];
        }>;
        citationIds?: string[];
    };

    costEstimate?: {
        total: number;
        currency: string;
        breakdown: Array<{
            category: string;
            amount: number;
            percentage: number;
            citationIds?: string[];
        }>;
        duration: string;
        confidenceScore?: number;
        assumptions?: string[];
        citationIds?: string[];
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
        evidence?: string;
        confidenceScore?: number;
        citationIds?: string[];
    }>;

    // UI Helper fields (sometimes used in different views)
    costImpactEstimate?: number;
    currency?: string;
    complianceScore?: number;
    approvalReadinessScore?: number;
    delayImpactDays?: number;
    redesignRequired?: boolean;
    extractionQuality?: {
        coverageScore: number;
        extractedFields: string[];
        missingFields: string[];
        warnings: string[];
        criticalMissingFields?: string[];
        reviewRequired?: boolean;
        rawTextLength?: number;
    };
    documentInfo?: {
        fileName: string;
        extension: string;
        mimeType?: string;
        sizeBytes: number;
    };
    constructionControlSummary?: {
        reportingStandard: string;
        generatedAt: string;
        gates: ConstructionControlGate[];
    };

    /** ENTERPRISE FIELDS */
    modelVersion?: ModelVersion;        // Reproducibility: exact model + params used
    approvalChain?: ApprovalStep[];     // Supervisor approval workflow
    auditEntryId?: string;              // Link back to audit log entry
    pipelineLatencyMs?: number;         // Total orchestration time in ms
}

