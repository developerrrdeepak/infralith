'use client';

import React, { useState, useRef, Suspense, useCallback, useMemo } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import {
    OrbitControls,
    Environment,
    ContactShadows,
    Html,
    Edges,
    PointerLockControls,
    Sky,
    Stars,
    useGLTF
} from '@react-three/drei';
import { EffectComposer, SSAO, Bloom, Noise, Vignette } from '@react-three/postprocessing';
import { Geometry, Base, Subtraction } from '@react-three/csg';
import * as THREE from 'three';
import { useThree } from '@react-three/fiber';
import { Sparkles, Footprints } from 'lucide-react';
import { motion } from 'framer-motion';
import {
    Upload,
    Box,
    Wand2,
    CheckCircle2,
    RefreshCw,
    Calculator,
    Sun,
    Moon,
    Library,
    FolderOpen,
    Map as MapIcon,
    CloudUpload,
    Settings,
    ChevronDown,
    Layers,
    Maximize2,
    Minimize2,
    ChevronRight,
    ChevronLeft,
    FileCode,
    FileBox,
    MousePointer2,
    Move,
    Scaling,
    Trash2,
    Eye,
    EyeOff,
    Edit2,
    Lightbulb,
    Camera,
    User,
    DoorOpen,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { useToast } from '@/hooks/use-toast';
import {
    GeometricReconstruction,
    RoofGeometry,
    AIAsset,
    SiteReconstruction,
} from '@/ai/flows/infralith/reconstruction-types';
import {
    processBlueprintTo3D,
    processBlueprintToSite3D,
    generateBuildingFromDescription,
    generateRealTimeAsset,
} from '@/ai/flows/infralith/blueprint-to-3d-agent';

import { BIMProvider, useBIM } from '@/contexts/bim-context';
import { exportToDXF, exportToSVG, downloadStringAsFile } from '@/lib/cad-exporter';
import { estimateConstructionCost } from '@/lib/cost-estimator';

// -- Optional custom civil-engineer model (GLB) for walkthrough --
// Prefer /public/models/civil-engineer.glb via NEXT_PUBLIC_CIVIL_ENGINEER_GLB_URL.
// Legacy default path /public/models/human.glb is still supported.
const CUSTOM_HUMAN_GLB_URL: string | null =
    process.env.NEXT_PUBLIC_CIVIL_ENGINEER_GLB_URL ||
    process.env.NEXT_PUBLIC_CUSTOM_HUMAN_GLB_URL ||
    "/models/human.glb";
const CUSTOM_HUMAN_GLB_SCALE = 1.04;
const CUSTOM_HUMAN_GLB_Y_OFFSET = 0;

// Normalizes model labels like "a person is walking" into Human rendering.
const HUMAN_LABEL_ALIASES = new Set([
    "human",
    "person",
    "a person is walking",
    "a person is waking",
    "person is walking",
    "person is waking",
    "person walking",
    "person waking",
    "walking person",
    "waking person",
    "walking human",
    "waking human",
    "human walking",
    "human waking"
]);

const normalizeHumanLabel = (value?: string | null) =>
    (value || "")
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .replace(/\s+/g, " ")
        .trim();

function isHumanLabel(value?: string | null) {
    const normalized = normalizeHumanLabel(value);
    if (!normalized) return false;
    if (HUMAN_LABEL_ALIASES.has(normalized)) return true;
    return normalized.includes("person") && (normalized.includes("walking") || normalized.includes("waking"));
}

const getVisibilityKey = (type: string, id: string | number) => `${type}::${id}`;

type WalkthroughBounds = {
    minX: number;
    maxX: number;
    minZ: number;
    maxZ: number;
};

type WalkthroughInteractableType = 'door' | 'furniture' | 'stairs';

type WalkthroughInteractable = {
    id: string;
    label: string;
    type: WalkthroughInteractableType;
    position: [number, number];
    floorLevel: number;
    useHint: string;
    collectible?: boolean;
};

type WalkthroughInteractionAction = 'toggle-door' | 'pickup' | 'use' | 'stairs';

type WalkthroughInteractionEvent = {
    item: WalkthroughInteractable;
    action: WalkthroughInteractionAction;
    message: string;
};

type WalkthroughHudState = {
    hint: string | null;
    activeFloor: number;
    sprinting: boolean;
    crouching: boolean;
    flashlightOn: boolean;
};

const clampScalar = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

const normalizeFloorLevel = (value: unknown): number => {
    const n = Number(value);
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.round(n));
};

const DEFAULT_FLOOR_HEIGHT = 2.8;
const MIN_FLOOR_HEIGHT = 2.2;

type FloorMetrics = {
    levels: number[];
    floorHeightByLevel: Map<number, number>;
    floorBaseByLevel: Map<number, number>;
    fallbackHeight: number;
};

const computeFloorMetrics = (model: GeometricReconstruction | null | undefined): FloorMetrics => {
    const levels = new Set<number>();
    const addLevel = (value: unknown) => {
        const parsed = Number(value);
        if (!Number.isFinite(parsed)) return;
        levels.add(Math.max(0, Math.round(parsed)));
    };

    for (const wall of model?.walls || []) addLevel(wall.floor_level);
    for (const room of model?.rooms || []) addLevel(room.floor_level);
    for (const door of model?.doors || []) addLevel(door.floor_level);
    for (const win of model?.windows || []) addLevel(win.floor_level);
    for (const item of model?.furnitures || []) addLevel(item.floor_level);

    if (levels.size === 0) levels.add(0);

    const hintedCountRaw = Number(model?.meta?.floor_count);
    const hintedCount = Number.isFinite(hintedCountRaw) ? Math.max(0, Math.round(hintedCountRaw)) : 0;
    const maxDetectedLevel = Math.max(...levels);
    const maxLevel = Math.max(0, maxDetectedLevel, hintedCount > 0 ? hintedCount - 1 : 0);
    const orderedLevels = Array.from({ length: maxLevel + 1 }, (_, level) => level);

    const floorHeightByLevel = new Map<number, number>();
    for (const wall of model?.walls || []) {
        const floorLevel = normalizeFloorLevel(wall.floor_level);
        const wallHeight = Math.max(
            MIN_FLOOR_HEIGHT,
            Number.isFinite(Number(wall.height)) ? Number(wall.height) : DEFAULT_FLOOR_HEIGHT
        );
        const current = floorHeightByLevel.get(floorLevel) || 0;
        floorHeightByLevel.set(floorLevel, Math.max(current, wallHeight));
    }

    const sampledHeights = [...floorHeightByLevel.values()].filter((height) => Number.isFinite(height) && height > 0);
    const averageHeight =
        sampledHeights.length > 0
            ? sampledHeights.reduce((sum, height) => sum + height, 0) / sampledHeights.length
            : DEFAULT_FLOOR_HEIGHT;
    const fallbackHeight = Math.max(MIN_FLOOR_HEIGHT, Number(averageHeight.toFixed(3)));

    const floorBaseByLevel = new Map<number, number>();
    let runningY = 0;
    for (const level of orderedLevels) {
        floorBaseByLevel.set(level, Number(runningY.toFixed(3)));
        runningY += floorHeightByLevel.get(level) || fallbackHeight;
    }

    return {
        levels: orderedLevels,
        floorHeightByLevel,
        floorBaseByLevel,
        fallbackHeight,
    };
};

const resolveFloorBaseYFromMetrics = (metrics: FloorMetrics, floorLevel: unknown): number => {
    const level = normalizeFloorLevel(floorLevel);
    const mapped = metrics.floorBaseByLevel.get(level);
    if (mapped != null) return mapped;
    if (metrics.levels.length === 0) return 0;
    const maxKnownLevel = metrics.levels[metrics.levels.length - 1];
    const maxKnownBase = metrics.floorBaseByLevel.get(maxKnownLevel) || 0;
    const extensionHeight = metrics.floorHeightByLevel.get(maxKnownLevel) || metrics.fallbackHeight;
    if (level <= maxKnownLevel) return level * metrics.fallbackHeight;
    return maxKnownBase + ((level - maxKnownLevel) * extensionHeight);
};

const resolveFloorHeightFromMetrics = (metrics: FloorMetrics, floorLevel: unknown): number => {
    const level = normalizeFloorLevel(floorLevel);
    return metrics.floorHeightByLevel.get(level) || metrics.fallbackHeight;
};

const inferClientFloorCount = (model: GeometricReconstruction | null | undefined): number => {
    if (!model) return 1;
    const metaCount = Number(model.meta?.floor_count);
    let maxLevel = -1;
    const bump = (value: unknown) => {
        const parsed = Number(value);
        if (!Number.isFinite(parsed)) return;
        maxLevel = Math.max(maxLevel, Math.round(parsed));
    };
    for (const wall of model.walls || []) bump(wall.floor_level);
    for (const room of model.rooms || []) bump(room.floor_level);
    for (const door of model.doors || []) bump(door.floor_level);
    for (const win of model.windows || []) bump(win.floor_level);
    const fromGeometry = maxLevel >= 0 ? maxLevel + 1 : 1;
    return Math.max(1, Number.isFinite(metaCount) ? Math.round(metaCount) : 1, fromGeometry);
};

const computeWalkBounds = (model: GeometricReconstruction | null | undefined): WalkthroughBounds | undefined => {
    if (!model?.walls?.length) return undefined;
    const xs = model.walls.flatMap((w) => [w.start[0], w.end[0]]).filter((v) => Number.isFinite(v));
    const zs = model.walls.flatMap((w) => [w.start[1], w.end[1]]).filter((v) => Number.isFinite(v));
    if (!xs.length || !zs.length) return undefined;
    return {
        minX: Math.min(...xs),
        maxX: Math.max(...xs),
        minZ: Math.min(...zs),
        maxZ: Math.max(...zs),
    };
};

const computeRoomCenter = (polygon: [number, number][] | null | undefined): [number, number] | null => {
    if (!Array.isArray(polygon) || polygon.length < 3) return null;
    let sumX = 0;
    let sumZ = 0;
    let count = 0;
    for (const pt of polygon) {
        const x = Number(pt?.[0]);
        const z = Number(pt?.[1]);
        if (!Number.isFinite(x) || !Number.isFinite(z)) continue;
        sumX += x;
        sumZ += z;
        count += 1;
    }
    if (count === 0) return null;
    return [sumX / count, sumZ / count];
};

const polygonArea2D = (polygon: [number, number][]): number => {
    if (!Array.isArray(polygon) || polygon.length < 3) return 0;
    let area = 0;
    for (let idx = 0; idx < polygon.length; idx += 1) {
        const [x1, y1] = polygon[idx];
        const [x2, y2] = polygon[(idx + 1) % polygon.length];
        area += (x1 * y2) - (x2 * y1);
    }
    return area / 2;
};

const buildShapeFromPolygonPoints = (polygon: [number, number][]): THREE.Shape | null => {
    if (!Array.isArray(polygon) || polygon.length < 3) return null;
    const shape = new THREE.Shape();
    polygon.forEach((point, idx) => {
        if (idx === 0) shape.moveTo(point[0], point[1]);
        else shape.lineTo(point[0], point[1]);
    });
    shape.closePath();
    return shape;
};

const buildFloorFootprintPolygonsFromWalls = (walls: GeometricReconstruction['walls']): [number, number][][] => {
    const sourceWalls = (walls || []).filter((wall) => wall?.is_exterior === true);
    const candidates = sourceWalls.length >= 3 ? sourceWalls : (walls || []);
    if (!Array.isArray(candidates) || candidates.length < 3) return [];

    const snap = (value: number) => Number(value.toFixed(3));
    const nodeIndexByKey = new Map<string, number>();
    const nodes: [number, number][] = [];
    const getNodeIndex = (point: [number, number]): number => {
        const x = snap(Number(point?.[0]));
        const y = snap(Number(point?.[1]));
        const key = `${x}:${y}`;
        const existing = nodeIndexByKey.get(key);
        if (existing != null) return existing;
        const next = nodes.length;
        nodes.push([x, y]);
        nodeIndexByKey.set(key, next);
        return next;
    };

    const edges: Array<{ a: number; b: number }> = [];
    for (const wall of candidates) {
        const start = wall?.start;
        const end = wall?.end;
        if (!Array.isArray(start) || !Array.isArray(end)) continue;
        const sx = Number(start[0]);
        const sz = Number(start[1]);
        const ex = Number(end[0]);
        const ez = Number(end[1]);
        if (![sx, sz, ex, ez].every((value) => Number.isFinite(value))) continue;
        const a = getNodeIndex([sx, sz]);
        const b = getNodeIndex([ex, ez]);
        if (a === b) continue;
        edges.push({ a, b });
    }
    if (edges.length < 3) return [];

    const adjacency = new Map<number, number[]>();
    edges.forEach((edge, edgeIdx) => {
        const aList = adjacency.get(edge.a) || [];
        aList.push(edgeIdx);
        adjacency.set(edge.a, aList);
        const bList = adjacency.get(edge.b) || [];
        bList.push(edgeIdx);
        adjacency.set(edge.b, bList);
    });

    const edgeUsed = new Set<number>();
    const polygons: [number, number][][] = [];

    for (let edgeStart = 0; edgeStart < edges.length; edgeStart += 1) {
        if (edgeUsed.has(edgeStart)) continue;
        const seed = edges[edgeStart];
        let prevNode = seed.a;
        let currentNode = seed.b;
        const pathNodes = [seed.a, seed.b];
        edgeUsed.add(edgeStart);

        let safety = 0;
        while (safety < edges.length * 4) {
            safety += 1;
            const connected = adjacency.get(currentNode) || [];
            const nextEdgeIdx = connected.find((idx) => {
                if (edgeUsed.has(idx)) return false;
                const edge = edges[idx];
                const nextNode = edge.a === currentNode ? edge.b : edge.a;
                return nextNode !== prevNode;
            });
            if (nextEdgeIdx == null) break;

            edgeUsed.add(nextEdgeIdx);
            const nextEdge = edges[nextEdgeIdx];
            const nextNode = nextEdge.a === currentNode ? nextEdge.b : nextEdge.a;
            pathNodes.push(nextNode);
            prevNode = currentNode;
            currentNode = nextNode;

            if (nextNode === pathNodes[0]) {
                const raw = pathNodes.slice(0, -1).map((nodeIdx) => nodes[nodeIdx]);
                if (raw.length >= 3) {
                    const area = Math.abs(polygonArea2D(raw));
                    if (area >= 0.8) polygons.push(raw);
                }
                break;
            }
        }
    }

    if (polygons.length === 0) return [];
    polygons.sort((a, b) => Math.abs(polygonArea2D(b)) - Math.abs(polygonArea2D(a)));
    return polygons;
};

const computeFloorInsetFromWalls = (walls: GeometricReconstruction['walls']): number => {
    const thicknessValues = (walls || [])
        .map((wall) => Number(wall?.thickness))
        .filter((value) => Number.isFinite(value) && value > 0) as number[];
    if (thicknessValues.length === 0) return 0.04;
    const avgThickness = thicknessValues.reduce((sum, value) => sum + value, 0) / thicknessValues.length;
    return clampScalar(avgThickness * 0.5, 0.02, 0.22);
};

const insetPolygonToCentroid = (polygon: [number, number][], inset = 0.04): [number, number][] => {
    if (!Array.isArray(polygon) || polygon.length < 3 || inset <= 0) return polygon;
    const center = computeRoomCenter(polygon);
    if (!center) return polygon;
    return polygon.map(([x, z]) => {
        const dx = x - center[0];
        const dz = z - center[1];
        const len = Math.hypot(dx, dz);
        if (!Number.isFinite(len) || len <= inset + 1e-4) return [x, z];
        const scale = (len - inset) / len;
        return [
            Number((center[0] + dx * scale).toFixed(4)),
            Number((center[1] + dz * scale).toFixed(4)),
        ];
    });
};

const stairsSemanticRegex = /\bstair(?:case)?s?\b|\bstairwell\b|\bup\b|\bdn\b|\bdown\b/i;

const clampUnit = (value: number, min = 0, max = 1) => Math.max(min, Math.min(max, value));

const getAdaptiveWallPbr = (wall: any) => {
    const thickness = Math.max(0.08, Number(wall?.thickness || 0.115));
    const height = Math.max(2.2, Number(wall?.height || 2.8));
    const thicknessRatio = clampUnit(thickness / 0.23, 0.45, 1.9);
    const heightRatio = clampUnit(height / 3.4, 0.55, 1.3);
    const exteriorBoost = wall?.is_exterior ? -0.06 : 0.04;
    return {
        roughness: clampUnit(0.78 - (thicknessRatio * 0.1) + exteriorBoost, 0.46, 0.9),
        metalness: clampUnit(0.03 + (thicknessRatio - 1) * 0.02, 0.01, 0.12),
        clearcoat: clampUnit(0.1 + (heightRatio * 0.08), 0.08, 0.26),
        clearcoatRoughness: clampUnit(0.74 + (thicknessRatio * 0.08), 0.58, 0.9),
        reflectivity: clampUnit(0.12 + (wall?.is_exterior ? 0.08 : 0), 0.08, 0.32),
    };
};

const getAdaptiveFloorPbr = (room: any) => {
    const area = Math.max(1, Number(room?.area || 8));
    const areaRatio = clampUnit(Math.sqrt(area) / 7.5, 0.35, 1.45);
    return {
        roughness: clampUnit(0.66 - areaRatio * 0.12, 0.38, 0.82),
        metalness: clampUnit(0.04 + areaRatio * 0.06, 0.02, 0.14),
        clearcoat: clampUnit(0.14 + areaRatio * 0.14, 0.1, 0.32),
        clearcoatRoughness: clampUnit(0.2 + (1 - areaRatio) * 0.15, 0.1, 0.38),
        reflectivity: clampUnit(0.18 + areaRatio * 0.12, 0.12, 0.34),
    };
};

const getAdaptiveRoofPbr = (roof: RoofGeometry) => {
    const heightRatio = clampUnit((Number(roof?.height || 1.5)) / 2.6, 0.25, 1.4);
    const typeBoost = roof?.type === 'flat' ? 0.05 : -0.04;
    return {
        roughness: clampUnit(0.64 + typeBoost + heightRatio * 0.05, 0.44, 0.84),
        metalness: clampUnit(0.03 + (roof?.type === 'flat' ? 0.03 : 0.01), 0.01, 0.12),
        clearcoat: clampUnit(0.1 + heightRatio * 0.1, 0.08, 0.28),
        clearcoatRoughness: clampUnit(0.62 + (1 - heightRatio) * 0.12, 0.46, 0.82),
        reflectivity: clampUnit(0.14 + (roof?.type === 'gable' ? 0.05 : 0.02), 0.1, 0.32),
    };
};

const getAdaptiveAssetPartPbr = (material: AIAsset['parts'][number]['material']) => {
    if (material === 'glass') {
        return {
            roughness: 0.07,
            metalness: 0.02,
            transmission: 0.86,
            ior: 1.46,
            thickness: 0.05,
            clearcoat: 0.7,
            clearcoatRoughness: 0.08,
            reflectivity: 0.9,
            transparent: true,
            opacity: 0.42,
        };
    }
    if (material === 'metal') {
        return {
            roughness: 0.24,
            metalness: 0.9,
            clearcoat: 0.32,
            clearcoatRoughness: 0.2,
            reflectivity: 0.86,
            transparent: false,
            opacity: 1,
        };
    }
    if (material === 'stone') {
        return {
            roughness: 0.82,
            metalness: 0.02,
            clearcoat: 0.06,
            clearcoatRoughness: 0.82,
            reflectivity: 0.1,
            transparent: false,
            opacity: 1,
        };
    }
    if (material === 'cloth') {
        return {
            roughness: 0.9,
            metalness: 0,
            clearcoat: 0.01,
            clearcoatRoughness: 0.96,
            reflectivity: 0.04,
            transparent: false,
            opacity: 1,
        };
    }
    return {
        roughness: material === 'wood' ? 0.54 : 0.68,
        metalness: material === 'wood' ? 0.08 : 0.04,
        clearcoat: material === 'wood' ? 0.26 : 0.1,
        clearcoatRoughness: material === 'wood' ? 0.4 : 0.72,
        reflectivity: material === 'wood' ? 0.24 : 0.12,
        transparent: false,
        opacity: 1,
    };
};

