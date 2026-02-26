import { GeometricReconstruction, ConstructionConflict } from './reconstruction-types';

/**
 * Architectural Engineering Validation Engine.
 * Runs deterministic geometric checks against International Building Codes (IBC) 
 * and ADA compliance requirements to ensure the AI-generated model is physically viable.
 */
export function applyBuildingCodes(model: GeometricReconstruction): GeometricReconstruction {
    const newConflicts: ConstructionConflict[] = [];

    // 1. ADA Minimum Door Width (32 inches / 0.81m clear width)
    model.doors?.forEach((door) => {
        if (door.width < 0.81) {
            newConflicts.push({
                type: 'code',
                severity: 'high',
                description: `ADA Violation: Door width (${door.width.toFixed(2)}m) is less than the minimum 0.81m egress requirement.`,
                location: door.position as [number, number]
            });
        }
    });

    // 2. Minimum Exterior Wall Thickness (150mm / 0.15m for structural integrity & insulation)
    model.walls?.forEach((wall) => {
        if (wall.is_exterior && wall.thickness < 0.15) {
            newConflicts.push({
                type: 'structural',
                severity: 'medium',
                description: `Structural Warning: Exterior wall thickness (${wall.thickness.toFixed(2)}m) may be insufficient for standard insulation requirements (min 0.15m).`,
                location: wall.start as [number, number]
            });
        }
    });

    // 3. Minimum Habitable Room Area (70 sq ft / 6.5 sqm by IRC)
    model.rooms?.forEach((room) => {
        // Exclude bathrooms or closets by simple name heuristics
        const isHabitable = !/bath|toilet|wc|closet|powder|store|utility/i.test(room.name);

        if (isHabitable && room.area && room.area < 6.5) {
            newConflicts.push({
                type: 'code',
                severity: 'low',
                description: `IRC Violation: Habitable room '${room.name}' area (${room.area.toFixed(1)}m²) is below the minimum 6.5m² threshold.`,
                location: room.polygon[0] as [number, number]
            });
        }
    });

    // Safely append the deterministic conflicts to any existing AI-generated ones
    const existingConflicts = model.conflicts || [];

    // De-duplicate by description to prevent AI hallucinating the exact same string we generated
    const allConflicts = [...existingConflicts, ...newConflicts];
    const uniqueConflicts = Array.from(new Map(allConflicts.map(item => [item.description, item])).values());

    return {
        ...model,
        conflicts: uniqueConflicts
    };
}
