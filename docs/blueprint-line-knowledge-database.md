# Blueprint Line Knowledge Database (v2026-03-05)

This database centralizes blueprint line semantics used by the blueprint-to-3D pipeline.

## Source

- `src/ai/flows/infralith/blueprint-line-database.ts`

## Why it improves accuracy

- Removes scattered hardcoded line rules and uses one canonical taxonomy.
- Expands line coverage across structural, opening, annotation, reference, circulation, services, site, and construction overlays.
- Feeds both:
  - Prompt semantics (`buildArchitecturalLineSemanticsReference`)
  - Opening recovery text-signal scoring (`assessOpeningSemantics`)

## Data fields

Each line-family record includes:

- `id`: stable identifier.
- `label`: human-readable line name.
- `category`: semantic family.
- `cue`: visual cue to detect.
- `meaning`: reconstruction interpretation.
- `caution`: anti-hallucination or conflict rule.
- `aliases`: OCR/text synonyms.
- `openingSignal`: optional (`door | window | generic`) for opening recovery.
- `promptPriority`: ordering for semantic prompt output.
- `wallGraphRole`: `candidate | context | exclude`.

## Current coverage

The DB currently includes 28 canonical line families, including:

- Structural walls (double-line, partition, curtain wall)
- Openings (swing/sliding doors, windows, generic openings)
- Circulation (stairs, ramps)
- Reference lines (centerline, grid, section/elevation markers, hidden lines)
- Annotation lines (dimension, extension, leader, break)
- Site lines (property boundary, setback, landscape edge)
- Construction overlays (demolition, new work)
- MEP services (plumbing, drainage, electrical, HVAC, fire)

## Integration points

- `src/ai/flows/infralith/architectural-line-semantics.ts`
  - now imports `buildBlueprintLineSemanticsReference()`
  - now imports `getOpeningTextPatterns()`
- `src/lib/blueprint-line-db-service.ts`
  - persists DB records in Cosmos collab store (`type: blueprintLineDatabase`)
- `src/app/api/infralith/blueprint-line-db/route.ts`
  - `GET`: fetch effective DB snapshot
  - `PUT`: admin-only DB update endpoint
- `src/components/infralith/BlueprintLineDbAdminPanel.tsx`
  - admin editor UI to manage line records
- `src/ai/flows/infralith/blueprint-to-3d-agent.ts`
  - loads DB snapshot before prompt generation and opening-recovery scoring
  - falls back to bundled defaults if DB unavailable

No API/schema contract changes were required for existing 3D output payloads.
