'use client';

import React, { useState, useRef, Suspense, useCallback, useMemo } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import {
    OrbitControls,
    Environment,
    ContactShadows,
    Html,
    Edges
} from '@react-three/drei';
import * as THREE from 'three';
import { AlertTriangle, ShieldAlert, PenLine, Image as ImageIcon, Sparkles } from 'lucide-react';
import { motion } from 'framer-motion';
import {
    Upload,
    Box,
    Wand2,
    CheckCircle2,
    RefreshCw,
    Download,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { useToast } from '@/hooks/use-toast';
import {
    processBlueprintTo3D,
    generateBuildingFromDescription,
    GeometricReconstruction,
    RoofGeometry,
    ConstructionConflict
} from '@/ai/flows/infralith/blueprint-to-3d-agent';

// -- Conflict Markers --

function ConflictMarker({ conflict }: { conflict: ConstructionConflict }) {
    const meshRef = useRef<THREE.Mesh>(null);
    useFrame((state) => {
        if (meshRef.current) meshRef.current.position.y = 2 + Math.sin(state.clock.getElapsedTime() * 3) * 0.2;
    });
    const color = conflict.severity === 'high' ? '#ef4444' : conflict.severity === 'medium' ? '#f59e0b' : '#3b82f6';
    return (
        <group position={[conflict.location[0], 0, conflict.location[1]]}>
            <mesh ref={meshRef}>
                <octahedronGeometry args={[0.3, 0]} />
                <meshStandardMaterial color={color} emissive={color} emissiveIntensity={2} transparent opacity={0.8} />
            </mesh>
            <Html distanceFactor={10} position={[0, 2.8, 0]} center>
                <div className={cn(
                    "flex items-center gap-2 px-3 py-1.5 rounded-full border backdrop-blur-xl shadow-2xl",
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

// -- Generated Structure --

function GeneratedStructure({ progress, data }: { progress: number, data: GeometricReconstruction | null }) {
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
            <mesh position={[0, -0.02, 0]} receiveShadow rotation={[-Math.PI / 2, 0, 0]}>
                <planeGeometry args={[40, 40]} />
                <meshStandardMaterial color="#7cad6b" roughness={0.95} />
            </mesh>
            {/* Subtle ground grid */}
            <gridHelper args={[40, 80, "#6b9e5b", "#6b9e5b"]} position={[0, 0.005, 0]} />

            {/* Pathway from gate to entrance */}
            <mesh position={[(bounds.minX + bounds.maxX) / 2, 0.01, bounds.minZ - 1.5]} rotation={[-Math.PI / 2, 0, 0]}>
                <planeGeometry args={[1.5, 3]} />
                <meshStandardMaterial color="#c9b896" roughness={0.8} />
            </mesh>

            {p > 0 && (
                <group scale={[1, p, 1]}>
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

                        return (
                            <group key={`room-${i}`}>
                                <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.02, 0]} receiveShadow>
                                    <shapeGeometry args={[shape]} />
                                    <meshStandardMaterial color={room.floor_color || defaultFloor} roughness={0.55} />
                                </mesh>
                                <Html position={[cx, 0.15, cz]} distanceFactor={14} center>
                                    <div className="px-2 py-0.5 bg-black/70 backdrop-blur-sm rounded-md shadow-lg">
                                        <p className="text-[8px] font-black uppercase text-white select-none whitespace-nowrap tracking-wider">
                                            {room.name}
                                        </p>
                                        {room.area > 0 && (
                                            <p className="text-[7px] text-white/50 text-center">{room.area.toFixed(0)} sqm</p>
                                        )}
                                    </div>
                                </Html>
                            </group>
                        );
                    })}

                    {/* Walls */}
                    {data.walls.map((wall, i) => {
                        const dx = wall.end[0] - wall.start[0];
                        const dz = wall.end[1] - wall.start[1];
                        const len = Math.sqrt(dx * dx + dz * dz);
                        const ang = Math.atan2(dz, dx);
                        const cx = (wall.start[0] + wall.end[0]) / 2;
                        const cz = (wall.start[1] + wall.end[1]) / 2;
                        const col = wall.color || (wall.is_exterior ? defaultExterior : defaultInterior);

                        return (
                            <mesh key={`wall-${i}`} position={[cx, wall.height / 2, cz]} rotation={[0, -ang, 0]} castShadow receiveShadow>
                                <boxGeometry args={[len, wall.height, wall.thickness]} />
                                <meshStandardMaterial color={col} roughness={0.55} metalness={0.02} />
                                <Edges color="#00000015" threshold={15} />
                            </mesh>
                        );
                    })}

                    {/* Doors */}
                    {data.doors.map((door, i) => (
                        <group key={`door-${i}`} position={[door.position[0], door.height / 2, door.position[1]]}>
                            <mesh castShadow>
                                <boxGeometry args={[door.width, door.height, 0.08]} />
                                <meshStandardMaterial color={door.color || defaultDoor} roughness={0.4} />
                                <Edges color="#3e2a12" threshold={15} />
                            </mesh>
                            <mesh position={[door.width * 0.35, -0.1, 0.05]}>
                                <sphereGeometry args={[0.04, 8, 8]} />
                                <meshStandardMaterial color="#c0a060" metalness={0.85} roughness={0.15} />
                            </mesh>
                        </group>
                    ))}

                    {/* Windows */}
                    {data.windows.map((win, i) => {
                        const wh = 1.2;
                        return (
                            <group key={`win-${i}`}>
                                <mesh position={[win.position[0], win.sill_height + wh / 2, win.position[1]]}>
                                    <boxGeometry args={[win.width + 0.1, wh + 0.1, 0.12]} />
                                    <meshStandardMaterial color="#f0ece4" roughness={0.3} />
                                </mesh>
                                <mesh position={[win.position[0], win.sill_height + wh / 2, win.position[1]]}>
                                    <boxGeometry args={[win.width, wh, 0.04]} />
                                    <meshStandardMaterial color={win.color || defaultWindow} transparent opacity={0.4} metalness={0.7} roughness={0.1} />
                                </mesh>
                                <mesh position={[win.position[0], win.sill_height + wh / 2, win.position[1]]}>
                                    <boxGeometry args={[0.025, wh, 0.06]} />
                                    <meshStandardMaterial color="#f0ece4" />
                                </mesh>
                                <mesh position={[win.position[0], win.sill_height + wh / 2, win.position[1]]}>
                                    <boxGeometry args={[win.width, 0.025, 0.06]} />
                                    <meshStandardMaterial color="#f0ece4" />
                                </mesh>
                            </group>
                        );
                    })}

                    {/* Roof */}
                    {data.roof && <RoofMesh roof={data.roof} />}

                    {/* Staircase */}
                    <Staircase position={[(bounds.minX + bounds.maxX) / 2 - 1, 0, (bounds.minZ + bounds.maxZ) / 2]} />

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
                    <Tree position={[bounds.maxX + 2, 0, bounds.minZ + 1]} scale={1.2} />
                    <Tree position={[bounds.maxX + 2.5, 0, bounds.maxZ - 1]} scale={0.9} />
                    <Tree position={[bounds.minX - 2, 0, bounds.maxZ]} scale={1.1} />
                    <Tree position={[bounds.minX - 2.5, 0, bounds.minZ + 2]} scale={0.8} />
                    <Tree position={[(bounds.minX + bounds.maxX) / 2 + 4, 0, bounds.maxZ + 2]} scale={1.3} />
                    <Tree position={[(bounds.minX + bounds.maxX) / 2 - 3, 0, bounds.maxZ + 2.5]} scale={1.0} />

                    {/* Bushes along boundary */}
                    {Array.from({ length: 8 }).map((_, i) => (
                        <Bush key={`bush-${i}`} position={[
                            bounds.minX - 2.5 + i * ((bounds.maxX - bounds.minX + 5) / 7),
                            0.15,
                            bounds.maxZ + 2.8
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

// -- Main Page --

export default function BlueprintTo3D() {
    const { toast } = useToast();
    const [mode, setMode] = useState<'upload' | 'describe'>('upload');
    const [file, setFile] = useState<File | null>(null);
    const [preview, setPreview] = useState<string | null>(null);
    const [description, setDescription] = useState('');
    const [status, setStatus] = useState<'idle' | 'analyzing' | 'generating' | 'complete'>('idle');
    const [progress, setProgress] = useState(0);
    const [elements, setElements] = useState<GeometricReconstruction | null>(null);

    const ACCEPTED_TYPES = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'application/pdf'];

    const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
        if (e.target.files?.[0]) {
            const f = e.target.files[0];
            if (!ACCEPTED_TYPES.includes(f.type)) {
                toast({ title: 'Invalid File', description: 'Please upload a PNG, JPG, or PDF file.', variant: 'destructive' });
                return;
            }
            await startFileGeneration(f);
        }
    };

    const handleDrop = async (e: React.DragEvent) => {
        e.preventDefault();
        if (e.dataTransfer.files?.[0]) {
            const f = e.dataTransfer.files[0];
            if (!ACCEPTED_TYPES.includes(f.type)) {
                toast({ title: 'Invalid File', description: 'Please upload a PNG, JPG, or PDF file.', variant: 'destructive' });
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
        setFile(f); setStatus('analyzing'); setProgress(0);
        if (f.type.startsWith('image/')) setPreview(URL.createObjectURL(f));
        let cur = 0;
        const iv = setInterval(() => { cur += 0.02; if (cur <= 0.45) setProgress(cur); }, 80);
        try {
            const b64 = await fileToBase64(f);
            const result = await processBlueprintTo3D(b64);
            clearInterval(iv);
            animateProgress(result);
        } catch {
            clearInterval(iv); setStatus('idle'); setFile(null); setPreview(null);
            toast({ title: "Conversion Failed", description: "Try a higher resolution blueprint.", variant: 'destructive' });
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

    return (
        <div className="h-[calc(100vh-100px)] w-full flex flex-col relative overflow-hidden">
            {/* Header */}
            <div className="flex items-center justify-between px-6 py-4 z-30 pointer-events-none absolute top-0 w-full">
                <div className="pointer-events-auto">
                    <h1 className="text-xl font-black tracking-tight flex items-center gap-2">
                        <Box className="h-6 w-6 text-primary" />
                        <span className="text-gradient">3D Building Generator</span>
                    </h1>
                </div>
                {status === 'complete' && (
                    <div className="flex gap-2 pointer-events-auto">
                        <Button variant="outline" size="sm" className="h-9 bg-background/50 backdrop-blur-md border-border" onClick={resetState}>
                            <RefreshCw className="h-4 w-4 mr-2" /> New
                        </Button>
                        <Button size="sm" className="h-9 bg-primary text-primary-foreground font-bold shadow-lg shadow-primary/20">
                            <Download className="h-4 w-4 mr-2" /> Export IFC
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
                            <OrbitControls makeDefault enableDamping dampingFactor={0.05} autoRotate={status === 'complete'} autoRotateSpeed={0.35} maxPolarAngle={Math.PI / 2.1} />
                            <ambientLight intensity={1.5} />
                            <pointLight position={[15, 25, 15]} intensity={1.0} castShadow />
                            <directionalLight position={[-12, 30, 12]} intensity={2.0} color="#fff8e7" castShadow />
                            <directionalLight position={[8, -5, 8]} intensity={0.2} />

                            <Suspense fallback={null}>
                                <GeneratedStructure progress={progress} data={elements} />
                                <Environment preset="apartment" />
                                <ContactShadows position={[0, -0.01, 0]} opacity={0.2} scale={30} blur={3} far={15} />
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
                    </div>
                </div>

                {/* Side Panel */}
                <div className="relative z-10 w-full md:w-[380px] p-6 h-full pointer-events-none flex flex-col">
                    <div className="mt-auto pointer-events-auto">
                        {status === 'idle' && (
                            <motion.div
                                initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}
                                className="bg-card/90 backdrop-blur-xl rounded-3xl border border-border shadow-2xl overflow-hidden"
                            >
                                {/* Mode Toggle */}
                                <div className="flex border-b border-border">
                                    <button
                                        onClick={() => setMode('upload')}
                                        className={cn(
                                            "flex-1 py-3 px-4 text-xs font-black uppercase tracking-widest flex items-center justify-center gap-2 transition-all",
                                            mode === 'upload' ? "bg-primary/10 text-primary border-b-2 border-primary" : "text-muted-foreground hover:text-foreground"
                                        )}
                                    >
                                        <ImageIcon className="h-4 w-4" /> Upload
                                    </button>
                                    <button
                                        onClick={() => setMode('describe')}
                                        className={cn(
                                            "flex-1 py-3 px-4 text-xs font-black uppercase tracking-widest flex items-center justify-center gap-2 transition-all",
                                            mode === 'describe' ? "bg-primary/10 text-primary border-b-2 border-primary" : "text-muted-foreground hover:text-foreground"
                                        )}
                                    >
                                        <PenLine className="h-4 w-4" /> Describe
                                    </button>
                                </div>

                                <div className="p-6 space-y-5">
                                    {mode === 'upload' && (
                                        <>
                                            <div className="text-center" onDragOver={e => { e.preventDefault(); e.stopPropagation(); }} onDrop={handleDrop}>
                                                <div className="h-14 w-14 mx-auto rounded-2xl bg-primary/10 border border-primary/20 flex items-center justify-center mb-3">
                                                    <Upload className="h-7 w-7 text-primary" />
                                                </div>
                                                <h3 className="text-lg font-black mb-1">Upload Blueprint</h3>
                                                <p className="text-xs text-muted-foreground">Drop your floor plan image or PDF</p>
                                            </div>
                                            <Button onClick={() => document.getElementById('blueprint-upload')?.click()} className="w-full bg-primary text-primary-foreground font-bold h-11 rounded-xl">
                                                Select File
                                            </Button>
                                            <input type="file" id="blueprint-upload" className="hidden" accept=".pdf,.png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp,application/pdf" onChange={handleFileUpload} />
                                            <div className="flex justify-center gap-2">
                                                {["PNG", "JPG", "PDF"].map(f => (
                                                    <Badge key={f} variant="outline" className="bg-muted/50 border-border text-[9px] font-black uppercase">{f}</Badge>
                                                ))}
                                            </div>
                                        </>
                                    )}

                                    {mode === 'describe' && (
                                        <>
                                            <div className="text-center">
                                                <div className="h-14 w-14 mx-auto rounded-2xl bg-primary/10 border border-primary/20 flex items-center justify-center mb-3">
                                                    <Sparkles className="h-7 w-7 text-primary" />
                                                </div>
                                                <h3 className="text-lg font-black mb-1">Describe Your Building</h3>
                                                <p className="text-xs text-muted-foreground">AI generates a fully colored 3D model</p>
                                            </div>
                                            <textarea
                                                value={description}
                                                onChange={e => setDescription(e.target.value)}
                                                placeholder="Example: A 3BHK bungalow with open living room, kitchen, 2 bathrooms, balcony, covered parking, terracotta roof, cream walls..."
                                                className="w-full h-28 px-4 py-3 bg-muted/50 border border-border rounded-xl text-sm resize-none focus:outline-none focus:ring-2 focus:ring-primary/50 placeholder:text-muted-foreground/50"
                                            />
                                            <Button onClick={startDescriptionGeneration} className="w-full bg-primary text-primary-foreground font-bold h-11 rounded-xl gap-2" disabled={!description.trim()}>
                                                <Sparkles className="h-4 w-4" /> Generate 3D Building
                                            </Button>
                                            <div className="space-y-1.5">
                                                <p className="text-[9px] font-black uppercase text-muted-foreground tracking-widest">Quick Templates</p>
                                                <div className="flex flex-wrap gap-1.5">
                                                    {[
                                                        { label: "3BHK Bungalow", desc: "A modern 3-bedroom bungalow with spacious living room, modular kitchen, 2 bathrooms, covered parking, front lawn, terracotta roof and cream exterior walls." },
                                                        { label: "2BHK Flat", desc: "A compact 2-bedroom apartment with living/dining area, kitchen, balcony, 2 bathrooms, and utility area. Modern finish with beige walls." },
                                                        { label: "Luxury Villa", desc: "A luxury 4-bedroom villa with double-height living room, home office, family lounge, swimming pool area, landscaped garden, covered parking for 2 cars, terrace with pergola." },
                                                        { label: "Farmhouse", desc: "A spacious farmhouse with 3 bedrooms, large kitchen, veranda, exposed brick walls, wooden beams, courtyard, and sloped clay tile roof." },
                                                        { label: "Studio", desc: "A modern studio apartment with open plan living, kitchenette, bathroom, balcony, minimalist design with white walls and wood accents." },
                                                    ].map(t => (
                                                        <button key={t.label} onClick={() => setDescription(t.desc)}
                                                            className="px-2.5 py-1 rounded-lg bg-muted/80 border border-border text-[10px] font-bold hover:bg-primary/10 hover:border-primary/30 hover:text-primary transition-all">
                                                            {t.label}
                                                        </button>
                                                    ))}
                                                </div>
                                            </div>
                                        </>
                                    )}
                                </div>
                            </motion.div>
                        )}

                        {/* Analyzing */}
                        {(status === 'analyzing' || status === 'generating') && (
                            <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}
                                className="bg-card/90 backdrop-blur-xl p-6 rounded-2xl border border-border shadow-2xl flex flex-col items-center">
                                {preview && (
                                    <div className="w-full h-24 rounded-lg overflow-hidden mb-4 border border-border">
                                        <img src={preview} alt="Analyzing" className="w-full h-full object-cover opacity-60" />
                                    </div>
                                )}
                                <div className="relative h-14 w-14 flex items-center justify-center mb-3">
                                    <div className="absolute inset-0 rounded-full border-2 border-primary/20 animate-ping" />
                                    <Wand2 className="h-6 w-6 text-primary animate-pulse" />
                                </div>
                                <h4 className="font-black uppercase tracking-widest text-xs mb-1">
                                    {mode === 'describe' ? 'Constructing Building' : 'Analyzing Blueprint'}
                                </h4>
                                <p className="text-[10px] text-muted-foreground mb-3 text-center max-w-[250px] truncate">
                                    {file?.name || (description.length > 50 ? description.substring(0, 50) + '...' : description)}
                                </p>
                                <div className="w-full bg-muted h-1.5 rounded-full overflow-hidden">
                                    <motion.div className="h-full bg-primary rounded-full" initial={{ width: 0 }} animate={{ width: `${progress * 100}%` }} transition={{ ease: 'easeOut' }} />
                                </div>
                                <p className="text-[10px] text-muted-foreground mt-2">{Math.round(progress * 100)}%</p>
                            </motion.div>
                        )}

                        {/* Complete */}
                        {status === 'complete' && (
                            <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}
                                className="bg-card/90 backdrop-blur-xl p-5 rounded-2xl border border-border shadow-2xl space-y-3">
                                <div className="flex items-center gap-3">
                                    <div className="h-10 w-10 rounded-lg bg-green-500/20 flex items-center justify-center">
                                        <CheckCircle2 className="h-6 w-6 text-green-500" />
                                    </div>
                                    <div>
                                        <p className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Built Successfully</p>
                                        <p className="text-sm font-bold truncate max-w-[200px]">{elements?.building_name || file?.name || 'Custom Building'}</p>
                                    </div>
                                </div>

                                {elements?.rooms && elements.rooms.length > 0 && (
                                    <div className="space-y-1 max-h-28 overflow-y-auto pr-1">
                                        {elements.rooms.map((r, i) => (
                                            <div key={i} className="flex items-center gap-2 text-[11px]">
                                                <div className="h-3 w-3 rounded-sm border border-border" style={{ backgroundColor: r.floor_color || '#e8d5b7' }} />
                                                <span className="font-bold flex-1 truncate">{r.name}</span>
                                                <span className="text-muted-foreground text-[10px]">{r.area?.toFixed(0)} sqm</span>
                                            </div>
                                        ))}
                                    </div>
                                )}

                                {elements?.conflicts && elements.conflicts.length > 0 && (
                                    <div className="space-y-1 pt-2 border-t border-border/50">
                                        <p className="text-[9px] font-black uppercase text-destructive/80">Issues ({elements.conflicts.length})</p>
                                        {elements.conflicts.slice(0, 3).map((c, i) => (
                                            <div key={i} className="p-1.5 rounded bg-destructive/10 border border-destructive/20 text-[10px]">
                                                <span className="font-bold text-destructive">{c.type}:</span>
                                                <span className="text-muted-foreground ml-1">{c.description}</span>
                                            </div>
                                        ))}
                                    </div>
                                )}

                                <div className="grid grid-cols-2 gap-2 pt-2 border-t border-border/50">
                                    <Button variant="outline" size="sm" className="bg-muted/50 border-border text-[10px] font-black h-8" onClick={() => {
                                        if (!elements) return;
                                        setElements({ ...elements, walls: [...elements.walls, { id: Date.now(), start: [0, 0], end: [2, 2], thickness: 0.23, height: 2.7, color: '#f5e6d3', is_exterior: true }] })
                                    }}>+ Wall</Button>
                                    <Button variant="outline" size="sm" className="bg-muted/50 border-border text-[10px] font-black h-8" onClick={() => {
                                        if (!elements) return;
                                        setElements({ ...elements, doors: [...elements.doors, { id: Date.now(), host_wall_id: 0, position: [1, 1], width: 0.9, height: 2.1, color: '#8B4513' }] })
                                    }}>+ Door</Button>
                                </div>
                            </motion.div>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}
