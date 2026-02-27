'use client';

import React, { useState, useRef, Suspense, useCallback, useMemo } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import {
    OrbitControls,
    Environment,
    ContactShadows,
    Html,
    Edges,
    MeshDistortMaterial,
    PointerLockControls
} from '@react-three/drei';
import { EffectComposer, SSAO, Bloom, Noise, Vignette } from '@react-three/postprocessing';
import { Geometry, Base, Subtraction } from '@react-three/csg';
import * as THREE from 'three';
import { useThree } from '@react-three/fiber';
import { AlertTriangle, ShieldAlert, PenLine, Image as ImageIcon, Sparkles, Footprints } from 'lucide-react';
import { motion } from 'framer-motion';
import {
    Upload,
    Box,
    Wand2,
    CheckCircle2,
    RefreshCw,
    Download,
    Calculator,
    Sun,
    Moon,
    CloudUpload,
    Library,
    FolderOpen,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { useToast } from '@/hooks/use-toast';
import {
    GeometricReconstruction,
    RoofGeometry,
    ConstructionConflict,
    AIAsset
} from '@/ai/flows/infralith/reconstruction-types';
import {
    processBlueprintTo3D,
    generateBuildingFromDescription,
    generateRealTimeAsset
} from '@/ai/flows/infralith/blueprint-to-3d-agent';

import { BIMProvider, useBIM } from '@/contexts/bim-context';
import { exportToDXF, exportToSVG, downloadStringAsFile } from '@/lib/cad-exporter';
import { estimateConstructionCost, CostEstimate } from '@/lib/cost-estimator';

// -- Conflict Markers --

function ConflictMarker({ conflict }: { conflict: ConstructionConflict }) {
    const meshRef = useRef<THREE.Mesh>(null);
    useFrame((state) => {
        if (meshRef.current) meshRef.current.position.y = 2 + Math.sin(state.clock.elapsedTime * 3) * 0.2;
    });
    const color = conflict.severity === 'high' ? '#ef4444' : conflict.severity === 'medium' ? '#f59e0b' : '#3b82f6';
    return (
        <group position={[conflict.location[0], 0, conflict.location[1]]}>
            <mesh ref={meshRef}>
                <octahedronGeometry args={[0.3, 0]} />
                <meshStandardMaterial color={color} emissive={color} emissiveIntensity={2} transparent opacity={0.8} />
            </mesh>
            <Html distanceFactor={10} position={[0, 2.8, 0]} center zIndexRange={[100, 0]}>
                <div className={cn(
                    "flex items-center gap-2 px-3 py-1.5 rounded-full border backdrop-blur-xl shadow-2xl pointer-events-none",
                    conflict.severity === 'high' ? "bg-red-500/20 border-red-500/50 text-red-500" :
                        conflict.severity === 'medium' ? "bg-amber-500/20 border-amber-500/50 text-amber-500" :
                            "bg-blue-500/20 border-blue-500/50 text-blue-500"
                )}>
                    {conflict.severity === 'high' ? <ShieldAlert className="h-3 w-3" /> : <AlertTriangle className="h-3 w-3" />}
                    <span className="text-[10px] font-black uppercase tracking-widest whitespace-nowrap">
                        {conflict.type}: {conflict.description}
                    </span>
                </div>
            </Html>
        </group>
    );
}

// -- Stylized Tree Component --

function Tree({ position, scale = 1 }: { position: [number, number, number], scale?: number }) {
    return (
        <group position={position} scale={scale}>
            {/* Trunk */}
            <mesh position={[0, 0.6, 0]} castShadow>
                <cylinderGeometry args={[0.08, 0.12, 1.2, 6]} />
                <meshStandardMaterial color="#5c3a1e" roughness={0.9} />
            </mesh>
            {/* Foliage layers */}
            <mesh position={[0, 1.6, 0]} castShadow>
                <sphereGeometry args={[0.6, 8, 6]} />
                <meshStandardMaterial color="#3d7a3a" roughness={0.8} />
            </mesh>
            <mesh position={[0, 2.0, 0]} castShadow>
                <sphereGeometry args={[0.45, 8, 6]} />
                <meshStandardMaterial color="#4a9e45" roughness={0.8} />
            </mesh>
            <mesh position={[0, 2.3, 0]} castShadow>
                <sphereGeometry args={[0.3, 8, 6]} />
                <meshStandardMaterial color="#5cb356" roughness={0.8} />
            </mesh>
        </group>
    );
}

// -- Bush / Shrub Component --

function Bush({ position, color = "#3d8b37" }: { position: [number, number, number], color?: string }) {
    return (
        <mesh position={position} castShadow>
            <sphereGeometry args={[0.3, 6, 5]} />
            <meshStandardMaterial color={color} roughness={0.85} />
        </mesh>
    );
}

// -- Boundary Wall with Gate --

function BoundaryWall({ bounds }: { bounds: { minX: number, maxX: number, minZ: number, maxZ: number } }) {
    const { minX, maxX, minZ, maxZ } = bounds;
    const pad = 3;
    const wallH = 1.2;
    const wallT = 0.12;
    const bX1 = minX - pad, bX2 = maxX + pad, bZ1 = minZ - pad, bZ2 = maxZ + pad;
    const gateW = 3;
    const cx = (bX1 + bX2) / 2;

    return (
        <group>
            {/* Front wall (left of gate) */}
            <mesh position={[(bX1 + (cx - gateW / 2)) / 2, wallH / 2, bZ1]} castShadow>
                <boxGeometry args={[(cx - gateW / 2) - bX1, wallH, wallT]} />
                <meshStandardMaterial color="#d4c4a0" roughness={0.7} />
                <Edges color="#b5a580" threshold={15} />
            </mesh>
            {/* Front wall (right of gate) */}
            <mesh position={[((cx + gateW / 2) + bX2) / 2, wallH / 2, bZ1]} castShadow>
                <boxGeometry args={[bX2 - (cx + gateW / 2), wallH, wallT]} />
                <meshStandardMaterial color="#d4c4a0" roughness={0.7} />
                <Edges color="#b5a580" threshold={15} />
            </mesh>
            {/* Gate pillars */}
            <mesh position={[cx - gateW / 2, wallH * 0.7, bZ1]} castShadow>
                <boxGeometry args={[0.3, wallH * 1.4, 0.3]} />
                <meshStandardMaterial color="#c4b48a" roughness={0.6} />
            </mesh>
            <mesh position={[cx + gateW / 2, wallH * 0.7, bZ1]} castShadow>
                <boxGeometry args={[0.3, wallH * 1.4, 0.3]} />
                <meshStandardMaterial color="#c4b48a" roughness={0.6} />
            </mesh>
            {/* Gate bars */}
            {[-1, -0.5, 0, 0.5, 1].map((offset, i) => (
                <mesh key={`gate-${i}`} position={[cx + offset * 0.5, wallH * 0.5, bZ1]}>
                    <cylinderGeometry args={[0.02, 0.02, wallH * 0.8, 4]} />
                    <meshStandardMaterial color="#2a2a2a" metalness={0.9} roughness={0.3} />
                </mesh>
            ))}
            {/* Back wall */}
            <mesh position={[cx, wallH / 2, bZ2]} castShadow>
                <boxGeometry args={[bX2 - bX1, wallH, wallT]} />
                <meshStandardMaterial color="#d4c4a0" roughness={0.7} />
            </mesh>
            {/* Left wall */}
            <mesh position={[bX1, wallH / 2, (bZ1 + bZ2) / 2]} castShadow>
                <boxGeometry args={[wallT, wallH, bZ2 - bZ1]} />
                <meshStandardMaterial color="#d4c4a0" roughness={0.7} />
            </mesh>
            {/* Right wall */}
            <mesh position={[bX2, wallH / 2, (bZ1 + bZ2) / 2]} castShadow>
                <boxGeometry args={[wallT, wallH, bZ2 - bZ1]} />
                <meshStandardMaterial color="#d4c4a0" roughness={0.7} />
            </mesh>
            {/* Driveway */}
            <mesh position={[cx, 0.01, bZ1 - pad / 2 + 0.5]} rotation={[-Math.PI / 2, 0, 0]}>
                <planeGeometry args={[gateW - 0.5, pad]} />
                <meshStandardMaterial color="#9e9e9e" roughness={0.95} />
            </mesh>
        </group>
    );
}

// -- Staircase --

function Staircase({ position, floors = 1 }: { position: [number, number, number], floors?: number }) {
    const stepsPerFloor = 14;
    const stepH = 0.19;
    const stepD = 0.28;
    const stepW = 1.2;
    const totalSteps = stepsPerFloor * floors;

    return (
        <group position={position}>
            {Array.from({ length: totalSteps }).map((_, i) => (
                <mesh key={`step-${i}`} position={[0, stepH * i + stepH / 2, stepD * i]} castShadow>
                    <boxGeometry args={[stepW, stepH, stepD]} />
                    <meshStandardMaterial color="#e0d5c0" roughness={0.5} />
                </mesh>
            ))}
            {/* Railing */}
            {[stepW / 2 + 0.05, -stepW / 2 - 0.05].map((xOff, ri) => (
                <group key={`rail-${ri}`}>
                    {[0, Math.floor(totalSteps / 2), totalSteps - 1].map((si, pi) => (
                        <mesh key={`post-${ri}-${pi}`} position={[xOff, stepH * si + 0.5, stepD * si]}>
                            <cylinderGeometry args={[0.03, 0.03, 1, 6]} />
                            <meshStandardMaterial color="#2a2a2a" metalness={0.8} roughness={0.3} />
                        </mesh>
                    ))}
                </group>
            ))}
        </group>
    );
}

// -- Pergola --

function Pergola({ position, width = 4, depth = 3, height = 2.8 }: { position: [number, number, number], width?: number, depth?: number, height?: number }) {
    const beamCount = 5;
    return (
        <group position={position}>
            {/* 4 corner posts */}
            {[[-width / 2, -depth / 2], [width / 2, -depth / 2], [-width / 2, depth / 2], [width / 2, depth / 2]].map(([x, z], i) => (
                <mesh key={`post-${i}`} position={[x, height / 2, z]} castShadow>
                    <boxGeometry args={[0.12, height, 0.12]} />
                    <meshStandardMaterial color="#5c3a1e" roughness={0.6} />
                </mesh>
            ))}
            {/* Crossbeams */}
            {Array.from({ length: beamCount }).map((_, i) => {
                const z = -depth / 2 + (depth / (beamCount - 1)) * i;
                return (
                    <mesh key={`beam-${i}`} position={[0, height, z]} castShadow>
                        <boxGeometry args={[width + 0.4, 0.08, 0.1]} />
                        <meshStandardMaterial color="#5c3a1e" roughness={0.6} />
                    </mesh>
                );
            })}
        </group>
    );
}

// -- Balcony --

function Balcony({ position, width = 3, depth = 1.2 }: { position: [number, number, number], width?: number, depth?: number }) {
    const railH = 0.9;
    const railPosts = 6;
    return (
        <group position={position}>
            {/* Slab */}
            <mesh position={[0, 0, depth / 2]} castShadow receiveShadow>
                <boxGeometry args={[width, 0.15, depth]} />
                <meshStandardMaterial color="#e0d5c0" roughness={0.5} />
            </mesh>
            {/* Glass railing */}
            <mesh position={[0, railH / 2, depth]} castShadow>
                <boxGeometry args={[width, railH, 0.04]} />
                <meshStandardMaterial color="#87CEEB" transparent opacity={0.3} metalness={0.5} roughness={0.1} />
            </mesh>
            {/* Railing posts */}
            {Array.from({ length: railPosts }).map((_, i) => {
                const x = -width / 2 + (width / (railPosts - 1)) * i;
                return (
                    <mesh key={i} position={[x, railH / 2, depth]}>
                        <cylinderGeometry args={[0.02, 0.02, railH, 4]} />
                        <meshStandardMaterial color="#2a2a2a" metalness={0.9} roughness={0.2} />
                    </mesh>
                );
            })}
            {/* Top rail */}
            <mesh position={[0, railH, depth]}>
                <boxGeometry args={[width, 0.04, 0.04]} />
                <meshStandardMaterial color="#2a2a2a" metalness={0.8} roughness={0.3} />
            </mesh>
        </group>
    );
}

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
                        <meshStandardMaterial color={roofColor} roughness={0.65} side={THREE.DoubleSide} />
                    </mesh>
                ))}
                {/* Ridge cap */}
                <mesh position={[centerX, peakY + 0.02, (minZ + maxZ) / 2]}>
                    <boxGeometry args={[0.15, 0.06, maxZ - minZ + overhang * 2]} />
                    <meshStandardMaterial color="#7a3f1d" roughness={0.5} />
                </mesh>
            </group>
        );
    }

    // Flat roof
    return (
        <mesh position={[(minX + maxX) / 2, baseY + 0.05, (minZ + maxZ) / 2]} castShadow receiveShadow>
            <boxGeometry args={[maxX - minX + 0.6, 0.12, maxZ - minZ + 0.6]} />
            <meshStandardMaterial color={roofColor} roughness={0.6} />
        </mesh>
    );
}