const buildWalkthroughInteractables = (model: GeometricReconstruction | null | undefined): WalkthroughInteractable[] => {
    if (!model) return [];
    const interactables: WalkthroughInteractable[] = [];
    const seen = new Set<string>();

    for (const door of model.doors || []) {
        const pos = door.position;
        if (!Array.isArray(pos) || pos.length < 2) continue;
        const x = Number(pos[0]);
        const z = Number(pos[1]);
        if (!Number.isFinite(x) || !Number.isFinite(z)) continue;
        const floorLevel = normalizeFloorLevel(door.floor_level);
        const id = `door-${String(door.id)}`;
        if (seen.has(id)) continue;
        seen.add(id);
        interactables.push({
            id,
            label: 'Door',
            type: 'door',
            position: [x, z],
            floorLevel,
            useHint: 'Open / Close Door',
        });
    }

    for (const item of model.furnitures || []) {
        const pos = item.position;
        if (!Array.isArray(pos) || pos.length < 2) continue;
        const x = Number(pos[0]);
        const z = Number(pos[1]);
        if (!Number.isFinite(x) || !Number.isFinite(z)) continue;
        const typeLabel = String(item.type || '').trim();
        const descLabel = String(item.description || '').trim();
        const baseLabel = typeLabel || descLabel || 'Item';
        const isStairItem = stairsSemanticRegex.test(`${typeLabel} ${descLabel}`);
        const collectible = /\b(ammo|med|kit|bandage|key|flashlight|torch|tool|hammer|wrench|extinguisher|gun|rifle|pistol|battery|radio)\b/i.test(
            `${typeLabel} ${descLabel}`
        );
        const floorLevel = normalizeFloorLevel(item.floor_level);
        const id = isStairItem ? `stairs-furniture-${String(item.id)}` : `furniture-${String(item.id)}`;
        if (seen.has(id)) continue;
        seen.add(id);
        if (isStairItem) {
            interactables.push({
                id,
                label: baseLabel.slice(0, 48) || 'Stairs',
                type: 'stairs',
                position: [x, z],
                floorLevel,
                useHint: 'Use Stairs (Change Floor)',
            });
            continue;
        }
        interactables.push({
            id,
            label: baseLabel.slice(0, 48),
            type: 'furniture',
            position: [x, z],
            floorLevel,
            useHint: collectible ? `Pick ${baseLabel.slice(0, 36)}` : `Use ${baseLabel.slice(0, 36)}`,
            collectible,
        });
    }

    for (const room of model.rooms || []) {
        const roomName = String(room.name || '').trim();
        if (!stairsSemanticRegex.test(roomName)) continue;
        const center = computeRoomCenter(room.polygon || []);
        if (!center) continue;
        const floorLevel = normalizeFloorLevel(room.floor_level);
        const id = `stairs-${String(room.id)}`;
        if (seen.has(id)) continue;
        seen.add(id);
        interactables.push({
            id,
            label: roomName || 'Stairs',
            type: 'stairs',
            position: center,
            floorLevel,
            useHint: 'Use Stairs (Change Floor)',
        });
    }

    return interactables;
};

const pointToSegmentDistance2D = (
    pointX: number,
    pointZ: number,
    ax: number,
    az: number,
    bx: number,
    bz: number
): { distance: number; t: number } => {
    const dx = bx - ax;
    const dz = bz - az;
    const l2 = dx * dx + dz * dz;
    if (l2 <= 1e-9) {
        return { distance: Math.hypot(pointX - ax, pointZ - az), t: 0 };
    }
    let t = ((pointX - ax) * dx + (pointZ - az) * dz) / l2;
    t = clampScalar(t, 0, 1);
    const cx = ax + t * dx;
    const cz = az + t * dz;
    return { distance: Math.hypot(pointX - cx, pointZ - cz), t };
};

// -- UI Helper Components for Professional CAD Interface --

const ToolButton = ({ icon, label, active, onClick, expanded, shortcut, color, className }: any) => (
    <button
        onClick={onClick}
        className={cn(
            "w-full flex items-center gap-3 p-3 rounded-xl transition-all duration-200 group relative",
            active ? "bg-[#f8a14d] text-white shadow-lg shadow-orange-500/20" : "text-white/40 hover:text-white hover:bg-white/5",
            !expanded && "justify-center",
            className
        )}
        title={!expanded ? `${label} (${shortcut || ''})` : ""}
    >
        <div className={cn("transition-transform duration-200 group-hover:scale-110", color)}>
            {icon}
        </div>
        {expanded && (
            <div className="flex flex-1 items-center justify-between min-w-0">
                <span className="text-[11px] font-bold truncate">{label}</span>
                {shortcut && <span className="text-[9px] font-black opacity-30 ml-2">{shortcut}</span>}
            </div>
        )}
        {!expanded && active && (
            <motion.div layoutId="activeTool" className="absolute left-0 w-1 h-6 bg-white rounded-r-full" />
        )}
    </button>
);

const InspectorGroup = ({ title, children, isOpen, onToggle }: any) => (
    <div className="space-y-1">
        <button
            onClick={onToggle}
            className="w-full flex items-center justify-between px-3 py-2 rounded-xl hover:bg-slate-100 transition-colors group"
        >
            <div className="flex items-center gap-2">
                <ChevronRight className={cn("h-3 w-3 text-slate-400 transition-transform", isOpen && "rotate-90")} />
                <span className="text-[10px] font-black uppercase tracking-widest text-slate-600">{title}</span>
            </div>
            <Badge variant="outline" className="text-[9px] px-1.5 h-4 border-slate-200 text-slate-400">
                {React.Children.count(children)}
            </Badge>
        </button>
        {isOpen && <div className="pl-2 space-y-1">{children}</div>}
    </div>
);

const InspectorItem = ({ icon, label, sublabel, active, visible, onSelect, onToggleVisibility, onEdit }: any) => (
    <div
        className={cn(
            "group flex items-center gap-3 p-2 rounded-xl transition-all cursor-pointer",
            active ? "bg-slate-100 ring-1 ring-slate-200" : "hover:bg-slate-50"
        )}
        onClick={onSelect}
    >
        <div className="shrink-0">{icon}</div>
        <div className="flex-1 min-w-0">
            <p className={cn("text-[11px] font-bold truncate", active ? "text-slate-900" : "text-slate-600")}>{label}</p>
            {sublabel && <p className="text-[9px] text-slate-400 font-medium">{sublabel}</p>}
        </div>
        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
            {onToggleVisibility && (
                <button
                    onClick={(e) => { e.stopPropagation(); onToggleVisibility(); }}
                    className="p-1 text-slate-400 hover:text-slate-600 rounded-md"
                >
                    {visible ? <Eye className="h-3 w-3" /> : <EyeOff className="h-3 w-3" />}
                </button>
            )}
            {onEdit && (
                <button
                    onClick={(e) => { e.stopPropagation(); onEdit(); }}
                    className="p-1 text-slate-400 hover:text-slate-600 rounded-md"
                >
                    <Edit2 className="h-3 w-3" />
                </button>
            )}
        </div>
    </div>
);

// -- Gable Roof --

function RoofMesh({ roof }: { roof: RoofGeometry }) {
    if (!roof || !roof.polygon || roof.polygon.length < 3) return null;
    const roofColor = roof.color || '#a0522d';
    const baseY = roof.base_height || 2.7;
    const peakY = baseY + (roof.height || 1.5);
    const minX = Math.min(...roof.polygon.map(p => p[0]));
    const maxX = Math.max(...roof.polygon.map(p => p[0]));
    const minZ = Math.min(...roof.polygon.map(p => p[1]));
    const maxZ = Math.max(...roof.polygon.map(p => p[1]));
    const centerX = (minX + maxX) / 2;
    const overhang = 0.4;
    const roofPbr = getAdaptiveRoofPbr(roof);

    if (roof.type === 'gable') {
        const left = new THREE.BufferGeometry();
        const lv = new Float32Array([
            minX - overhang, baseY, minZ - overhang,
            centerX, peakY, minZ - overhang,
            centerX, peakY, maxZ + overhang,
            minX - overhang, baseY, maxZ + overhang,
        ]);
        left.setAttribute('position', new THREE.BufferAttribute(lv, 3));
        left.setIndex([0, 1, 2, 0, 2, 3]);
        left.computeVertexNormals();

        const right = new THREE.BufferGeometry();
        const rv = new Float32Array([
            centerX, peakY, minZ - overhang,
            maxX + overhang, baseY, minZ - overhang,
            maxX + overhang, baseY, maxZ + overhang,
            centerX, peakY, maxZ + overhang,
        ]);
        right.setAttribute('position', new THREE.BufferAttribute(rv, 3));
        right.setIndex([0, 1, 2, 0, 2, 3]);
        right.computeVertexNormals();

        const front = new THREE.BufferGeometry();
        const fv = new Float32Array([
            minX - overhang, baseY, minZ - overhang,
            maxX + overhang, baseY, minZ - overhang,
            centerX, peakY, minZ - overhang,
        ]);
        front.setAttribute('position', new THREE.BufferAttribute(fv, 3));
        front.setIndex([0, 1, 2]);
        front.computeVertexNormals();

        const back = new THREE.BufferGeometry();
        const bv = new Float32Array([
            minX - overhang, baseY, maxZ + overhang,
            centerX, peakY, maxZ + overhang,
            maxX + overhang, baseY, maxZ + overhang,
        ]);
        back.setAttribute('position', new THREE.BufferAttribute(bv, 3));
        back.setIndex([0, 1, 2]);
        back.computeVertexNormals();

        return (
            <group>
                {[left, right, front, back].map((geo, i) => (
                    <mesh key={i} geometry={geo} castShadow receiveShadow>
                        <meshPhysicalMaterial color={roofColor} side={THREE.DoubleSide} {...roofPbr} />
                    </mesh>
                ))}
                {/* Ridge cap */}
                <mesh position={[centerX, peakY + 0.02, (minZ + maxZ) / 2]}>
                    <boxGeometry args={[0.15, 0.06, maxZ - minZ + overhang * 2]} />
                    <meshPhysicalMaterial color="#7a3f1d" {...roofPbr} />
                </mesh>
            </group>
        );
    }

    // Flat roof
    return (
        <mesh position={[(minX + maxX) / 2, baseY + 0.05, (minZ + maxZ) / 2]} castShadow receiveShadow>
            <boxGeometry args={[maxX - minX + 0.6, 0.12, maxZ - minZ + 0.6]} />
            <meshPhysicalMaterial color={roofColor} {...roofPbr} />
        </mesh>
    );
}

// -- Procedural Edge/Wall Detailing --
const SkirtingBoard = ({ width, depth, yOffset = 0.05, height = 0.1 }: { width: number, depth: number, yOffset?: number, height?: number }) => (
    <mesh position={[0, yOffset, 0]} receiveShadow>
        <boxGeometry args={[width, height, depth + 0.02]} />
        <meshPhysicalMaterial color="#d4cdc3" roughness={0.62} metalness={0.03} clearcoat={0.08} clearcoatRoughness={0.7} reflectivity={0.12} />
    </mesh>
);

// -- Real-Time AI Asset Engine Component --

const globalAssetCache = new Map<string, AIAsset>();

function AIAssetRenderer({ description, width, height, depth, fallbackColor, isWalkthrough }: { description: string, width: number, height: number, depth: number, fallbackColor: string, isWalkthrough?: boolean }) {
    const [asset, setAsset] = useState<AIAsset | null>(globalAssetCache.get(description) || null);

    React.useEffect(() => {
        if (!asset) {
            generateRealTimeAsset(description).then((data) => {
                globalAssetCache.set(description, data);
                setAsset(data);
            }).catch(e => console.warn("[AI Asset Renderer] Model Synthesis Failed:", e));
        }
    }, [description, asset]);

    if (!asset) {
        // Fallback or "generating" state geometry
        return (
            <group>
                <mesh position={[0, 0, 0]}>
                    <boxGeometry args={[width, height, depth]} />
                    <meshStandardMaterial color={fallbackColor} transparent opacity={0.3} wireframe />
                </mesh>
                {isWalkthrough && (
                    <Html position={[0, height / 2.5, 0]} center>
                        <div className="bg-black/80 text-primary-foreground text-[7px] font-black uppercase px-2 py-0.5 rounded-full flex gap-1 items-center">
                            <Wand2 className="w-2 h-2 animate-pulse" />
                            Generating
                        </div>
                    </Html>
                )}
            </group>
        );
    }

    return (
        <group scale={[width, height, depth]}>
            {asset.parts.map((part, i) => (
                <mesh key={i} position={part.position as [number, number, number]} castShadow receiveShadow>
                    <boxGeometry args={part.size as [number, number, number]} />
                    <meshPhysicalMaterial
                        color={part.color}
                        {...getAdaptiveAssetPartPbr(part.material)}
                    />
                </mesh>
            ))}
        </group>
    );
}

// -- Wall with CSG Openings --

function AnimatedDoorLeaf({
    door,
    localX,
    wallThickness,
    wallHeight,
    isOpen,
}: {
    door: any;
    localX: number;
    wallThickness: number;
    wallHeight: number;
    isOpen: boolean;
}) {
    const hingeRef = useRef<THREE.Group>(null);
    const doorWidth = Math.max(0.72, Number(door?.width || 0.9));
    const doorHeight = Math.max(1.9, Number(door?.height || 2.1));
    const doorDepth = Math.max(0.035, wallThickness * 0.42);
    const hingeOnRight = String(door?.swing || '').toLowerCase() === 'right';
    const openSign = hingeOnRight ? -1 : 1;
    const hingeX = localX + (hingeOnRight ? (doorWidth / 2) : -(doorWidth / 2));
    const leafOffset = hingeOnRight ? -(doorWidth / 2) : (doorWidth / 2);

    useFrame((_, delta) => {
        if (!hingeRef.current) return;
        const targetYaw = isOpen ? openSign * 1.2 : 0;
        hingeRef.current.rotation.y = THREE.MathUtils.lerp(
            hingeRef.current.rotation.y,
            targetYaw,
            Math.min(1, delta * 9)
        );
    });

    return (
        <group ref={hingeRef} position={[hingeX, doorHeight / 2 - wallHeight / 2, 0]}>
            <mesh position={[leafOffset, 0, 0]} castShadow receiveShadow>
                <boxGeometry args={[doorWidth, doorHeight, doorDepth]} />
                <meshPhysicalMaterial color={door.color || "#8b4513"} roughness={0.52} metalness={0.08} clearcoat={0.28} clearcoatRoughness={0.42} reflectivity={0.24} />
            </mesh>
            <mesh position={[leafOffset + (hingeOnRight ? -doorWidth * 0.32 : doorWidth * 0.32), 0, doorDepth * 0.58]} castShadow>
                <boxGeometry args={[0.06, 0.06, 0.06]} />
                <meshPhysicalMaterial color="#d9d3c7" roughness={0.22} metalness={0.88} clearcoat={0.36} clearcoatRoughness={0.2} reflectivity={0.84} />
            </mesh>
        </group>
    );
}

const WallSegment = React.memo(function WallSegment({
    wall,
    wallWindows,
    wallDoors,
    defaultColor,
    onSelect,
    isWalkthrough,
    openedDoorIds,
    useCsg = true,
    renderWallMesh = true,
    renderOpeningAssets = true,
    resolveFloorBaseY
}: any) {
    const dx = wall.end[0] - wall.start[0];
    const dz = wall.end[1] - wall.start[1];
    const len = Math.sqrt(dx * dx + dz * dz);
    const ang = Math.atan2(dz, dx);
    const cx = (wall.start[0] + wall.end[0]) / 2;
    const cz = (wall.start[1] + wall.end[1]) / 2;
    const floorLevel = normalizeFloorLevel(wall.floor_level);
    const floorBaseY = typeof resolveFloorBaseY === 'function'
        ? resolveFloorBaseY(floorLevel)
        : floorLevel * DEFAULT_FLOOR_HEIGHT;
    const baseY = floorBaseY + Number(wall.base_offset || 0);

    return (
        <group position={[cx, baseY + wall.height / 2, cz]} rotation={[0, -ang, 0]}>
            {renderWallMesh && (
                <>
                    <mesh castShadow receiveShadow
                        onClick={(e) => { e.stopPropagation(); onSelect?.({ type: 'wall', data: wall }) }}
                        onPointerOver={(e) => { e.stopPropagation(); document.body.style.cursor = 'pointer'; }}
                        onPointerOut={() => { document.body.style.cursor = 'auto'; }}
                    >
                        {useCsg ? (
                            <Geometry>
                                <Base geometry={new THREE.BoxGeometry(len, wall.height, wall.thickness)} />

                                {/* Subtract Windows */}
                                {wallWindows.map((win: any) => {
                                    const winDx = win.position[0] - wall.start[0];
                                    const winDz = win.position[1] - wall.start[1];
                                    const dist = (winDx * dx + winDz * dz) / len;
                                    const localX = dist - len / 2;
                                    const wh = 1.2;
                                    return (
                                        <Subtraction key={win.id} position={[localX, win.sill_height + wh / 2 - wall.height / 2, 0]}>
                                            <boxGeometry args={[win.width, wh, wall.thickness + 0.1]} />
                                        </Subtraction>
                                    );
                                })}

                                {/* Subtract Doors */}
                                {wallDoors.map((door: any) => {
                                    const doorDx = door.position[0] - wall.start[0];
                                    const doorDz = door.position[1] - wall.start[1];
                                    const dist = (doorDx * dx + doorDz * dz) / len;
                                    const localX = dist - len / 2;
                                    return (
                                        <Subtraction key={door.id} position={[localX, door.height / 2 - wall.height / 2, 0]}>
                                            <boxGeometry args={[door.width, door.height, wall.thickness + 0.1]} />
                                        </Subtraction>
                                    );
                                })}
                            </Geometry>
                        ) : (
                            <boxGeometry args={[len, wall.height, wall.thickness]} />
                        )}
                        <meshPhysicalMaterial color={wall.color || defaultColor} {...getAdaptiveWallPbr(wall)} />
                        <Edges color="#00000020" threshold={15} />
                    </mesh>

                    {/* Skirting Baseboard for Interior */}
                    {!wall.is_exterior && <SkirtingBoard width={len} depth={wall.thickness} />}
                </>
            )}

            {/* Visual Fillers for Glass and Frames Generated by OpenAI */}
            {renderOpeningAssets && wallWindows.map((win: any) => {
                const winDx = win.position[0] - wall.start[0];
                const winDz = win.position[1] - wall.start[1];
                const dist = (winDx * dx + winDz * dz) / len;
                const localX = dist - len / 2;
                const wh = 1.2;
                // High-fidelity description for AI Generation
                const desc = `High - end enterprise architectural aluminum window with frame, mullions, and double glazing glass.Color: ${win.color || 'dark grey'}.`;
                return (
                    <group key={`win - glass - ${win.id} `} position={[localX, win.sill_height + wh / 2 - wall.height / 2, 0]}>
                        <AIAssetRenderer description={desc} width={win.width} height={wh} depth={wall.thickness + 0.05} fallbackColor={win.color || "#87CEEB"} isWalkthrough={isWalkthrough} />
                    </group>
                );
            })}

            {/* Visual Fillers for Doors Generated by OpenAI */}
            {renderOpeningAssets && wallDoors.map((door: any) => {
                const doorDx = door.position[0] - wall.start[0];
                const doorDz = door.position[1] - wall.start[1];
                const dist = (doorDx * dx + doorDz * dz) / len;
                const localX = dist - len / 2;
                const isOpen = !!openedDoorIds?.has(String(door.id));
                if (isWalkthrough) {
                    return (
                        <AnimatedDoorLeaf
                            key={`door-leaf-${door.id}`}
                            door={door}
                            localX={localX}
                            wallThickness={wall.thickness}
                            wallHeight={wall.height}
                            isOpen={isOpen}
                        />
                    );
                }
                // High-fidelity description for AI Generation
                const desc = `Premium solid wooden entrance door with metallic modern handle, hinges, and detailed door frame.Color: ${door.color || 'walnut brown'} wood.`;
                return (
                    <group key={`door - leaf - ${door.id} `} position={[localX, door.height / 2 - wall.height / 2, 0]}>
                        <AIAssetRenderer description={desc} width={door.width} height={door.height} depth={wall.thickness + 0.02} fallbackColor={door.color || "#8b4513"} isWalkthrough={isWalkthrough} />
                    </group>
                );
            })}
        </group>
    );
});

