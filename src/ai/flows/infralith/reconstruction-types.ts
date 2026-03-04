export interface WallSolid {
    id: string;
    position: [number, number, number]; // [x, y, z] center of the solid piece
    size: [number, number, number];     // [width, height, depth]
    rotation: [number, number, number]; // [x, y, z] rotation
    color: string;
}

export interface WallGeometry {
    id: string | number;
    start: [number, number];
    end: [number, number];
    thickness: number;
    height: number;
    source_wall_id?: string | number;
    base_offset?: number;
    color?: string; // hex color for the wall
    is_exterior?: boolean;
    floor_level?: number; // 0 for Ground, 1 for First Floor, etc.
    wallSolids?: WallSolid[]; // Pre-cut geometry from the server
}

export interface DoorGeometry {
    id: string | number;
    host_wall_id: string | number;
    position: [number, number];
    width: number;
    height: number;
    color?: string;
    floor_level?: number;
}

export interface WindowGeometry {
    id: string | number;
    host_wall_id: string | number;
    position: [number, number];
    width: number;
    sill_height: number;
    color?: string;
    floor_level?: number;
}

export interface RoomGeometry {
    id: string | number;
    name: string;
    polygon: [number, number][];
    area: number;
    floor_color?: string; // hex color for the floor tile
    floor_level?: number;
}

export interface RoofGeometry {
    type: 'flat' | 'gable' | 'hip';
    polygon: [number, number][];
    height: number;      // peak height above wall top
    base_height: number; // wall top height (2.7 usually)
    color?: string;
}

export interface FurnitureGeometry {
    id: string | number;
    room_id?: string | number;
    type: string; // e.g. "sofa", "bed", "dining table", "hvac"
    position: [number, number]; // [x, z] center position
    rotation?: number; // Added rotation for wall-snapping
    width: number;
    depth: number;
    height: number;
    color?: string;
    description: string; // detailed description for AI asset generation
    floor_level?: number;
}

export interface ConstructionConflict {
    type: 'structural' | 'safety' | 'code';
    severity: 'low' | 'medium' | 'high';
    description: string;
    location: [number, number];
}

export interface AIAssetPart {
    name: string;
    position: [number, number, number];
    size: [number, number, number];
    color: string;
    material: 'wood' | 'metal' | 'glass' | 'plastic' | 'stone' | 'cloth';
}

export interface AIAsset {
    name: string;
    parts: AIAssetPart[];
}

export interface GeometricReconstruction {
    walls: WallGeometry[];
    wallSolids?: WallGeometry[];
    doors: DoorGeometry[];
    windows: WindowGeometry[];
    rooms: RoomGeometry[];
    furnitures?: FurnitureGeometry[];
    roof?: RoofGeometry;
    conflicts: ConstructionConflict[];
    building_name?: string;
    exterior_color?: string;
    debug_image?: string;
    is_vision_only?: boolean;
}

