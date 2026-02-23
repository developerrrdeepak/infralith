'use client';

import React, { useState, useRef, Suspense, useCallback } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import {
    OrbitControls,
    PerspectiveCamera,
    Environment,
    Grid,
    ContactShadows,
    Html,
    Edges
} from '@react-three/drei';
import * as THREE from 'three';
import { AlertTriangle, ShieldAlert, Cpu, PenLine, Image as ImageIcon, Sparkles } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import {
    Upload,
    Box,
    Layers,
    Wand2,
    CheckCircle2,
    RefreshCw,
    Download,
    FileText,
    Plus
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { useToast } from '@/hooks/use-toast';
import {
    processBlueprintTo3D,
    generateBuildingFromDescription,
    GeometricReconstruction,
    WallGeometry,
    DoorGeometry,
    WindowGeometry,
    RoomGeometry,
    RoofGeometry,
    ConstructionConflict
} from '@/ai/flows/infralith/blueprint-to-3d-agent';

// -- 3D Conflict Markers --

function ConflictMarker({ conflict }: { conflict: ConstructionConflict }) {
    const meshRef = useRef<THREE.Mesh>(null);
    useFrame((state) => {
        if (meshRef.current) {
            meshRef.current.position.y = 2 + Math.sin(state.clock.getElapsedTime() * 3) * 0.2;
        }
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
                    "flex items-center gap-2 px-3 py-1.5 rounded-full border backdrop-blur-xl shadow-2xl transition-all",
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

// -- Roof Component --

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
    const centerZ = (minZ + maxZ) / 2;
    const halfW = (maxX - minX) / 2;
    const halfD = (maxZ - minZ) / 2;

    if (roof.type === 'gable') {
        // Gable roof: two sloped planes meeting at a ridge
        const ridgeY = peakY;
        const eaveY = baseY;
        const overhang = 0.3;

        const leftGeom = new THREE.BufferGeometry();
        const rightGeom = new THREE.BufferGeometry();

        // Left slope
        const leftVerts = new Float32Array([
            minX - overhang, eaveY, minZ - overhang,
            centerX, ridgeY, minZ - overhang,
            centerX, ridgeY, maxZ + overhang,
            minX - overhang, eaveY, maxZ + overhang,
        ]);
        const leftIndices = [0, 1, 2, 0, 2, 3];
        leftGeom.setAttribute('position', new THREE.BufferAttribute(leftVerts, 3));
        leftGeom.setIndex(leftIndices);
        leftGeom.computeVertexNormals();

        // Right slope
        const rightVerts = new Float32Array([
            centerX, ridgeY, minZ - overhang,
            maxX + overhang, eaveY, minZ - overhang,
            maxX + overhang, eaveY, maxZ + overhang,
            centerX, ridgeY, maxZ + overhang,
        ]);
        const rightIndices = [0, 1, 2, 0, 2, 3];
        rightGeom.setAttribute('position', new THREE.BufferAttribute(rightVerts, 3));
        rightGeom.setIndex(rightIndices);
        rightGeom.computeVertexNormals();

        // Front/back triangles (gable ends)
        const frontGeom = new THREE.BufferGeometry();
        const frontVerts = new Float32Array([
            minX - overhang, eaveY, minZ - overhang,
            maxX + overhang, eaveY, minZ - overhang,
            centerX, ridgeY, minZ - overhang,
        ]);
        frontGeom.setAttribute('position', new THREE.BufferAttribute(frontVerts, 3));
        frontGeom.setIndex([0, 1, 2]);
        frontGeom.computeVertexNormals();

        const backGeom = new THREE.BufferGeometry();
        const backVerts = new Float32Array([
            minX - overhang, eaveY, maxZ + overhang,
            centerX, ridgeY, maxZ + overhang,
            maxX + overhang, eaveY, maxZ + overhang,
        ]);
        backGeom.setAttribute('position', new THREE.BufferAttribute(backVerts, 3));
        backGeom.setIndex([0, 1, 2]);
        backGeom.computeVertexNormals();

        return (
            <group>
                <mesh geometry={leftGeom} castShadow receiveShadow>
                    <meshStandardMaterial color={roofColor} roughness={0.7} side={THREE.DoubleSide} />
                </mesh>
                <mesh geometry={rightGeom} castShadow receiveShadow>
                    <meshStandardMaterial color={roofColor} roughness={0.7} side={THREE.DoubleSide} />
                </mesh>
                <mesh geometry={frontGeom} castShadow>
                    <meshStandardMaterial color={roofColor} roughness={0.7} side={THREE.DoubleSide} />
                </mesh>
                <mesh geometry={backGeom} castShadow>
                    <meshStandardMaterial color={roofColor} roughness={0.7} side={THREE.DoubleSide} />
                </mesh>
            </group>
        );
    }

    // Flat roof fallback
    return (
        <mesh position={[centerX, baseY + 0.05, centerZ]} castShadow receiveShadow>
            <boxGeometry args={[maxX - minX + 0.4, 0.1, maxZ - minZ + 0.4]} />
            <meshStandardMaterial color={roofColor} roughness={0.6} />
        </mesh>
    );
}

// -- Main 3D Structure --

function GeneratedStructure({ progress, data }: { progress: number, data: GeometricReconstruction | null }) {
    if (!data) return null;
    const groupRef = useRef<THREE.Group>(null);
    const currentScaleY = progress;

    // Default colors
    const defaultExteriorWall = data.exterior_color || '#f5e6d3';
    const defaultInteriorWall = '#faf7f2';
    const defaultFloor = '#e8d5b7';
    const defaultDoor = '#8B4513';
    const defaultWindow = '#87CEEB';

    return (
        <group ref={groupRef} position={[0, 0, 0]}>
            {/* Ground plane */}
            <mesh position={[0, -0.05, 0]} receiveShadow>
                <boxGeometry args={[20, 0.1, 20]} />
                <meshStandardMaterial color="#7cad6b" roughness={0.95} />
            </mesh>
            {/* Garden/lawn texture grid */}
            <gridHelper args={[20, 40, "#6b9e5b", "#6b9e5b"]} position={[0, 0.01, 0]} />

            {currentScaleY > 0 && (
                <group scale={[1, currentScaleY, 1]}>
                    {/* Room Floor Slabs with colors */}
                    {data.rooms.map((room, i) => {
                        const shape = new THREE.Shape();
                        room.polygon.forEach((p, idx) => {
                            if (idx === 0) shape.moveTo(p[0], p[1]);
                            else shape.lineTo(p[0], p[1]);
                        });
                        shape.closePath();
                        const floorColor = room.floor_color || defaultFloor;

                        return (
                            <group key={`room-${i}`}>
                                <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.02, 0]} receiveShadow>
                                    <shapeGeometry args={[shape]} />
                                    <meshStandardMaterial color={floorColor} roughness={0.6} metalness={0.05} />
                                </mesh>
                                <Html position={[
                                    room.polygon.reduce((s, p) => s + p[0], 0) / room.polygon.length,
                                    0.15,
                                    room.polygon.reduce((s, p) => s + p[1], 0) / room.polygon.length
                                ]} distanceFactor={12} center>
                                    <div className="px-2 py-0.5 bg-black/60 backdrop-blur-sm rounded-md">
                                        <p className="text-[9px] font-black uppercase text-white select-none whitespace-nowrap tracking-wider">
                                            {room.name}
                                        </p>
                                        {room.area > 0 && (
                                            <p className="text-[7px] text-white/60 text-center">{room.area.toFixed(0)} sqm</p>
                                        )}
                                    </div>
                                </Html>
                            </group>
                        );
                    })}

                    {/* Walls with colors */}
                    {data.walls.map((wall, i) => {
                        const dx = wall.end[0] - wall.start[0];
                        const dz = wall.end[1] - wall.start[1];
                        const length = Math.sqrt(dx * dx + dz * dz);
                        const angle = Math.atan2(dz, dx);
                        const centerX = (wall.start[0] + wall.end[0]) / 2;
                        const centerZ = (wall.start[1] + wall.end[1]) / 2;
                        const wallColor = wall.color || (wall.is_exterior ? defaultExteriorWall : defaultInteriorWall);

                        return (
                            <mesh
                                key={`wall-${i}`}
                                position={[centerX, wall.height / 2, centerZ]}
                                rotation={[0, -angle, 0]}
                                castShadow
                                receiveShadow
                            >
                                <boxGeometry args={[length, wall.height, wall.thickness]} />
                                <meshStandardMaterial color={wallColor} roughness={0.6} metalness={0.05} />
                                <Edges color="#00000022" threshold={15} />
                            </mesh>
                        );
                    })}

                    {/* Doors with colors */}
                    {data.doors.map((door, i) => {
                        const doorColor = door.color || defaultDoor;
                        return (
                            <group key={`door-${i}`} position={[door.position[0], door.height / 2, door.position[1]]}>
                                <mesh castShadow>
                                    <boxGeometry args={[door.width, door.height, 0.08]} />
                                    <meshStandardMaterial color={doorColor} roughness={0.4} metalness={0.05} />
                                    <Edges color="#3e2a12" threshold={15} />
                                </mesh>
                                {/* Door handle */}
                                <mesh position={[door.width * 0.35, -0.1, 0.05]}>
                                    <sphereGeometry args={[0.04, 8, 8]} />
                                    <meshStandardMaterial color="#c0a060" metalness={0.8} roughness={0.2} />
                                </mesh>
                            </group>
                        );
                    })}

                    {/* Windows with colors and glass effect */}
                    {data.windows.map((window, i) => {
                        const windowHeight = 1.2;
                        const winColor = window.color || defaultWindow;
                        return (
                            <group key={`window-${i}`}>
                                {/* Window frame */}
                                <mesh position={[window.position[0], window.sill_height + windowHeight / 2, window.position[1]]}>
                                    <boxGeometry args={[window.width + 0.1, windowHeight + 0.1, 0.12]} />
                                    <meshStandardMaterial color="#f0f0f0" roughness={0.3} />
                                </mesh>
                                {/* Glass pane */}
                                <mesh position={[window.position[0], window.sill_height + windowHeight / 2, window.position[1]]} castShadow>
                                    <boxGeometry args={[window.width, windowHeight, 0.04]} />
                                    <meshStandardMaterial color={winColor} transparent opacity={0.45} metalness={0.8} roughness={0.1} />
                                </mesh>
                                {/* Window divider (cross bar) */}
                                <mesh position={[window.position[0], window.sill_height + windowHeight / 2, window.position[1]]}>
                                    <boxGeometry args={[0.03, windowHeight, 0.06]} />
                                    <meshStandardMaterial color="#f0f0f0" />
                                </mesh>
                                <mesh position={[window.position[0], window.sill_height + windowHeight / 2, window.position[1]]}>
                                    <boxGeometry args={[window.width, 0.03, 0.06]} />
                                    <meshStandardMaterial color="#f0f0f0" />
                                </mesh>
                            </group>
                        );
                    })}

                    {/* Roof */}
                    {data.roof && <RoofMesh roof={data.roof} />}
                </group>
            )}

            {/* Conflict markers */}
            {progress >= 1 && data.conflicts?.map((conflict, i) => (
                <ConflictMarker key={`conflict-${i}`} conflict={conflict} />
            ))}
        </group>
    );
}

// -- Main Page Component --

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
        if (e.target.files && e.target.files[0]) {
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
        if (e.dataTransfer.files && e.dataTransfer.files[0]) {
            const f = e.dataTransfer.files[0];
            if (!ACCEPTED_TYPES.includes(f.type)) {
                toast({ title: 'Invalid File', description: 'Please upload a PNG, JPG, or PDF file.', variant: 'destructive' });
                return;
            }
            await startFileGeneration(f);
        }
    };

    const fileToBase64 = (f: File): Promise<string> => {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.readAsDataURL(f);
            reader.onload = () => resolve(reader.result as string);
            reader.onerror = error => reject(error);
        });
    };

    const resetState = useCallback(() => {
        setFile(null);
        setPreview(null);
        setDescription('');
        setStatus('idle');
        setProgress(0);
        setElements(null);
    }, []);

    const animateProgress = (result: GeometricReconstruction) => {
        setElements(result);
        setStatus('generating');

        const extInt = setInterval(() => {
            setProgress(prev => {
                const next = prev + 0.04;
                if (next >= 1.0) {
                    clearInterval(extInt);
                    setStatus('complete');
                    toast({
                        title: "3D Building Generated",
                        description: `${result.building_name || 'Building'}: ${result.walls.length} walls, ${result.rooms?.length || 0} rooms, ${result.doors?.length || 0} doors.`,
                    });
                    return 1.0;
                }
                return next;
            });
        }, 40);
    };

    const startFileGeneration = async (f: File) => {
        setFile(f);
        setStatus('analyzing');
        setProgress(0);
        if (f.type.startsWith('image/')) setPreview(URL.createObjectURL(f));

        let current = 0;
        const interval = setInterval(() => {
            current += 0.02;
            if (current <= 0.45) setProgress(current);
        }, 80);

        try {
            const b64 = await fileToBase64(f);
            const result = await processBlueprintTo3D(b64);
            clearInterval(interval);
            animateProgress(result);
        } catch (error) {
            console.error('Blueprint generation error:', error);
            clearInterval(interval);
            setStatus('idle');
            setFile(null);
            setPreview(null);
            toast({ title: "Conversion Failed", description: "Try a higher resolution blueprint image.", variant: 'destructive' });
        }
    };

    const startDescriptionGeneration = async () => {
        if (!description.trim()) {
            toast({ title: 'Empty Description', description: 'Please describe the building you want to create.', variant: 'destructive' });
            return;
        }
        setStatus('analyzing');
        setProgress(0);

        let current = 0;
        const interval = setInterval(() => {
            current += 0.015;
            if (current <= 0.45) setProgress(current);
        }, 80);

        try {
            const result = await generateBuildingFromDescription(description);
            clearInterval(interval);
            animateProgress(result);
        } catch (error) {
            console.error('Text-to-3D generation error:', error);
            clearInterval(interval);
            setStatus('idle');
            toast({ title: "Generation Failed", description: "Could not generate building from description. Try again.", variant: 'destructive' });
        }
    };

    return (
        <div className="h-[calc(100vh-100px)] w-full flex flex-col relative overflow-hidden">
            {/* Minimal Header */}
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
                    <div className="w-full h-full relative group" style={{ background: 'linear-gradient(180deg, #d4e6f1 0%, #a9cce3 40%, #85c1ae 100%)' }}>
                        <Canvas
                            dpr={[1, 2]}
                            camera={{ position: [15, 12, 15], fov: 35 }}
                            gl={{ antialias: true, alpha: true }}
                            style={{ background: 'transparent' }}
                        >
                            <OrbitControls makeDefault enableDamping dampingFactor={0.05} autoRotate={status === 'complete'} autoRotateSpeed={0.4} />
                            <ambientLight intensity={1.4} />
                            <pointLight position={[10, 20, 10]} intensity={1.2} castShadow />
                            <directionalLight position={[-10, 25, 10]} intensity={1.8} color="#ffffff" castShadow />
                            <directionalLight position={[5, -5, 5]} intensity={0.3} color="#ffffff" />

                            <Suspense fallback={null}>
                                <GeneratedStructure progress={progress} data={elements} />
                                <Environment preset="apartment" />
                                <ContactShadows position={[0, -0.01, 0]} opacity={0.25} scale={25} blur={3} far={12} />
                            </Suspense>
                        </Canvas>

                        {/* Status overlays */}
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

                        {/* Preview thumbnail */}
                        {preview && status !== 'idle' && (
                            <div className="absolute bottom-6 right-6">
                                <div className="w-24 h-24 rounded-xl overflow-hidden border-2 border-primary/30 shadow-2xl">
                                    <img src={preview} alt="Blueprint" className="w-full h-full object-cover" />
                                </div>
                            </div>
                        )}
                    </div>
                </div>

                {/* Left Side Controls */}
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
                                            <div
                                                className="text-center"
                                                onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); }}
                                                onDrop={handleDrop}
                                            >
                                                <div className="h-14 w-14 mx-auto rounded-2xl bg-primary/10 border border-primary/20 flex items-center justify-center mb-3">
                                                    <Upload className="h-7 w-7 text-primary" />
                                                </div>
                                                <h3 className="text-lg font-black mb-1">Upload Blueprint</h3>
                                                <p className="text-xs text-muted-foreground">Drop your floor plan image or PDF</p>
                                            </div>

                                            <Button
                                                onClick={() => document.getElementById('blueprint-upload')?.click()}
                                                className="w-full bg-primary text-primary-foreground font-bold h-11 rounded-xl"
                                            >
                                                Select File
                                            </Button>
                                            <input type="file" id="blueprint-upload" className="hidden" accept=".pdf,.png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp,application/pdf" onChange={handleFileUpload} />

                                            <div className="flex justify-center gap-2 flex-wrap">
                                                <Badge variant="outline" className="bg-muted/50 border-border text-[9px] font-black uppercase">PNG</Badge>
                                                <Badge variant="outline" className="bg-muted/50 border-border text-[9px] font-black uppercase">JPG</Badge>
                                                <Badge variant="outline" className="bg-muted/50 border-border text-[9px] font-black uppercase">PDF</Badge>
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
                                                <p className="text-xs text-muted-foreground">AI will generate a fully colored 3D model</p>
                                            </div>

                                            <textarea
                                                value={description}
                                                onChange={(e) => setDescription(e.target.value)}
                                                placeholder="Example: A 3-bedroom bungalow with a large living room, open kitchen, 2 bathrooms, a balcony facing east, and a covered parking area. Use terracotta roof and cream exterior walls."
                                                className="w-full h-32 px-4 py-3 bg-muted/50 border border-border rounded-xl text-sm resize-none focus:outline-none focus:ring-2 focus:ring-primary/50 placeholder:text-muted-foreground/50"
                                            />

                                            <Button
                                                onClick={startDescriptionGeneration}
                                                className="w-full bg-primary text-primary-foreground font-bold h-11 rounded-xl gap-2"
                                                disabled={!description.trim()}
                                            >
                                                <Sparkles className="h-4 w-4" />
                                                Generate 3D Building
                                            </Button>

                                            <div className="space-y-1">
                                                <p className="text-[9px] font-black uppercase text-muted-foreground tracking-widest">Quick Templates</p>
                                                <div className="flex flex-wrap gap-1.5">
                                                    {[
                                                        "3BHK Bungalow",
                                                        "2BHK Apartment",
                                                        "Villa with Pool",
                                                        "Studio Flat",
                                                        "Farmhouse"
                                                    ].map(t => (
                                                        <button
                                                            key={t}
                                                            onClick={() => setDescription(`A modern ${t.toLowerCase()} with living room, kitchen, bathrooms, and proper ventilation. Use warm colors with cream exterior and terracotta roof.`)}
                                                            className="px-2.5 py-1 rounded-lg bg-muted/80 border border-border text-[10px] font-bold hover:bg-primary/10 hover:border-primary/30 hover:text-primary transition-all"
                                                        >
                                                            {t}
                                                        </button>
                                                    ))}
                                                </div>
                                            </div>
                                        </>
                                    )}
                                </div>
                            </motion.div>
                        )}

                        {/* Analyzing state */}
                        {(status === 'analyzing' || status === 'generating') && (
                            <motion.div
                                initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}
                                className="bg-card/90 backdrop-blur-xl p-6 rounded-2xl border border-border shadow-2xl flex flex-col items-center"
                            >
                                {preview && (
                                    <div className="w-full h-24 rounded-lg overflow-hidden mb-4 border border-border">
                                        <img src={preview} alt="Analyzing" className="w-full h-full object-cover opacity-60" />
                                    </div>
                                )}
                                <div className="relative h-16 w-16 flex items-center justify-center mb-4">
                                    <div className="absolute inset-0 rounded-full border-2 border-primary/20 animate-ping"></div>
                                    <Wand2 className="h-7 w-7 text-primary animate-pulse" />
                                </div>
                                <h4 className="font-black uppercase tracking-widest text-xs mb-1">
                                    {mode === 'describe' ? 'Constructing Building' : 'Analyzing Blueprint'}
                                </h4>
                                <p className="text-[10px] text-muted-foreground mb-3 text-center max-w-[250px] truncate">
                                    {file?.name || (description.length > 50 ? description.substring(0, 50) + '...' : description)}
                                </p>
                                <div className="w-full bg-muted h-1.5 rounded-full overflow-hidden">
                                    <motion.div
                                        className="h-full bg-primary rounded-full"
                                        initial={{ width: 0 }}
                                        animate={{ width: `${progress * 100}%` }}
                                        transition={{ ease: 'easeOut' }}
                                    />
                                </div>
                                <p className="text-[10px] text-muted-foreground mt-2">{Math.round(progress * 100)}% complete</p>
                            </motion.div>
                        )}

                        {/* Complete state */}
                        {status === 'complete' && (
                            <motion.div
                                initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}
                                className="bg-card/90 backdrop-blur-xl p-5 rounded-2xl border border-border shadow-2xl space-y-4"
                            >
                                <div className="flex items-center gap-3">
                                    <div className="h-10 w-10 rounded-lg bg-green-500/20 flex items-center justify-center">
                                        <CheckCircle2 className="h-6 w-6 text-green-500" />
                                    </div>
                                    <div>
                                        <p className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Built Successfully</p>
                                        <p className="text-sm font-bold truncate max-w-[200px]">{elements?.building_name || file?.name || 'Custom Building'}</p>
                                    </div>
                                </div>

                                {/* Room summary */}
                                {elements?.rooms && elements.rooms.length > 0 && (
                                    <div className="space-y-1.5 max-h-32 overflow-y-auto pr-1">
                                        {elements.rooms.map((r, i) => (
                                            <div key={i} className="flex items-center gap-2 text-[11px]">
                                                <div className="h-3 w-3 rounded-sm border border-border" style={{ backgroundColor: r.floor_color || '#e8d5b7' }} />
                                                <span className="font-bold flex-1">{r.name}</span>
                                                <span className="text-muted-foreground">{r.area?.toFixed(0)} sqm</span>
                                            </div>
                                        ))}
                                    </div>
                                )}

                                {/* Conflicts */}
                                {elements?.conflicts && elements.conflicts.length > 0 && (
                                    <div className="space-y-1.5 pt-2 border-t border-border/50">
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