function GeneratedStructure({
    progress,
    data,
    visibleElements,
    onSelect,
    isWalkthrough,
    humanModelUrl,
    openedDoorIds,
    hiddenFurnitureIds,
}: {
    progress: number,
    data: GeometricReconstruction | null,
    visibleElements?: Set<string | number>,
    onSelect?: (el: any) => void,
    isWalkthrough?: boolean,
    humanModelUrl?: string | null,
    openedDoorIds?: Set<string>,
    hiddenFurnitureIds?: Set<string>,
}) {
    if (!data) return null;
    const groupRef = useRef<THREE.Group>(null);
    const p = progress;

    const defaultExterior = data.exterior_color || '#f5e6d3';
    const defaultInterior = '#faf7f2';
    const defaultFloor = '#e8d5b7';
    const totalOpenings = (data.windows?.length || 0) + (data.doors?.length || 0);
    const serverWallSolids = Array.isArray(data.wallSolids) ? data.wallSolids : [];
    const useServerCuts = serverWallSolids.length > 0;
    const useCsg = !useServerCuts && totalOpenings <= 40;

    const openingsByWall = useMemo(() => {
        const windowsMap = new Map<string, any[]>();
        const doorsMap = new Map<string, any[]>();

        for (const win of data.windows || []) {
            const key = String(win.host_wall_id);
            if (!windowsMap.has(key)) windowsMap.set(key, []);
            windowsMap.get(key)!.push(win);
        }

        for (const door of data.doors || []) {
            const key = String(door.host_wall_id);
            if (!doorsMap.has(key)) doorsMap.set(key, []);
            doorsMap.get(key)!.push(door);
        }

        return { windowsMap, doorsMap };
    }, [data.windows, data.doors]);

    // Calculate building bounds for boundary wall
    const allX = data.walls.flatMap(w => [w.start[0], w.end[0]]);
    const allZ = data.walls.flatMap(w => [w.start[1], w.end[1]]);
    const bounds = {
        minX: Math.min(...allX),
        maxX: Math.max(...allX),
        minZ: Math.min(...allZ),
        maxZ: Math.max(...allZ),
    };
    const floorMetrics = useMemo(() => computeFloorMetrics(data), [data]);
    const wallsByFloor = useMemo(() => {
        const grouped = new Map<number, GeometricReconstruction['walls']>();
        for (const wall of data.walls || []) {
            const floorLevel = normalizeFloorLevel(wall.floor_level);
            const bucket = grouped.get(floorLevel) || [];
            bucket.push(wall);
            grouped.set(floorLevel, bucket);
        }
        return grouped;
    }, [data.walls]);
    const roomPolygonsByFloor = useMemo(() => {
        const grouped = new Map<number, [number, number][][]>();
        for (const room of data.rooms || []) {
            if (!Array.isArray(room?.polygon) || room.polygon.length < 3) continue;
            const floorLevel = normalizeFloorLevel(room.floor_level);
            const bucket = grouped.get(floorLevel) || [];
            bucket.push(room.polygon);
            grouped.set(floorLevel, bucket);
        }
        return grouped;
    }, [data.rooms]);
    const floorSlabPolygonsByLevel = useMemo(() => {
        const grouped = new Map<number, [number, number][][]>();
        for (const level of floorMetrics.levels) {
            const levelWalls = wallsByFloor.get(level) || [];
            const wallInset = computeFloorInsetFromWalls(levelWalls);
            const wallPolygons = buildFloorFootprintPolygonsFromWalls(levelWalls)
                .map((polygon) => insetPolygonToCentroid(polygon, wallInset))
                .filter((polygon) => polygon.length >= 3 && Math.abs(polygonArea2D(polygon)) >= 0.4);
            if (wallPolygons.length > 0) {
                grouped.set(level, wallPolygons);
                continue;
            }

            // If walls are incomplete for a floor, use only same-floor room polygons from source data.
            const roomPolygons = (roomPolygonsByFloor.get(level) || [])
                .map((polygon) => insetPolygonToCentroid(polygon, 0.02))
                .filter((polygon) => polygon.length >= 3 && Math.abs(polygonArea2D(polygon)) >= 0.1);
            if (roomPolygons.length > 0) grouped.set(level, roomPolygons);
        }
        return grouped;
    }, [floorMetrics.levels, roomPolygonsByFloor, wallsByFloor]);
    const resolveFloorHeight = (floorLevel: number) => resolveFloorHeightFromMetrics(floorMetrics, floorLevel);
    const resolveFloorBaseY = (floorLevel: number) => resolveFloorBaseYFromMetrics(floorMetrics, floorLevel);
    const groundPbr = { roughness: 0.88, metalness: 0.01, clearcoat: 0.03, clearcoatRoughness: 0.88, reflectivity: 0.08 };
    const ceilingPbr = { roughness: 0.9, metalness: 0, clearcoat: 0.02, clearcoatRoughness: 0.9, reflectivity: 0.04 };

    return (
        <group ref={groupRef}>
            {/* Ground / Lawn */}
            <mesh position={[0, -0.05, 0]} receiveShadow rotation={[-Math.PI / 2, 0, 0]}>
                <planeGeometry args={[100, 100]} />
                <meshPhysicalMaterial color="#6b9e5b" {...groundPbr} />
            </mesh>
            {/* Subtle ground grid */}
            <gridHelper args={[100, 100, "#5a8a4d", "#5a8a4d"]} position={[0, 0.005, 0]} />

            {/* Pathway from gate to entrance */}
            <mesh position={[(bounds.minX + bounds.maxX) / 2, 0.01, bounds.minZ - 1.5]} rotation={[-Math.PI / 2, 0, 0]}>
                <planeGeometry args={[2, 4]} />
                <meshPhysicalMaterial color="#b8a68a" roughness={0.7} metalness={0.05} clearcoat={0.14} clearcoatRoughness={0.36} reflectivity={0.18} />
            </mesh>

            {p > 0 && (
                <group scale={[1, p, 1]}>
                    {/* Floor slabs from blueprint footprints (no hardcoded slab extents). */}
                    {floorMetrics.levels.map((floorLevel) => {
                        const polygons = floorSlabPolygonsByLevel.get(floorLevel) || [];
                        if (polygons.length === 0) return null;
                        const zPos = resolveFloorBaseY(floorLevel);
                        const ceilingY = zPos + resolveFloorHeight(floorLevel) - 0.02;
                        return (
                            <group key={`floor-shell-${floorLevel}`}>
                                {polygons.map((polygon, polygonIdx) => {
                                    const shape = buildShapeFromPolygonPoints(polygon);
                                    if (!shape) return null;
                                    return (
                                        <group key={`floor-shell-${floorLevel}-${polygonIdx}`}>
                                            <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, zPos + 0.01, 0]} receiveShadow>
                                                <shapeGeometry args={[shape]} />
                                                <meshPhysicalMaterial
                                                    color={defaultFloor}
                                                    roughness={0.74}
                                                    metalness={0.02}
                                                    clearcoat={0.1}
                                                    clearcoatRoughness={0.5}
                                                    reflectivity={0.14}
                                                />
                                            </mesh>
                                            <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, ceilingY, 0]} receiveShadow={false}>
                                                <shapeGeometry args={[shape]} />
                                                <meshPhysicalMaterial
                                                    color="#f4f1eb"
                                                    {...ceilingPbr}
                                                    side={THREE.BackSide}
                                                    transparent
                                                    opacity={isWalkthrough ? 0.52 : 0.2}
                                                />
                                            </mesh>
                                        </group>
                                    );
                                })}
                            </group>
                        );
                    })}

                    {/* Room Floors */}
                    {data.rooms.filter(r => !visibleElements || visibleElements.has(getVisibilityKey('room', r.id))).map((room, i) => {
                        const renderPolygon = insetPolygonToCentroid(room.polygon || [], 0.04);
                        if (!Array.isArray(renderPolygon) || renderPolygon.length < 3) return null;
                        const shape = new THREE.Shape();
                        renderPolygon.forEach((pt, idx) => {
                            if (idx === 0) shape.moveTo(pt[0], pt[1]);
                            else shape.lineTo(pt[0], pt[1]);
                        });
                        shape.closePath();
                        const floorLevel = normalizeFloorLevel(room.floor_level);
                        const zPos = resolveFloorBaseY(floorLevel);

                        return (
                            <group key={`room - ${i} `}>
                                <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, zPos + 0.02, 0]} receiveShadow
                                    onClick={(e) => { e.stopPropagation(); onSelect?.({ type: 'room', data: room }); }}
                                    onPointerOver={(e) => { e.stopPropagation(); document.body.style.cursor = 'pointer'; }}
                                    onPointerOut={() => { document.body.style.cursor = 'auto'; }}
                                >
                                    <shapeGeometry args={[shape]} />
                                    <meshPhysicalMaterial
                                        color={room.floor_color || defaultFloor}
                                        {...getAdaptiveFloorPbr(room)}
                                    />
                                </mesh>
                            </group>
                        );
                    })}

                    {/* Walls (server pre-cut solids when available, else CSG/dynamic wall mesh) */}
                    {(useServerCuts ? serverWallSolids : data.walls)
                        .filter((wall) => {
                            const visibilityWallId = wall.source_wall_id ?? wall.id;
                            return !visibleElements || visibleElements.has(getVisibilityKey('wall', visibilityWallId));
                        })
                        .map((wall, i) => (
                            <WallSegment
                                key={`wall-mesh-${i}-${wall.id}`}
                                wall={wall}
                                wallWindows={useServerCuts ? [] : (openingsByWall.windowsMap.get(String(wall.id)) || [])}
                                wallDoors={useServerCuts ? [] : (openingsByWall.doorsMap.get(String(wall.id)) || [])}
                                defaultColor={wall.is_exterior ? defaultExterior : defaultInterior}
                                onSelect={onSelect}
                                isWalkthrough={isWalkthrough}
                                openedDoorIds={openedDoorIds}
                                useCsg={useCsg}
                                renderWallMesh={true}
                                renderOpeningAssets={!useServerCuts}
                                resolveFloorBaseY={resolveFloorBaseY}
                            />
                        ))}

                    {/* In server pre-cut mode, render door/window assets once using original host walls */}
                    {useServerCuts && data.walls
                        .filter(w => !visibleElements || visibleElements.has(getVisibilityKey('wall', w.id)))
                        .map((wall, i) => (
                            <WallSegment
                                key={`wall-openings-${i}-${wall.id}`}
                                wall={wall}
                                wallWindows={openingsByWall.windowsMap.get(String(wall.id)) || []}
                                wallDoors={openingsByWall.doorsMap.get(String(wall.id)) || []}
                                defaultColor={wall.is_exterior ? defaultExterior : defaultInterior}
                                onSelect={onSelect}
                                isWalkthrough={isWalkthrough}
                                openedDoorIds={openedDoorIds}
                                useCsg={false}
                                renderWallMesh={false}
                                renderOpeningAssets={true}
                                resolveFloorBaseY={resolveFloorBaseY}
                            />
                        ))}

                    {/* Procedurally Generated Furniture / Decor */}
                    {data.furnitures?.map((furniture, i) => {
                        const furnitureInteractableId = `furniture-${String(furniture.id)}`;
                        if (hiddenFurnitureIds?.has(furnitureInteractableId)) return null;
                        const zPos = resolveFloorBaseY(normalizeFloorLevel(furniture.floor_level));
                        const isHumanFurniture = isHumanLabel(furniture.type) || isHumanLabel(furniture.description);
                        const humanScale = Math.max(0.65, Math.min(1.8, (furniture.height || 1.7) / 1.7));
                        return (
                            <group
                                key={`furniture - ${i} `}
                                position={[
                                    furniture.position[0],
                                    isHumanFurniture ? zPos : zPos + furniture.height / 2,
                                    furniture.position[1]
                                ]}
                            >
                                {isHumanFurniture ? (
                                    <HumanCharacter humanModelUrl={humanModelUrl} scale={humanScale} />
                                ) : (
                                    <AIAssetRenderer
                                        description={furniture.description}
                                        width={furniture.width}
                                        height={furniture.height}
                                        depth={furniture.depth}
                                        fallbackColor={furniture.color || "#cccccc"}
                                        isWalkthrough={isWalkthrough}
                                    />
                                )}
                            </group>
                        );
                    })}

                    {/* Roof */}
                    {data.roof && <RoofMesh roof={data.roof} />}
                </group>
            )}

        </group>
    );
}

function OrbitViewController({
    data,
    isTopView,
    isFullscreen,
}: {
    data: GeometricReconstruction | null | undefined;
    isTopView: boolean;
    isFullscreen: boolean;
}) {
    const { camera } = useThree();
    const controlsRef = useRef<any>(null);
    const bounds = useMemo(() => computeWalkBounds(data), [data]);

    React.useEffect(() => {
        const centerX = bounds ? (bounds.minX + bounds.maxX) / 2 : 0;
        const centerZ = bounds ? (bounds.minZ + bounds.maxZ) / 2 : 0;
        const footprint = bounds ? Math.max(bounds.maxX - bounds.minX, bounds.maxZ - bounds.minZ) : 20;
        const orbitRadius = clampScalar(footprint * 2.05, 16, 190);

        if (isTopView) {
            const topY = clampScalar(footprint * 2.6, 26, 170);
            camera.position.set(centerX, topY, centerZ + 0.001);
        } else {
            const sideY = clampScalar(footprint * 0.72, 12, 38);
            camera.position.set(centerX + orbitRadius * 0.88, sideY, centerZ + orbitRadius * 0.88);
        }

        camera.lookAt(centerX, 1.2, centerZ);
        if (controlsRef.current) {
            controlsRef.current.target.set(centerX, 1.2, centerZ);
            controlsRef.current.update();
        }
    }, [bounds, camera, isTopView, isFullscreen]);

    return (
        <OrbitControls
            ref={controlsRef}
            makeDefault
            enableDamping
            dampingFactor={0.08}
            enablePan={!isTopView}
            enableRotate={!isTopView}
            minDistance={6}
            maxDistance={220}
            minPolarAngle={isTopView ? 0 : 0.22}
            maxPolarAngle={isTopView ? 0.08 : Math.PI / 2.05}
        />
    );
}

// -- Walkthrough First Person Controller --

