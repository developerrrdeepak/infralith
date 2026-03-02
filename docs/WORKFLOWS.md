# Workflows

## Runtime Workflow Architecture

### 1. Authentication and Role Gating

1. User signs in through NextAuth providers.
2. Session is hydrated in `AppProvider`.
3. Role checks gate privileged actions (Engineer/Admin for blueprint workflow).

### 2. Blueprint Analysis Workflow

1. User uploads file from UI.
2. Client context calls `runInfralithWorkflow(formData)`.
3. Orchestrator validates auth, role, file size, and file type.
4. Pipeline execution:
   - Parse blueprint context
   - Run compliance, risk, and cost agents in parallel
   - Build conflicts and approval metadata
   - Execute DevOps action agent
   - Return normalized `WorkflowResult`
5. Client stores and displays the result across dashboard views.

### 3. Pipeline Stage Model

Pipeline progression is standardized in `src/ai/flows/infralith/pipeline.ts`:

- shared stage definitions
- canonical stage count
- stage-to-progress conversion helper

## CI/CD Workflow Architecture

Current workflows live in `.github/workflows`:

- `ci.yml`: Type-check validation on push/PR.
- `main_infralith.yml`: Azure Web App build/deploy pipeline.
- `azure-app-service.yml`: Alternate Azure App Service deployment pipeline.
- `azure-static-web-apps.yml`: Azure Static Web Apps deployment pipeline.

## Operational Guidance

- Keep one active deployment target per environment when possible.
- Use `ci.yml` as a merge gate for branch quality.
- Keep secrets only in GitHub Actions secrets; never commit them.
- If two deployment workflows target the same branch/environment, disable one to prevent duplicate releases.