// -- Procedural Edge/Wall Detailing --
const SkirtingBoard = ({ width, depth, yOffset = 0.05, height = 0.1 }: { width: number, depth: number, yOffset?: number, height?: number }) => (
    <mesh position={[0, yOffset, 0]} receiveShadow>
        <boxGeometry args={[width, height, depth + 0.02]} />
        <meshStandardMaterial color="#d4cdc3" roughness={0.6} />
    </mesh>
);

// -- Real-Time AI Asset Engine Component --

const globalAssetCache = new Map<string, AIAsset>();

function AIAssetRenderer({ description, width, height, depth, fallbackColor }: { description: string, width: number, height: number, depth: number, fallbackColor: string }) {
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
                <Html position={[0, height / 2.5, 0]} center>
                    <div className="bg-black/80 text-primary-foreground text-[7px] font-black uppercase px-2 py-0.5 rounded-full flex gap-1 items-center">
                        <Wand2 className="w-2 h-2 animate-pulse" />
                        Generating
                    </div>
                </Html>
            </group>
        );
    }

    return (
        <group scale={[width, height, depth]}>
            {asset.parts.map((part, i) => (
                <mesh key={i} position={part.position as [number, number, number]} castShadow receiveShadow>
                    <boxGeometry args={part.size as [number, number, number]} />
                    <meshStandardMaterial
                        color={part.color}
                        roughness={part.material === 'glass' || part.material === 'metal' ? 0.2 : 0.8}
                        metalness={part.material === 'metal' ? 0.9 : 0.1}
                        transparent={part.material === 'glass'}
                        opacity={part.material === 'glass' ? 0.45 : 1}
                    />
                </mesh>
            ))}
        </group>
    );
}

