# Architecture

## Goals

This project is organized to keep feature behavior predictable while allowing rapid iteration on AI workflows.

## Layered Structure

- `src/app`: UI entry points and API routes (HTTP boundary).
- `src/contexts`: Shared app state and orchestration calls from client features.
- `src/components`: Presentation and feature modules (`infralith`, `career-compass`, `ui`).
- `src/ai/flows/infralith`: Server-side multi-agent workflow pipeline.
- `src/lib`: Shared services, auth setup, utility modules, and storage adapters.
- `src/server`: Server-only helpers (database and mapping utilities).

## Core Execution Path

1. User uploads a blueprint from `BlueprintUpload`.
2. `AppContext.runInfralithEvaluation` triggers `runInfralithWorkflow`.
3. Orchestrator executes:
   - blueprint parsing
   - compliance, risk, and cost analysis (parallel)
   - DevOps agent action
   - synthesis into `WorkflowResult`
4. Result is persisted and surfaced in report/compliance/risk views.

## Workflow Source of Truth

Pipeline stage metadata is centralized in:

- `src/ai/flows/infralith/pipeline.ts`

This avoids drift between:

- upload progress UI
- pipeline status cards
- context stage progression logic

## Module Ownership Rules

- Keep orchestration logic in `src/ai/flows/infralith/*`.
- Keep route handlers thin; call services/flows instead of embedding logic.
- Keep UI components stateless where possible; orchestrate state in contexts.
- Keep browser storage and mock persistence inside `src/lib/services.ts` or extracted service modules.

## Known Refactor Targets

- `src/contexts/app-context.tsx` is large and should be split by domain.
- `src/lib/services.ts` currently mixes auth, chat, community, DM, and evaluation services.
- Two product domains (`infralith`, `career-compass`) share context; consider domain-specific providers over time.
