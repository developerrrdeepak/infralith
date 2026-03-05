# Project-Document to Final-Report Grounding Notes (2026-03-05)

## Objective
Improve reliability of final compliance reports generated from uploaded project documents by reducing hallucinated findings and exposing confidence/evidence.

## Research Signals

1. Azure Document Intelligence layout model extracts structured signals (text lines, words, tables, selection marks).
   This supports evidence-first report generation instead of free-form inference.
2. Microsoft Content Understanding best practices emphasize confidence thresholds and review gating.
   Critical fields should trigger human review if confidence is below strict thresholds.
3. LayoutLMv3 (2022) shows strong value in unified text + image pretraining for document AI tasks.
4. Donut (2021) demonstrates OCR-free document understanding can reduce OCR bottlenecks in end-to-end extraction.
5. RAG (2020) and Self-RAG (2023) support grounding outputs in retrieved evidence and explicit self-check behavior.

## Practical Design Rules Applied

1. Do not let compliance generation invent measurements or locations.
2. Force each violation to carry:
   - rule reference
   - location
   - required value
   - measured value
   - evidence
   - confidence score
3. Escalate report review status when extraction coverage is low or critical fields are missing.
4. Surface evidence/confidence in UI so engineers can audit why a finding exists.

## Sources

- Azure Document Intelligence layout model docs:
  https://learn.microsoft.com/en-us/azure/ai-services/document-intelligence/prebuilt/layout?view=doc-intel-4.0.0
- Azure Content Understanding overview:
  https://learn.microsoft.com/en-us/azure/ai-services/content-understanding/document/overview
- Azure Content Understanding best practices:
  https://learn.microsoft.com/en-us/azure/ai-services/content-understanding/document/best-practice?tabs=classification
- LayoutLMv3:
  https://arxiv.org/abs/2204.08387
- Donut:
  https://arxiv.org/abs/2111.15664
- Retrieval-Augmented Generation:
  https://arxiv.org/abs/2005.11401
- Self-RAG:
  https://arxiv.org/abs/2310.11511