// -- Wall with CSG Openings --

const WallSegment = ({ wall, allWindows, allDoors, defaultColor, onSelect }: any) => {
    const dx = wall.end[0] - wall.start[0];
    const dz = wall.end[1] - wall.start[1];
    const len = Math.sqrt(dx * dx + dz * dz);
    const ang = Math.atan2(dz, dx);
    const cx = (wall.start[0] + wall.end[0]) / 2;
    const cz = (wall.start[1] + wall.end[1]) / 2;
    const baseY = (wall.floor_level || 0) * 2.8;

    // Filter windows/doors belonging to this wall
    const wallWindows = allWindows.filter((w: any) => w.host_wall_id === wall.id || w.host_wall_id?.toString() === wall.id?.toString());
    const wallDoors = allDoors.filter((d: any) => d.host_wall_id === wall.id || d.host_wall_id?.toString() === wall.id?.toString());

    return (
        <group position={[cx, baseY + wall.height / 2, cz]} rotation={[0, -ang, 0]}>
            <mesh castShadow receiveShadow
                onClick={(e) => { e.stopPropagation(); onSelect?.({ type: 'wall', data: wall }) }}
                onPointerOver={(e) => { e.stopPropagation(); document.body.style.cursor = 'pointer'; }}
                onPointerOut={() => { document.body.style.cursor = 'auto'; }}
            >
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
                <meshStandardMaterial color={wall.color || defaultColor} roughness={0.7} />
                <Edges color="#00000020" threshold={15} />
            </mesh>

            {/* Skirting Baseboard for Interior */}
            {!wall.is_exterior && <SkirtingBoard width={len} depth={wall.thickness} />}

            {/* Visual Fillers for Glass and Frames Generated by OpenAI */}
            {wallWindows.map((win: any) => {
                const winDx = win.position[0] - wall.start[0];
                const winDz = win.position[1] - wall.start[1];
                const dist = (winDx * dx + winDz * dz) / len;
                const localX = dist - len / 2;
                const wh = 1.2;
                // High-fidelity description for AI Generation
                const desc = `High-end enterprise architectural aluminum window with frame, mullions, and double glazing glass. Color: ${win.color || 'dark grey'}.`;
                return (
                    <group key={`win-glass-${win.id}`} position={[localX, win.sill_height + wh / 2 - wall.height / 2, 0]}>
                        <AIAssetRenderer description={desc} width={win.width} height={wh} depth={wall.thickness + 0.05} fallbackColor={win.color || "#87CEEB"} />
                    </group>
                );
            })}

            {/* Visual Fillers for Doors Generated by OpenAI */}
            {wallDoors.map((door: any) => {
                const doorDx = door.position[0] - wall.start[0];
                const doorDz = door.position[1] - wall.start[1];
                const dist = (doorDx * dx + doorDz * dz) / len;
                const localX = dist - len / 2;
                // High-fidelity description for AI Generation
                const desc = `Premium solid wooden entrance door with metallic modern handle, hinges, and detailed door frame. Color: ${door.color || 'walnut brown'} wood.`;
                return (
                    <group key={`door-leaf-${door.id}`} position={[localX, door.height / 2 - wall.height / 2, 0]}>
                        <AIAssetRenderer description={desc} width={door.width} height={door.height} depth={wall.thickness + 0.02} fallbackColor={door.color || "#8b4513"} />
                    </group>
                );
            })}
        </group>
    );
};

