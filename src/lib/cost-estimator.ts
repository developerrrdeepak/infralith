import { GeometricReconstruction } from '@/ai/flows/infralith/reconstruction-types';

export interface CostEstimate {
    totalUSD: number;
    breakdown: {
        foundationAndSlab: number;
        framingAndWalls: number;
        doorsAndWindows: number;
        roofing: number;
        interiorFinishing: number;
    };
    sqmTotal: number;
}

// Approximate National Average Rates (USD)
const RATES = {
    CONCRETE_SLAB_PER_SQM: 65,
    WALL_FRAMING_PER_SQM_SURFACE: 45, // surface area of wall (length * height)
    DOOR_UNIT: 350,
    WINDOW_UNIT: 400,
    ROOFING_PER_SQM: 85,
    FINISHING_PER_SQM_FLOOR: 120 // flooring, paint, basic electrical/plumbing per habitable space
};

export function estimateConstructionCost(data: GeometricReconstruction): CostEstimate {
    let sqmTotal = 0;

    // 1. Foundation & Floor Slabs (Calculate total footprint area from rooms)
    data.rooms.forEach(room => {
        sqmTotal += room.area || 0;
    });

    // If no rooms defined properly, estimate from walls bounding box
    if (sqmTotal === 0 && data.walls.length > 0) {
        let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
        data.walls.forEach(w => {
            minX = Math.min(minX, w.start[0], w.end[0]);
            maxX = Math.max(maxX, w.start[0], w.end[0]);
            minZ = Math.min(minZ, w.start[1], w.end[1]);
            maxZ = Math.max(maxZ, w.start[1], w.end[1]);
        });
        sqmTotal = (maxX - minX) * (maxZ - minZ);
    }

    const foundationCost = sqmTotal * RATES.CONCRETE_SLAB_PER_SQM;

    // 2. Framing & Walls
    let totalWallSurface = 0;
    data.walls.forEach(w => {
        const dx = w.end[0] - w.start[0];
        const dz = w.end[1] - w.start[1];
        const length = Math.sqrt(dx * dx + dz * dz);
        totalWallSurface += length * w.height;
    });
    const framingCost = totalWallSurface * RATES.WALL_FRAMING_PER_SQM_SURFACE;

    // 3. Doors & Windows
    const doorsDeduct = (data.doors || []).length * RATES.DOOR_UNIT;
    const windowsDeduct = (data.windows || []).length * RATES.WINDOW_UNIT;
    const fenestrationCost = doorsDeduct + windowsDeduct;

    // 4. Roofing
    // Rough estimate: footprint area + 20% for overhangs/pitch
    let roofArea = sqmTotal * 1.2;
    if (data.roof && data.roof.polygon.length > 0) {
        // Just use bounding box of roof if available
        roofArea = sqmTotal * 1.1; // fallback
    }
    const roofCost = roofArea * RATES.ROOFING_PER_SQM;

    // 5. Finishing (interior only)
    const finishingCost = sqmTotal * RATES.FINISHING_PER_SQM_FLOOR;

    const totalUSD = foundationCost + framingCost + fenestrationCost + roofCost + finishingCost;

    return {
        totalUSD,
        sqmTotal,
        breakdown: {
            foundationAndSlab: foundationCost,
            framingAndWalls: framingCost,
            doorsAndWindows: fenestrationCost,
            roofing: roofCost,
            interiorFinishing: finishingCost
        }
    };
}
