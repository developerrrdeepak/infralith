'use server';

import { generateAzureVisionObject } from '@/ai/azure-ai';

export interface WallGeometry {
    start: [number, number];
    end: [number, number];
    thickness: number;
    height: number;
}

export interface DoorGeometry {
    host_wall_id: string | number;
    position: [number, number];
    width: number;
    height: number;
}

export interface WindowGeometry {
    host_wall_id: string | number;
    position: [number, number];
    width: number;
    sill_height: number;
}

export interface RoomGeometry {
    polygon: [number, number][];
}

export interface GeometricReconstruction {
    walls: WallGeometry[];
    doors: DoorGeometry[];
    windows: WindowGeometry[];
    rooms: RoomGeometry[];
}

/**
 * Construction-grade geometric reconstruction engine.
 * Converts 2D architectural floor plans into metrically consistent parametric 3D models.
 */
export async function processBlueprintTo3D(base64Image: string): Promise<GeometricReconstruction> {
    console.log("Infralith Geometric Reconstruction: Initiating spatial synthesis via Azure Vision...");

    const prompt = `
        You are a construction-grade geometric reconstruction engine.

        Input: A 2D architectural floor plan containing walls, doors, windows, and enclosed room spaces.

        Your task is NOT to visually approximate the structure, but to generate a metrically consistent parametric 3D model using architectural constraints.

        Follow these rules strictly:

        1. Treat all detected wall boundaries as structural wall centerlines.
        2. Infer wall thickness using parallel line spacing where available. If unavailable, assign 0.23m for exterior walls and 0.115m for interior walls.
        3. Enforce topological closure on all room polygons. Reject open loops.
        4. Snap all wall intersections to eliminate gaps or overlaps.
        5. Align doors and windows only along valid host walls.
        6. Subtract door and window openings from parent wall volumes using boolean operations.
        7. Assume default vertical parameters unless explicitly labeled:
           - Wall height: 2.7m
           - Door height: 2.1m
           - Window sill: 0.9m
           - Slab thickness: 0.15m
        8. Extrude all validated 2D wall polygons along the Z-axis.
        9. Generate floor slabs for all enclosed room polygons.
        10. Preserve spatial hierarchy between rooms using adjacency mapping.

        Output structured JSON in this format:

        {
          "walls": [
            {
              "start": [x,y],
              "end": [x,y],
              "thickness": value,
              "height": value
            }
          ],
          "doors": [
            {
              "host_wall_id": id,
              "position": [x,y],
              "width": value,
              "height": value
            }
          ],
          "windows": [
            {
              "host_wall_id": id,
              "position": [x,y],
              "width": value,
              "sill_height": value
            }
          ],
          "rooms": [
            {
              "polygon": [[x,y],[x,y]...]
            }
          ]
        }

        Do not generate meshes or visuals.
        Only return validated geometric construction parameters suitable for downstream 3D extrusion.
        Reject inconsistent geometry.
    `;

    try {
        const result = await generateAzureVisionObject<GeometricReconstruction>(prompt, base64Image);

        if (!result || !result.walls) {
            console.warn("Geometric reconstruction: No valid walls found. Generating default shell.");
            return generateSafeShell();
        }

        return result;
    } catch (e) {
        console.error("Geometric Reconstruction Pipeline Error:", e);
        throw e;
    }
}

function generateSafeShell(): GeometricReconstruction {
    return {
        walls: [
            { start: [-5, -5], end: [5, -5], thickness: 0.23, height: 2.7 },
            { start: [5, -5], end: [5, 5], thickness: 0.23, height: 2.7 },
            { start: [5, 5], end: [-5, 5], thickness: 0.23, height: 2.7 },
            { start: [-5, 5], end: [-5, -5], thickness: 0.23, height: 2.7 },
            { start: [0, -5], end: [0, 5], thickness: 0.115, height: 2.7 },
        ],
        doors: [
            { host_wall_id: 4, position: [0, 1], width: 0.9, height: 2.1 }
        ],
        windows: [
            { host_wall_id: 0, position: [0, -5], width: 1.5, sill_height: 0.9 }
        ],
        rooms: [
            { polygon: [[-5, -5], [0, -5], [0, 5], [-5, 5]] },
            { polygon: [[0, -5], [5, -5], [5, 5], [0, 5]] }
        ]
    };
}