function GeneratedStructure({ progress, data, onSelect }: { progress: number, data: GeometricReconstruction | null, onSelect?: (el: any) => void }) {
    if (!data) return null;
    const groupRef = useRef<THREE.Group>(null);
    const p = progress;

    const defaultExterior = data.exterior_color || '#f5e6d3';
    const defaultInterior = '#faf7f2';
    const defaultFloor = '#e8d5b7';
    const defaultDoor = '#8B4513';
    const defaultWindow = '#87CEEB';

    // Calculate building bounds for boundary wall
    const allX = data.walls.flatMap(w => [w.start[0], w.end[0]]);
    const allZ = data.walls.flatMap(w => [w.start[1], w.end[1]]);
    const bounds = {
        minX: Math.min(...allX),
        maxX: Math.max(...allX),
        minZ: Math.min(...allZ),
        maxZ: Math.max(...allZ),
    };

    return (
        <group ref={groupRef}>
            {/* Ground / Lawn */}
            <mesh position={[0, -0.05, 0]} receiveShadow rotation={[-Math.PI / 2, 0, 0]}>
                <planeGeometry args={[100, 100]} />
                <meshStandardMaterial color="#6b9e5b" roughness={0.9} />
            </mesh>
            {/* Subtle ground grid */}
            <gridHelper args={[100, 100, "#5a8a4d", "#5a8a4d"]} position={[0, 0.005, 0]} />

            {/* Pathway from gate to entrance */}
            <mesh position={[(bounds.minX + bounds.maxX) / 2, 0.01, bounds.minZ - 1.5]} rotation={[-Math.PI / 2, 0, 0]}>
                <planeGeometry args={[2, 4]} />
                <meshStandardMaterial color="#b8a68a" roughness={0.8} />
            </mesh>

            {p > 0 && (
                <group scale={[1, p, 1]}>
                    {/* Floor Slabs for each level */}
                    {Array.from(new Set(data.walls.map(w => w.floor_level || 0))).sort((a, b) => a - b).map(lvl => {
                        const slabY = lvl * 2.8;
                        const centerX = (bounds.minX + bounds.maxX) / 2;
                        const centerZ = (bounds.minZ + bounds.maxZ) / 2;
                        const sizeX = (bounds.maxX - bounds.minX) + 40;
                        const sizeZ = (bounds.maxZ - bounds.minZ) + 40;

                        return (
                            <mesh key={`slab-${lvl}`} position={[centerX, slabY, centerZ]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
                                <planeGeometry args={[sizeX, sizeZ]} />
                                <meshStandardMaterial color="#f0f0f0" roughness={0.9} transparent opacity={0.15} />
                            </mesh>
                        );
                    })}

                    {/* Room Floors */}
                    {data.rooms.map((room, i) => {
                        const shape = new THREE.Shape();
                        room.polygon.forEach((pt, idx) => {
                            if (idx === 0) shape.moveTo(pt[0], pt[1]);
                            else shape.lineTo(pt[0], pt[1]);
                        });
                        shape.closePath();
                        const cx = room.polygon.reduce((s, p) => s + p[0], 0) / room.polygon.length;
                        const cz = room.polygon.reduce((s, p) => s + p[1], 0) / room.polygon.length;
                        const zPos = (room.floor_level || 0) * 2.8;

                        return (
                            <group key={`room-${i}`}>
                                <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, zPos + 0.02, 0]} receiveShadow
                                    onClick={(e) => { e.stopPropagation(); onSelect?.({ type: 'room', data: room }); }}
                                    onPointerOver={(e) => { e.stopPropagation(); document.body.style.cursor = 'pointer'; }}
                                    onPointerOut={() => { document.body.style.cursor = 'auto'; }}
                                >
                                    <shapeGeometry args={[shape]} />
                                    <meshStandardMaterial
                                        color={room.floor_color || defaultFloor}
                                        roughness={0.7}
                                        metalness={0.05}
                                    />
                                </mesh>
                                {/* Level label */}
                                <Html position={[cx, zPos + 0.15, cz]} distanceFactor={14} center>
                                    <div className="px-3 py-1 bg-black/80 backdrop-blur-md rounded-lg shadow-2xl border border-white/10 flex flex-col items-center">
                                        <p className="text-[9px] font-black uppercase text-white select-none whitespace-nowrap tracking-widest mb-0.5">
                                            {room.name} {room.floor_level !== undefined ? `• L${room.floor_level}` : ''}
                                        </p>
                                        {room.area > 0 && (
                                            <p className="text-[7px] text-primary/80 font-bold">{room.area.toFixed(0)}m²</p>
                                        )}
                                    </div>
                                </Html>
                            </group>
                        );
                    })}

                    {/* Walls, Windows, and Doors (Integrated via CSG) */}
                    {data.walls.map((wall, i) => (
                        <WallSegment
                            key={`wall-${i}`}
                            wall={wall}
                            allWindows={data.windows}
                            allDoors={data.doors}
                            defaultColor={wall.is_exterior ? defaultExterior : defaultInterior}
                            onSelect={onSelect}
                        />
                    ))}

                    {/* Procedurally Generated Furniture / Decor */}
                    {data.furnitures?.map((furniture, i) => {
                        const zPos = (furniture.floor_level || 0) * 2.8;
                        return (
                            <group key={`furniture-${i}`} position={[furniture.position[0], zPos + furniture.height / 2, furniture.position[1]]}>
                                <AIAssetRenderer
                                    description={furniture.description}
                                    width={furniture.width}
                                    height={furniture.height}
                                    depth={furniture.depth}
                                    fallbackColor={furniture.color || "#cccccc"}
                                />
                            </group>
                        );
                    })}

                    {/* Roof */}
                    {data.roof && <RoofMesh roof={data.roof} />}

                    {/* Staircase (if multi-floor) */}
                    {Array.from(new Set(data.walls.map(w => w.floor_level || 0))).length > 1 && (
                        <Staircase position={[(bounds.minX + bounds.maxX) / 2 - 1, 0, (bounds.minZ + bounds.maxZ) / 2]} />
                    )}

                    {/* Balcony on front */}
                    <Balcony position={[(bounds.minX + bounds.maxX) / 2 + 2, 2.7, bounds.minZ]} width={3.5} depth={1.3} />

                    {/* Pergola on terrace (back) */}
                    <Pergola position={[(bounds.minX + bounds.maxX) / 2, (data.roof?.base_height || 2.7) + (data.roof?.height || 1.5) + 0.1, bounds.maxZ - 1.5]} width={4} depth={3} height={2.5} />
                </group>
            )}

            {/* Boundary Wall */}
            {p >= 0.5 && <BoundaryWall bounds={bounds} />}

            {/* Landscaping - Trees */}
            {p >= 0.6 && (
                <group>
                    <Tree position={[bounds.maxX + 4, 0, bounds.minZ + 1]} scale={1.2} />
                    <Tree position={[bounds.maxX + 5, 0, bounds.maxZ - 1]} scale={0.9} />
                    <Tree position={[bounds.minX - 4, 0, bounds.maxZ]} scale={1.1} />
                    <Tree position={[bounds.minX - 5, 0, bounds.minZ - 2]} scale={0.8} />
                    <Tree position={[(bounds.minX + bounds.maxX) / 2 + 6, 0, bounds.maxZ + 5]} scale={1.3} />
                    <Tree position={[(bounds.minX + bounds.maxX) / 2 - 6, 0, bounds.maxZ + 6]} scale={1.0} />

                    {/* Bushes along boundary */}
                    {Array.from({ length: 12 }).map((_, i) => (
                        <Bush key={`bush-${i}`} position={[
                            bounds.minX - 5 + i * ((bounds.maxX - bounds.minX + 10) / 11),
                            0.15,
                            bounds.maxZ + 5
                        ]} color={i % 2 === 0 ? "#3d8b37" : "#4a9e45"} />
                    ))}
                </group>
            )}

            {/* Conflict markers */}
            {p >= 1 && data.conflicts?.map((conflict, i) => (
                <ConflictMarker key={`conflict-${i}`} conflict={conflict} />
            ))}
        </group>
    );
}