function WalkthroughController({
    bounds,
    walls,
    doors,
    interactables,
    disabledInteractableIds,
    floorCount = 1,
    onHudChange,
    onUseInteractable,
}: {
    bounds?: WalkthroughBounds;
    walls?: GeometricReconstruction['walls'];
    doors?: GeometricReconstruction['doors'];
    interactables?: WalkthroughInteractable[];
    disabledInteractableIds?: Set<string>;
    floorCount?: number;
    onHudChange?: (next: WalkthroughHudState) => void;
    onUseInteractable?: (event: WalkthroughInteractionEvent) => void;
}) {
    const { camera } = useThree();
    const [flashlightOn, setFlashlightOn] = useState(false);
    const flashlightOnRef = useRef(false);
    const spotLightRef = useRef<THREE.SpotLight>(null);
    const spotlightTargetRef = useRef<THREE.Object3D>(null);

    const movementRef = useRef({
        forward: false,
        backward: false,
        left: false,
        right: false,
        sprint: false,
        crouch: false,
    });
    const jumpRequestedRef = useRef(false);
    const interactRequestedRef = useRef(false);
    const horizontalVelocityRef = useRef(new THREE.Vector3());
    const verticalVelocityRef = useRef(0);
    const jumpOffsetRef = useRef(0);
    const eyeHeightRef = useRef(1.72);
    const bobPhaseRef = useRef(0);
    const activeFloorRef = useRef(0);
    const currentTargetRef = useRef<WalkthroughInteractable | null>(null);
    const hudSignatureRef = useRef('');
    const audioContextRef = useRef<AudioContext | null>(null);
    const footstepTimerRef = useRef(0);

    const wallCacheByFloor = useMemo(() => {
        const cache = new Map<number, GeometricReconstruction['walls']>();
        for (const wall of walls || []) {
            const floor = normalizeFloorLevel(wall.floor_level);
            if (!cache.has(floor)) cache.set(floor, []);
            cache.get(floor)?.push(wall);
        }
        return cache;
    }, [walls]);

    const doorCacheByWall = useMemo(() => {
        const cache = new Map<string, Array<{ x: number; z: number; halfWidth: number; floorLevel: number }>>();
        for (const door of doors || []) {
            const pos = door.position;
            if (!Array.isArray(pos) || pos.length < 2) continue;
            const x = Number(pos[0]);
            const z = Number(pos[1]);
            if (!Number.isFinite(x) || !Number.isFinite(z)) continue;
            const key = String(door.host_wall_id);
            if (!cache.has(key)) cache.set(key, []);
            cache.get(key)?.push({
                x,
                z,
                halfWidth: Math.max(0.35, Number(door.width || 0.9) * 0.5),
                floorLevel: normalizeFloorLevel(door.floor_level),
            });
        }
        return cache;
    }, [doors]);

    const ensureAudioContext = useCallback(() => {
        if (typeof window === 'undefined') return null;
        if (!audioContextRef.current) {
            const Ctx = (window.AudioContext || (window as any).webkitAudioContext);
            if (!Ctx) return null;
            audioContextRef.current = new Ctx();
        }
        const ctx = audioContextRef.current;
        if (ctx && ctx.state === 'suspended') {
            ctx.resume().catch(() => { /* no-op */ });
        }
        return ctx;
    }, []);

    const playFootstep = useCallback((profile: 'sprint' | 'walk' | 'crouch') => {
        const ctx = ensureAudioContext();
        if (!ctx || ctx.state !== 'running') return;
        const now = ctx.currentTime;
        const oscillator = ctx.createOscillator();
        const filter = ctx.createBiquadFilter();
        const gain = ctx.createGain();
        const baseFrequency = profile === 'sprint' ? 145 : (profile === 'crouch' ? 105 : 120);
        const maxGain = profile === 'sprint' ? 0.042 : (profile === 'crouch' ? 0.018 : 0.03);
        oscillator.type = 'triangle';
        oscillator.frequency.setValueAtTime(baseFrequency + Math.random() * 30, now);
        filter.type = 'lowpass';
        filter.frequency.setValueAtTime(profile === 'sprint' ? 420 : 320, now);

        gain.gain.setValueAtTime(0.0001, now);
        gain.gain.exponentialRampToValueAtTime(maxGain, now + 0.012);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.11);

        oscillator.connect(filter);
        filter.connect(gain);
        gain.connect(ctx.destination);

        oscillator.start(now);
        oscillator.stop(now + 0.12);
    }, [ensureAudioContext]);

    React.useEffect(() => {
        flashlightOnRef.current = flashlightOn;
    }, [flashlightOn]);

    React.useEffect(() => {
        if (bounds) {
            activeFloorRef.current = 0;
            horizontalVelocityRef.current.set(0, 0, 0);
            verticalVelocityRef.current = 0;
            jumpOffsetRef.current = 0;
            eyeHeightRef.current = 1.72;
            bobPhaseRef.current = 0;
            const spawnX = (bounds.minX + bounds.maxX) / 2;
            const spawnZ = bounds.maxZ + 1.8;
            camera.position.set(spawnX, 1.72, spawnZ);
            camera.rotation.set(0, 0, 0);
        }
    }, [bounds, camera]);

    React.useEffect(() => {
        const updateKeyState = (code: string, isDown: boolean, repeated = false) => {
            switch (code) {
                case 'KeyW':
                case 'ArrowUp':
                    movementRef.current.forward = isDown;
                    break;
                case 'KeyS':
                case 'ArrowDown':
                    movementRef.current.backward = isDown;
                    break;
                case 'KeyA':
                case 'ArrowLeft':
                    movementRef.current.left = isDown;
                    break;
                case 'KeyD':
                case 'ArrowRight':
                    movementRef.current.right = isDown;
                    break;
                case 'ShiftLeft':
                case 'ShiftRight':
                    movementRef.current.sprint = isDown;
                    break;
                case 'ControlLeft':
                case 'ControlRight':
                case 'KeyC':
                    movementRef.current.crouch = isDown;
                    break;
                case 'Space':
                    if (isDown && !repeated) jumpRequestedRef.current = true;
                    break;
                case 'KeyE':
                    if (isDown && !repeated) interactRequestedRef.current = true;
                    break;
                case 'KeyF':
                    if (isDown && !repeated) {
                        setFlashlightOn((prev) => !prev);
                    }
                    break;
                default:
                    break;
            }
        };

        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.code === 'Space') e.preventDefault();
            if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ShiftLeft', 'ShiftRight', 'Space', 'KeyE', 'KeyF', 'ControlLeft', 'ControlRight', 'KeyC'].includes(e.code)) {
                ensureAudioContext();
            }
            updateKeyState(e.code, true, e.repeat);
        };

        const handleKeyUp = (e: KeyboardEvent) => {
            updateKeyState(e.code, false, false);
        };

        document.addEventListener('keydown', handleKeyDown);
        document.addEventListener('keyup', handleKeyUp);
        return () => {
            document.removeEventListener('keydown', handleKeyDown);
            document.removeEventListener('keyup', handleKeyUp);
        };
    }, [ensureAudioContext]);

    React.useEffect(() => {
        return () => {
            if (audioContextRef.current) {
                audioContextRef.current.close().catch(() => { /* ignore */ });
                audioContextRef.current = null;
            }
        };
    }, []);

    const collidesWithWalls = useCallback((nextX: number, nextZ: number, radius: number, floorLevel: number) => {
        const floorWalls = wallCacheByFloor.get(floorLevel) || [];
        for (const wall of floorWalls) {
            const ax = Number(wall.start?.[0]);
            const az = Number(wall.start?.[1]);
            const bx = Number(wall.end?.[0]);
            const bz = Number(wall.end?.[1]);
            if (![ax, az, bx, bz].every((v) => Number.isFinite(v))) continue;

            const wallThickness = Math.max(0.05, Number(wall.thickness || 0.115));
            const collisionThreshold = radius + (wallThickness * 0.5);
            const hit = pointToSegmentDistance2D(nextX, nextZ, ax, az, bx, bz);
            if (hit.distance > collisionThreshold) continue;

            const wallIdKey = String(wall.id);
            const wallDoors = (doorCacheByWall.get(wallIdKey) || []).filter((entry) => entry.floorLevel === floorLevel);
            if (wallDoors.length > 0) {
                const dx = bx - ax;
                const dz = bz - az;
                const wallLength = Math.hypot(dx, dz);
                if (wallLength > 1e-5) {
                    const invLenSq = 1 / (wallLength * wallLength);
                    const isInsideDoor = wallDoors.some((entry) => {
                        const doorT = clampScalar(((entry.x - ax) * dx + (entry.z - az) * dz) * invLenSq, 0, 1);
                        const normalizedHalfWidth = (entry.halfWidth + radius + 0.12) / wallLength;
                        return Math.abs(hit.t - doorT) <= normalizedHalfWidth;
                    });
                    if (isInsideDoor) continue;
                }
            }

            return true;
        }
        return false;
    }, [doorCacheByWall, wallCacheByFloor]);

    useFrame((_, delta) => {
        const dt = clampScalar(delta, 0.0001, 0.04);
        const FLOOR_HEIGHT = 2.8;
        const STAND_HEIGHT = 1.72;
        const CROUCH_HEIGHT = 1.18;
        const PLAYER_RADIUS = 0.28;
        const GRAVITY = 18.5;
        const JUMP_VELOCITY = 5.4;

        const forward = new THREE.Vector3();
        camera.getWorldDirection(forward);
        forward.y = 0;
        if (forward.lengthSq() < 1e-6) {
            forward.set(0, 0, -1);
        } else {
            forward.normalize();
        }
        const right = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0)).normalize();

        const moveInput = new THREE.Vector3();
        if (movementRef.current.forward) moveInput.add(forward);
        if (movementRef.current.backward) moveInput.sub(forward);
        if (movementRef.current.right) moveInput.add(right);
        if (movementRef.current.left) moveInput.sub(right);

        const hasMovementInput = moveInput.lengthSq() > 1e-6;
        if (hasMovementInput) moveInput.normalize();

        const isCrouching = movementRef.current.crouch;
        const targetEyeHeight = isCrouching ? CROUCH_HEIGHT : STAND_HEIGHT;
        eyeHeightRef.current = THREE.MathUtils.lerp(eyeHeightRef.current, targetEyeHeight, Math.min(1, dt * 12));

        const isSprinting = movementRef.current.sprint && hasMovementInput && !isCrouching;
        const targetSpeed = isCrouching ? 2.05 : (isSprinting ? 6.7 : 4.25);
        const desiredHorizontalVelocity = moveInput.multiplyScalar(targetSpeed);
        const acceleration = hasMovementInput ? 16 : 10;
        horizontalVelocityRef.current.lerp(desiredHorizontalVelocity, Math.min(1, dt * acceleration));
        const horizontalSpeed = Math.hypot(horizontalVelocityRef.current.x, horizontalVelocityRef.current.z);

        if (hasMovementInput && jumpOffsetRef.current <= 0.001 && horizontalSpeed > 0.8) {
            footstepTimerRef.current += dt;
            const stepInterval = isSprinting ? 0.22 : (isCrouching ? 0.46 : 0.32);
            if (footstepTimerRef.current >= stepInterval) {
                footstepTimerRef.current = 0;
                playFootstep(isSprinting ? 'sprint' : (isCrouching ? 'crouch' : 'walk'));
            }
        } else {
            footstepTimerRef.current = 0;
        }

        const activeFloor = clampScalar(activeFloorRef.current, 0, Math.max(0, floorCount - 1));
        activeFloorRef.current = activeFloor;

        const nextX = camera.position.x + (horizontalVelocityRef.current.x * dt);
        const nextZ = camera.position.z + (horizontalVelocityRef.current.z * dt);
        const collides = collidesWithWalls(nextX, nextZ, PLAYER_RADIUS, activeFloor);

        if (!collides) {
            camera.position.x = nextX;
            camera.position.z = nextZ;
        } else {
            const slideX = camera.position.x + (horizontalVelocityRef.current.x * dt);
            const slideXBlocked = collidesWithWalls(slideX, camera.position.z, PLAYER_RADIUS, activeFloor);
            if (!slideXBlocked) {
                camera.position.x = slideX;
                horizontalVelocityRef.current.z *= 0.6;
            } else {
                const slideZ = camera.position.z + (horizontalVelocityRef.current.z * dt);
                const slideZBlocked = collidesWithWalls(camera.position.x, slideZ, PLAYER_RADIUS, activeFloor);
                if (!slideZBlocked) {
                    camera.position.z = slideZ;
                    horizontalVelocityRef.current.x *= 0.6;
                } else {
                    horizontalVelocityRef.current.multiplyScalar(0.4);
                }
            }
        }

        if (bounds) {
            camera.position.x = clampScalar(camera.position.x, bounds.minX - 10, bounds.maxX + 10);
            camera.position.z = clampScalar(camera.position.z, bounds.minZ - 10, bounds.maxZ + 10);
        }

        if (jumpRequestedRef.current && jumpOffsetRef.current <= 0.001) {
            verticalVelocityRef.current = JUMP_VELOCITY;
        }
        jumpRequestedRef.current = false;

        verticalVelocityRef.current -= GRAVITY * dt;
        jumpOffsetRef.current += verticalVelocityRef.current * dt;
        if (jumpOffsetRef.current < 0) {
            jumpOffsetRef.current = 0;
            verticalVelocityRef.current = 0;
        }

        let headBob = 0;
        if (hasMovementInput && jumpOffsetRef.current <= 0.001) {
            bobPhaseRef.current += dt * (isSprinting ? 12.5 : (isCrouching ? 6.5 : 9.5));
            headBob = Math.sin(bobPhaseRef.current) * (isSprinting ? 0.045 : (isCrouching ? 0.015 : 0.028));
        }

        const baseFloorY = activeFloor * FLOOR_HEIGHT;
        camera.position.y = baseFloorY + eyeHeightRef.current + jumpOffsetRef.current + headBob;

        let bestTarget: WalkthroughInteractable | null = null;
        let bestScore = Number.POSITIVE_INFINITY;
        for (const target of interactables || []) {
            if (disabledInteractableIds?.has(target.id)) continue;
            if (normalizeFloorLevel(target.floorLevel) !== activeFloor) continue;
            const dx = target.position[0] - camera.position.x;
            const dz = target.position[1] - camera.position.z;
            const planarDistance = Math.hypot(dx, dz);
            if (!Number.isFinite(planarDistance) || planarDistance > 2.6) continue;
            const invDist = planarDistance <= 1e-6 ? 1 : (1 / planarDistance);
            const dot = (dx * forward.x + dz * forward.z) * invDist;
            if (dot < 0.42) continue;
            const score = planarDistance - (dot * 0.65);
            if (score < bestScore) {
                bestScore = score;
                bestTarget = target;
            }
        }

        currentTargetRef.current = bestTarget;

        if (interactRequestedRef.current) {
            const activeTarget = currentTargetRef.current;
            if (activeTarget) {
                if (activeTarget.type === 'stairs' && floorCount > 1) {
                    const nextFloor = (activeFloorRef.current + 1) % floorCount;
                    activeFloorRef.current = nextFloor;
                    jumpOffsetRef.current = 0;
                    verticalVelocityRef.current = 0;
                    onUseInteractable?.({
                        item: activeTarget,
                        action: 'stairs',
                        message: `Moved to floor ${nextFloor + 1}`,
                    });
                } else if (activeTarget.type === 'door') {
                    onUseInteractable?.({
                        item: activeTarget,
                        action: 'toggle-door',
                        message: `${activeTarget.label} toggled`,
                    });
                } else if (activeTarget.type === 'furniture' && activeTarget.collectible) {
                    onUseInteractable?.({
                        item: activeTarget,
                        action: 'pickup',
                        message: `Picked ${activeTarget.label}`,
                    });
                } else {
                    onUseInteractable?.({
                        item: activeTarget,
                        action: 'use',
                        message: `Used ${activeTarget.label}`,
                    });
                }
            }
        }
        interactRequestedRef.current = false;

        if (spotLightRef.current && spotlightTargetRef.current) {
            const light = spotLightRef.current;
            const targetObj = spotlightTargetRef.current;
            light.position.copy(camera.position);
            targetObj.position.set(
                camera.position.x + (forward.x * 8),
                camera.position.y - 0.05,
                camera.position.z + (forward.z * 8)
            );
            light.target = targetObj;
            light.intensity = flashlightOnRef.current ? 2.2 : 0;
            targetObj.updateMatrixWorld();
        }

        const hint = currentTargetRef.current ? `[E] ${currentTargetRef.current.useHint}` : null;
        const hudSnapshot = `${hint || ''}|${activeFloorRef.current}|${isSprinting ? 1 : 0}|${isCrouching ? 1 : 0}|${flashlightOnRef.current ? 1 : 0}`;
        if (hudSnapshot !== hudSignatureRef.current) {
            hudSignatureRef.current = hudSnapshot;
            onHudChange?.({
                hint,
                activeFloor: activeFloorRef.current,
                sprinting: isSprinting,
                crouching: isCrouching,
                flashlightOn: flashlightOnRef.current,
            });
        }
    });

    return (
        <>
            <PointerLockControls />
            <object3D ref={spotlightTargetRef} />
            <spotLight
                ref={spotLightRef}
                intensity={flashlightOn ? 2.2 : 0}
                distance={18}
                angle={0.32}
                penumbra={0.45}
                color="#fff5cf"
                castShadow
                shadow-mapSize={[1024, 1024]}
            />
        </>
    );
}

function FallbackCivilEngineerAvatar({ moving = false, sprinting = false }: { moving?: boolean; sprinting?: boolean }) {
    const bodyRef = useRef<THREE.Group>(null);
    const leftLegRef = useRef<THREE.Mesh>(null);
    const rightLegRef = useRef<THREE.Mesh>(null);
    const leftArmRef = useRef<THREE.Mesh>(null);
    const rightArmRef = useRef<THREE.Mesh>(null);
    const headRef = useRef<THREE.Mesh>(null);
    const skinColor = '#e8b792';

    useFrame((state) => {
        const phaseSpeed = moving ? (sprinting ? 12 : 8.5) : 2.2;
        const phase = state.clock.elapsedTime * phaseSpeed;
        const swing = Math.sin(phase);
        const armAmp = moving ? (sprinting ? 0.7 : 0.48) : 0.08;
        const legAmp = moving ? (sprinting ? 0.82 : 0.56) : 0.1;

        if (leftLegRef.current) leftLegRef.current.rotation.x = swing * legAmp;
        if (rightLegRef.current) rightLegRef.current.rotation.x = -swing * legAmp;
        if (leftArmRef.current) leftArmRef.current.rotation.x = -swing * armAmp;
        if (rightArmRef.current) rightArmRef.current.rotation.x = swing * armAmp;
        if (headRef.current) headRef.current.rotation.y = Math.sin(phase * 0.33) * 0.06;
        if (bodyRef.current) {
            bodyRef.current.position.y = moving ? (Math.sin(phase * 2) * 0.02) : (Math.sin(phase * 0.6) * 0.006);
            bodyRef.current.rotation.z = moving ? (Math.sin(phase) * 0.03) : 0;
        }
    });

    return (
        <group ref={bodyRef}>
            {/* Boots */}
            <mesh position={[-0.13, 0.06, 0.04]} castShadow>
                <boxGeometry args={[0.16, 0.12, 0.28]} />
                <meshStandardMaterial color="#1f2937" roughness={0.58} metalness={0.12} />
            </mesh>
            <mesh position={[0.13, 0.06, 0.04]} castShadow>
                <boxGeometry args={[0.16, 0.12, 0.28]} />
                <meshStandardMaterial color="#1f2937" roughness={0.58} metalness={0.12} />
            </mesh>

            {/* Pants / legs */}
            <mesh ref={leftLegRef} position={[-0.13, 0.38, 0]} castShadow>
                <capsuleGeometry args={[0.085, 0.54, 8, 14]} />
                <meshStandardMaterial color="#334155" roughness={0.62} />
            </mesh>
            <mesh ref={rightLegRef} position={[0.13, 0.38, 0]} castShadow>
                <capsuleGeometry args={[0.085, 0.54, 8, 14]} />
                <meshStandardMaterial color="#334155" roughness={0.62} />
            </mesh>

            {/* Torso */}
            <mesh position={[0, 1.02, 0]} castShadow>
                <capsuleGeometry args={[0.24, 0.56, 8, 16]} />
                <meshStandardMaterial color="#f59e0b" roughness={0.55} metalness={0.08} />
            </mesh>
            <mesh position={[0, 0.84, 0.02]} castShadow>
                <boxGeometry args={[0.4, 0.12, 0.18]} />
                <meshStandardMaterial color="#f59e0b" roughness={0.56} metalness={0.06} />
            </mesh>

            {/* Reflective vest stripes */}
            <mesh position={[0, 1.0, 0.23]} castShadow>
                <boxGeometry args={[0.38, 0.06, 0.02]} />
                <meshStandardMaterial color="#f8fafc" roughness={0.25} metalness={0.35} />
            </mesh>
            <mesh position={[0, 1.12, 0.23]} castShadow>
                <boxGeometry args={[0.38, 0.06, 0.02]} />
                <meshStandardMaterial color="#f8fafc" roughness={0.25} metalness={0.35} />
            </mesh>

            {/* Sleeves / arms */}
            <mesh ref={leftArmRef} position={[-0.33, 1.02, 0]} rotation={[0, 0, 0.12]} castShadow>
                <capsuleGeometry args={[0.07, 0.48, 8, 12]} />
                <meshStandardMaterial color="#1e293b" roughness={0.64} />
            </mesh>
            <mesh ref={rightArmRef} position={[0.33, 1.02, 0]} rotation={[0, 0, -0.12]} castShadow>
                <capsuleGeometry args={[0.07, 0.48, 8, 12]} />
                <meshStandardMaterial color="#1e293b" roughness={0.64} />
            </mesh>

            {/* Hands */}
            <mesh position={[-0.45, 0.82, 0.04]} castShadow>
                <sphereGeometry args={[0.06, 16, 16]} />
                <meshStandardMaterial color={skinColor} roughness={0.72} />
            </mesh>
            <mesh position={[0.45, 0.82, 0.04]} castShadow>
                <sphereGeometry args={[0.06, 16, 16]} />
                <meshStandardMaterial color={skinColor} roughness={0.72} />
            </mesh>

            {/* Neck */}
            <mesh position={[0, 1.38, 0]} castShadow>
                <capsuleGeometry args={[0.07, 0.08, 8, 14]} />
                <meshStandardMaterial color={skinColor} roughness={0.68} />
            </mesh>

            {/* Head */}
            <mesh ref={headRef} position={[0, 1.58, 0.005]} scale={[0.98, 1.08, 0.96]} castShadow>
                <sphereGeometry args={[0.16, 28, 28]} />
                <meshStandardMaterial color={skinColor} roughness={0.7} />
            </mesh>
            <mesh position={[-0.16, 1.58, 0.005]} castShadow>
                <sphereGeometry args={[0.026, 14, 14]} />
                <meshStandardMaterial color={skinColor} roughness={0.72} />
            </mesh>
            <mesh position={[0.16, 1.58, 0.005]} castShadow>
                <sphereGeometry args={[0.026, 14, 14]} />
                <meshStandardMaterial color={skinColor} roughness={0.72} />
            </mesh>

            {/* Face details */}
            <mesh position={[-0.06, 1.61, 0.145]} castShadow>
                <sphereGeometry args={[0.022, 18, 18]} />
                <meshStandardMaterial color="#ffffff" roughness={0.24} metalness={0.03} />
            </mesh>
            <mesh position={[0.06, 1.61, 0.145]} castShadow>
                <sphereGeometry args={[0.022, 18, 18]} />
                <meshStandardMaterial color="#ffffff" roughness={0.24} metalness={0.03} />
            </mesh>
            <mesh position={[-0.06, 1.61, 0.161]} castShadow>
                <sphereGeometry args={[0.009, 16, 16]} />
                <meshStandardMaterial color="#1f2937" roughness={0.25} metalness={0.02} />
            </mesh>
            <mesh position={[0.06, 1.61, 0.161]} castShadow>
                <sphereGeometry args={[0.009, 16, 16]} />
                <meshStandardMaterial color="#1f2937" roughness={0.25} metalness={0.02} />
            </mesh>
            <mesh position={[0, 1.565, 0.166]} castShadow>
                <coneGeometry args={[0.018, 0.045, 14]} />
                <meshStandardMaterial color="#d39b78" roughness={0.6} />
            </mesh>
            <mesh position={[0, 1.515, 0.153]} castShadow>
                <boxGeometry args={[0.08, 0.008, 0.015]} />
                <meshStandardMaterial color="#7c2d12" roughness={0.5} metalness={0.02} />
            </mesh>
            <mesh position={[0, 1.485, 0.145]} castShadow>
                <boxGeometry args={[0.11, 0.03, 0.02]} />
                <meshStandardMaterial color="#8b5e3c" roughness={0.65} metalness={0.03} />
            </mesh>
            <mesh position={[0, 1.655, 0.158]} castShadow>
                <boxGeometry args={[0.18, 0.012, 0.012]} />
                <meshStandardMaterial color="#5b3a2b" roughness={0.6} />
            </mesh>

            {/* Safety helmet */}
            <mesh position={[0, 1.71, 0.01]} castShadow>
                <sphereGeometry args={[0.19, 20, 20, 0, Math.PI * 2, 0, Math.PI * 0.62]} />
                <meshStandardMaterial color="#facc15" roughness={0.36} metalness={0.22} />
            </mesh>
            <mesh position={[0, 1.645, 0.08]} castShadow>
                <boxGeometry args={[0.26, 0.02, 0.16]} />
                <meshStandardMaterial color="#facc15" roughness={0.38} metalness={0.2} />
            </mesh>
            <mesh position={[-0.12, 1.56, 0.11]} castShadow>
                <boxGeometry args={[0.02, 0.11, 0.01]} />
                <meshStandardMaterial color="#facc15" roughness={0.4} metalness={0.18} />
            </mesh>
            <mesh position={[0.12, 1.56, 0.11]} castShadow>
                <boxGeometry args={[0.02, 0.11, 0.01]} />
                <meshStandardMaterial color="#facc15" roughness={0.4} metalness={0.18} />
            </mesh>
            <mesh position={[0, 1.505, 0.11]} castShadow>
                <boxGeometry args={[0.2, 0.01, 0.01]} />
                <meshStandardMaterial color="#64748b" roughness={0.34} metalness={0.16} />
            </mesh>

            {/* Clipboard */}
            <mesh position={[0.34, 0.93, 0.2]} rotation={[-0.1, 0.18, -0.38]} castShadow>
                <boxGeometry args={[0.22, 0.3, 0.02]} />
                <meshStandardMaterial color="#cbd5e1" roughness={0.38} metalness={0.22} />
            </mesh>
        </group>
    );
}

function GLBHumanCharacter({ url, scale, yOffset }: { url: string; scale: number; yOffset: number }) {
    const { scene } = useGLTF(url);
    const model = useMemo(() => {
        const clone = scene.clone(true);
        clone.traverse((node: any) => {
            if (node?.isMesh) {
                node.castShadow = true;
                node.receiveShadow = true;
            }
        });
        return clone;
    }, [scene]);

    return <primitive object={model} scale={[scale, scale, scale]} position={[0, yOffset, 0]} />;
}

class GLBLoadBoundary extends React.Component<
    { fallback: React.ReactNode; children: React.ReactNode },
    { hasError: boolean }
> {
    state = { hasError: false };

    static getDerivedStateFromError() {
        return { hasError: true };
    }

    componentDidCatch(error: unknown) {
        console.warn("[Human GLB] Failed to load model, using fallback avatar.", error);
    }

    render() {
        if (this.state.hasError) return this.props.fallback;
        return this.props.children;
    }
}

function HumanCharacter({
    humanModelUrl,
    scale = 1,
    moving = false,
    sprinting = false,
}: {
    humanModelUrl?: string | null;
    scale?: number;
    moving?: boolean;
    sprinting?: boolean;
}) {
    return (
        <group scale={[scale, scale, scale]}>
            {humanModelUrl ? (
                <GLBLoadBoundary key={humanModelUrl} fallback={<FallbackCivilEngineerAvatar moving={moving} sprinting={sprinting} />}>
                    <Suspense fallback={<FallbackCivilEngineerAvatar moving={moving} sprinting={sprinting} />}>
                        <GLBHumanCharacter
                            url={humanModelUrl}
                            scale={CUSTOM_HUMAN_GLB_SCALE}
                            yOffset={CUSTOM_HUMAN_GLB_Y_OFFSET}
                        />
                    </Suspense>
                </GLBLoadBoundary>
            ) : (
                <FallbackCivilEngineerAvatar moving={moving} sprinting={sprinting} />
            )}
        </group>
    );
}

