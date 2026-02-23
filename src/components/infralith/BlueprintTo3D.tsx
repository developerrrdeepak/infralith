'use client';

import React, { useState, useRef, Suspense } from 'react';
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
import { processBlueprintTo3D, GeometricReconstruction, WallGeometry, DoorGeometry, WindowGeometry, RoomGeometry } from '@/ai/flows/infralith/blueprint-to-3d-agent';

// -- 3D Models and Animations --

function GeneratedStructure({ progress, data }: { progress: number, data: GeometricReconstruction | null }) {
    if (!data) return null;
    const groupRef = useRef<THREE.Group>(null);

    useFrame((state, delta) => {
        if (groupRef.current) {
            groupRef.current.rotation.y += delta * 0.05;
        }
    });

    const currentScaleY = progress;

    return (
        <group ref={groupRef} position={[0, 0, 0]}>
            <mesh position={[0, -0.05, 0]} receiveShadow>
                <boxGeometry args={[14, 0.1, 14]} />
                <meshStandardMaterial color="#0f172a" roughness={0.8} />
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
                            <mesh key={`room-${i}`} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.01, 0]} receiveShadow>
                                <shapeGeometry args={[shape]} />
                                <meshStandardMaterial color="#1e293b" roughness={0.5} metalness={0.2} />
                            </mesh>
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
                                <meshStandardMaterial color="#475569" roughness={0.6} metalness={0.1} />
                                <Edges color="#1e293b" threshold={15} />
                            </mesh>
                        );
                    })}

                    {/* Doors Rendering */}
                    {data.doors.map((door, i) => (
                        <group key={`door-${i}`} position={[door.position[0], door.height / 2, door.position[1]]}>
                            <mesh castShadow>
                                <boxGeometry args={[door.width, door.height, 0.2]} />
                                <meshStandardMaterial color="#fbbf24" roughness={0.3} metalness={0.2} />
                                <Edges color="#78350f" threshold={15} />
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
                                <boxGeometry args={[window.width, windowHeight, 0.15]} />
                                <meshStandardMaterial color="#60a5fa" transparent opacity={0.4} metalness={1} roughness={0} />
                            </mesh>
                        );
                    })}
                </group>
            )}
        </group>
    );
}

// -- Main Page component --