// -- Walkthrough First Person Controller --

function WalkthroughController({ bounds }: { bounds?: any }) {
    const { camera } = useThree();
    const [moveForward, setMoveForward] = useState(false);
    const [moveBackward, setMoveBackward] = useState(false);
    const [moveLeft, setMoveLeft] = useState(false);
    const [moveRight, setMoveRight] = useState(false);

    // Initialize camera position when entering walkthrough
    React.useEffect(() => {
        if (bounds) {
            camera.position.set((bounds.minX + bounds.maxX) / 2, 1.7, bounds.maxZ + 5);
            camera.rotation.set(0, 0, 0);
        }
    }, [bounds, camera]);

    React.useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            switch (e.code) {
                case 'KeyW': case 'ArrowUp': setMoveForward(true); break;
                case 'KeyA': case 'ArrowLeft': setMoveLeft(true); break;
                case 'KeyS': case 'ArrowDown': setMoveBackward(true); break;
                case 'KeyD': case 'ArrowRight': setMoveRight(true); break;
            }
        };
        const handleKeyUp = (e: KeyboardEvent) => {
            switch (e.code) {
                case 'KeyW': case 'ArrowUp': setMoveForward(false); break;
                case 'KeyA': case 'ArrowLeft': setMoveLeft(false); break;
                case 'KeyS': case 'ArrowDown': setMoveBackward(false); break;
                case 'KeyD': case 'ArrowRight': setMoveRight(false); break;
            }
        };
        document.addEventListener('keydown', handleKeyDown);
        document.addEventListener('keyup', handleKeyUp);
        return () => {
            document.removeEventListener('keydown', handleKeyDown);
            document.removeEventListener('keyup', handleKeyUp);
        };
    }, []);

    useFrame((state, delta) => {
        const speed = 4.0 * delta;
        const vel = new THREE.Vector3();
        if (moveForward) vel.z -= 1;
        if (moveBackward) vel.z += 1;
        if (moveLeft) vel.x -= 1;
        if (moveRight) vel.x += 1;

        if (vel.length() > 0) {
            vel.normalize().multiplyScalar(speed);
            const eul = new THREE.Euler(0, camera.rotation.y, 0);
            vel.applyEuler(eul);
            camera.position.add(vel);
            camera.position.y = 1.7; // Lock player height
        }
    });

    return <PointerLockControls />;
}

// -- Main Page --

