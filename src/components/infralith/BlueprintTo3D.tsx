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
import { AlertTriangle, ShieldAlert, Cpu } from 'lucide-react';
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
import { processBlueprintTo3D, GeometricReconstruction, WallGeometry, DoorGeometry, WindowGeometry, RoomGeometry, ConstructionConflict } from '@/ai/flows/infralith/blueprint-to-3d-agent';

// -- 3D Models and Animations --

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
                <meshStandardMaterial
                    color={color}
                    emissive={color}
                    emissiveIntensity={2}
                    transparent
                    opacity={0.8}
                />
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
            <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.05, 0]}>
                <ringGeometry args={[0.4, 0.5, 32]} />
                <meshStandardMaterial color={color} transparent opacity={0.5} />
            </mesh>
        </group>
    );
}

function GeneratedStructure({ progress, data }: { progress: number, data: GeometricReconstruction | null }) {
    if (!data) return null;
    const groupRef = useRef<THREE.Group>(null);

    const currentScaleY = progress;

    return (
        <group ref={groupRef} position={[0, 0, 0]}>
            <mesh position={[0, -0.05, 0]} receiveShadow>
                <boxGeometry args={[14, 0.1, 14]} />
                <meshStandardMaterial color="#0f172a" roughness={0.9} />
                <gridHelper args={[14, 28, "#1e293b", "#334155"]} rotation={[0, 0, 0]} position={[0, 0.06, 0]} />
            </mesh>

            {currentScaleY > 0 && (
                <group scale={[1, currentScaleY, 1]} position={[0, 0, 0]}>
                    {/* Room Slabs */}
                    {data.rooms.map((room, i) => {
                        const shape = new THREE.Shape();
                        room.polygon.forEach((p, idx) => {
                            if (idx === 0) shape.moveTo(p[0], p[1]);
                            else shape.lineTo(p[0], p[1]);
                        });
                        shape.closePath();

                        return (
                            <group key={`room-group-${i}`}>
                                <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.02, 0]} receiveShadow>
                                    <shapeGeometry args={[shape]} />
                                    <meshStandardMaterial color="#1e293b" roughness={0.7} metalness={0.1} />
                                </mesh>
                                <Html
                                    position={[room.polygon[0][0], 0.1, room.polygon[0][1]]}
                                    distanceFactor={12}
                                >
                                    <div className="text-[8px] font-black uppercase text-white/20 select-none whitespace-nowrap">
                                        {room.name} {room.area > 0 ? `(${room.area.toFixed(1)} sqm)` : ''}
                                    </div>
                                </Html>
                            </group>
                        );
                    })}

                    {/* Walls Rendering */}
                    {data.walls.map((wall, i) => {
                        const dx = wall.end[0] - wall.start[0];
                        const dz = wall.end[1] - wall.start[1];
                        const length = Math.sqrt(dx * dx + dz * dz);
                        const angle = Math.atan2(dz, dx);
                        const centerX = (wall.start[0] + wall.end[0]) / 2;
                        const centerZ = (wall.start[1] + wall.end[1]) / 2;

                        return (
                            <mesh
                                key={`wall-${i}`}
                                position={[centerX, wall.height / 2, centerZ]}
                                rotation={[0, -angle, 0]}
                                castShadow
                                receiveShadow
                            >
                                <boxGeometry args={[length, wall.height, wall.thickness]} />
                                <meshStandardMaterial
                                    color={wall.thickness > 0.2 ? "#334155" : "#475569"}
                                    roughness={0.8}
                                    metalness={0.05}
                                />
                                <Edges color="#1e293b" threshold={15} />
                            </mesh>
                        );
                    })}

                    {/* Doors Rendering */}
                    {data.doors.map((door, i) => (
                        <group key={`door-${i}`} position={[door.position[0], door.height / 2, door.position[1]]}>
                            <mesh castShadow>
                                <boxGeometry args={[door.width, door.height, 0.1]} />
                                <meshStandardMaterial color="#92400e" roughness={0.5} />
                                <Edges color="#451a03" threshold={15} />
                            </mesh>
                        </group>
                    ))}

                    {/* Windows Rendering */}
                    {data.windows.map((window, i) => {
                        const windowHeight = 1.2;
                        return (
                            <mesh
                                key={`window-${i}`}
                                position={[window.position[0], window.sill_height + windowHeight / 2, window.position[1]]}
                                castShadow
                            >
                                <boxGeometry args={[window.width, windowHeight, 0.05]} />
                                <meshStandardMaterial color="#60a5fa" transparent opacity={0.6} metalness={0.9} roughness={0} />
                                <Edges color="#1e3a8a" threshold={15} />
                            </mesh>
                        );
                    })}
                </group>
            )}

            {progress >= 1 && data.conflicts?.map((conflict, i) => (
                <ConflictMarker key={`conflict-${i}`} conflict={conflict} />
            ))}
        </group>
    );
}

