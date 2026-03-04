# Blueprint Prompting Standard (v2026-03-04)

This document defines the research-backed prompting baseline for blueprint-to-3D reconstruction.

## Design Principles

1. Geometry-first and topology-first extraction:
- Build structural wall graph before semantics (openings, furniture).
- Prioritize closed loops, non-self-intersection, and host-link integrity.

2. Evidence-gated output:
- When confidence is low, output fewer objects and emit conflicts.
- Never fabricate missing structure for completeness.

3. Non-Manhattan support:
- Preserve diagonal/curved evidence where present.
- Avoid forced orthogonal regularization unless supported by cues.

4. Explicit scale reliability:
- Use dimension text first.
- If inferred from priors, flag lower reliability via conflict.

5. Schema strictness:
- Return strict JSON matching typed schema.
- Keep IDs consistent and references valid.

## Prompt Rules Mapped to Research

- Learned-plus-constraints hybrid:
  Raster-to-Vector (ICCV 2017), HEAT (CVPR 2022), RoomFormer (CVPR 2023).
- Topology-constrained reconstruction:
  Floor-SP (ICCV 2019), RoomFormer (CVPR 2023), PolyRoom (ECCV 2024).
- Complex polygonal rooms and non-Manhattan layouts:
  PolyRoom (ECCV 2024), FRI-Net (ECCV 2024).
- Data and domain adaptation:
  Structured3D (ECCV 2020), CubiCasa5K (arXiv 2019).
- Emerging graph completion direction:
  CAGE (NeurIPS 2025).

## Implementation Notes

- Prompt template source: `src/ai/flows/infralith/prompt-templates.ts`
- Current strategy:
  1) Compact hint summarization to reduce prompt noise.
  2) Mandatory structural graph pipeline.
  3) Retry prompt with explicit topology recovery gates.

## Primary Sources

- Raster-to-Vector (ICCV 2017): https://openaccess.thecvf.com/content_iccv_2017/html/Liu_Raster-To-Vector_Revisiting_Floorplan_ICCV_2017_paper.html
- Floor-SP (ICCV 2019): https://openaccess.thecvf.com/content_ICCV_2019/html/Chen_Floor-SP_Inverse_CAD_for_Floorplans_by_Sequential_Room-Wise_Shortest_Path_ICCV_2019_paper.html
- HEAT (CVPR 2022): https://openaccess.thecvf.com/content/CVPR2022/html/Chen_HEAT_Holistic_Edge_Attention_Transformer_for_Structured_Reconstruction_CVPR_2022_paper.html
- RoomFormer (CVPR 2023): https://openaccess.thecvf.com/content/CVPR2023/html/Yue_Connecting_the_Dots_Floorplan_Reconstruction_Using_Two-Level_Queries_CVPR_2023_paper.html
- PolyRoom (ECCV 2024): https://www.ecva.net/papers/eccv_2024/papers_ECCV/html/6708_ECCV_2024_paper.php
- FRI-Net (ECCV 2024): https://www.ecva.net/papers/eccv_2024/papers_ECCV/html/6729_ECCV_2024_paper.php
- Structured3D (ECCV 2020): https://www.ecva.net/papers/eccv_2020/papers_ECCV/html/890_ECCV_2020_paper.php
- CubiCasa5K (arXiv): https://arxiv.org/abs/1904.01920
- CAGE (NeurIPS 2025): https://openreview.net/forum?id=1V7Fq2VN6M
- OpenAI Structured Outputs: https://platform.openai.com/docs/guides/structured-outputs
- Azure OpenAI Structured Outputs: https://learn.microsoft.com/azure/ai-services/openai/how-to/structured-outputs
