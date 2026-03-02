# Infralith

Infralith is a Next.js platform for infrastructure intelligence workflows:

- Blueprint ingestion and parsing
- Compliance, risk, and cost analysis
- Report generation and approval tracking
- Role-based access (Engineer, Supervisor, Admin)

This repository has been cleaned and reorganized for maintainability, with explicit architecture and workflow documentation.

## Quick Start

1. Install dependencies:
   ```bash
   npm install
   ```
2. Configure environment variables in `.env.local`.
3. Start development server:
   ```bash
   npm run dev
   ```
4. Open `http://localhost:3500`.

## Scripts

- `npm run dev`: Run local development server (port 3500).
- `npm run build`: Create production build.
- `npm run start`: Run production server.
- `npm run typecheck`: Validate TypeScript.
- `npm run lint`: Alias to `typecheck` (current project behavior).

## Core Environment Variables

- Auth: `NEXTAUTH_SECRET`, `AZURE_AD_CLIENT_ID`, `AZURE_AD_CLIENT_SECRET`, `AZURE_AD_TENANT_ID`
- Azure AI: `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_KEY`, `AZURE_OPENAI_DEPLOYMENT_NAME`
- Document Intelligence: `AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT`, `AZURE_DOCUMENT_INTELLIGENCE_KEY`
- DevOps agent (optional): `GITHUB_TOKEN`, `GITHUB_OWNER`, `GITHUB_REPO`
- Storage and backend: `AZURE_COSMOS_CONNECTION_STRING`, `USER_LOOKUP_URL`, `GNEWS_API_KEY`
- CAD conversion (optional for DWG): `INFRALITH_DWG_TO_DXF_COMMAND`

## Repository Layout

```text
src/
  app/              # Next.js app router pages + API routes
  components/       # UI + feature components
  contexts/         # Global application state and orchestration entry points
  ai/               # Multi-agent flows, runtime config, scripts
  lib/              # Services, auth, utility modules
  server/           # Server-side database and response mapping helpers
docs/
  ARCHITECTURE.md   # System boundaries and module ownership
  WORKFLOWS.md      # Runtime and CI/CD workflow architecture
  MAINTENANCE.md    # Maintenance standards and cleanup checklist
.github/workflows/  # CI/CD pipelines
```

## Architecture and Workflows

- [Architecture](docs/ARCHITECTURE.md)
- [Workflows](docs/WORKFLOWS.md)
- [Maintenance](docs/MAINTENANCE.md)

## Deployment Notes

Deployment workflows are under `.github/workflows`. Keep only the workflows you actively deploy with (App Service or Static Web Apps) to avoid duplicate deployments.
