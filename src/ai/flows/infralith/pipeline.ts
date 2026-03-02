export type PipelineStageKey =
  | 'gateway'
  | 'parse'
  | 'cost'
  | 'risk'
  | 'compliance'
  | 'aggregate';

export interface PipelineStageDefinition {
  key: PipelineStageKey;
  title: string;
  description: string;
  estimatedDurationMs: number;
}

export const PIPELINE_STAGES: PipelineStageDefinition[] = [
  {
    key: 'gateway',
    title: 'API Gateway Orchestration',
    description: 'Routing payload and initializing continuous workflow...',
    estimatedDurationMs: 1500,
  },
  {
    key: 'parse',
    title: 'Document Parsing Agent',
    description: 'Extracting blueprints and storing structured data...',
    estimatedDurationMs: 2500,
  },
  {
    key: 'cost',
    title: 'Cost Prediction Agent',
    description: 'Algorithmic cost forecasting based on materials...',
    estimatedDurationMs: 2000,
  },
  {
    key: 'risk',
    title: 'Risk Analysis Agent',
    description: 'Predicting failure patterns and structural risks...',
    estimatedDurationMs: 2000,
  },
  {
    key: 'compliance',
    title: 'Compliance Agent',
    description: 'Verifying data against ISO and regional codes...',
    estimatedDurationMs: 2000,
  },
  {
    key: 'aggregate',
    title: 'Analytics Aggregator',
    description: 'Consolidating results to database and dashboard...',
    estimatedDurationMs: 2500,
  },
];

export const PIPELINE_STAGE_COUNT = PIPELINE_STAGES.length;
export const PIPELINE_STAGE_ERROR = -1;

export function pipelineStageToProgress(stage: number): number {
  if (stage < 0) return 0;
  const bounded = Math.min(stage, PIPELINE_STAGE_COUNT);
  return Math.round((bounded / PIPELINE_STAGE_COUNT) * 100);
}