function EngineerWalkthroughController({ bounds, humanModelUrl }: { bounds?: any; humanModelUrl?: string | null }) {
    const { camera } = useThree();
    const controlsRef = useRef<any>(null);
    const playerRef = useRef<THREE.Group>(null);
    const playerPosition = useRef(new THREE.Vector3(0, 0, 0));
    const movementRef = useRef({
        forward: false,
        backward: false,
        left: false,
        right: false,
        sprint: false,
    });
    const [animationState, setAnimationState] = useState({ moving: false, sprinting: false });
    const moveDirRef = useRef(new THREE.Vector3());
    const cameraForwardRef = useRef(new THREE.Vector3());
    const cameraRightRef = useRef(new THREE.Vector3());
    const upAxisRef = useRef(new THREE.Vector3(0, 1, 0));
    const followTargetRef = useRef(new THREE.Vector3());

    const syncAnimationState = useCallback(() => {
        const moving =
            movementRef.current.forward ||
            movementRef.current.backward ||
            movementRef.current.left ||
            movementRef.current.right;
        const sprinting = moving && movementRef.current.sprint;
        setAnimationState((prev) => {
            if (prev.moving === moving && prev.sprinting === sprinting) return prev;
            return { moving, sprinting };
        });
    }, []);

    React.useEffect(() => {
        if (bounds) {
            const spawn = new THREE.Vector3((bounds.minX + bounds.maxX) / 2, 0, bounds.maxZ + 1.2);
            playerPosition.current.copy(spawn);
            camera.position.set(spawn.x, 2.2, spawn.z + 4.2);
            camera.lookAt(spawn.x, 1.2, spawn.z);
        }
    }, [bounds, camera]);

    React.useEffect(() => {
        const setMovement = (code: string, isDown: boolean) => {
            switch (code) {
                case 'KeyW':
                case 'ArrowUp':
                    movementRef.current.forward = isDown;
                    break;
                case 'KeyA':
                case 'ArrowLeft':
                    movementRef.current.left = isDown;
                    break;
                case 'KeyS':
                case 'ArrowDown':
                    movementRef.current.backward = isDown;
                    break;
                case 'KeyD':
                case 'ArrowRight':
                    movementRef.current.right = isDown;
                    break;
                case 'ShiftLeft':
                case 'ShiftRight':
                    movementRef.current.sprint = isDown;
                    break;
                default:
                    return;
            }
            syncAnimationState();
        };

        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.repeat) return;
            setMovement(e.code, true);
        };
        const handleKeyUp = (e: KeyboardEvent) => {
            setMovement(e.code, false);
        };
        document.addEventListener('keydown', handleKeyDown);
        document.addEventListener('keyup', handleKeyUp);
        return () => {
            document.removeEventListener('keydown', handleKeyDown);
            document.removeEventListener('keyup', handleKeyUp);
        };
    }, [syncAnimationState]);

    useFrame((state, delta) => {
        const controls = controlsRef.current;
        const player = playerRef.current;
        if (!controls || !player) return;

        const dt = clampScalar(delta, 0.0001, 0.04);
        const moveDir = moveDirRef.current;
        moveDir.set(0, 0, 0);
        const cameraForward = cameraForwardRef.current;
        camera.getWorldDirection(cameraForward);
        cameraForward.y = 0;
        if (cameraForward.lengthSq() < 1e-6) {
            cameraForward.set(0, 0, -1);
        } else {
            cameraForward.normalize();
        }
        const cameraRight = cameraRightRef.current;
        cameraRight.crossVectors(cameraForward, upAxisRef.current).normalize();

        if (movementRef.current.forward) moveDir.add(cameraForward);
        if (movementRef.current.backward) moveDir.sub(cameraForward);
        if (movementRef.current.right) moveDir.add(cameraRight);
        if (movementRef.current.left) moveDir.sub(cameraRight);

        if (moveDir.lengthSq() > 0) {
            moveDir.normalize();
            const speed = (movementRef.current.sprint ? 7.6 : 4.9) * dt;
            playerPosition.current.addScaledVector(moveDir, speed);

            if (bounds) {
                playerPosition.current.x = Math.max(bounds.minX - 12, Math.min(bounds.maxX + 12, playerPosition.current.x));
                playerPosition.current.z = Math.max(bounds.minZ - 12, Math.min(bounds.maxZ + 12, playerPosition.current.z));
            }

            const targetYaw = Math.atan2(moveDir.x, moveDir.z);
            player.rotation.y = THREE.MathUtils.lerp(player.rotation.y, targetYaw, Math.min(1, dt * 12));
        }

        const runningBob = moveDir.lengthSq() > 0 ? Math.sin(state.clock.elapsedTime * (movementRef.current.sprint ? 14 : 9)) * 0.04 : 0;
        player.position.set(playerPosition.current.x, runningBob, playerPosition.current.z);

        const target = followTargetRef.current.set(playerPosition.current.x, 1.15, playerPosition.current.z);
        controls.target.lerp(target, Math.min(1, dt * 11));
        controls.update();
    });

    return (
        <>
            <OrbitControls
                ref={controlsRef}
                makeDefault
                enablePan={false}
                enableZoom={false}
                enableDamping
                dampingFactor={0.06}
                minDistance={3.6}
                maxDistance={6.8}
                minPolarAngle={0.25}
                maxPolarAngle={Math.PI / 2.15}
            />

            <group ref={playerRef}>
                <HumanCharacter
                    humanModelUrl={humanModelUrl}
                    moving={animationState.moving}
                    sprinting={animationState.sprinting}
                />
            </group>
        </>
    );
}

// -- Main Page --

