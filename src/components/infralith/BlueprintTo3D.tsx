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

        // Let the UI breathe, simulate spatial mapping progress
        let current = 0;
        const interval = setInterval(() => {
            current += 0.02;
            if (current <= 0.45) {
                setProgress(current);
            }
        }, 80);

        try {
            const b64 = await fileToBase64(f);
            const spatialElements = await processBlueprintTo3D(b64);

            clearInterval(interval);
            setElements(spatialElements);
            setStatus('generating');

            // Topological extrusion animation
            const extInt = setInterval(() => {
                setProgress(prev => {
                    const next = prev + 0.05;
                    if (next >= 1.0) {
                        clearInterval(extInt);
                        setStatus('complete');
                        toast({
                            title: "3D Model Generated",
                            description: `Successfully identified ${spatialElements.walls.length} walls and generated a 3D model.`,
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
                description: "Could not resolve coordinates. Ensure the blueprint is a supported high-res format.",
                variant: 'destructive'
            });
        }
    };

    return (
        <div className="h-[calc(100vh-120px)] w-full flex flex-col relative gap-6">

            <div className="flex justify-between items-center premium-glass p-8 rounded-[2rem] border-white/5 shadow-2xl">
                <div>
                    <h1 className="text-4xl font-black tracking-tight text-slate-900 dark:text-white flex items-center gap-4">
                        <Box className="h-10 w-10 text-primary" />
                        <span className="text-gradient">3D Blueprint</span> Generator
                    </h1>
                    <p className="text-slate-500 dark:text-muted-foreground mt-2 font-medium flex items-center gap-2">
                        <Badge variant="secondary" className="bg-primary/10 text-primary border-none text-[10px] font-black uppercase tracking-widest">Conversion Engine</Badge>
                        Turn your 2D floor plans into interactive 3D models.
                    </p>
                </div>
                {status === 'complete' && (
                    <div className="flex gap-4">
                        <Button variant="outline" className="border-white/10 text-muted-foreground hover:bg-white/5 rounded-xl h-12" onClick={() => { setFile(null); setStatus('idle'); setProgress(0); }}>
                            <RefreshCw className="h-4 w-4 mr-2" /> New Twin
                        </Button>
                        <Button className="bg-primary text-slate-900 hover:bg-primary/90 font-black px-8 h-12 rounded-xl shadow-lg shadow-primary/20">
                            <Download className="h-4 w-4 mr-2" /> Export BIM/IFC
                        </Button>
                    </div>
                )}
            </div>

            <div className="flex-1 overflow-hidden relative rounded-[2rem] border border-slate-200 dark:border-white/5 bg-slate-50 dark:bg-slate-950 flex flex-col md:flex-row shadow-2xl">

                {/* Loader Overlay */}
                <AnimatePresence>
                    {(status === 'analyzing' || status === 'generating') && (
                        <motion.div
                            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                            className="absolute inset-0 z-20 flex flex-col items-center justify-center bg-white/90 dark:bg-slate-950/90 backdrop-blur-2xl"
                        >
                            <div className="h-40 w-40 relative flex items-center justify-center mb-10">
                                <div className="absolute inset-0 rounded-full border-2 border-primary/20 animate-ping"></div>
                                <div className="absolute inset-2 rounded-full border border-primary/40"></div>
                                <svg className="absolute inset-0 h-full w-full -rotate-90">
                                    <circle
                                        cx="80" cy="80" r="76" fill="transparent"
                                        stroke="currentColor" strokeWidth="2"
                                        strokeDasharray={2 * Math.PI * 76}
                                        strokeDashoffset={2 * Math.PI * 76 * (1 - (progress || 0))}
                                        className="text-primary transition-all duration-300 ease-out"
                                    />
                                </svg>
                                <Wand2 className="h-12 w-12 text-primary animate-pulse" />
                            </div>

                            <h3 className="text-3xl font-black tracking-tighter text-slate-900 dark:text-white mb-3">
                                {status === 'analyzing' ? 'Analyzing Blueprint...' : 'Extruding 3D Model...'}
                            </h3>
                            <div className="flex gap-3">
                                <Badge variant="outline" className="text-[10px] font-mono border-white/10 text-muted-foreground">SCANNING</Badge>
                                <Badge variant="outline" className="text-[10px] font-mono border-white/10 text-muted-foreground">GENERATING</Badge>
                            </div>
                        </motion.div>
                    )}
                </AnimatePresence>

                {/* Left Side: Upload or Details */}
                <div className="w-full md:w-1/3 border-r border-slate-200 dark:border-white/5 bg-white/50 dark:bg-slate-900/50 backdrop-blur-3xl p-8 flex flex-col z-10">
                    {status === 'idle' ? (
                        <div
                            className="flex-1 border-2 border-dashed border-slate-200 dark:border-white/5 rounded-3xl flex flex-col items-center justify-center text-center p-10 hover:border-primary/50 hover:bg-primary/5 transition-all cursor-pointer group relative overflow-hidden"
                            onDragOver={(e) => e.preventDefault()}
                            onDrop={handleDrop}
                            onClick={() => document.getElementById('blueprint-upload')?.click()}
                        >
                            <div className="absolute inset-0 bg-gradient-to-br from-primary/10 dark:from-primary/5 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
                            <input type="file" id="blueprint-upload" className="hidden" accept=".pdf,.png,.jpg,.jpeg,.dwg" onChange={handleFileUpload} />
                            <div className="h-24 w-24 rounded-3xl bg-slate-100 dark:bg-white/5 border border-slate-200 dark:border-white/10 flex items-center justify-center mb-8 group-hover:scale-110 group-hover:border-primary/50 transition-all shadow-2xl relative z-10">
                                <Upload className="h-10 w-10 text-primary" />
                            </div>
                            <h3 className="text-2xl font-black mb-3 relative z-10 text-slate-900 dark:text-white">Upload 2D Plan</h3>
                            <p className="text-sm text-muted-foreground mb-8 max-w-[200px] mx-auto relative z-10">Drag & drop AutoCAD, PDF, or scanned blueprints.</p>

                            <Button
                                onClick={(e) => {
                                    e.stopPropagation();
                                    document.getElementById('blueprint-upload')?.click();
                                }}
                                className="relative z-10 mb-8 bg-primary text-slate-900 font-bold px-6"
                            >
                                Select Blueprint File
                            </Button>

                            <div className="flex gap-2 justify-center flex-wrap relative z-10">
                                <Badge variant="outline" className="bg-slate-200 dark:bg-black/40 border-slate-300 dark:border-white/5 text-[10px] font-bold py-1 px-3 text-slate-700 dark:text-white">AUTOCAD DWG</Badge>
                                <Badge variant="outline" className="bg-slate-200 dark:bg-black/40 border-slate-300 dark:border-white/5 text-[10px] font-bold py-1 px-3 text-slate-700 dark:text-white">PDF VECTOR</Badge>
                            </div>

                            <div className="mt-10 pt-10 border-t border-slate-200 dark:border-white/10 w-full">
                                <p className="text-[10px] font-black uppercase tracking-widest text-muted-foreground text-center mb-4">Or Start Fresh</p>
                                <Button
                                    onClick={() => {
                                        setElements(null);
                                        setStatus('complete');
                                        setProgress(1.0);
                                    }}

                                    className="w-full bg-white dark:bg-white/5 hover:bg-primary/10 border border-slate-200 dark:border-white/10 text-slate-900 dark:text-white font-bold h-12 rounded-xl transition-all"
                                >
                                    <Plus className="h-4 w-4 mr-2 text-primary" /> Create from Scratch
                                </Button>
                            </div>
                        </div>
                    ) : (
                        <div className="flex-1 flex flex-col gap-8 relative">
                            {/* ... previous content ... */}
                            <div className="space-y-4">
                                <h4 className="text-[10px] font-black uppercase tracking-[0.2em] text-primary/80 dark:text-primary/60">Manual Blueprint Additions</h4>
                                <div className="grid grid-cols-2 gap-2">
                                    <Button size="sm" variant="outline" className="text-[10px] font-bold" onClick={() => {
                                        if (!elements) return;
                                        setElements({ ...elements, walls: [...elements.walls, { start: [0, 0], end: [2, 2], thickness: 0.23, height: 2.7 }] })
                                    }}>+ Wall</Button>
                                    <Button size="sm" variant="outline" className="text-[10px] font-bold" onClick={() => {
                                        if (!elements) return;
                                        setElements({ ...elements, doors: [...elements.doors, { host_wall_id: 0, position: [1, 1], width: 0.9, height: 2.1 }] })
                                    }}>+ Door</Button>
                                </div>

                            </div>
                            <div className="flex items-center gap-5 p-5 rounded-2xl bg-white dark:bg-white/5 border border-slate-200 dark:border-white/10 shadow-xl">
                                <div className="h-14 w-14 rounded-xl bg-primary/10 flex items-center justify-center border border-primary/20">
                                    <FileText className="h-7 w-7 text-primary" />
                                </div>
                                <div className="overflow-hidden">
                                    <p className="text-base font-bold truncate text-slate-900 dark:text-white">{file?.name || 'blueprint.pdf'}</p>
                                    <p className="text-[10px] text-muted-foreground font-black uppercase tracking-widest mt-1">Spatially Indexing Source</p>
                                </div>
                            </div>

                            <div className="space-y-6">
                                <h4 className="text-[10px] font-black uppercase tracking-[0.2em] text-primary/80 dark:text-primary/60">Generation Pipeline</h4>
                                <div className="space-y-6 relative">
                                    <div className="absolute left-[7px] top-2 bottom-2 w-[1px] bg-slate-300 dark:bg-white/5" />

                                    <div className="relative pl-8">
                                        <div className="absolute left-0 top-1 h-3.5 w-3.5 rounded-full bg-primary ring-4 ring-primary/20 shadow-[0_0_15px_rgba(var(--primary),0.5)]"></div>
                                        <p className="font-black text-sm text-slate-900 dark:text-white">Extracting Structures</p>
                                        <p className="text-xs text-muted-foreground mt-1 leading-relaxed">Identifying walls and boundaries from the image.</p>
                                    </div>

                                    <div className="relative pl-8">
                                        <div className={cn("absolute left-0 top-1 h-3.5 w-3.5 rounded-full transition-all duration-500", progress > 0.5 ? "bg-primary ring-4 ring-primary/20 shadow-[0_0_15px_rgba(var(--primary),0.5)]" : "bg-slate-300 dark:bg-white/10 ring-4 ring-slate-200 dark:ring-white/5")}></div>
                                        <p className={cn("font-black text-sm transition-colors", progress > 0.5 ? "text-slate-900 dark:text-white" : "text-slate-400 dark:text-white/30")}>Generating 3D Models</p>
                                        <p className="text-xs text-muted-foreground mt-1 leading-relaxed">Mapping 2D lines to 3D meshes.</p>
                                    </div>

                                    <div className="relative pl-8">
                                        <div className={cn("absolute left-0 top-1 h-3.5 w-3.5 rounded-full transition-all duration-500", progress >= 1 ? "bg-primary ring-4 ring-primary/20 shadow-[0_0_15px_rgba(var(--primary),0.5)]" : "bg-slate-300 dark:bg-white/10 ring-4 ring-slate-200 dark:ring-white/5")}></div>
                                        <p className={cn("font-black text-sm transition-colors", progress >= 1 ? "text-slate-900 dark:text-white" : "text-slate-400 dark:text-white/30")}>Finalizing Scene</p>
                                        <p className="text-xs text-muted-foreground mt-1 leading-relaxed">The 3D model is ready for viewing.</p>
                                    </div>
                                </div>
                            </div>

                            {status === 'complete' && (
                                <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="mt-auto">
                                    <Card className="bg-primary/10 border-primary/20 shadow-2xl border-dashed rounded-2xl">
                                        <CardContent className="p-5 flex items-start gap-4">
                                            <CheckCircle2 className="h-6 w-6 text-primary shrink-0 mt-1" />
                                            <div>
                                                <p className="font-black text-sm text-primary uppercase tracking-tight">Generation Complete</p>
                                                <p className="text-xs text-white/50 mt-1 leading-relaxed">The 3D model is fully loaded and can be exported below.</p>
                                            </div>
                                        </CardContent>
                                    </Card>
                                </motion.div>
                            )}
                        </div>
                    )}
                </div>

                {/* Right Side: 3D Viewport */}
                <div className="flex-1 relative">
                    {status === 'idle' ? (
                        <div className="absolute inset-0 flex flex-col items-center justify-center opacity-30 pointer-events-none">
                            <Layers className="h-48 w-48 text-slate-400 dark:text-white mb-8" />
                            <p className="font-black text-4xl tracking-tighter uppercase text-slate-400 dark:text-white">Awaiting Spatial Input</p>
                        </div>
                    ) : (
                        <div className="w-full h-full relative group">
                            <Canvas shadows dpr={[1, 2]}>
                                <PerspectiveCamera makeDefault position={[12, 10, 12]} fov={35} />
                                <OrbitControls makeDefault enableDamping dampingFactor={0.05} autoRotate={status === 'complete'} autoRotateSpeed={0.5} />

                                <ambientLight intensity={0.4} />
                                <spotLight position={[15, 20, 15]} angle={0.25} penumbra={1} intensity={1.5} castShadow />
                                <pointLight position={[-10, 10, -10]} intensity={0.5} />

                                <Suspense fallback={null}>
                                    <GeneratedStructure progress={progress} data={elements} />


                                    <Environment preset="night" />
                                    <ContactShadows position={[0, -0.1, 0]} opacity={0.8} scale={20} blur={3} far={10} />
                                </Suspense>
                            </Canvas>

                            <AnimatePresence>
                                {status === 'complete' && (
                                    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="absolute top-8 right-8 flex flex-col gap-3">
                                        <Badge className="bg-white/80 dark:bg-slate-900/80 backdrop-blur-3xl border-primary/30 text-primary font-black uppercase text-[10px] py-1.5 px-4 tracking-widest shadow-2xl">
                                            3D PREVIEW: ACTIVE
                                        </Badge>
                                        <Badge className="bg-white/80 dark:bg-slate-900/80 backdrop-blur-3xl border-slate-300 dark:border-white/10 text-slate-600 dark:text-white/50 font-black uppercase text-[10px] py-1.5 px-4 tracking-widest shadow-2xl">
                                            SCENE NODES: {elements?.walls.length}
                                        </Badge>

                                    </motion.div>
                                )}
                            </AnimatePresence>
                        </div>
                    )}
                </div>

            </div>
        </div>
    );
}
