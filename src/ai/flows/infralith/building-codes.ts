import { GeometricReconstruction, ConstructionConflict } from './reconstruction-types';

export type BuildingCodeProfile = 'india' | 'international';

export interface BuildingCodeThresholds {
    minDoorWidthM: number;
    minExteriorWallThicknessM: number;
    minHabitableRoomAreaSqm: number;
}

export interface BuildingCodeOptions {
    profile?: BuildingCodeProfile;
    thresholds?: Partial<BuildingCodeThresholds>;
}

const DEFAULT_PROFILE: BuildingCodeProfile = 'india';
const PROFILE_THRESHOLDS: Record<BuildingCodeProfile, BuildingCodeThresholds> = {
    // India-first baseline (project configurable; not a legal substitute for local byelaws).
    india: {
        minDoorWidthM: 0.9,
        minExteriorWallThicknessM: 0.23,
        minHabitableRoomAreaSqm: 9.5,
    },
    // Legacy international defaults kept for quick switch.
    international: {
        minDoorWidthM: 0.81,
        minExteriorWallThicknessM: 0.15,
        minHabitableRoomAreaSqm: 6.5,
    },
};

const parsePositiveNumber = (value: string | undefined): number | null => {
    if (typeof value !== 'string' || value.trim() === '') return null;
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : null;
};

const normalizeProfile = (value: string | undefined): BuildingCodeProfile => {
    const normalized = String(value || '').trim().toLowerCase();
    if (normalized === 'international') return 'international';
    return DEFAULT_PROFILE;
};

const readThresholdOverride = (profile: BuildingCodeProfile, suffix: string): number | null => {
    const profileSpecificKey = `INFRALITH_${profile.toUpperCase()}_${suffix}`;
    return parsePositiveNumber(process.env[profileSpecificKey]) ??
        parsePositiveNumber(process.env[`INFRALITH_${suffix}`]);
};

export const resolveBuildingCodeConfig = (options?: BuildingCodeOptions) => {
    const envProfile = normalizeProfile(process.env.INFRALITH_BUILDING_CODE_PROFILE);
    const profile = options?.profile || envProfile;
    const baseline = PROFILE_THRESHOLDS[profile];

    const envDoor = readThresholdOverride(profile, 'MIN_DOOR_WIDTH_M');
    const envWall = readThresholdOverride(profile, 'MIN_EXTERIOR_WALL_THICKNESS_M');
    const envRoom = readThresholdOverride(profile, 'MIN_HABITABLE_ROOM_AREA_SQM');

    const thresholds: BuildingCodeThresholds = {
        minDoorWidthM: options?.thresholds?.minDoorWidthM ?? envDoor ?? baseline.minDoorWidthM,
        minExteriorWallThicknessM: options?.thresholds?.minExteriorWallThicknessM ?? envWall ?? baseline.minExteriorWallThicknessM,
        minHabitableRoomAreaSqm: options?.thresholds?.minHabitableRoomAreaSqm ?? envRoom ?? baseline.minHabitableRoomAreaSqm,
    };

    return { profile, thresholds };
};

/**
 * Deterministic geometric validation for generated building models.
 * Default profile is India and thresholds can be overridden via env vars:
 * - INFRALITH_BUILDING_CODE_PROFILE=india|international
 * - INFRALITH_MIN_DOOR_WIDTH_M
 * - INFRALITH_MIN_EXTERIOR_WALL_THICKNESS_M
 * - INFRALITH_MIN_HABITABLE_ROOM_AREA_SQM
 * Profile-specific override keys are also supported:
 * - INFRALITH_INDIA_MIN_DOOR_WIDTH_M
 * - INFRALITH_INTERNATIONAL_MIN_DOOR_WIDTH_M
 * (same suffixes for wall thickness and room area)
 */
export function applyBuildingCodes(model: GeometricReconstruction, options?: BuildingCodeOptions): GeometricReconstruction {
    const { profile, thresholds } = resolveBuildingCodeConfig(options);
    const newConflicts: ConstructionConflict[] = [];

    model.doors?.forEach((door) => {
        if (!Number.isFinite(door.width)) return;
        if (door.width < thresholds.minDoorWidthM) {
            newConflicts.push({
                type: 'code',
                severity: 'high',
                description: `[${profile}] Door width (${door.width.toFixed(2)}m) is below configured minimum ${thresholds.minDoorWidthM.toFixed(2)}m.`,
                location: door.position as [number, number],
            });
        }
    });

    model.walls?.forEach((wall) => {
        if (!wall.is_exterior || !Number.isFinite(wall.thickness)) return;
        if (wall.thickness < thresholds.minExteriorWallThicknessM) {
            newConflicts.push({
                type: 'structural',
                severity: 'medium',
                description: `[${profile}] Exterior wall thickness (${wall.thickness.toFixed(2)}m) is below configured minimum ${thresholds.minExteriorWallThicknessM.toFixed(2)}m.`,
                location: wall.start as [number, number],
            });
        }
    });

    model.rooms?.forEach((room) => {
        const isHabitable = !/bath|toilet|wc|closet|powder|store|utility/i.test(room.name);
        if (!isHabitable || !Number.isFinite(room.area)) return;

        if (room.area < thresholds.minHabitableRoomAreaSqm) {
            newConflicts.push({
                type: 'code',
                severity: 'low',
                description: `[${profile}] Habitable room '${room.name}' area (${room.area.toFixed(1)}m^2) is below configured minimum ${thresholds.minHabitableRoomAreaSqm.toFixed(1)}m^2.`,
                location: room.polygon[0] as [number, number],
            });
        }
    });

    const existingConflicts = model.conflicts || [];
    const allConflicts = [...existingConflicts, ...newConflicts];
    const uniqueConflicts = Array.from(new Map(allConflicts.map((item) => [item.description, item])).values());

    return {
        ...model,
        conflicts: uniqueConflicts,
    };
}