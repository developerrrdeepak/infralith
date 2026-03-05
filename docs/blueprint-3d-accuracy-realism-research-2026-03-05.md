# Blueprint-to-3D Accuracy and Realism Research Notes (2026-03-05)

## Goal
Improve:
1. Blueprint-to-3D geometric/topological accuracy.
2. Visual realism of generated 3D models.

## Key Research Takeaways

### Accuracy-focused papers
- Raster-to-Vector (ICCV 2017): strong baseline for junction-first vectorization plus global optimization for topological consistency.
- Floor-SP (ICCV 2019): room-wise optimization with explicit consistency terms across shared walls/corners.
- HEAT (CVPR 2022): holistic edge candidate reasoning works better than local primitive heuristics.
- RoomFormer (CVPR 2023): polygon-level set prediction improves structured room reconstruction and room semantics.
- PolyRoom (ECCV 2024): robust to non-Manhattan room geometry and polygon complexity.
- FRI-Net (ECCV 2024): room-wise implicit representation improves complex room topology recovery.
- CAGE (NeurIPS 2025 / arXiv 2025): edge-centric representation improves watertightness and robustness; reports strong room/corner/angle F1.

### Realism-focused papers
- HouseCrafter (ICCV 2025 / arXiv 2024): floorplan-conditioned multi-view RGB-D generation for house-scale realistic 3D scenes.
- DiffuScene (CVPR 2024): unordered object-set diffusion gives more physically plausible and diverse indoor layouts.
- DiffInDScene (CVPR 2024): coarse-to-fine 3D diffusion and TSDF fusion improves room-level mesh quality.
- PhyScene (CVPR 2024): physics/interactivity guidance (collision, reachability) improves scene plausibility.
- ATISS (NeurIPS 2021): object-set autoregressive layout generation, efficient and practical for scene completion/suggestions.

### Data papers to anchor training/evaluation
- CubiCasa5K (arXiv 2019): floorplan image dataset with dense polygon annotations.
- Structured3D (ECCV 2020): large photorealistic structured modeling dataset.
- 3D-FRONT (arXiv 2020): large furnished indoor dataset with textures and style-consistent object layouts.

## Mapping to Current Repo

Current strengths already present:
- Strong topology-aware prompting and retry diagnostics in:
  - `src/ai/flows/infralith/prompt-templates.ts`
  - `src/ai/flows/infralith/blueprint-to-3d-agent.ts`
- Dimension, semantic, and multi-floor enforcement pipelines already exist.

Current realism bottlenecks:
- Rendering is mostly uniform `meshStandardMaterial` with limited material diversity.
- Limited physically grounded scene arrangement logic.
- No learned layout/asset realism prior from 3D-FRONT-style distributions.

## Priority Implementation Plan

### P0 (Accuracy first, low-risk)
1. Add edge-continuity scoring + repair pass before final room extraction.
2. Add explicit non-Manhattan preservation guardrail in post-normalization.
3. Improve scale reconciliation using robust fit over multiple dimension anchors (not single-anchor dependence).
4. Add stronger opening-host validation: intersection/offset checks before `host_wall_id` acceptance.
5. Add benchmark script with geometric metrics (room IoU / corner F1 / opening host validity) on fixed test set.

### P1 (Realism uplift, moderate effort)
1. Introduce material presets using `MeshPhysicalMaterial` (clearcoat, transmission, normal/roughness maps).
2. Add adaptive HDR/environment profile + tone mapping presets by time-of-day.
3. Add AO/contact-shadow tuning and edge darkening at wall-floor intersections.
4. Add object placement priors (ATISS/DiffuScene-inspired) for furniture spacing, wall clearance, and symmetry.

### P2 (Advanced, high effort)
1. Add optional texture synthesis stage from floorplan + room semantics (HouseCrafter-like direction).
2. Add physically plausible constraints (collision/reachability) during furniture placement (PhyScene-like guidance).

## Suggested First Coding Batch
1. Accuracy: implement edge-continuity repair + robust scale reconciliation in `blueprint-to-3d-agent.ts`.
2. Realism: add physically based material profile switch in `BlueprintTo3D.tsx` with controlled roughness/metalness/clearcoat presets.
3. Testing: add artifact metrics summary script for before/after comparison.

## Primary Sources
- Raster-to-Vector (ICCV 2017): https://openaccess.thecvf.com/content_iccv_2017/html/Liu_Raster-To-Vector_Revisiting_Floorplan_ICCV_2017_paper.html
- Floor-SP (ICCV 2019): https://openaccess.thecvf.com/content_ICCV_2019/html/Chen_Floor-SP_Inverse_CAD_for_Floorplans_by_Sequential_Room-Wise_Shortest_Path_ICCV_2019_paper.html
- HEAT (CVPR 2022): https://openaccess.thecvf.com/content/CVPR2022/html/Chen_HEAT_Holistic_Edge_Attention_Transformer_for_Structured_Reconstruction_CVPR_2022_paper.html
- RoomFormer (CVPR 2023): https://openaccess.thecvf.com/content/CVPR2023/html/Yue_Connecting_the_Dots_Floorplan_Reconstruction_Using_Two-Level_Queries_CVPR_2023_paper.html
- PolyRoom (ECCV 2024): https://www.ecva.net/papers/eccv_2024/papers_ECCV/html/6708_ECCV_2024_paper.php
- FRI-Net (ECCV 2024): https://www.ecva.net/papers/eccv_2024/papers_ECCV/html/6729_ECCV_2024_paper.php
- CAGE (arXiv 2025): https://arxiv.org/abs/2509.15459
- HouseCrafter (ICCV 2025): https://openaccess.thecvf.com/content/ICCV2025/html/Chen_HouseCrafter_Lifting_Floorplans_to_3D_Scenes_with_2D_Diffusion_Models_ICCV_2025_paper.html
- HouseCrafter (arXiv): https://arxiv.org/abs/2406.20077
- DiffuScene (CVPR 2024): https://openaccess.thecvf.com/content/CVPR2024/html/Tang_DiffuScene_Denoising_Diffusion_Models_for_Generative_Indoor_Scene_Synthesis_CVPR_2024_paper.html
- DiffInDScene (CVPR 2024): https://openaccess.thecvf.com/content/CVPR2024/html/Ju_DiffInDScene_Diffusion-based_High-Quality_3D_Indoor_Scene_Generation_CVPR_2024_paper.html
- PhyScene (CVPR 2024): https://openaccess.thecvf.com/content/CVPR2024/html/Yang_PhyScene_Physically_Interactable_3D_Scene_Synthesis_for_Embodied_AI_CVPR_2024_paper.html
- ATISS (arXiv 2021): https://arxiv.org/abs/2110.03675
- Structured3D (ECCV 2020): https://www.ecva.net/papers/eccv_2020/papers_ECCV/html/890_ECCV_2020_paper.php
- CubiCasa5K (arXiv 2019): https://arxiv.org/abs/1904.01920
- 3D-FRONT (arXiv 2020): https://arxiv.org/abs/2011.09127