function BlueprintWorkspace() {
    const { toast } = useToast();
    const viewerRootRef = useRef<HTMLDivElement | null>(null);
    const [mode, setMode] = useState<'upload' | 'describe'>('upload');
    const [siteModeEnabled, setSiteModeEnabled] = useState(false);
    const [siteResult, setSiteResult] = useState<SiteReconstruction | null>(null);
    const [activeSiteBuildingId, setActiveSiteBuildingId] = useState<string | null>(null);
    const [preview, setPreview] = useState<string | null>(null);
    const [description, setDescription] = useState('');
    const [status, setStatus] = useState<'idle' | 'preprocessing' | 'analyzing' | 'generating' | 'complete'>('idle');
    const [progress, setProgress] = useState(0);
    const [showCost, setShowCost] = useState(false);
    const [isSaving, setIsSaving] = useState(false);
    const [showProjects, setShowProjects] = useState(false);
    const [projects, setProjects] = useState<any[]>([]);
    const [isLoadingProjects, setIsLoadingProjects] = useState(false);
    const [timeOfDay, setTimeOfDay] = useState(14); // 2 PM default
    const [isWalkthrough, setIsWalkthrough] = useState(false);
    const [showWalkthroughHuman, setShowWalkthroughHuman] = useState(false);
    const [isTopView, setIsTopView] = useState(false);
    const [isFullscreen, setIsFullscreen] = useState(false);
    const [activeTool, setActiveTool] = useState('select');
    const [isLeftPanelExpanded, setIsLeftPanelExpanded] = useState(false);
    const [isInspectorVisible, setIsInspectorVisible] = useState(true);
    const [walkHud, setWalkHud] = useState<WalkthroughHudState>({
        hint: null,
        activeFloor: 0,
        sprinting: false,
        crouching: false,
        flashlightOn: false,
    });
    const [walkActionFeed, setWalkActionFeed] = useState<string | null>(null);
    const [walkOpenedDoorIds, setWalkOpenedDoorIds] = useState<Set<string>>(new Set());
    const [walkCollectedItemIds, setWalkCollectedItemIds] = useState<Set<string>>(new Set());
    const [walkInventory, setWalkInventory] = useState<Array<{ id: string; label: string; count: number }>>([]);
    const [visibleElements, setVisibleElements] = useState<Set<string | number>>(new Set());
    const { model: elements, setModel: setElements, activeFloor, setActiveFloor, selectedElement, setSelectedElement, updateWallColor, updateRoomColor, saveToCloud, loadModel } = useBIM();
    const flowRunIdRef = useRef<string | null>(null);
    const pendingAutoWalkRef = useRef(false);
    const hasAutoEnteredFullscreenRef = useRef(false);
    const walkthroughBounds = useMemo(() => computeWalkBounds(elements), [elements]);
    const walkthroughInteractables = useMemo(() => buildWalkthroughInteractables(elements), [elements]);
    const walkthroughFloorCount = useMemo(() => inferClientFloorCount(elements), [elements]);
    const activeSiteBuilding = useMemo(
        () => siteResult?.buildings.find((building) => building.id === activeSiteBuildingId) || null,
        [siteResult, activeSiteBuildingId]
    );
    const useImmersiveLayout = status === 'complete' && !!elements && isFullscreen;
    const isPerformanceSensitiveMode = isWalkthrough || showWalkthroughHuman;

    const summarizeReconstruction = (result: GeometricReconstruction | null | undefined) => ({
        walls: result?.walls?.length || 0,
        rooms: result?.rooms?.length || 0,
        doors: result?.doors?.length || 0,
        windows: result?.windows?.length || 0,
        conflicts: result?.conflicts?.length || 0,
        hasRoof: !!result?.roof,
        buildingName: result?.building_name || 'N/A',
    });

    const logBlueprintFlow = (step: string, details?: Record<string, unknown>) => {
        const runId = flowRunIdRef.current || 'no-run';
        if (details) {
            console.log(`[Blueprint Flow][${runId}] ${step}`, details);
            return;
        }
        console.log(`[Blueprint Flow][${runId}] ${step}`);
    };

    const handleWalkHudChange = useCallback((next: WalkthroughHudState) => {
        setWalkHud((prev) => {
            if (
                prev.hint === next.hint &&
                prev.activeFloor === next.activeFloor &&
                prev.sprinting === next.sprinting &&
                prev.crouching === next.crouching &&
                prev.flashlightOn === next.flashlightOn
            ) {
                return prev;
            }
            return next;
        });
    }, []);

    const handleWalkUseInteractable = useCallback((event: WalkthroughInteractionEvent) => {
        const { item, action, message } = event;
        if (action === 'toggle-door') {
            setWalkOpenedDoorIds((prev) => {
                const next = new Set(prev);
                const key = String(item.id).replace(/^door-/, '');
                if (next.has(key)) next.delete(key);
                else next.add(key);
                return next;
            });
        }

        if (action === 'pickup') {
            if (!walkCollectedItemIds.has(item.id)) {
                setWalkCollectedItemIds((prev) => {
                    const next = new Set(prev);
                    next.add(item.id);
                    return next;
                });
                setWalkInventory((prev) => {
                    const existingIdx = prev.findIndex((entry) => entry.id === item.id || entry.label === item.label);
                    if (existingIdx >= 0) {
                        const next = [...prev];
                        next[existingIdx] = {
                            ...next[existingIdx],
                            count: next[existingIdx].count + 1,
                        };
                        return next;
                    }
                    return [...prev, { id: item.id, label: item.label, count: 1 }];
                });
            }
        }

        setWalkActionFeed(message);
        toast({
            title:
                action === 'stairs'
                    ? 'Floor Shift'
                    : action === 'pickup'
                        ? 'Item Collected'
                        : 'Interaction',
            description: message,
        });
    }, [toast, walkCollectedItemIds]);

    // Initialize visibility
    React.useEffect(() => {
        if (elements) {
            const allIds = [
                ...(elements.rooms?.map(r => getVisibilityKey('room', r.id)) || []),
                ...(elements.walls?.map(w => getVisibilityKey('wall', w.id)) || []),
                ...(elements.doors?.map(d => getVisibilityKey('door', d.id)) || []),
                ...(elements.windows?.map(w => getVisibilityKey('win', w.id)) || [])
            ];
            setVisibleElements(new Set(allIds));
        }
    }, [elements]);

    const toggleElementVisibility = (type: string, id: string | number) => {
        const key = getVisibilityKey(type, id);
        setVisibleElements(prev => {
            const next = new Set(prev);
            if (next.has(key)) next.delete(key);
            else next.add(key);
            return next;
        });
    };

    React.useEffect(() => {
        if (!siteResult || siteResult.buildings.length === 0) {
            setActiveSiteBuildingId(null);
            return;
        }
        if (activeSiteBuildingId && siteResult.buildings.some((building) => building.id === activeSiteBuildingId)) {
            return;
        }
        setActiveSiteBuildingId(siteResult.buildings[0].id);
    }, [siteResult, activeSiteBuildingId]);

    const handleSiteBuildingSelect = useCallback((buildingId: string) => {
        if (!siteResult) return;
        const selected = siteResult.buildings.find((building) => building.id === buildingId);
        if (!selected) return;
        pendingAutoWalkRef.current = true;
        setActiveSiteBuildingId(buildingId);
        setElements(selected.model);
        setStatus('complete');
        setProgress(1);
        toast({
            title: 'Building Switched',
            description: `${selected.name}: ${selected.floor_count} floor(s), ${selected.footprint_area.toFixed(0)} m² footprint.`,
        });
    }, [setElements, siteResult, toast]);

    React.useEffect(() => {
        if (isWalkthrough) return;
        setWalkHud({
            hint: null,
            activeFloor: 0,
            sprinting: false,
            crouching: false,
            flashlightOn: false,
        });
        setWalkActionFeed(null);
        setWalkOpenedDoorIds(new Set());
        setWalkCollectedItemIds(new Set());
        setWalkInventory([]);
    }, [isWalkthrough]);

    React.useEffect(() => {
        if (!walkActionFeed) return;
        const timer = window.setTimeout(() => setWalkActionFeed(null), 2200);
        return () => window.clearTimeout(timer);
    }, [walkActionFeed]);

    React.useEffect(() => {
        // Keep browser scroll state consistent while the immersive shell is active.
        const previousOverflow = document.body.style.overflow;
        if (useImmersiveLayout) {
            document.body.style.overflow = 'hidden';
        }
        return () => {
            document.body.style.overflow = previousOverflow;
        };
    }, [useImmersiveLayout]);

    React.useEffect(() => {
        // Force viewport-aware renderers (Three.js/Babylon) to recompute size after mode switch.
        const fireResize = () => window.dispatchEvent(new Event('resize'));
        fireResize();
        const rafId = window.requestAnimationFrame(fireResize);
        const t1 = window.setTimeout(fireResize, 120);
        const t2 = window.setTimeout(fireResize, 420);
        return () => {
            window.cancelAnimationFrame(rafId);
            window.clearTimeout(t1);
            window.clearTimeout(t2);
        };
    }, [isFullscreen, useImmersiveLayout]);

    React.useEffect(() => {
        if (!useImmersiveLayout) setIsLeftPanelExpanded(false);
    }, [useImmersiveLayout]);

    React.useEffect(() => {
        if (status === 'complete' && elements) {
            if (!hasAutoEnteredFullscreenRef.current) {
                setIsFullscreen(true);
                hasAutoEnteredFullscreenRef.current = true;
            }
            if (pendingAutoWalkRef.current) {
                pendingAutoWalkRef.current = false;
                setIsTopView(false);
                setIsWalkthrough(true);
                setShowWalkthroughHuman(true);
                toast({
                    title: 'Free Roam Ready',
                    description: 'WASD move, Shift sprint. Press H to switch first-person controls.',
                });
            }
            return;
        }
        hasAutoEnteredFullscreenRef.current = false;
    }, [status, elements, toast]);

    const handleDeleteElement = useCallback(() => {
        if (selectedElement && elements) {
            const nextElements = { ...elements };
            if (selectedElement.type === 'wall') {
                nextElements.walls = nextElements.walls?.filter(w => w.id !== selectedElement.data.id) || [];
            } else if (selectedElement.type === 'room') {
                nextElements.rooms = nextElements.rooms?.filter(r => r.id !== selectedElement.data.id) || [];
            }
            setElements(nextElements);
            setSelectedElement(null);
            toast({ title: 'Deleted', description: `${selectedElement.type === 'wall' ? 'Wall' : 'Room'} removed.` });
        } else {
            toast({ title: 'Nothing Selected', description: 'Select a wall or room first to delete it.', variant: 'destructive' });
        }
    }, [selectedElement, elements, setElements, setSelectedElement, toast]);

    React.useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

            if (e.key === 'Escape') {
                setIsFullscreen(false);
                setSelectedElement(null);
            } else if (e.key === 'Delete' || e.key === 'Backspace') {
                handleDeleteElement();
            } else if (e.key.toLowerCase() === 'v') {
                setActiveTool('select');
            } else if (e.key.toLowerCase() === 'm') {
                setActiveTool('move');
                toast({ title: 'Move', description: 'Select element and drag to move (Coming Soon in v2)' });
            } else if (e.key.toLowerCase() === 's') {
                setActiveTool('scale');
                toast({ title: 'Scale', description: 'Select element corners to scale (Coming Soon in v2)' });
            } else if (e.key.toLowerCase() === 'p') {
                setIsWalkthrough((prev) => {
                    const next = !prev;
                    if (next) setIsTopView(false);
                    return next;
                });
            } else if (e.key.toLowerCase() === 'h') {
                if (isWalkthrough) {
                    setShowWalkthroughHuman(prev => !prev);
                }
            } else if (e.key.toLowerCase() === 'l') {
                setTimeOfDay(prev => prev === 14 ? 22 : 14);
            } else if (e.key.toLowerCase() === 'c') {
                if (!isWalkthrough) {
                    setIsTopView((prev) => {
                        const next = !prev;
                        if (next) {
                            setIsWalkthrough(false);
                            setShowWalkthroughHuman(false);
                        }
                        return next;
                    });
                }
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [handleDeleteElement, isWalkthrough]);

    const costEstimate = useMemo(() => elements ? estimateConstructionCost(elements) : null, [elements]);

    const ACCEPTED_TYPES = [
        'image/png',
        'image/jpeg',
        'image/jpg',
        'image/webp',
    ];

    const isAcceptedFile = (f: File) => {
        if (ACCEPTED_TYPES.includes(f.type)) return true;
        const name = f.name.toLowerCase();
        return name.endsWith('.png') || name.endsWith('.jpg') || name.endsWith('.jpeg') || name.endsWith('.webp');
    };

    const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
        if (e.target.files?.[0]) {
            const f = e.target.files[0];
            if (!isAcceptedFile(f)) {
                toast({ title: 'Invalid File', description: 'Please upload PNG, JPG, JPEG, or WEBP.', variant: 'destructive' });
                return;
            }
            await startFileGeneration(f);
        }
    };

    const handleDrop = async (e: React.DragEvent) => {
        e.preventDefault();
        if (e.dataTransfer.files?.[0]) {
            const f = e.dataTransfer.files[0];
            if (!isAcceptedFile(f)) {
                toast({ title: 'Invalid File', description: 'Please upload PNG, JPG, JPEG, or WEBP.', variant: 'destructive' });
                return;
            }
            await startFileGeneration(f);
        }
    };

    const fileToBase64 = (f: File): Promise<string> => new Promise((res, rej) => {
        logBlueprintFlow('Step 3/9 converting file to base64.', { name: f.name, size: f.size });
        const r = new FileReader();
        r.readAsDataURL(f);
        r.onload = () => {
            const output = r.result as string;
            logBlueprintFlow('Step 4/9 base64 conversion complete.', { base64Chars: output.length });
            res(output);
        };
        r.onerror = e => {
            console.error('[Blueprint Flow] Base64 conversion failed.', e);
            rej(e);
        };
    });

    const resetState = useCallback(() => {
        pendingAutoWalkRef.current = false;
        hasAutoEnteredFullscreenRef.current = false;
        setPreview(null); setDescription('');
        setStatus('idle'); setProgress(0); setElements(null);
        setSiteResult(null);
        setActiveSiteBuildingId(null);
        setIsFullscreen(false);
    }, [setElements]);

    const animateProgress = (result: GeometricReconstruction) => {
        pendingAutoWalkRef.current = true;
        logBlueprintFlow('Step 8/9 applying generated JSON into BIM state.', summarizeReconstruction(result));
        setElements(result);
        setStatus('generating');
        const t = setInterval(() => {
            setProgress(prev => {
                const next = prev + 0.035;
                if (next >= 1.0) {
                    clearInterval(t);
                    setStatus('complete');
                    logBlueprintFlow('Step 9/9 generation complete and scene ready.', { progress: 1, status: 'complete' });
                    toast({
                        title: "Building Constructed",
                        description: `${result.building_name || 'Building'}: ${result.walls.length} walls, ${result.rooms?.length || 0} rooms`,
                    });
                    return 1.0;
                }
                return next;
            });
        }, 40);
    };

    const startFileGeneration = async (f: File) => {
        flowRunIdRef.current = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        logBlueprintFlow('Step 1/9 blueprint file accepted.', {
            name: f.name,
            type: f.type || 'unknown',
            sizeBytes: f.size,
        });
        setStatus('preprocessing'); setProgress(0);

        try {
            const previewUrl = URL.createObjectURL(f);
            setPreview(previewUrl);
            logBlueprintFlow('Step 2/9 preview URL created.');
        } catch (previewError) {
            console.warn('[Blueprint Flow] Preview creation failed.', previewError);
        }

        let cur = 0;
        const iv = setInterval(() => { cur += 0.02; if (cur <= 0.20) setProgress(cur); }, 80);
        try {
            logBlueprintFlow('Step 5/9 selecting processing pipeline.', { mode: 'vision-image' });
            setStatus('analyzing');

            const b64 = await fileToBase64(f);
            logBlueprintFlow('Step 6/9 executing vision blueprint pipeline.', {
                base64Chars: b64.length,
                siteModeEnabled,
            });

            if (siteModeEnabled) {
                const site = await processBlueprintToSite3D(b64);
                clearInterval(iv);
                setSiteResult(site);
                const primary = site.buildings[0];
                if (primary) {
                    setActiveSiteBuildingId(primary.id);
                    logBlueprintFlow('Step 7/9 site decomposition result received.', {
                        buildings: site.buildings.length,
                        selected: primary.name,
                        floors: primary.floor_count,
                        footprintArea: primary.footprint_area,
                    });
                    animateProgress(primary.model);
                    toast({
                        title: 'Site Blueprint Parsed',
                        description: `${site.buildings.length} building cluster(s) detected. Viewing ${primary.name}.`,
                    });
                } else {
                    setActiveSiteBuildingId(null);
                    logBlueprintFlow('Step 7/9 site decomposition produced no isolated buildings; fallback to source model.', {
                        conflicts: site.conflicts.length,
                    });
                    animateProgress(site.source_model);
                    toast({
                        title: 'Site Mode Fallback',
                        description: 'No separate building clusters detected. Showing consolidated model.',
                    });
                }
                return;
            }

            setSiteResult(null);
            setActiveSiteBuildingId(null);
            const result = await processBlueprintTo3D(b64);
            clearInterval(iv);
            logBlueprintFlow('Step 7/9 structured geometry received from AI pipeline.', summarizeReconstruction(result));
            animateProgress(result);
        } catch (error: unknown) {
            clearInterval(iv); setStatus('idle'); setPreview(null);
            console.error('[Blueprint Flow] Generation failed.', error);
            const message = error instanceof Error
                ? error.message
                : "The vision engine could not understand this layout. Please try a clearer blueprint.";
            toast({ title: "Construction Failed", description: message, variant: 'destructive' });
        }
    };

    const startDescriptionGeneration = async () => {
        if (!description.trim()) {
            toast({ title: 'Empty Description', description: 'Please describe the building you want.', variant: 'destructive' });
            return;
        }
        setSiteResult(null);
        setActiveSiteBuildingId(null);
        setStatus('analyzing'); setProgress(0);
        let cur = 0;
        const iv = setInterval(() => { cur += 0.012; if (cur <= 0.45) setProgress(cur); }, 80);
        try {
            const result = await generateBuildingFromDescription(description);
            clearInterval(iv);
            animateProgress(result);
        } catch {
            clearInterval(iv); setStatus('idle');
            toast({ title: "Generation Failed", description: "Could not generate. Try again.", variant: 'destructive' });
        }
    };

    const handleSaveToCloud = async () => {
        setIsSaving(true);
        const result = await saveToCloud();
        setIsSaving(false);
        if (result.ok) {
            toast({ title: "Saved to Cosmos DB", description: "Your BIM parametric model has been securely stored in the cloud.", variant: 'default' });
            // Refresh projects list if it's already open
            if (showProjects) fetchProjects();
        } else {
            toast({ title: "Sync Failed", description: result.error || "Could not connect to Azure Cosmos DB.", variant: 'destructive' });
        }
    };

    const fetchProjects = async () => {
        setIsLoadingProjects(true);
        try {
            const res = await fetch('/api/infralith/list-models');
            if (res.ok) {
                setProjects(await res.json());
            } else {
                const payload = await res.json().catch(() => null);
                toast({
                    title: "Project List Unavailable",
                    description: payload?.error || `Failed to fetch projects (status ${res.status}).`,
                    variant: 'destructive'
                });
            }
        } catch (e) {
            console.error("Failed to fetch projects", e);
            toast({ title: "Project List Unavailable", description: "Network error while fetching projects.", variant: 'destructive' });
        } finally {
            setIsLoadingProjects(false);
        }
    };

    const handleLoadProject = async (id: string) => {
        setStatus('analyzing'); setProgress(0.5);
        const result = await loadModel(id);
        if (result.ok) {
            pendingAutoWalkRef.current = true;
            setSiteResult(null);
            setActiveSiteBuildingId(null);
            setStatus('complete'); setProgress(1);
            setShowProjects(false);
            toast({ title: "Project Loaded", description: "Successfully retrieved from Azure Cosmos DB." });
        } else {
            setStatus('idle');
            toast({ title: "Load Failed", description: result.error || "Could not retrieve project.", variant: 'destructive' });
        }
    };

    return (
        <div
            ref={viewerRootRef}
            className={cn(
                "w-full min-h-0 flex flex-col relative overflow-hidden transition-colors duration-300",
                useImmersiveLayout
                    ? "fixed inset-0 z-[9999] w-screen h-dvh bg-[#f8f5f0]"
                    : "h-[calc(100dvh-100px)] bg-background"
            )}
        >
            {/* Fullscreen UI */}
            {useImmersiveLayout && (
                <>
                    {/* --- TOP HEADER --- */}
                    <div className="absolute top-0 left-0 right-0 h-24 px-8 flex items-center justify-between z-[110] pointer-events-none">
                        <div className="flex items-center gap-12 pointer-events-auto">
                            <div className="flex flex-col">
                                <h1 className="text-3xl font-black tracking-tighter text-[#f8a14d] flex items-center gap-2">
                                    <Box className="h-8 w-8" />
                                </h1>
                            </div>

                            <div className="flex items-center gap-2 bg-white/40 backdrop-blur-md p-1.5 rounded-2xl border border-white/40 shadow-sm transition-all hover:bg-white/60">
                                <Button variant="ghost" size="sm" className="h-10 text-slate-600 hover:text-slate-900 font-black text-xs uppercase tracking-widest px-4" onClick={() => { setShowProjects(!showProjects); if (!showProjects) fetchProjects(); }}>
                                    <Layers className="h-4 w-4 mr-2" /> My Projects
                                </Button>
                            </div>
                            {siteResult && siteResult.buildings.length > 0 && (
                                <div className="flex items-center gap-2 bg-white/40 backdrop-blur-md p-1.5 rounded-2xl border border-white/40 shadow-sm pointer-events-auto">
                                    <span className="text-[10px] font-black uppercase tracking-widest text-slate-600 px-2">
                                        Site
                                    </span>
                                    <select
                                        value={activeSiteBuildingId || siteResult.buildings[0].id}
                                        onChange={(e) => handleSiteBuildingSelect(e.target.value)}
                                        className="h-10 min-w-[220px] rounded-xl bg-white/80 border border-white/60 px-3 text-[11px] font-bold text-slate-700 focus:outline-none"
                                    >
                                        {siteResult.buildings.map((building) => (
                                            <option key={building.id} value={building.id}>
                                                {building.name} ({building.floor_count}F, {building.footprint_area.toFixed(0)}m²)
                                            </option>
                                        ))}
                                    </select>
                                </div>
                            )}
                        </div>

                        <div className="flex items-center gap-3 pointer-events-auto">
                            <Button variant="outline" size="sm" className="h-11 px-5 rounded-2xl bg-[#2d334a] border-none text-white hover:bg-[#1e2235] font-black uppercase text-[11px] tracking-widest shadow-xl transition-all active:scale-95" onClick={resetState}>
                                <RefreshCw className="h-4 w-4 mr-2" /> New
                            </Button>
                            <Button variant="outline" size="sm" className="h-11 px-5 rounded-2xl bg-[#2d334a] border-none text-white hover:bg-[#1e2235] font-black uppercase text-[11px] tracking-widest shadow-xl transition-all active:scale-95" onClick={() => downloadStringAsFile(exportToSVG(elements!, activeFloor), 'floorplan.svg', 'image/svg+xml')}>
                                Export SVG
                            </Button>
                            <Button
                                size="sm"
                                className="h-11 px-6 rounded-2xl bg-[#f8a14d] hover:bg-[#ea8d35] text-white font-black uppercase text-[11px] tracking-widest shadow-2xl shadow-orange-500/20 transition-all active:scale-95"
                                onClick={handleSaveToCloud}
                                disabled={isSaving}
                            >
                                {isSaving ? <RefreshCw className="h-4 w-4 mr-2 animate-spin" /> : <CloudUpload className="h-4 w-4 mr-2" />}
                                Save to Cloud
                            </Button>
                            <Button variant="ghost" size="sm" className="h-11 w-11 p-0 rounded-2xl bg-white/50 backdrop-blur-md border border-white/40 text-slate-600 hover:text-slate-900 shadow-sm transition-all" onClick={() => setIsFullscreen(false)}>
                                <Minimize2 className="h-5 w-5" />
                            </Button>
                        </div>
                    </div>

                    {/* --- LEFT NAVIGATION BAR (Tool System) --- */}
                    <div
                        className={cn(
                            "absolute left-6 top-1/2 -translate-y-1/2 bg-[#0f1429]/95 backdrop-blur-xl rounded-2xl border border-white/10 py-6 flex flex-col items-start z-[110] shadow-2xl transition-all duration-300 ease-in-out pointer-events-auto",
                            isLeftPanelExpanded ? "w-48 px-4" : "w-16 items-center"
                        )}
                        onMouseEnter={() => setIsLeftPanelExpanded(true)}
                        onMouseLeave={() => setIsLeftPanelExpanded(false)}
                    >
                        {/* Tool Group: EDIT */}
                        <div className="w-full space-y-2">
                            {isLeftPanelExpanded && <p className="text-[10px] font-black text-white/30 uppercase tracking-widest mb-2 px-2">Edit</p>}
                            <ToolButton
                                icon={<MousePointer2 className="h-4 w-4" />}
                                label="Select"
                                active={activeTool === 'select'}
                                onClick={() => setActiveTool('select')}
                                expanded={isLeftPanelExpanded}
                                shortcut="V"
                            />
                            <ToolButton
                                icon={<Move className="h-4 w-4" />}
                                label="Move"
                                active={activeTool === 'move'}
                                onClick={() => { setActiveTool('move'); toast({ title: 'Move', description: 'Select element and drag to move (Coming Soon)' }); }}
                                expanded={isLeftPanelExpanded}
                                shortcut="M"
                            />
                            <ToolButton
                                icon={<Scaling className="h-4 w-4" />}
                                label="Scale"
                                active={activeTool === 'scale'}
                                onClick={() => { setActiveTool('scale'); toast({ title: 'Scale', description: 'Select element corners to scale (Coming Soon)' }); }}
                                expanded={isLeftPanelExpanded}
                                shortcut="S"
                            />
                            <ToolButton
                                icon={<Trash2 className="h-4 w-4" />}
                                label="Delete"
                                active={activeTool === 'delete'}
                                onClick={() => { setActiveTool('delete'); handleDeleteElement(); }}
                                expanded={isLeftPanelExpanded}
                                shortcut="DEL"
                                color="text-red-400"
                            />
                        </div>

                        <div className="w-full h-[1px] bg-white/5 my-6" />

                        {/* Tool Group: VIEW */}
                        <div className="w-full space-y-2">
                            {isLeftPanelExpanded && <p className="text-[10px] font-black text-white/30 uppercase tracking-widest mb-2 px-2">View</p>}
                            <ToolButton
                                icon={<Footprints className="h-4 w-4" />}
                                label="Walk Mode"
                                active={isWalkthrough}
                                onClick={() => {
                                    setIsWalkthrough((prev) => {
                                        const next = !prev;
                                        if (next) {
                                            setIsTopView(false);
                                            toast({
                                                title: "Walkthrough Active",
                                                description: "WASD move, Shift sprint, Space jump, C crouch, E use, F flashlight.",
                                            });
                                        }
                                        return next;
                                    });
                                }}
                                expanded={isLeftPanelExpanded}
                                shortcut="P"
                            />
                            <ToolButton
                                icon={<User className="h-4 w-4" />}
                                label="Engineer"
                                active={isWalkthrough && showWalkthroughHuman}
                                onClick={() => {
                                    if (!isWalkthrough) {
                                        toast({ title: "Enable Walk Mode", description: "Turn on Walk Mode first to enable engineer character mode." });
                                        return;
                                    }
                                    setShowWalkthroughHuman(prev => !prev);
                                }}
                                expanded={isLeftPanelExpanded}
                                shortcut="H"
                            />
                            <ToolButton
                                icon={timeOfDay === 14 ? <Lightbulb className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
                                label={timeOfDay === 14 ? "Day Mode" : "Night Mode"}
                                active={timeOfDay === 22}
                                onClick={() => setTimeOfDay(prev => prev === 14 ? 22 : 14)}
                                expanded={isLeftPanelExpanded}
                                shortcut="L"
                            />
                            <ToolButton
                                icon={<Camera className="h-4 w-4" />}
                                label="Top Camera"
                                active={isTopView}
                                onClick={() => {
                                    setIsTopView((prev) => {
                                        const next = !prev;
                                        if (next) {
                                            setIsWalkthrough(false);
                                            setShowWalkthroughHuman(false);
                                        }
                                        return next;
                                    });
                                }}
                                expanded={isLeftPanelExpanded}
                                shortcut="C"
                            />
                        </div>

                        <ToolButton
                            icon={<Settings className="h-4 w-4" />}
                            label="Settings"
                            active={activeTool === 'settings'}
                            onClick={() => setActiveTool('settings')}
                            expanded={isLeftPanelExpanded}
                            className="mt-auto"
                        />
                    </div>

                    {/* --- RIGHT NAVIGATION PANEL (Project / Room Inspector) --- */}
                    {!isInspectorVisible && useImmersiveLayout && (
                        <motion.button
                            initial={{ opacity: 0, x: 20 }}
                            animate={{ opacity: 1, x: 0 }}
                            onClick={() => setIsInspectorVisible(true)}
                            className="absolute right-0 top-1/2 -translate-y-1/2 bg-white/95 p-3 rounded-l-xl shadow-[rgba(0,0,0,0.2)_-5px_0_15px] border border-r-0 border-slate-200 z-[111] hover:bg-white transition-all group pointer-events-auto"
                        >
                            <ChevronLeft className="h-6 w-6 text-slate-400 group-hover:text-[#f8a14d] transition-colors" />
                        </motion.button>
                    )}

                    <motion.div
                        initial={false}
                        animate={{
                            x: isInspectorVisible ? 0 : 350,
                            opacity: isInspectorVisible ? 1 : 0,
                            pointerEvents: isInspectorVisible ? "auto" : "none"
                        }}
                        transition={{ duration: 0.3, ease: 'easeOut' }}
                        className="absolute right-6 top-1/2 -translate-y-1/2 w-[320px] bg-white/95 rounded-2xl border border-slate-200 shadow-2xl z-[110] flex flex-col h-[80vh] overflow-hidden"
                    >
                        <div className="p-4 border-b border-slate-100 flex items-center justify-between">
                            <h2 className="text-[11px] font-black uppercase tracking-widest text-slate-800 flex items-center gap-2">
                                <Box className="h-4 w-4 text-[#f8a14d]" />
                                Project Inspector
                            </h2>
                            <div className="flex items-center gap-1">
                                <Button variant="ghost" size="sm" className="h-7 w-7 p-0 rounded-lg hover:bg-slate-100 text-slate-400 hover:text-slate-800" onClick={() => setIsInspectorVisible(false)}>
                                    <ChevronRight className="h-4 w-4" />
                                </Button>
                                <Button variant="ghost" size="sm" className="h-7 w-7 p-0 rounded-lg hover:bg-slate-100 text-slate-400 hover:text-slate-800" onClick={() => setIsFullscreen(false)} title="Exit Fullscreen">
                                    <Minimize2 className="h-3.5 w-3.5" />
                                </Button>
                            </div>
                        </div>

                        {/* Status Header */}
                        <div className="px-4 py-3 bg-[#f8a14d]/5 flex items-center gap-3 border-b border-slate-100">
                            <div className="h-8 w-8 rounded-lg bg-[#f8a14d] text-white flex items-center justify-center shadow-md">
                                <CheckCircle2 className="h-4 w-4" />
                            </div>
                            <div className="min-w-0">
                                <p className="text-[8px] font-black uppercase text-[#f8a14d] tracking-widest">Active Model</p>
                                <p className="text-xs font-bold text-slate-800 truncate">{elements?.building_name || "New Architecture Design"}</p>
                            </div>
                        </div>

                        <div className="flex-1 overflow-y-auto custom-scrollbar p-3 space-y-4">
                            {/* Hierarchy: PROJECT -> FLOORS -> ROOMS */}
                            <div className="space-y-1">
                                <div className="flex items-center gap-2 px-2 py-1">
                                    <ChevronDown className="h-3.5 w-3.5 text-slate-400" />
                                    <span className="text-[10px] font-black uppercase tracking-widest text-slate-500">Building Model</span>
                                </div>

                                {Array.from(new Set([
                                    ...(elements?.walls?.map(w => w.floor_level || 0) || []),
                                    ...(elements?.rooms?.map(r => r.floor_level || 0) || [])
                                ])).sort().map(floor => (
                                    <InspectorGroup
                                        key={`floor - ${floor} `}
                                        title={`Floor Level ${floor} `}
                                        isOpen={activeFloor === null || activeFloor === floor}
                                        onToggle={() => setActiveFloor(activeFloor === floor ? null : floor)}
                                    >
                                        <div className="space-y-1 ml-2">
                                            {/* Rooms on this floor */}
                                            {elements?.rooms?.filter(r => (r.floor_level || 0) === floor).map(room => (
                                                <InspectorItem
                                                    key={`room - ${room.id} `}
                                                    icon={<div className="h-2 w-2 rounded-full" style={{ backgroundColor: room.floor_color || '#e8d5b7' }} />}
                                                    label={room.name}
                                                    sublabel={`${room.area?.toFixed(0)} m²`}
                                                    active={selectedElement?.type === 'room' && selectedElement.data.id === room.id}
                                                    visible={visibleElements.has(getVisibilityKey('room', room.id))}
                                                    onSelect={() => setSelectedElement({ type: 'room', data: room })}
                                                    onToggleVisibility={() => toggleElementVisibility('room', room.id)}
                                                    onEdit={() => setSelectedElement({ type: 'room', data: room })}
                                                />
                                            ))}

                                            {/* Elements summary for this floor */}
                                            <div className="mt-2 pt-2 border-t border-slate-100 space-y-1">
                                                <InspectorItem
                                                    label="Walls"
                                                    sublabel={`${elements?.walls?.filter(w => (w.floor_level || 0) === floor).length} Units`}
                                                    icon={<Layers className="h-3 w-3 text-slate-400" />}
                                                />
                                                <InspectorItem
                                                    label="Doors"
                                                    sublabel={`${elements?.doors?.filter(d => (d.floor_level || 0) === floor).length} Units`}
                                                    icon={<DoorOpen className="h-3 w-3 text-slate-400" />}
                                                />
                                            </div>
                                        </div>
                                    </InspectorGroup>
                                ))}
                            </div>
                        </div>

                        {/* Inspector Actions */}
                        <div className="p-4 bg-slate-50 border-t border-slate-100 grid grid-cols-2 gap-2">
                            <Button size="sm" variant="outline" className="h-9 border-slate-200 text-[#f8a14d] font-bold text-[10px] uppercase tracking-widest hover:bg-white rounded-xl">
                                <Layers className="h-3.5 w-3.5 mr-2" /> Add Level
                            </Button>
                            <Button size="sm" className="h-9 bg-[#f8a14d] hover:bg-[#ea8d35] text-white font-bold text-[10px] uppercase tracking-widest rounded-xl shadow-lg shadow-orange-500/10">
                                Export BIM
                            </Button>
                        </div>
                    </motion.div>

                    {/* Context Panel - Wall Profile */}
                    {
                        selectedElement && (
                            <motion.div initial={{ opacity: 0, x: -20 }} animate={{ opacity: 1, x: 0 }}
                                className="absolute top-1/2 left-32 -translate-y-1/2 w-[280px] bg-[#0f1429]/95 backdrop-blur-2xl rounded-[32px] border border-white/5 p-8 z-[110] shadow-2xl pointer-events-auto">
                                <h3 className="text-white font-black uppercase text-xs tracking-widest mb-6 flex items-center justify-between">
                                    {selectedElement.type === 'room' ? 'Room Profile' : 'Wall Segment'}
                                    <button onClick={() => setSelectedElement(null)} className="text-white/20 hover:text-white transition-colors">✕</button>
                                </h3>

                                <div className="space-y-6">
                                    <div className="flex justify-between items-center group">
                                        <span className="text-white/40 text-[11px] font-bold uppercase tracking-wider">Thickness</span>
                                        <span className="text-white font-black text-sm">{(selectedElement.data as any).thickness || "0.23"}m</span>
                                    </div>
                                    <div className="flex justify-between items-center group">
                                        <span className="text-white/40 text-[11px] font-bold uppercase tracking-wider">Height</span>
                                        <span className="text-white font-black text-sm">{(selectedElement.data as any).height || "2.8"}m</span>
                                    </div>

                                    <div className="pt-4 border-t border-white/5">
                                        <p className="text-white/40 text-[10px] font-black uppercase tracking-widest mb-4">Material</p>
                                        <div className="flex gap-3">
                                            {['#f5e6d3', '#e2c2a3', '#d0e0e3', '#e3d0db'].map(c => (
                                                <button
                                                    key={c}
                                                    className="w-8 h-8 rounded-full border-2 border-white/20 hover:border-white shadow-xl transition-all hover:scale-110 active:scale-90"
                                                    style={{ backgroundColor: c }}
                                                    onClick={() => {
                                                        if (selectedElement.type === 'wall') updateWallColor(selectedElement.data.id, c);
                                                        else updateRoomColor(selectedElement.data.id, c);
                                                    }}
                                                />
                                            ))}
                                        </div>
                                    </div>
                                </div>
                            </motion.div>
                        )
                    }

                </>
            )}

            {/* --- STANDARD (PRE-COMPLETION) UI --- */}
            {!useImmersiveLayout && (

                <div className="flex flex-col z-30 pointer-events-none absolute top-0 w-full px-4 pt-3 pb-2 gap-2 bg-gradient-to-b from-background/90 to-transparent backdrop-blur-sm">
                    {/* Row 1: Title + Essential Actions */}
                    <div className="flex items-center justify-between pointer-events-auto">
                        <div className="flex items-center gap-4">
                            <h1 className="text-lg font-black tracking-tight flex items-center gap-2">
                                <Box className="h-5 w-5 text-primary shrink-0" />
                                <span className="hidden sm:inline text-gradient uppercase tracking-tighter">BIM Engine</span>
                            </h1>
                            <Button variant="ghost" size="sm" className="h-8 text-muted-foreground hover:text-foreground font-bold text-[10px] uppercase tracking-widest px-2" onClick={() => { setShowProjects(!showProjects); if (!showProjects) fetchProjects(); }}>
                                <Library className="h-3.5 w-3.5 mr-1.5" /> Projects
                            </Button>
                        </div>
                        <div className="flex items-center gap-1.5">
                            {status === 'complete' && elements && (
                                <>
                                    <Button variant="ghost" size="sm" className="h-8 text-primary font-black hover:bg-primary/10 text-[10px] uppercase tracking-widest px-3" onClick={() => setIsFullscreen(true)}>
                                        <Maximize2 className="h-3.5 w-3.5 mr-1.5" /> Fullscreen
                                    </Button>
                                    <Button variant="outline" size="sm" className="h-8 bg-background/50 border-border text-[10px] uppercase tracking-widest font-black px-3" onClick={resetState}>
                                        <RefreshCw className="h-3 w-3 mr-1.5" /> Reset
                                    </Button>
                                </>
                            )}
                        </div>
                    </div>

                    {/* Row 2: Secondary Toolbar (only when complete) */}
                    {status === 'complete' && elements && (
                        <div className="flex items-center gap-1.5 pointer-events-auto flex-wrap bg-white/5 backdrop-blur-md p-1 rounded-xl border border-white/10 w-fit">
                            <Button
                                variant="ghost" size="sm"
                                className={cn("h-7 text-[9px] font-black uppercase tracking-wider px-2 transition-all rounded-lg", isTopView ? "bg-primary text-primary-foreground shadow-md" : "text-muted-foreground hover:bg-white/5")}
                                onClick={() => { setIsWalkthrough(false); setIsTopView(!isTopView); }}
                            >
                                <MapIcon className="h-3 w-3 mr-1.5" /> Ortho
                            </Button>
                            <Button
                                variant="ghost" size="sm"
                                className={cn("h-7 text-[9px] font-black uppercase tracking-wider px-2 transition-all rounded-lg", isWalkthrough ? "bg-primary text-primary-foreground shadow-md" : "text-muted-foreground hover:bg-white/5")}
                                onClick={() => { setIsTopView(false); setIsWalkthrough(!isWalkthrough); if (!isWalkthrough) { toast({ title: "Walkthrough Active", description: "WASD move, Shift sprint, Space jump, C crouch, E use, F flashlight." }); } }}
                            >
                                <Footprints className="h-3 w-3 mr-1.5" /> Walk
                            </Button>
                            <Button
                                variant="ghost" size="sm"
                                className={cn(
                                    "h-7 text-[9px] font-black uppercase tracking-wider px-2 transition-all rounded-lg",
                                    isWalkthrough && showWalkthroughHuman ? "bg-primary text-primary-foreground shadow-md" : "text-muted-foreground hover:bg-white/5"
                                )}
                                onClick={() => {
                                    if (!isWalkthrough) {
                                        toast({ title: "Enable Walk Mode", description: "Turn on Walk Mode first to enable engineer character mode." });
                                        return;
                                    }
                                    setShowWalkthroughHuman(prev => !prev);
                                }}
                            >
                                <User className="h-3 w-3 mr-1.5" /> Engineer
                            </Button>
                            {siteResult && siteResult.buildings.length > 0 && (
                                <div className="flex items-center gap-1.5 pl-1">
                                    <Badge className="h-7 bg-primary/10 border-primary/30 text-primary text-[9px] font-black uppercase tracking-widest px-2">
                                        Site: {siteResult.buildings.length}
                                    </Badge>
                                    <select
                                        value={activeSiteBuildingId || siteResult.buildings[0].id}
                                        onChange={(e) => handleSiteBuildingSelect(e.target.value)}
                                        className="h-7 min-w-[200px] rounded-lg bg-background/80 border border-white/20 px-2 text-[10px] font-bold text-foreground focus:outline-none"
                                    >
                                        {siteResult.buildings.map((building) => (
                                            <option key={building.id} value={building.id}>
                                                {building.name} ({building.floor_count}F)
                                            </option>
                                        ))}
                                    </select>
                                </div>
                            )}
                            <div className="w-[1px] h-3 bg-white/20 mx-1" />
                            <Button variant="ghost" size="sm" className="h-7 text-muted-foreground hover:bg-white/5 text-[9px] font-black uppercase tracking-wider px-2" onClick={() => downloadStringAsFile(exportToSVG(elements, activeFloor), 'floorplan.svg', 'image/svg+xml')}>
                                <FileCode className="h-3 w-3 mr-1.5" /> SVG
                            </Button>
                            <Button variant="ghost" size="sm" className="h-7 text-muted-foreground hover:bg-white/5 text-[9px] font-black uppercase tracking-wider px-2" onClick={() => downloadStringAsFile(exportToDXF(elements, activeFloor), 'floorplan.dxf', 'application/dxf')}>
                                <FileBox className="h-3 w-3 mr-1.5" /> DXF
                            </Button>
                            <Button variant="ghost" size="sm" className="h-7 text-muted-foreground hover:bg-white/5 text-[9px] font-black uppercase tracking-wider px-2" onClick={() => setShowCost(!showCost)}>
                                <Calculator className="h-3 w-3 mr-1.5" /> Budget
                            </Button>
                            <div className="w-[1px] h-3 bg-white/20 mx-1" />
                            <Button
                                size="sm" className="h-7 bg-emerald-600 hover:bg-emerald-700 text-white font-black text-[9px] uppercase tracking-wider px-3 rounded-lg border-0"
                                onClick={handleSaveToCloud} disabled={isSaving}
                            >
                                {isSaving ? <RefreshCw className="h-3 w-3 mr-1.5 animate-spin" /> : <CloudUpload className="h-3 w-3 mr-1.5" />}
                                {isSaving ? 'Syncing...' : 'Save'}
                            </Button>
                        </div>
                    )}
                </div>
            )}


            <div className="flex-1 relative flex flex-col md:flex-row">
                {/* 3D Viewport */}
                <div className="absolute inset-0 z-0">
                    <div className="w-full h-full relative" style={{
                        background: useImmersiveLayout ? 'linear-gradient(180deg, #f8f5f0 0%, #e8e2d6 100%)' : 'linear-gradient(180deg, #f0ece4 0%, #e8e2d6 50%, #ddd7c9 100%)'
                    }}>
                        <Canvas
                            key={`${useImmersiveLayout ? 'canvas-fullscreen' : 'canvas-standard'}-${isWalkthrough ? 'walk' : (isTopView ? 'top' : 'orbit')}`}
                            dpr={isPerformanceSensitiveMode ? [1, 1.35] : [1, 2]}
                            camera={{ position: [18, 14, 18], fov: useImmersiveLayout ? 28 : 32 }}
                            gl={{ antialias: !isPerformanceSensitiveMode, alpha: true, powerPreference: isPerformanceSensitiveMode ? 'high-performance' : 'default' }}
                            style={{ background: 'transparent', width: '100%', height: '100%', display: 'block' }}
                        >
                            {isWalkthrough ? (
                                showWalkthroughHuman ? (
                                    <EngineerWalkthroughController
                                        bounds={walkthroughBounds}
                                        humanModelUrl={CUSTOM_HUMAN_GLB_URL}
                                    />
                                ) : (
                                    <WalkthroughController
                                        bounds={walkthroughBounds}
                                        walls={elements?.walls}
                                        doors={elements?.doors}
                                        interactables={walkthroughInteractables}
                                        disabledInteractableIds={walkCollectedItemIds}
                                        floorCount={walkthroughFloorCount}
                                        onHudChange={handleWalkHudChange}
                                        onUseInteractable={handleWalkUseInteractable}
                                    />
                                )
                            ) : (
                                <OrbitViewController
                                    data={elements}
                                    isTopView={isTopView}
                                    isFullscreen={isFullscreen}
                                />
                            )}

                            {/* Environmental Lighting based on Time of Day */}
                            {(() => {
                                const isNight = timeOfDay < 6 || timeOfDay > 18;
                                const sunAngle = ((timeOfDay - 6) / 12) * Math.PI;
                                const sunX = Math.cos(sunAngle) * -30;
                                const sunY = Math.max(Math.sin(sunAngle) * 30, -5);
                                const sunZ = 15;
                                const intensity = isNight ? 0 : Math.sin(sunAngle) * 2.5;

                                return (
                                    <>
                                        <ambientLight intensity={isNight ? 0.2 : 0.6} color={isNight ? "#4a5a70" : "#ffffff"} />
                                        <pointLight position={[15, 25, 15]} intensity={isNight ? 0.5 : 1.2} color={isNight ? "#607d8b" : "#ffffff"} castShadow shadow-mapSize={isPerformanceSensitiveMode ? [1024, 1024] : [2048, 2048]} />
                                        <directionalLight position={[sunX, sunY, sunZ]} intensity={intensity} color="#fff8e7" castShadow shadow-mapSize={isPerformanceSensitiveMode ? [1024, 1024] : [2048, 2048]}
                                            shadow-camera-left={-20} shadow-camera-right={20} shadow-camera-top={20} shadow-camera-bottom={-20} />
                                        <directionalLight position={[8, -5, 8]} intensity={0.4} color="#a0b0d0" />
                                        {!isNight && (
                                            <Sky distance={450000} sunPosition={[sunX, sunY, sunZ]} inclination={0} azimuth={0.25} rayleigh={1.5} turbidity={0.5} />
                                        )}
                                        {isNight && (
                                            <>
                                                <color attach="background" args={['#050812']} />
                                                <Stars radius={100} depth={50} count={5000} factor={4} saturation={0} fade speed={1} />
                                            </>
                                        )}
                                        {!isNight && <color attach="background" args={['#d1eaff']} />}
                                    </>
                                );
                            })()}

                            <Suspense fallback={null}>
                                <GeneratedStructure
                                    progress={progress}
                                    data={elements}
                                    visibleElements={visibleElements}
                                    onSelect={setSelectedElement}
                                    isWalkthrough={isWalkthrough}
                                    humanModelUrl={CUSTOM_HUMAN_GLB_URL}
                                    openedDoorIds={walkOpenedDoorIds}
                                    hiddenFurnitureIds={walkCollectedItemIds}
                                />
                                {(() => {
                                    const isNight = timeOfDay < 6 || timeOfDay > 18;
                                    const envPreset = isNight
                                        ? 'city'
                                        : (timeOfDay < 9 || timeOfDay > 16 ? 'sunset' : 'apartment');
                                    return (
                                        <>
                                            <Environment preset={envPreset as any} />
                                            {!isPerformanceSensitiveMode && (
                                                <ContactShadows
                                                    position={[0, -0.01, 0]}
                                                    opacity={isNight ? 0.34 : 0.46}
                                                    scale={isNight ? 34 : 42}
                                                    blur={isNight ? 3.2 : 2.2}
                                                    far={isNight ? 14 : 18}
                                                />
                                            )}
                                        </>
                                    );
                                })()}

                                {!isPerformanceSensitiveMode && (
                                    <EffectComposer>
                                        <SSAO
                                            intensity={20}
                                            radius={0.4}
                                            luminanceInfluence={0.5}
                                            color={new THREE.Color("black")}
                                        />
                                        <Bloom
                                            luminanceThreshold={1.2}
                                            mipmapBlur
                                            intensity={0.4}
                                            radius={0.4}
                                        />
                                        <Noise opacity={0.03} />
                                        <Vignette eskil={false} offset={0.1} darkness={1.1} />
                                    </EffectComposer>
                                )}
                            </Suspense>
                        </Canvas>

                        {/* PUBG-style Walkthrough UI */}
                        {isWalkthrough && status !== 'idle' && (
                            <>
                                {/* Crosshair */}
                                <div className="absolute inset-0 pointer-events-none flex items-center justify-center z-[100]">
                                    <div className={cn(
                                        "w-2 h-2 rounded-full shadow-[0_0_2px_rgba(0,0,0,0.8)] border",
                                        walkHud.hint ? "bg-emerald-300 border-emerald-700/70" : "bg-white/80 border-black/50"
                                    )} />
                                </div>
                                {/* Instructions */}
                                <div className="absolute top-8 left-1/2 -translate-x-1/2 pointer-events-none z-[100]">
                                    <div className="bg-black/40 backdrop-blur-sm border border-white/10 text-white px-5 py-2.5 rounded-xl shadow-2xl flex flex-col items-center">
                                        <span className="text-[11px] font-black tracking-widest uppercase mb-1">Interactive Walkthrough Enabled</span>
                                        <span className="text-[9px] font-bold text-white/60 tracking-wider">
                                            {showWalkthroughHuman
                                                ? 'ENGINEER CHARACTER MODE • DRAG TO ROTATE • WASD MOVE • SHIFT SPRINT'
                                                : 'CLICK TO LOOK • WASD MOVE • SHIFT SPRINT • SPACE JUMP • C/CTRL CROUCH • E USE • F FLASHLIGHT'}
                                        </span>
                                    </div>
                                </div>
                                {!showWalkthroughHuman && (
                                    <>
                                        <div className="absolute top-24 left-6 pointer-events-none z-[100]">
                                            <div className="bg-black/45 backdrop-blur-md border border-white/10 text-white rounded-xl px-3 py-2 shadow-xl space-y-1">
                                                <div className="text-[9px] font-black tracking-widest uppercase text-white/70">
                                                    Floor {walkHud.activeFloor + 1}/{Math.max(1, walkthroughFloorCount)}
                                                </div>
                                                <div className="text-[9px] font-bold uppercase tracking-wide">
                                                    {walkHud.sprinting ? 'Sprint: ON' : 'Sprint: OFF'} • {walkHud.crouching ? 'Crouch: ON' : 'Crouch: OFF'}
                                                </div>
                                                <div className="text-[9px] font-bold uppercase tracking-wide">
                                                    Flashlight: {walkHud.flashlightOn ? 'ON' : 'OFF'}
                                                </div>
                                            </div>
                                        </div>
                                        {walkInventory.length > 0 && (
                                            <div className="absolute top-24 right-6 pointer-events-none z-[100]">
                                                <div className="bg-black/45 backdrop-blur-md border border-white/10 text-white rounded-xl px-3 py-2 shadow-xl min-w-[180px]">
                                                    <div className="text-[9px] font-black tracking-widest uppercase text-white/70 mb-1.5">Inventory</div>
                                                    <div className="space-y-1">
                                                        {walkInventory.slice(0, 5).map((entry) => (
                                                            <div key={entry.id} className="text-[9px] font-bold uppercase tracking-wide text-white/90 flex items-center justify-between">
                                                                <span className="truncate pr-2">{entry.label}</span>
                                                                <span>x{entry.count}</span>
                                                            </div>
                                                        ))}
                                                    </div>
                                                </div>
                                            </div>
                                        )}
                                        {walkHud.hint && (
                                            <div className="absolute bottom-28 left-1/2 -translate-x-1/2 pointer-events-none z-[100]">
                                                <div className="bg-emerald-500/20 border border-emerald-300/40 text-emerald-100 px-4 py-2 rounded-xl text-[11px] font-black tracking-wide shadow-xl">
                                                    {walkHud.hint}
                                                </div>
                                            </div>
                                        )}
                                        {walkActionFeed && (
                                            <div className="absolute bottom-16 left-1/2 -translate-x-1/2 pointer-events-none z-[100]">
                                                <div className="bg-sky-500/20 border border-sky-300/40 text-sky-100 px-4 py-2 rounded-xl text-[10px] font-black uppercase tracking-wider shadow-xl">
                                                    {walkActionFeed}
                                                </div>
                                            </div>
                                        )}
                                    </>
                                )}
                            </>
                        )}

                        {/* Overlays */}
                        {status === 'complete' && !useImmersiveLayout && (
                            <div className="absolute top-20 right-6 flex flex-col gap-2">
                                <Badge className="bg-primary/20 backdrop-blur-md border-primary/30 text-primary font-black uppercase text-[10px] py-1 px-3 tracking-widest shadow-xl">
                                    {activeSiteBuilding?.name || elements?.building_name || 'BUILDING'}
                                </Badge>
                                <Badge className="bg-background/60 backdrop-blur-md border-border text-foreground/70 font-black uppercase text-[10px] py-1 px-3 tracking-widest shadow-xl">
                                    WALLS: {elements?.walls.length} | ROOMS: {elements?.rooms?.length || 0}
                                </Badge>
                                {siteResult && siteResult.buildings.length > 0 && (
                                    <Badge className="bg-sky-500/15 backdrop-blur-md border-sky-500/30 text-sky-500 font-black uppercase text-[10px] py-1 px-3 tracking-widest shadow-xl">
                                        SITE MODE: {siteResult.buildings.length} BUILDINGS
                                    </Badge>
                                )}
                                {(elements?.conflicts?.length || 0) > 0 && (
                                    <Badge className="bg-red-500/15 backdrop-blur-md border-red-500/30 text-red-500 font-black uppercase text-[10px] py-1 px-3 tracking-widest shadow-xl">
                                        ⚠ {elements?.conflicts.length} ISSUE{(elements?.conflicts?.length || 0) > 1 ? 'S' : ''}
                                    </Badge>
                                )}
                            </div>
                        )}

                        {preview && status !== 'idle' && !useImmersiveLayout && (
                            <div className="absolute bottom-6 right-6">
                                <div className="w-24 h-24 rounded-xl overflow-hidden border-2 border-primary/30 shadow-2xl">
                                    <img src={preview} alt="Blueprint" className="w-full h-full object-cover" />
                                </div>
                            </div>
                        )}

                        {/* Project Gallery Modal */}
                        {showProjects && (
                            <div className="absolute inset-0 flex items-center justify-center z-50 bg-black/40 backdrop-blur-sm p-6" onClick={() => setShowProjects(false)}>
                                <motion.div initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }}
                                    className="w-full max-w-[500px] bg-background/95 backdrop-blur-xl border border-border shadow-2xl rounded-2xl overflow-hidden flex flex-col max-h-[80vh]"
                                    onClick={(e) => e.stopPropagation()}
                                >
                                    <div className="p-6 bg-secondary/30 border-b border-border flex items-center justify-between shrink-0">
                                        <h3 className="font-black text-foreground">Project Gallery</h3>
                                        <button onClick={() => setShowProjects(false)} className="text-muted-foreground hover:text-foreground">✕</button>
                                    </div>
                                    <div className="flex-1 overflow-y-auto p-4 space-y-3">
                                        {isLoadingProjects ? (
                                            <div className="flex flex-col items-center py-12 gap-3 text-muted-foreground">
                                                <RefreshCw className="h-8 w-8 animate-spin opacity-50" />
                                                <p className="text-sm font-bold uppercase tracking-widest">Accessing Cosmos DB...</p>
                                            </div>
                                        ) : projects.length === 0 ? (
                                            <div className="text-center py-12 space-y-2">
                                                <FolderOpen className="h-12 w-12 mx-auto text-muted-foreground opacity-20" />
                                                <p className="font-bold text-muted-foreground">No saved designs yet.</p>
                                            </div>
                                        ) : (
                                            projects.map((proj) => (
                                                <div key={proj.id} className="group p-4 bg-background border border-border rounded-xl hover:border-primary/50 transition-all flex items-center justify-between">
                                                    <div className="space-y-1">
                                                        <h4 className="font-bold text-foreground group-hover:text-primary transition-colors">{proj.modelName}</h4>
                                                        <p className="text-[11px] text-muted-foreground uppercase tracking-widest">Last synced {new Date(proj.updatedAt).toLocaleDateString()}</p>
                                                    </div>
                                                    <Button size="sm" variant="outline" className="h-8 rounded-lg font-bold" onClick={() => handleLoadProject(proj.id)}>
                                                        Open
                                                    </Button>
                                                </div>
                                            ))
                                        )}
                                    </div>
                                </motion.div>
                            </div>
                        )}

                        {/* Sunlight Simulation Timeline */}
                        {status === 'complete' && elements && !useImmersiveLayout && (
                            <div className="absolute bottom-6 left-1/2 -translate-x-1/2 w-full max-w-md pointer-events-auto">
                                <div className="bg-background/80 backdrop-blur-xl border border-border p-3 rounded-[20px] shadow-2xl flex items-center gap-4">
                                    <Moon className="h-4 w-4 text-slate-400 shrink-0" />
                                    <div className="flex-1 flex flex-col gap-1">
                                        <input
                                            type="range"
                                            min="0" max="24" step="0.5"
                                            value={timeOfDay}
                                            onChange={(e) => setTimeOfDay(parseFloat(e.target.value))}
                                            className="w-full h-1.5 bg-secondary rounded-lg appearance-none cursor-pointer accent-[#f97316]"
                                        />
                                        <div className="flex justify-between px-1 text-[9px] font-black uppercase tracking-widest text-muted-foreground">
                                            <span>12am</span>
                                            <span>6am</span>
                                            <span className="text-[#f97316]">12pm</span>
                                            <span>6pm</span>
                                            <span>12am</span>
                                        </div>
                                    </div>
                                    <Sun className="h-5 w-5 text-[#f97316] shrink-0" />
                                </div>
                            </div>
                        )}

                        {/* Cost Estimate Overlay */}
                        {showCost && costEstimate && (
                            <div className="absolute inset-0 flex items-center justify-center z-50 bg-black/40 backdrop-blur-sm p-6" onClick={() => setShowCost(false)}>
                                <motion.div initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }}
                                    className="w-full max-w-[400px] bg-background/95 backdrop-blur-xl border border-border shadow-2xl rounded-2xl overflow-hidden"
                                    onClick={(e) => e.stopPropagation()}
                                >
                                    <div className="p-6 bg-secondary/50 border-b border-border flex items-center justify-between">
                                        <div className="flex items-center gap-3">
                                            <div className="h-10 w-10 bg-primary/20 text-primary flex items-center justify-center rounded-xl border border-primary/30">
                                                <Calculator className="h-5 w-5" />
                                            </div>
                                            <div>
                                                <h3 className="font-black text-foreground text-[15px]">Construction Cost</h3>
                                                <p className="text-[11px] text-muted-foreground font-medium uppercase tracking-widest">{costEstimate.sqmTotal.toFixed(0)} SQM BUILD</p>
                                            </div>
                                        </div>
                                        <button onClick={() => setShowCost(false)} className="text-muted-foreground hover:text-foreground">✕</button>
                                    </div>
                                    <div className="p-6 space-y-4">
                                        <div className="space-y-3 pt-2 text-[13px]">
                                            <div className="flex justify-between items-center text-muted-foreground"><span>Foundation & Slab</span> <span className="font-bold text-foreground">${costEstimate.breakdown.foundationAndSlab.toLocaleString()}</span></div>
                                            <div className="flex justify-between items-center text-muted-foreground"><span>Wall Framing</span> <span className="font-bold text-foreground">${costEstimate.breakdown.framingAndWalls.toLocaleString()}</span></div>
                                            <div className="flex justify-between items-center text-muted-foreground"><span>Doors & Windows</span> <span className="font-bold text-foreground">${costEstimate.breakdown.doorsAndWindows.toLocaleString()}</span></div>
                                            <div className="flex justify-between items-center text-muted-foreground"><span>Roofing</span> <span className="font-bold text-foreground">${costEstimate.breakdown.roofing.toLocaleString()}</span></div>
                                            <div className="flex justify-between items-center text-muted-foreground"><span>Interior Finishing</span> <span className="font-bold text-foreground">${costEstimate.breakdown.interiorFinishing.toLocaleString()}</span></div>
                                        </div>
                                        <div className="pt-4 border-t border-border mt-4 flex justify-between items-end">
                                            <span className="text-[12px] font-bold text-muted-foreground uppercase tracking-widest">Estimated Total</span>
                                            <span className="text-2xl font-black text-primary">${costEstimate.totalUSD.toLocaleString()}</span>
                                        </div>
                                    </div>
                                </motion.div>
                            </div>
                        )}

                        {selectedElement && !showCost && !useImmersiveLayout && (
                            <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}
                                className="absolute bottom-6 left-6 p-5 bg-background/95 backdrop-blur-xl border border-border rounded-[20px] shadow-2xl w-[320px] pointer-events-auto z-40">
                                <h3 className="font-black text-foreground tracking-tight mb-4 flex items-center justify-between">
                                    <span>{selectedElement.type === 'room' ? 'Room Details' : 'Wall Segment'}</span>
                                    <button onClick={() => setSelectedElement(null)} className="text-muted-foreground hover:text-foreground">✕</button>
                                </h3>
                                {selectedElement.type === 'room' && (
                                    <div className="space-y-3 text-[13px] text-muted-foreground">
                                        <div className="flex justify-between border-b border-border pb-2"><span>Name</span> <span className="font-bold text-foreground">{(selectedElement.data as any).name}</span></div>
                                        <div className="flex justify-between border-b border-border pb-2"><span>Area</span> <span className="font-bold text-foreground">{(selectedElement.data as any).area?.toFixed(2)} m²</span></div>
                                        <div className="flex justify-between border-b border-border pb-2"><span>Level</span> <span className="font-bold text-foreground">{(selectedElement.data as any).floor_level || 0}</span></div>
                                        <div className="pt-2">
                                            <p className="text-[11px] font-bold mb-2 uppercase text-foreground">Material</p>
                                            <div className="flex gap-2">
                                                {['#e8d5b7', '#8a9a5b', '#7c98ab', '#6b5b95'].map(c => (
                                                    <button key={c} className="w-6 h-6 rounded-full border-2 border-white shadow-md transition-transform hover:scale-110 active:scale-95" style={{ backgroundColor: c }} onClick={() => typeof updateRoomColor === 'function' && updateRoomColor(selectedElement.data.id, c)} />
                                                ))}
                                            </div>
                                        </div>
                                    </div>
                                )}
                                {selectedElement.type === 'wall' && (
                                    <div className="space-y-3 text-[13px] text-muted-foreground">
                                        <div className="flex justify-between border-b border-border pb-2"><span>Thickness</span> <span className="font-bold text-foreground">{(selectedElement.data as any).thickness}m</span></div>
                                        <div className="flex justify-between border-b border-border pb-2"><span>Height</span> <span className="font-bold text-foreground">{(selectedElement.data as any).height}m</span></div>
                                        <div className="pt-2">
                                            <p className="text-[11px] font-bold mb-2 uppercase text-foreground">Material</p>
                                            <div className="flex gap-2">
                                                {['#f5e6d3', '#e2c2a3', '#d0e0e3', '#e3d0db'].map(c => (
                                                    <button key={c} className="w-6 h-6 rounded-full border-2 border-white shadow-md transition-transform hover:scale-110 active:scale-95" style={{ backgroundColor: c }} onClick={() => typeof updateWallColor === 'function' && updateWallColor(selectedElement.data.id, c)} />
                                                ))}
                                            </div>
                                        </div>
                                    </div>
                                )}
                            </motion.div>
                        )}
                    </div>
                </div>

                {/* Centered Idle Screen */}
                {status === 'idle' && (
                    <div className="absolute inset-0 z-20 flex items-center justify-center p-6 bg-background/80 backdrop-blur-sm" style={{
                        backgroundSize: '20px 20px'
                    }}>
                        <motion.div
                            initial={{ opacity: 0, scale: 0.95, y: 10 }} animate={{ opacity: 1, scale: 1, y: 0 }}
                            className="w-full max-w-[500px] bg-background rounded-[24px] shadow-[0_20px_60px_-15px_rgba(0,0,0,0.3)] border border-border overflow-hidden"
                        >
                            {/* Tabs */}
                            <div className="flex border-b border-border px-2 relative">
                                <button
                                    onClick={() => setMode('upload')}
                                    className={cn(
                                        "flex-1 py-4 text-[13px] font-bold transition-colors relative z-10",
                                        mode === 'upload' ? "text-[#f97316]" : "text-muted-foreground hover:text-foreground"
                                    )}
                                >
                                    Upload
                                    {mode === 'upload' && <motion.div layoutId="activeTabMode" className="absolute bottom-0 left-0 right-0 h-[2.5px] bg-[#f97316]" />}
                                </button>
                                <button
                                    onClick={() => setMode('describe')}
                                    className={cn(
                                        "flex-1 py-4 text-[13px] font-bold transition-colors relative z-10",
                                        mode === 'describe' ? "text-[#f97316]" : "text-muted-foreground hover:text-foreground"
                                    )}
                                >
                                    Describe
                                    {mode === 'describe' && <motion.div layoutId="activeTabMode" className="absolute bottom-0 left-0 right-0 h-[2.5px] bg-[#f97316]" />}
                                </button>
                            </div>

                            <div className="p-8">
                                {mode === 'upload' && (
                                    <div className="space-y-5">
                                        {/* Dropzone */}
                                        <div
                                            className="w-full bg-secondary/30 border-2 border-dashed border-border rounded-[20px] flex flex-col items-center justify-center p-10 transition-colors hover:bg-secondary/50 cursor-pointer"
                                            onClick={() => document.getElementById('blueprint-upload-centered')?.click()}
                                            onDragOver={e => { e.preventDefault(); e.stopPropagation(); }}
                                            onDrop={handleDrop}
                                        >
                                            <Upload className="h-10 w-10 text-[#f97316] mb-3" strokeWidth={2.5} />
                                            <h3 className="text-lg font-black text-foreground tracking-tight mb-1">Upload Blueprint</h3>
                                            <p className="text-[13px] text-muted-foreground mb-5">Drop your floor plan image file</p>
                                            <div className="flex items-center gap-2">
                                                {["PNG", "JPG", "JPEG", "WEBP"].map(ext => (
                                                    <span key={ext} className="px-3.5 py-1 rounded-full border border-[#f97316]/30 text-[#f97316] text-[10px] font-black uppercase bg-background">
                                                        {ext}
                                                    </span>
                                                ))}
                                            </div>
                                        </div>
                                        <label className="flex items-start gap-3 p-3 rounded-xl border border-border/70 bg-secondary/20 cursor-pointer">
                                            <input
                                                type="checkbox"
                                                className="mt-0.5 h-4 w-4 accent-[#f97316]"
                                                checked={siteModeEnabled}
                                                onChange={(e) => setSiteModeEnabled(e.target.checked)}
                                            />
                                            <span className="text-[12px] leading-relaxed text-muted-foreground">
                                                <span className="font-black uppercase tracking-wider text-foreground text-[10px] block mb-0.5">
                                                    Site Mode (Society / Master Plan)
                                                </span>
                                                Enable this when one drawing contains multiple buildings or blocks. The engine will split and return building-wise models.
                                            </span>
                                        </label>
                                        <input type="file" id="blueprint-upload-centered" className="hidden" accept=".png,.jpg,.jpeg,.webp,image/*" onChange={handleFileUpload} />
                                        <Button
                                            onClick={() => document.getElementById('blueprint-upload-centered')?.click()}
                                            className="w-full bg-[#f97316] hover:bg-[#ea580c] text-white font-bold h-12 rounded-[16px] text-[14px] shadow-lg shadow-[#f97316]/20 transition-all hover:-translate-y-0.5"
                                        >
                                            Select File
                                        </Button>
                                    </div>
                                )}

                                {mode === 'describe' && (
                                    <div className="space-y-5">
                                        <div className="w-full bg-secondary/30 border-2 border-dashed border-border rounded-[20px] p-6 text-center">
                                            <Sparkles className="h-8 w-8 text-[#f97316] mb-2 mx-auto" />
                                            <h3 className="text-lg font-black text-foreground tracking-tight mb-1">Describe Blueprint</h3>
                                            <p className="text-[12px] text-muted-foreground max-w-[280px] mx-auto">AI generates a parametric 3D structure from your text description in seconds.</p>
                                        </div>
                                        <textarea
                                            value={description}
                                            onChange={e => setDescription(e.target.value)}
                                            placeholder="Example: A custom 3BHK bungalow with a large open living room, L-shaped kitchen, 2 bathrooms, covered parking, terracotta roof, cream walls..."
                                            className="w-full h-24 px-4 py-3 bg-background border border-border rounded-[14px] text-[13px] text-foreground resize-none focus:outline-none focus:ring-2 focus:ring-[#f97316]/50 placeholder:text-muted-foreground"
                                        />
                                        <Button
                                            onClick={startDescriptionGeneration}
                                            disabled={!description.trim()}
                                            className="w-full bg-[#f97316] hover:bg-[#ea580c] text-white font-bold h-12 rounded-[16px] gap-2 text-[14px] shadow-lg shadow-[#f97316]/20 transition-all hover:-translate-y-0.5"
                                        >
                                            <Sparkles className="h-4 w-4" /> Generate
                                        </Button>
                                        <div className="flex flex-wrap gap-2 justify-center pt-1">
                                            {[
                                                { label: "3BHK Bungalow", desc: "A modern 3-bedroom bungalow with spacious living room, modular kitchen, 2 bathrooms, covered parking, front lawn, terracotta roof and cream exterior walls." },
                                                { label: "2BHK Flat", desc: "A compact 2-bedroom apartment with living/dining area, kitchen, balcony, 2 bathrooms, and utility area. Modern finish with beige walls." },
                                                { label: "Luxury Villa", desc: "A luxury 4-bedroom villa with double-height living room, home office, family lounge, swimming pool area, landscaped garden, covered parking for 2 cars, terrace with pergola." }
                                            ].map((t, idx) => (
                                                <button key={idx} onClick={() => setDescription(t.desc)} className="px-3 py-1.5 rounded-full bg-secondary/40 border border-border text-foreground hover:bg-[#f97316]/10 hover:border-[#f97316]/30 hover:text-[#f97316] text-[10px] font-bold transition-all">
                                                    {t.label}
                                                </button>
                                            ))}
                                        </div>
                                    </div>
                                )}
                            </div>
                        </motion.div>
                    </div>
                )}

                {/* Side Info Sidebar (Floating Right) */}
                {status !== 'idle' && !useImmersiveLayout && (
                    <div className="absolute right-4 top-16 bottom-20 z-20 w-[240px] pointer-events-none flex flex-col gap-3">
                        {/* Processing Status */}
                        {(status === 'preprocessing' || status === 'analyzing' || status === 'generating') && (
                            <motion.div
                                initial={{ opacity: 0, x: 20 }}
                                animate={{ opacity: 1, x: 0 }}
                                className="bg-background/90 backdrop-blur-xl p-4 rounded-2xl border border-white/10 shadow-2xl pointer-events-auto"
                            >
                                <div className="flex items-center gap-3 mb-4">
                                    <div className="relative flex items-center justify-center">
                                        <div className="absolute inset-0 rounded-full border border-primary/20 animate-ping" />
                                        <div className="h-10 w-10 rounded-full bg-primary/10 flex items-center justify-center">
                                            <Wand2 className="h-5 w-5 text-primary animate-pulse" />
                                        </div>
                                    </div>
                                    <div>
                                        <p className="text-[8px] font-black uppercase text-primary tracking-[0.2em]">Processing</p>
                                        <p className="text-[10px] font-bold text-foreground">AI Generation</p>
                                    </div>
                                </div>
                                <div className="space-y-1.5">
                                    <div className="flex justify-between text-[9px] font-black uppercase text-muted-foreground px-0.5">
                                        <span>Progress</span>
                                        <span>{Math.round(progress * 100)}%</span>
                                    </div>
                                    <div className="w-full bg-white/10 h-1.5 rounded-full overflow-hidden p-[2px]">
                                        <motion.div
                                            className="h-full bg-primary rounded-full"
                                            initial={{ width: 0 }}
                                            animate={{ width: `${progress * 100}% ` }}
                                        />
                                    </div>
                                    <p className="text-[9px] text-muted-foreground/60 italic text-center pt-1 truncate">
                                        {status === 'preprocessing' ? 'Analyzing structure...' : status === 'analyzing' ? 'Planning spaces...' : 'Generating 3D...'}
                                    </p>
                                </div>
                            </motion.div>
                        )}

                        {/* Complete Details Sidebar Hidden Button */}
                        {status === 'complete' && elements && !isInspectorVisible && (
                            <div className="flex justify-end pointer-events-auto">
                                <Button
                                    variant="outline"
                                    className="h-8 bg-background/90 backdrop-blur-xl border-white/10 shadow-lg font-black text-[9px] uppercase tracking-widest text-muted-foreground hover:text-foreground hover:bg-white/10"
                                    onClick={() => setIsInspectorVisible(true)}
                                >
                                    <ChevronLeft className="h-4 w-4 mr-1" /> Inspector
                                </Button>
                            </div>
                        )}

                        {/* Complete Details Sidebar */}
                        {status === 'complete' && elements && isInspectorVisible && (
                            <motion.div
                                initial={{ opacity: 0, x: 20 }}
                                animate={{ opacity: 1, x: 0 }}
                                className="flex-1 min-h-0 bg-background/90 backdrop-blur-xl rounded-2xl border border-white/10 shadow-2xl pointer-events-auto flex flex-col overflow-hidden"
                            >
                                <div className="p-4 border-b border-white/10 bg-white/5 flex items-center justify-between">
                                    <div className="flex items-center gap-3">
                                        <div className="h-8 w-8 rounded-lg bg-emerald-500/20 flex items-center justify-center border border-emerald-500/30">
                                            <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                                        </div>
                                        <div className="min-w-0">
                                            <p className="text-[8px] font-black uppercase text-emerald-500 tracking-[0.2em]">Success</p>
                                            <p className="text-[11px] font-bold text-foreground truncate">{elements.building_name || "Custom Project"}</p>
                                        </div>
                                    </div>
                                    <button onClick={() => setIsInspectorVisible(false)} className="text-muted-foreground hover:text-foreground shrink-0 p-1">
                                        <ChevronRight className="h-4 w-4" />
                                    </button>
                                </div>

                                <div className="flex-1 overflow-y-auto p-3 space-y-4 custom-scrollbar">
                                    {/* Debug Image from layout parsing */}
                                    {elements.debug_image && (
                                        <div className="space-y-2">
                                            <h5 className="text-[8px] font-black uppercase text-muted-foreground tracking-widest px-1">Layout Analysis</h5>
                                            <div className="p-2 rounded-xl bg-white/5 border border-white/10">
                                                <img src={elements.debug_image} alt="Layout Analysis Preview" className="rounded-lg" />
                                                <p className="text-[9px] text-center mt-1 text-muted-foreground/60 italic">Azure parsing preview</p>
                                            </div>
                                        </div>
                                    )}

                                    {/* Room Inventory */}
                                    {elements.rooms && elements.rooms.length > 0 && (
                                        <div className="space-y-2">
                                            <h5 className="text-[8px] font-black uppercase text-muted-foreground tracking-widest px-1">Inventory</h5>
                                            <div className="space-y-1">
                                                {elements.rooms.map((room, i) => (
                                                    <div key={i} className="group flex items-center gap-2 p-2 rounded-xl bg-white/5 border border-transparent hover:border-white/10 hover:bg-white/10 transition-all cursor-pointer">
                                                        <div className="h-2 w-2 rounded-full border border-white/20 shrink-0" style={{ backgroundColor: room.floor_color || '#e8d5b7' }} />
                                                        <span className="text-[10px] font-bold text-muted-foreground group-hover:text-foreground flex-1 truncate">{room.name}</span>
                                                        <span className="text-[9px] font-mono text-muted-foreground/60">{room.area?.toFixed(0)}m²</span>
                                                    </div>
                                                ))}
                                            </div>
                                        </div>
                                    )}

                                    {/* Issues/Conflicts */}
                                    {elements.conflicts && elements.conflicts.length > 0 && (
                                        <div className="space-y-2">
                                            <h5 className="text-[8px] font-black uppercase text-red-500 tracking-widest px-1">Compliance ({elements.conflicts.length})</h5>
                                            <div className="space-y-1.5">
                                                {elements.conflicts.map((conflict, i) => (
                                                    <div key={i} className="p-2 rounded-xl bg-red-500/5 border border-red-500/20">
                                                        <div className="flex items-center gap-1.5 mb-1">
                                                            <div className="h-1 w-1 rounded-full bg-red-500" />
                                                            <span className="text-[8px] font-black text-red-500 uppercase">{conflict.type}</span>
                                                        </div>
                                                        <p className="text-[9px] text-muted-foreground/80 leading-snug">{conflict.description}</p>
                                                    </div>
                                                ))}
                                            </div>
                                        </div>
                                    )}
                                </div>

                                {/* Quick Tools */}
                                <div className="p-3 border-t border-white/10 bg-white/5 grid grid-cols-2 gap-2">
                                    <Button variant="outline" size="sm" className="h-8 bg-background border-white/10 text-[9px] font-black hover:bg-white/5 rounded-lg" onClick={() => {
                                        if (!elements) return;
                                        setElements({ ...elements, walls: [...elements.walls, { id: Date.now(), start: [0, 0], end: [2, 2], thickness: 0.23, height: 2.7, color: '#f5e6d3', is_exterior: true }] })
                                    }}>+ Wall</Button>
                                    <Button variant="outline" size="sm" className="h-8 bg-background border-white/10 text-[9px] font-black hover:bg-white/5 rounded-lg" onClick={() => {
                                        if (!elements) return;
                                        setElements({ ...elements, doors: [...elements.doors, { id: Date.now(), host_wall_id: 0, position: [1, 1], width: 0.9, height: 2.1, color: '#8B4513' }] })
                                    }}>+ Door</Button>
                                </div>
                            </motion.div>
                        )}
                    </div>
                )}
            </div>
        </div >
    );
}

export default function BlueprintTo3D() {
    return (
        <BIMProvider>
            <BlueprintWorkspace />
        </BIMProvider>
    );
}