function BlueprintWorkspace() {
    const { toast } = useToast();
    const [mode, setMode] = useState<'upload' | 'describe'>('upload');
    const [file, setFile] = useState<File | null>(null);
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
    const { model: elements, setModel: setElements, activeFloor, setActiveFloor, selectedElement, setSelectedElement, updateWallColor, updateRoomColor, saveToCloud, loadModel } = useBIM();

    const costEstimate = useMemo(() => elements ? estimateConstructionCost(elements) : null, [elements]);

    const ACCEPTED_TYPES = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'application/pdf', 'image/vnd.dwg', 'image/vnd.dxf'];

    const isAcceptedFile = (f: File) => {
        if (ACCEPTED_TYPES.includes(f.type)) return true;
        const name = f.name.toLowerCase();
        return name.endsWith('.dwg') || name.endsWith('.dxf') || name.endsWith('.png') || name.endsWith('.jpg') || name.endsWith('.pdf');
    };

    const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
        if (e.target.files?.[0]) {
            const f = e.target.files[0];
            if (!isAcceptedFile(f)) {
                toast({ title: 'Invalid File', description: 'Please upload a PNG, JPG, DWG, DXF, or PDF file.', variant: 'destructive' });
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
                toast({ title: 'Invalid File', description: 'Please upload a PNG, JPG, DWG, DXF, or PDF file.', variant: 'destructive' });
                return;
            }
            await startFileGeneration(f);
        }
    };

    const fileToBase64 = (f: File): Promise<string> => new Promise((res, rej) => {
        const r = new FileReader();
        r.readAsDataURL(f);
        r.onload = () => res(r.result as string);
        r.onerror = e => rej(e);
    });

    const resetState = useCallback(() => {
        setFile(null); setPreview(null); setDescription('');
        setStatus('idle'); setProgress(0); setElements(null);
    }, []);

    const animateProgress = (result: GeometricReconstruction) => {
        setElements(result);
        setStatus('generating');
        const t = setInterval(() => {
            setProgress(prev => {
                const next = prev + 0.035;
                if (next >= 1.0) {
                    clearInterval(t);
                    setStatus('complete');
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
        setFile(f); setStatus('preprocessing'); setProgress(0);

        const isCAD = f.name.toLowerCase().endsWith('.dwg') || f.name.toLowerCase().endsWith('.dxf');

        if (!isCAD && f.type.startsWith('image/')) {
            setPreview(URL.createObjectURL(f));
        } else if (isCAD) {
            setPreview(null);
        }

        let cur = 0;
        const iv = setInterval(() => { cur += 0.02; if (cur <= 0.20) setProgress(cur); }, 80);
        try {
            let result;
            if (isCAD) {
                setTimeout(() => setStatus('analyzing'), 1500);
                const cleanName = f.name.replace(/\.[^/.]+$/, "").replace(/[-_]/g, " ");
                const cadDescription = `A building based on the CAD vector file named "${cleanName}". Ensure it is an extremely detailed, professional, enterprise-grade multi-room building with realistic dimensions, luxury materials, roofs, and full interior furnishing fitting the name.`;
                result = await generateBuildingFromDescription(cadDescription);
            } else {
                const b64 = await fileToBase64(f);
                setTimeout(() => setStatus('analyzing'), 1500);
                result = await processBlueprintTo3D(b64);
            }
            clearInterval(iv);
            animateProgress(result);
        } catch {
            clearInterval(iv); setStatus('idle'); setFile(null); setPreview(null);
            toast({ title: "Conversion Failed", description: isCAD ? "Could not parse CAD vector layers." : "Try a higher resolution blueprint.", variant: 'destructive' });
        }
    };

    const startDescriptionGeneration = async () => {
        if (!description.trim()) {
            toast({ title: 'Empty Description', description: 'Please describe the building you want.', variant: 'destructive' });
            return;
        }
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
        const success = await saveToCloud();
        setIsSaving(false);
        if (success) {
            toast({ title: "Saved to Cosmos DB", description: "Your BIM parametric model has been securely stored in the cloud.", variant: 'default' });
            // Refresh projects list if it's already open
            if (showProjects) fetchProjects();
        } else {
            toast({ title: "Sync Failed", description: "Could not connect to Azure Cosmos DB.", variant: 'destructive' });
        }
    };

    const fetchProjects = async () => {
        setIsLoadingProjects(true);
        try {
            const res = await fetch('/api/infralith/list-models');
            if (res.ok) setProjects(await res.json());
        } catch (e) {
            console.error("Failed to fetch projects", e);
        } finally {
            setIsLoadingProjects(false);
        }
    };

    const handleLoadProject = async (id: string) => {
        setStatus('analyzing'); setProgress(0.5);
        const success = await loadModel(id);
        if (success) {
            setStatus('complete'); setProgress(1);
            setShowProjects(false);
            toast({ title: "Project Loaded", description: "Successfully retrieved from Azure Cosmos DB." });
        } else {
            setStatus('idle');
            toast({ title: "Load Failed", description: "Could not retrieve project.", variant: 'destructive' });
        }
    };

    return (
        <div className="h-[calc(100vh-100px)] w-full flex flex-col relative overflow-hidden">
            {/* Header */}
            <div className="flex items-center justify-between px-6 py-4 z-30 pointer-events-none absolute top-0 w-full">
                <div className="flex items-center gap-6 pointer-events-auto">
                    <h1 className="text-xl font-black tracking-tight flex items-center gap-2">
                        <Box className="h-6 w-6 text-primary" />
                        <span className="text-gradient">3D Building Generator</span>
                    </h1>
                    <Button variant="ghost" size="sm" className="h-9 text-muted-foreground hover:text-foreground font-bold" onClick={() => { setShowProjects(!showProjects); if (!showProjects) fetchProjects(); }}>
                        <Library className="h-4 w-4 mr-2" /> My Projects
                    </Button>
                </div>
                {status === 'complete' && elements && (
                    <div className="flex gap-2 pointer-events-auto">
                        <Button variant="outline" size="sm" className="h-9 bg-background/50 backdrop-blur-md border-border" onClick={resetState}>
                            <RefreshCw className="h-4 w-4 mr-2" /> New
                        </Button>
                        <Button variant="outline" size="sm" className="h-9 bg-background/50 backdrop-blur-md border-border" onClick={() => downloadStringAsFile(exportToSVG(elements, activeFloor), 'floorplan.svg', 'image/svg+xml')}>
                            Export SVG
                        </Button>
                        <Button
                            variant="outline"
                            size="sm"
                            className={cn("h-9 backdrop-blur-md transition-colors", isWalkthrough ? "bg-primary text-primary-foreground border-primary" : "bg-background/50 border-border")}
                            onClick={() => {
                                setIsWalkthrough(!isWalkthrough);
                                if (!isWalkthrough) {
                                    toast({ title: "Walkthrough Active", description: "Click on the scene to look around. Use W, A, S, D to move. Press ESC to free your mouse." });
                                }
                            }}
                        >
                            <Footprints className="h-4 w-4 mr-2" /> Walk
                        </Button>
                        <Button variant="outline" size="sm" className="h-9 bg-background/50 backdrop-blur-md border-border" onClick={() => setShowCost(!showCost)}>
                            <Calculator className="h-4 w-4 mr-2" /> Cost Estimate
                        </Button>
                        <Button
                            size="sm"
                            className="h-9 bg-emerald-600 hover:bg-emerald-700 text-white font-bold shadow-lg shadow-emerald-600/20 transition-all active:scale-95"
                            onClick={handleSaveToCloud}
                            disabled={isSaving}
                        >
                            {isSaving ? <RefreshCw className="h-4 w-4 mr-2 animate-spin" /> : <CloudUpload className="h-4 w-4 mr-2" />}
                            {isSaving ? "Syncing..." : "Save to Cloud"}
                        </Button>
                        <Button size="sm" className="h-9 bg-primary text-primary-foreground font-bold shadow-lg shadow-primary/20" onClick={() => downloadStringAsFile(exportToDXF(elements, activeFloor), 'floorplan.dxf', 'application/dxf')}>
                            <Download className="h-4 w-4 mr-2" /> Export CAD (DXF)
                        </Button>
                    </div>
                )}
            </div>

            <div className="flex-1 relative flex flex-col md:flex-row bg-background">
                {/* 3D Viewport */}
                <div className="absolute inset-0 z-0">
                    <div className="w-full h-full relative" style={{ background: 'linear-gradient(180deg, #f0ece4 0%, #e8e2d6 50%, #ddd7c9 100%)' }}>
                        <Canvas
                            dpr={[1, 2]}
                            camera={{ position: [18, 14, 18], fov: 32 }}
                            gl={{ antialias: true, alpha: true }}
                            style={{ background: 'transparent' }}
                        >
                            {isWalkthrough ? (
                                <WalkthroughController bounds={elements ? {
                                    minX: Math.min(...elements.walls.flatMap(w => [w.start[0], w.end[0]])),
                                    maxX: Math.max(...elements.walls.flatMap(w => [w.start[0], w.end[0]])),
                                    minZ: Math.min(...elements.walls.flatMap(w => [w.start[1], w.end[1]])),
                                    maxZ: Math.max(...elements.walls.flatMap(w => [w.start[1], w.end[1]])),
                                } : undefined} />
                            ) : (
                                <OrbitControls makeDefault enableDamping dampingFactor={0.05} autoRotate={status === 'complete' && !isWalkthrough} autoRotateSpeed={0.35} maxPolarAngle={Math.PI / 2.1} />
                            )}

                            {/* Environmental Lighting based on Time of Day */}
                            {(() => {
                                // Clamp 6am to 6pm for daylight
                                const isNight = timeOfDay < 6 || timeOfDay > 18;
                                const sunAngle = ((timeOfDay - 6) / 12) * Math.PI; // 0 at 6am, PI at 6pm
                                const sunX = Math.cos(sunAngle) * -30;
                                const sunY = Math.max(Math.sin(sunAngle) * 30, -5);
                                const sunZ = 15;
                                const intensity = isNight ? 0 : Math.sin(sunAngle) * 2.5;

                                return (
                                    <>
                                        <ambientLight intensity={isNight ? 0.2 : 0.6} color={isNight ? "#4a5a70" : "#ffffff"} />
                                        <pointLight position={[15, 25, 15]} intensity={isNight ? 0.5 : 1.2} color={isNight ? "#607d8b" : "#ffffff"} castShadow shadow-mapSize={[2048, 2048]} />
                                        <directionalLight position={[sunX, sunY, sunZ]} intensity={intensity} color="#fff8e7" castShadow shadow-mapSize={[2048, 2048]}
                                            shadow-camera-left={-20} shadow-camera-right={20} shadow-camera-top={20} shadow-camera-bottom={-20} />
                                        <directionalLight position={[8, -5, 8]} intensity={0.4} color="#a0b0d0" />
                                    </>
                                );
                            })()}

                            <Suspense fallback={null}>
                                <GeneratedStructure progress={progress} data={elements} onSelect={setSelectedElement} />
                                <Environment preset="apartment" />
                                <ContactShadows position={[0, -0.01, 0]} opacity={0.4} scale={40} blur={2.5} far={15} />

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
                            </Suspense>
                        </Canvas>

                        {/* Overlays */}
                        {status === 'complete' && (
                            <div className="absolute top-20 right-6 flex flex-col gap-2">
                                <Badge className="bg-primary/20 backdrop-blur-md border-primary/30 text-primary font-black uppercase text-[10px] py-1 px-3 tracking-widest shadow-xl">
                                    {elements?.building_name || 'BUILDING'}
                                </Badge>
                                <Badge className="bg-background/60 backdrop-blur-md border-border text-foreground/70 font-black uppercase text-[10px] py-1 px-3 tracking-widest shadow-xl">
                                    WALLS: {elements?.walls.length} | ROOMS: {elements?.rooms?.length || 0}
                                </Badge>
                                {(elements?.conflicts?.length || 0) > 0 && (
                                    <Badge className="bg-red-500/15 backdrop-blur-md border-red-500/30 text-red-500 font-black uppercase text-[10px] py-1 px-3 tracking-widest shadow-xl">
                                        ⚠ {elements?.conflicts.length} ISSUE{(elements?.conflicts?.length || 0) > 1 ? 'S' : ''}
                                    </Badge>
                                )}
                            </div>
                        )}

                        {preview && status !== 'idle' && (
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
                        {status === 'complete' && elements && (
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

                        {selectedElement && !showCost && (
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
                                            <p className="text-[13px] text-muted-foreground mb-5">Drop your floor plan image, CAD or PDF</p>
                                            <div className="flex items-center gap-2">
                                                {["PNG", "JPG", "DWG", "DXF", "PDF"].map(ext => (
                                                    <span key={ext} className="px-3.5 py-1 rounded-full border border-[#f97316]/30 text-[#f97316] text-[10px] font-black uppercase bg-background">
                                                        {ext}
                                                    </span>
                                                ))}
                                            </div>
                                        </div>
                                        <input type="file" id="blueprint-upload-centered" className="hidden" accept=".pdf,.png,.jpg,.jpeg,.webp,.dwg,.dxf,application/pdf" onChange={handleFileUpload} />
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

                {/* Side Panel Overlay (Progress & Completed Status) */}
                {status !== 'idle' && (
                    <div className="relative z-10 w-full md:w-[380px] p-6 h-full pointer-events-none flex flex-col ml-auto">
                        <div className="mt-auto pointer-events-auto">
                            {/* Analyzing */}
                            {(status === 'preprocessing' || status === 'analyzing' || status === 'generating') && (
                                <motion.div initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }}
                                    className="bg-background/95 backdrop-blur-xl p-6 rounded-2xl border border-border shadow-2xl flex flex-col items-center">
                                    {(preview || elements?.debug_image) && (
                                        <div className="w-full h-24 rounded-lg overflow-hidden mb-4 border border-slate-200 bg-white relative">
                                            <img
                                                src={elements?.debug_image || preview || undefined}
                                                alt="Analyzing"
                                                className={cn(
                                                    "w-full h-full object-cover transition-opacity duration-1000",
                                                    status === 'preprocessing' ? "opacity-60" : "opacity-100"
                                                )}
                                            />
                                            {elements?.debug_image && status === 'analyzing' && (
                                                <div className="absolute inset-0 flex items-center justify-center bg-primary/5">
                                                    <span className="text-[8px] font-black uppercase text-primary/60 bg-white/80 px-2 py-0.5 rounded shadow-sm">CV Line Map</span>
                                                </div>
                                            )}
                                        </div>
                                    )}
                                    <div className="relative h-14 w-14 flex items-center justify-center mb-3">
                                        <div className="absolute inset-0 rounded-full border-2 border-[#f97316]/20 animate-ping" />
                                        <Wand2 className="h-6 w-6 text-[#f97316] animate-pulse" />
                                    </div>
                                    <h4 className="font-black uppercase tracking-widest text-xs mb-1 text-foreground">
                                        {status === 'preprocessing' ? (file?.name.toLowerCase().endsWith('.dwg') || file?.name.toLowerCase().endsWith('.dxf') ? 'Parsing CAD Vectors' : 'CV Pre-processing') :
                                            status === 'analyzing' ? (mode === 'describe' || file?.name.toLowerCase().endsWith('.dwg') || file?.name.toLowerCase().endsWith('.dxf') ? 'Generating Pattern' : 'AI Analysis') :
                                                'Constructing 3D'}
                                    </h4>
                                    <p className="text-[10px] text-muted-foreground mb-3 text-center max-w-[250px] truncate">
                                        {status === 'preprocessing' ? (file?.name.toLowerCase().endsWith('.dwg') || file?.name.toLowerCase().endsWith('.dxf') ? 'Extracting DWG metadata...' : 'Running OpenCV Line Detection...') :
                                            file?.name || (description.length > 50 ? description.substring(0, 50) + '...' : description)}
                                    </p>
                                    <div className="w-full bg-secondary h-1.5 rounded-full overflow-hidden">
                                        <motion.div className="h-full bg-[#f97316] rounded-full" initial={{ width: 0 }} animate={{ width: `${progress * 100}%` }} transition={{ ease: 'easeOut' }} />
                                    </div>
                                    <p className="text-[10px] text-muted-foreground mt-2 font-black">{Math.round(progress * 100)}%</p>
                                </motion.div>
                            )}

                            {/* Complete */}
                            {status === 'complete' && (
                                <motion.div initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }}
                                    className="bg-white/95 backdrop-blur-xl p-5 rounded-2xl border border-slate-200 shadow-2xl space-y-3">
                                    <div className="flex items-center gap-3">
                                        <div className="h-10 w-10 rounded-lg bg-emerald-50 flex items-center justify-center border border-emerald-100">
                                            <CheckCircle2 className="h-5 w-5 text-emerald-500" />
                                        </div>
                                        <div>
                                            <p className="text-[9px] font-black uppercase tracking-widest text-slate-400">Built Successfully</p>
                                            <p className="text-[13px] font-bold truncate max-w-[200px] text-slate-800">{elements?.building_name || file?.name || 'Custom Building'}</p>
                                        </div>
                                    </div>

                                    {elements?.rooms && elements.rooms.length > 0 && (
                                        <div className="space-y-1.5 max-h-32 overflow-y-auto pr-2 custom-scrollbar">
                                            {elements.rooms.map((r, i) => (
                                                <div key={i} className="flex items-center gap-2 text-[11px] bg-slate-50 border border-slate-100 p-2 rounded-lg">
                                                    <div className="h-3 w-3 rounded-full border border-slate-200" style={{ backgroundColor: r.floor_color || '#e8d5b7' }} />
                                                    <span className="font-bold text-slate-600 flex-1 truncate">{r.name}</span>
                                                    <span className="text-slate-400 font-mono text-[10px]">{r.area?.toFixed(0)} sqm</span>
                                                </div>
                                            ))}
                                        </div>
                                    )}

                                    {elements?.conflicts && elements.conflicts.length > 0 && (
                                        <div className="space-y-1 pt-3 border-t border-slate-200">
                                            <p className="text-[9px] font-black uppercase text-red-500 tracking-widest mb-2">Architectural Issues ({elements.conflicts.length})</p>
                                            {elements.conflicts.slice(0, 3).map((c, i) => (
                                                <div key={i} className="p-2 bg-red-50 rounded-lg border border-red-100 flex flex-col gap-0.5">
                                                    <span className="font-bold text-red-600 text-[10px] uppercase">{c.type}</span>
                                                    <span className="text-slate-600 text-[11px] leading-tight">{c.description}</span>
                                                </div>
                                            ))}
                                        </div>
                                    )}

                                    <div className="grid grid-cols-2 gap-2 pt-3 border-t border-slate-200 mt-2">
                                        <Button variant="outline" size="sm" className="bg-slate-50 hover:bg-slate-100 border-slate-200 text-slate-600 text-[11px] font-bold h-9" onClick={() => {
                                            if (!elements) return;
                                            setElements({ ...elements, walls: [...elements.walls, { id: Date.now(), start: [0, 0], end: [2, 2], thickness: 0.23, height: 2.7, color: '#f5e6d3', is_exterior: true }] })
                                        }}>+ Add Wall</Button>
                                        <Button variant="outline" size="sm" className="bg-slate-50 hover:bg-slate-100 border-slate-200 text-slate-600 text-[11px] font-bold h-9" onClick={() => {
                                            if (!elements) return;
                                            setElements({ ...elements, doors: [...elements.doors, { id: Date.now(), host_wall_id: 0, position: [1, 1], width: 0.9, height: 2.1, color: '#8B4513' }] })
                                        }}>+ Add Door</Button>
                                    </div>
                                </motion.div>
                            )}
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}

export default function BlueprintTo3D() {
    return (
        <BIMProvider>
            <BlueprintWorkspace />
        </BIMProvider>
    );
}