// -- Main Page component --

export default function BlueprintTo3D() {
    const { toast } = useToast();
    const [file, setFile] = useState<File | null>(null);
    const [preview, setPreview] = useState<string | null>(null);
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
            await startGeneration(f);
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
            await startGeneration(f);
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
        setStatus('idle');
        setProgress(0);
        setElements(null);
    }, []);

    const startGeneration = async (f: File) => {
        setFile(f);
        setStatus('analyzing');
        setProgress(0);

        // Generate preview for image files
        if (f.type.startsWith('image/')) {
            const url = URL.createObjectURL(f);
            setPreview(url);
        }

        let current = 0;
        const interval = setInterval(() => {
            current += 0.02;
            if (current <= 0.45) setProgress(current);
        }, 80);

        try {
            const b64 = await fileToBase64(f);
            const spatialElements = await processBlueprintTo3D(b64);

            clearInterval(interval);
            setElements(spatialElements);
            setStatus('generating');

            const extInt = setInterval(() => {
                setProgress(prev => {
                    const next = prev + 0.05;
                    if (next >= 1.0) {
                        clearInterval(extInt);
                        setStatus('complete');
                        toast({
                            title: "3D Model Generated",
                            description: `Identified ${spatialElements.walls.length} walls, ${spatialElements.rooms?.length || 0} rooms, and ${spatialElements.conflicts?.length || 0} issues.`,
                        });
                        return 1.0;
                    }
                    return next;
                });
            }, 50);

        } catch (error) {
            console.error('Blueprint generation error:', error);
            clearInterval(interval);
            setStatus('idle');
            setFile(null);
            setPreview(null);
            toast({
                title: "Conversion Failed",
                description: "Spatial mapping failed. Try a higher resolution blueprint image (PNG or JPG recommended).",
                variant: 'destructive'
            });
        }
    };

    return (
        <div className="h-[calc(100vh-100px)] w-full flex flex-col relative overflow-hidden">
            {/* Minimal Header */}
            <div className="flex items-center justify-between px-6 py-4 z-30 pointer-events-none absolute top-0 w-full">
                <div className="pointer-events-auto">
                    <h1 className="text-xl font-black tracking-tight flex items-center gap-2">
                        <Box className="h-6 w-6 text-primary" />
                        <span className="text-gradient">3D Reconstruction</span>
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
                {/* 3D Viewport - Absolute Fill */}
                <div className="absolute inset-0 z-0">
                    <div className="w-full h-full relative group" style={{ background: 'linear-gradient(180deg, hsl(var(--background)) 0%, hsl(220 20% 92%) 100%)' }}>
                        <Canvas
                            dpr={[1, 2]}
                            camera={{ position: [12, 10, 12], fov: 35 }}
                            gl={{ antialias: true, alpha: true }}
                            style={{ background: 'transparent' }}
                        >
                            <OrbitControls makeDefault enableDamping dampingFactor={0.05} autoRotate={status === 'complete'} autoRotateSpeed={0.3} />
                            <ambientLight intensity={1.2} />
                            <pointLight position={[10, 15, 10]} intensity={1.0} />
                            <directionalLight position={[-8, 20, 8]} intensity={1.5} color="#ffffff" />
                            <directionalLight position={[5, -5, 5]} intensity={0.4} color="#ffffff" />

                            <Suspense fallback={null}>
                                <GeneratedStructure progress={progress} data={elements} />
                                <Environment preset="apartment" />
                                <ContactShadows position={[0, -0.01, 0]} opacity={0.3} scale={20} blur={2.5} far={10} />
                            </Suspense>
                        </Canvas>

                        {/* Viewport UI Overlays */}
                        {status === 'complete' && (
                            <div className="absolute top-20 right-6 flex flex-col gap-2">
                                <Badge className="bg-primary/20 backdrop-blur-md border-primary/30 text-primary font-black uppercase text-[10px] py-1 px-3 tracking-widest shadow-xl">
                                    ENGINE: ACTIVE
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

                        {/* Blueprint Preview Thumbnail */}
                        {preview && status !== 'idle' && (
                            <div className="absolute bottom-6 right-6">
                                <div className="w-24 h-24 rounded-xl overflow-hidden border-2 border-primary/30 shadow-2xl">
                                    <img src={preview} alt="Blueprint" className="w-full h-full object-cover" />
                                </div>
                            </div>
                        )}
                    </div>
                </div>

                {/* Left Side: Dynamic Controls */}
                <div className="relative z-10 w-full md:w-[350px] p-6 h-full pointer-events-none flex flex-col">
                    <div className="mt-auto pointer-events-auto">
                        {status === 'idle' && (
                            <motion.div
                                initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}
                                className="bg-card/80 backdrop-blur-xl p-8 rounded-3xl border border-border shadow-2xl space-y-6"
                                onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); }}
                                onDrop={handleDrop}
                            >
                                <div className="text-center">
                                    <div className="h-16 w-16 mx-auto rounded-2xl bg-primary/10 border border-primary/20 flex items-center justify-center mb-4">
                                        <Upload className="h-8 w-8 text-primary" />
                                    </div>
                                    <h3 className="text-xl font-black mb-1">Upload Blueprint</h3>
                                    <p className="text-xs text-muted-foreground">Drop your floor plan image or PDF</p>
                                </div>

                                <Button
                                    onClick={() => document.getElementById('blueprint-upload')?.click()}
                                    className="w-full bg-primary text-primary-foreground font-bold h-12 rounded-xl"
                                >
                                    Select File
                                </Button>
                                <input type="file" id="blueprint-upload" className="hidden" accept=".pdf,.png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp,application/pdf" onChange={handleFileUpload} />

                                <div className="pt-4 border-t border-border/50 flex justify-center gap-2 flex-wrap">
                                    <Badge variant="outline" className="bg-muted/50 border-border text-[9px] font-black uppercase tracking-tighter">PNG</Badge>
                                    <Badge variant="outline" className="bg-muted/50 border-border text-[9px] font-black uppercase tracking-tighter">JPG</Badge>
                                    <Badge variant="outline" className="bg-muted/50 border-border text-[9px] font-black uppercase tracking-tighter">PDF</Badge>
                                    <Badge variant="outline" className="bg-muted/50 border-border text-[9px] font-black uppercase tracking-tighter">WEBP</Badge>
                                </div>
                            </motion.div>
                        )}

                        {(status === 'analyzing' || status === 'generating') && (
                            <motion.div
                                initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}
                                className="bg-card/80 backdrop-blur-xl p-6 rounded-2xl border border-border shadow-2xl flex flex-col items-center"
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
                                <h4 className="font-black uppercase tracking-widest text-xs mb-1">Analyzing Geometry</h4>
                                <p className="text-[10px] text-muted-foreground mb-3">{file?.name}</p>
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

                        {status === 'complete' && (
                            <motion.div
                                initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}
                                className="bg-card/80 backdrop-blur-xl p-5 rounded-2xl border border-border shadow-2xl space-y-4"
                            >
                                <div className="flex items-center gap-3">
                                    <div className="h-10 w-10 rounded-lg bg-blue-500/20 flex items-center justify-center">
                                        <Cpu className="h-6 w-6 text-blue-500" />
                                    </div>
                                    <div>
                                        <p className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Engineering Audit</p>
                                        <p className="text-sm font-bold truncate max-w-[180px]">{file?.name || 'Blueprint Analysis'}</p>
                                    </div>
                                </div>

                                {elements?.conflicts && elements.conflicts.length > 0 && (
                                    <div className="space-y-2 max-h-40 overflow-y-auto pr-2 custom-scrollbar">
                                        <p className="text-[9px] font-black uppercase text-destructive/80">Structural Conflicts Detected</p>
                                        {elements.conflicts.map((c, i) => (
                                            <div key={i} className="p-2 rounded bg-destructive/10 border border-destructive/20 text-[10px] space-y-1">
                                                <div className="flex justify-between items-center">
                                                    <span className="font-bold uppercase tracking-tighter text-destructive">{c.type}</span>
                                                    <Badge variant="outline" className="text-[8px] h-3 px-1 border-destructive/50 text-destructive">{c.severity}</Badge>
                                                </div>
                                                <p className="text-muted-foreground leading-tight">{c.description}</p>
                                            </div>
                                        ))}
                                    </div>
                                )}

                                <div className="grid grid-cols-2 gap-2 pt-2 border-t border-border/50">
                                    <Button variant="outline" size="sm" className="bg-muted/50 border-border text-[10px] font-black h-8" onClick={() => {
                                        if (!elements) return;
                                        setElements({ ...elements, walls: [...elements.walls, { id: Date.now(), start: [0, 0], end: [2, 2], thickness: 0.23, height: 2.7 }] })
                                    }}>+ Structural</Button>
                                    <Button variant="outline" size="sm" className="bg-muted/50 border-border text-[10px] font-black h-8" onClick={() => {
                                        if (!elements) return;
                                        setElements({ ...elements, doors: [...elements.doors, { id: Date.now(), host_wall_id: 0, position: [1, 1], width: 0.9, height: 2.1 }] })
                                    }}>+ Egress</Button>
                                </div>
                            </motion.div>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}