export default function BlueprintTo3D() {
    const { toast } = useToast();
    const [file, setFile] = useState<File | null>(null);
    const [status, setStatus] = useState<'idle' | 'analyzing' | 'generating' | 'complete'>('idle');
    const [progress, setProgress] = useState(0);
    const [elements, setElements] = useState<GeometricReconstruction | null>(null);

    const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
        if (e.target.files && e.target.files[0]) {
            await startGeneration(e.target.files[0]);
        }
    };

    const handleDrop = async (e: React.DragEvent) => {
        e.preventDefault();
        if (e.dataTransfer.files && e.dataTransfer.files[0]) {
            await startGeneration(e.dataTransfer.files[0]);
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

    const startGeneration = async (f: File) => {
        setFile(f);
        setStatus('analyzing');
        setProgress(0);

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
                            description: `Identified ${spatialElements.walls.length} walls and reconstructed the structure.`,
                        });
                        return 1.0;
                    }
                    return next;
                });
            }, 50);

        } catch (error) {
            clearInterval(interval);
            setStatus('idle');
            setFile(null);
            toast({
                title: "Conversion Failed",
                description: "Spatial mapping failed. Try a higher resolution blueprint.",
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
                        <Button variant="outline" size="sm" className="h-9 bg-background/50 backdrop-blur-md border-white/10" onClick={() => { setFile(null); setStatus('idle'); setProgress(0); }}>
                            <RefreshCw className="h-4 w-4 mr-2" /> New
                        </Button>
                        <Button size="sm" className="h-9 bg-primary text-black font-bold shadow-lg shadow-primary/20">
                            <Download className="h-4 w-4 mr-2" /> Export IFC
                        </Button>
                    </div>
                )}
            </div>

            <div className="flex-1 relative flex flex-col md:flex-row bg-slate-950">
                {/* 3D Viewport - Absolute Fill */}
                <div className="absolute inset-0 z-0">
                    <div className="w-full h-full relative group">
                        <Canvas shadows dpr={[1, 2]} camera={{ position: [10, 10, 10], fov: 35 }}>
                            <OrbitControls makeDefault enableDamping dampingFactor={0.05} autoRotate={status === 'complete'} autoRotateSpeed={0.5} />
                            <ambientLight intensity={0.5} />
                            <spotLight position={[15, 20, 15]} angle={0.25} penumbra={1} intensity={2} castShadow />
                            <directionalLight position={[-10, 10, 5]} intensity={1} color="#3b82f6" />

                            <Suspense fallback={null}>
                                <GeneratedStructure progress={progress} data={elements} />
                                <Environment preset="city" />
                                <ContactShadows position={[0, -0.01, 0]} opacity={0.6} scale={20} blur={2.5} far={10} />
                            </Suspense>
                        </Canvas>

                        {/* Viewport UI Overlays */}
                        {status === 'complete' && (
                            <div className="absolute top-20 right-6 flex flex-col gap-2">
                                <Badge className="bg-primary/20 backdrop-blur-md border-primary/30 text-primary font-black uppercase text-[10px] py-1 px-3 tracking-widest shadow-xl">
                                    LIVE ENGINE: ACTIVE
                                </Badge>
                                <Badge className="bg-black/40 backdrop-blur-md border-white/10 text-white/70 font-black uppercase text-[10px] py-1 px-3 tracking-widest shadow-xl">
                                    NODES: {elements?.walls.length}
                                </Badge>
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
                                className="premium-glass p-8 rounded-3xl border-white/5 shadow-2xl space-y-6"
                                onDragOver={(e) => e.preventDefault()}
                                onDrop={handleDrop}
                            >
                                <div className="text-center">
                                    <div className="h-16 w-16 mx-auto rounded-2xl bg-primary/10 border border-primary/20 flex items-center justify-center mb-4">
                                        <Upload className="h-8 w-8 text-primary" />
                                    </div>
                                    <h3 className="text-xl font-black mb-1">Spatial Input</h3>
                                    <p className="text-xs text-muted-foreground">Drop 2D Architectural PDF</p>
                                </div>

                                <Button
                                    onClick={() => document.getElementById('blueprint-upload')?.click()}
                                    className="w-full bg-primary text-black font-bold h-12 rounded-xl"
                                >
                                    Select Document
                                </Button>
                                <input type="file" id="blueprint-upload" className="hidden" accept=".pdf,.png,.jpg" onChange={handleFileUpload} />

                                <div className="pt-4 border-t border-white/10 flex justify-center gap-2">
                                    <Badge variant="outline" className="bg-white/5 border-white/5 text-[9px] font-black uppercase tracking-tighter">AutoCAD</Badge>
                                    <Badge variant="outline" className="bg-white/5 border-white/5 text-[9px] font-black uppercase tracking-tighter">PDF Vector</Badge>
                                </div>
                            </motion.div>
                        )}

                        {(status === 'analyzing' || status === 'generating') && (
                            <motion.div
                                initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}
                                className="premium-glass p-6 rounded-2xl border-white/5 shadow-2xl flex flex-col items-center"
                            >
                                <div className="relative h-20 w-20 flex items-center justify-center mb-4">
                                    <div className="absolute inset-0 rounded-full border-2 border-primary/20 animate-ping"></div>
                                    <Wand2 className="h-8 w-8 text-primary animate-pulse" />
                                </div>
                                <h4 className="font-black uppercase tracking-widest text-xs mb-2">Analyzing Geometry</h4>
                                <div className="w-full bg-white/5 h-1 rounded-full overflow-hidden">
                                    <motion.div
                                        className="h-full bg-primary"
                                        initial={{ width: 0 }}
                                        animate={{ width: `${progress * 100}%` }}
                                    />
                                </div>
                            </motion.div>
                        )}

                        {status === 'complete' && (
                            <motion.div
                                initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}
                                className="premium-glass p-5 rounded-2xl border-white/5 shadow-2xl space-y-4"
                            >
                                <div className="flex items-center gap-3">
                                    <div className="h-10 w-10 rounded-lg bg-green-500/20 flex items-center justify-center">
                                        <CheckCircle2 className="h-6 w-6 text-green-500" />
                                    </div>
                                    <div>
                                        <p className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Reconstruction</p>
                                        <p className="text-sm font-bold truncate max-w-[180px]">{file?.name || 'Building Alpha'}</p>
                                    </div>
                                </div>
                                <div className="grid grid-cols-2 gap-2">
                                    <Button variant="outline" size="sm" className="bg-white/5 border-white/5 text-[10px] font-black h-8" onClick={() => setElements({ ...elements!, walls: [...elements!.walls, { start: [0, 0], end: [2, 2], thickness: 0.23, height: 2.7 }] })}>+ Wall</Button>
                                    <Button variant="outline" size="sm" className="bg-white/5 border-white/5 text-[10px] font-black h-8" onClick={() => setElements({ ...elements!, doors: [...elements!.doors, { host_wall_id: 0, position: [1, 1], width: 0.9, height: 2.1 }] })}>+ Door</Button>
                                </div>
                            </motion.div>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}

