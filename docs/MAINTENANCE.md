# Maintenance Guide

## Code Hygiene Baseline

- Run `npm run typecheck` before commits.
- Keep generated artifacts out of git (`*.tsbuildinfo`, transient logs, scratch dumps).
- Keep API routes minimal and delegate logic to flows/services.

## Repository Ordering Rules

- Product features: `src/components/infralith` and `src/components/career-compass`.
- Shared UI primitives: `src/components/ui`.
- Shared state: `src/contexts`.
- Domain logic: `src/ai/flows/infralith`.
- Shared cross-cutting helpers: `src/lib`.

## Documentation Rules

- `README.md`: onboarding and high-level map.
- `docs/ARCHITECTURE.md`: boundaries and ownership.
- `docs/WORKFLOWS.md`: runtime and CI/CD flow.
- Update docs when adding new routes, flows, or major services.

## Cleanup Checklist

1. Remove temporary files and local dumps before committing.
2. Avoid committing debug logs (`tsc.log`, `tsc_output.txt`).
3. Keep only active deployment workflows.
4. Validate changed paths with `git status --short`.
