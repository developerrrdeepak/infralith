
'use client';

import { useState, useRef, Suspense, useMemo } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import {
    OrbitControls,
    PerspectiveCamera,
    Html,
    Float,
    ContactShadows,
    Environment,
    Grid,
    Edges
} from '@react-three/drei';
import * as THREE from 'three';
import { motion, AnimatePresence } from 'framer-motion';
import {
    MessageSquare,
    X,
    Maximize2,
    AlertTriangle,
    Send,
    Activity,
    Box,
    Layers,
    Share2
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { useAppContext } from '@/contexts/app-context';

// --- 3D Components ---

function PinPoint({ position, label, type, active, onClick }: any) {
    const [hovered, setHovered] = useState(false);

    return (
        <group position={position}>
            <Float speed={2} rotationIntensity={0.5} floatIntensity={0.5}>
                <mesh
                    onClick={(e) => { e.stopPropagation(); onClick(); }}
                    onPointerOver={() => {
                        setHovered(true);
                        document.body.style.cursor = 'pointer';
                    }}
                    onPointerOut={() => {
                        setHovered(false);
                        document.body.style.cursor = 'auto';
                    }}
                >
                    <sphereGeometry args={[0.15, 32, 32]} />
                    <meshStandardMaterial
                        color={type === 'critical' ? '#ef4444' : type === 'warning' ? '#f59e0b' : '#3b82f6'}
                        emissive={type === 'critical' ? '#ef4444' : type === 'warning' ? '#f59e0b' : '#3b82f6'}
                        emissiveIntensity={hovered || active ? 2 : 0.5}
                    />
                </mesh>
            </Float>

            {(hovered || active) && (
                <Html distanceFactor={10} position={[0, 0.4, 0]} center>
                    <div className={cn(
                        "px-3 py-1.5 rounded-lg border backdrop-blur-md shadow-2xl transition-all duration-300 whitespace-nowrap flex items-center gap-2",
                        active ? "bg-primary/20 border-primary scale-110" : "bg-white/80 dark:bg-black/60 border-slate-200 dark:border-white/10"
                    )}>
                        {type === 'critical' ? <AlertTriangle className="h-3 w-3 text-red-500" /> : <MessageSquare className="h-3 w-3 text-blue-500" />}
                        <span className="text-[10px] font-bold uppercase tracking-wider text-slate-900 dark:text-white">{label}</span>
                    </div>
                </Html>
            )}
        </group>
    );
}

function BuildingStructure({ blueprint, risk }: { blueprint?: any, risk?: any }) {
    const meshRef = useRef<THREE.Group>(null);

    // Parametric calculations based on live blueprint data
    const floors = Math.max(1, Math.min(blueprint?.totalFloors || 5, 20));
    const totalHeightUnits = (blueprint?.height || floors * 4) / 5;
    const floorHeight = totalHeightUnits / floors;
    const footprintSide = Math.max(4, Math.min(Math.sqrt((blueprint?.totalArea || 5000) / floors) / 5, 8));

    const isHighRisk = risk?.level === 'High' || risk?.riskIndex > 70;
    const coreColor = isHighRisk ? "#ef4444" : "#3b82f6";

    // Ambient floating animation
    useFrame((state) => {
        if (meshRef.current) {
            meshRef.current.position.y = Math.sin(state.clock.elapsedTime * 0.5) * 0.1;
        }
    });

    return (
        <group ref={meshRef}>
            {/* Dynamic Foundation */}
            <mesh position={[0, -1, 0]}>
                <boxGeometry args={[footprintSide + 2, 0.5, footprintSide + 2]} />
                <meshStandardMaterial color="#0f172a" metalness={0.9} roughness={0.1} transparent opacity={0.6} />
                <Edges color="#1e293b" />
            </mesh>

            {/* Glowing Structural Core */}
            <mesh position={[0, (totalHeightUnits / 2) - 0.75, 0]}>
                <boxGeometry args={[footprintSide * 0.3, totalHeightUnits, footprintSide * 0.3]} />
                <meshStandardMaterial color={coreColor} emissive={coreColor} emissiveIntensity={0.5} metalness={0.8} roughness={0.2} transparent opacity={0.8} />
            </mesh>

            {/* Parametric Floor Slabs with Glass Facade */}
            {Array.from({ length: floors }).map((_, i) => (
                <group key={i} position={[0, i * floorHeight - 0.5, 0]}>
                    {/* Concrete Slab */}
                    <mesh position={[0, -floorHeight / 2 + 0.05, 0]}>
                        <boxGeometry args={[footprintSide, 0.1, footprintSide]} />
                        <meshStandardMaterial color="#475569" metalness={0.6} roughness={0.4} />
                    </mesh>

                    {/* Glass Facade Overlay */}
                    <mesh position={[0, 0, 0]}>
                        <boxGeometry args={[footprintSide + 0.1, floorHeight - 0.1, footprintSide + 0.1]} />
                        <meshStandardMaterial color="#93c5fd" metalness={0.9} roughness={0.0} transparent opacity={0.15} />
                        <Edges color="#ffffff" threshold={15} />
                    </mesh>
                </group>
            ))}

            {/* Outer Holographic Bounding Box */}
            <mesh position={[0, (totalHeightUnits / 2) - 0.75, 0]}>
                <boxGeometry args={[footprintSide + 0.5, totalHeightUnits + 0.5, footprintSide + 0.5]} />
                <meshStandardMaterial color="#3b82f6" wireframe transparent opacity={0.05} />
            </mesh>
        </group>
    );
}

// --- Main Page Component ---

export default function VirtualWarRoom() {
    const { infralithResult, user } = useAppContext();
    const [activePin, setActivePin] = useState<string | number | null>(null);
    const [isSidebarOpen, setIsSidebarOpen] = useState(true);

    const pins = useMemo(() => {
        if (!infralithResult) {
            return [
                { id: 'm1', pos: [2.5, 2.2, 2.5], label: "Awaiting Data", type: "info", author: "System", time: "Now", desc: "No active 3D session detected. Please upload a project in the Dashboard." },
            ];
        }

        const dynamicPins: any[] = [];

        // Map violations to pins as Digital Twin Alerts
        if (infralithResult.complianceReport?.violations) {
            infralithResult.complianceReport.violations.forEach((v: any, i: number) => {
                dynamicPins.push({
                    id: `v-${i}`,
                    pos: [(Math.random() - 0.5) * 5, (Math.random() * (infralithResult.parsedBlueprint?.totalFloors || 3)) * 1.5, (Math.random() - 0.5) * 5],
                    label: "ALERT: " + (v.ruleId || "Compliance"),
                    type: infralithResult.complianceReport.overallStatus === 'Fail' ? 'critical' : 'warning',
                    author: "System Auditor",
                    time: "Live Sync",
                    desc: v.description + " — " + v.comment
                });
            });
        }

        // Map hazards to pins as Telemetry Anomalies
        if (infralithResult.riskReport?.hazards) {
            infralithResult.riskReport.hazards.slice(0, 3).forEach((h: any, i: number) => {
                dynamicPins.push({
                    id: `h-${i}`,
                    pos: [(Math.random() - 0.5) * 4, 0.5, (Math.random() - 0.5) * 4],
                    label: "SENSOR ALERT: " + h.type,
                    type: h.severity === 'High' ? 'critical' : 'warning',
                    author: "Risk System",
                    time: "Real-time",
                    desc: h.description + " | Strategic Mitigation: " + h.mitigation
                });
            });
        }

        return dynamicPins.length > 0 ? dynamicPins : [
            { id: 'm1', pos: [0, 4, 0], label: "Model Sync: OK", type: "info", author: "AI Monitor", time: "Live", desc: "Building structure is within normal limits." }
        ];
    }, [infralithResult]);

    return (
        <div className="relative h-[calc(100vh-120px)] w-full rounded-[2.5rem] overflow-hidden border border-slate-200 dark:border-white/5 bg-slate-50 dark:bg-slate-950 flex transition-colors duration-500 shadow-2xl">

            {/* 3D Viewport */}
            <div className="flex-1 relative cursor-move">
                <div className="absolute top-10 left-10 z-10 space-y-4 pointer-events-none">
                    <div className="flex flex-col gap-1">
                        <h2 className="text-4xl font-black tracking-tighter text-slate-900 dark:text-white flex items-center gap-3">
                            <Box className="h-8 w-8 text-primary" />
                            3D Project <span className="text-primary italic">War Room</span>
                        </h2>
                        <p className="text-[10px] font-black uppercase tracking-[0.3em] text-slate-400 dark:text-white/30">Real-time Structure Visualization</p>
                    </div>

                    <div className="flex items-center gap-3">
                        <Badge className="bg-primary/20 text-primary border-primary/30 font-black px-3 py-1 animate-pulse uppercase text-[10px] tracking-widest">
                            <Activity className="h-3 w-3 mr-2" /> Sensors: Linked
                        </Badge>
                        <Badge variant="outline" className="bg-white/40 dark:bg-black/40 text-slate-500 dark:text-muted-foreground border-slate-200 dark:border-white/10 font-black tracking-widest uppercase text-[9px] px-3 py-1">
                            REGION: SOUTH ASIA / MUMBAI-HUB
                        </Badge>
                    </div>
                </div>

                <div className="absolute top-6 right-6 z-10 flex gap-2">
                    <Button size="icon" variant="outline" className="bg-white/40 dark:bg-black/40 border-slate-200 dark:border-white/10 hover:bg-slate-100 dark:hover:bg-white/10 backdrop-blur-md">
                        <Share2 className="h-4 w-4 text-slate-600 dark:text-slate-300" />
                    </Button>
                    <Button size="icon" variant="outline" className="bg-white/40 dark:bg-black/40 border-slate-200 dark:border-white/10 hover:bg-slate-100 dark:hover:bg-white/10 backdrop-blur-md">
                        <Layers className="h-4 w-4 text-slate-600 dark:text-slate-300" />
                    </Button>
                    <Button size="icon" variant="outline" className="bg-white/40 dark:bg-black/40 border-slate-200 dark:border-white/10 hover:bg-slate-100 dark:hover:bg-white/10 backdrop-blur-md" onClick={() => setIsSidebarOpen(!isSidebarOpen)}>
                        <Maximize2 className="h-4 w-4 text-slate-600 dark:text-slate-300" />
                    </Button>
                </div>

                <Canvas shadows dpr={[1, 2]}>
                    <PerspectiveCamera makeDefault position={[10, 8, 10]} fov={40} />
                    <OrbitControls makeDefault enableDamping dampingFactor={0.05} minDistance={5} maxDistance={20} />

                    <ambientLight intensity={0.5} />
                    <spotLight position={[10, 10, 10]} angle={0.15} penumbra={1} intensity={1} castShadow />
                    <pointLight position={[-10, -10, -10]} intensity={0.5} />

                    <Suspense fallback={null}>
                        <group position={[0, -1, 0]}>
                            <BuildingStructure
                                blueprint={infralithResult?.parsedBlueprint}
                                risk={infralithResult?.riskReport}
                            />
                            {pins.map((pin) => (
                                <PinPoint
                                    key={pin.id}
                                    position={pin.pos}
                                    label={pin.label}
                                    type={pin.type}
                                    active={activePin === pin.id}
                                    onClick={() => {
                                        setActivePin(pin.id);
                                        setIsSidebarOpen(true);
                                    }}
                                />
                            ))}
                        </group>

                        <Grid
                            infiniteGrid
                            fadeDistance={30}
                            fadeStrength={5}
                            cellSize={1}
                            sectionSize={4}
                            sectionColor="#3b82f6"
                            cellColor="#cbd5e1"
                            position={[0, -2.5, 0]}
                        />

                        <Environment preset="city" />
                        <ContactShadows position={[0, -2.5, 0]} opacity={0.4} scale={20} blur={2.4} far={4.5} />
                    </Suspense>
                </Canvas>

                <div className="absolute bottom-6 left-6 z-10 flex items-center gap-4 bg-white/60 dark:bg-black/60 backdrop-blur-xl border border-slate-200 dark:border-white/10 p-4 rounded-2xl pointer-events-auto shadow-2xl">
                    <div className="flex -space-x-3">
                        <div className="h-10 w-10 rounded-full bg-slate-100 dark:bg-slate-800 border-2 border-white dark:border-slate-950 flex items-center justify-center text-xs font-bold text-slate-600 dark:text-white shadow-lg uppercase">
                            {user?.name?.substring(0, 2) || 'EN'}
                        </div>
                        <div className="h-10 w-10 rounded-full bg-primary/20 border-2 border-white dark:border-slate-950 flex items-center justify-center text-[10px] font-bold text-primary shadow-lg backdrop-blur-md">
                            AI
                        </div>
                    </div>
                    <div className="h-8 w-px bg-slate-200 dark:bg-white/10" />
                    <p className="text-xs font-bold text-slate-500 dark:text-white/50">Only you and AI are viewing this project</p>
                </div>
            </div>

            {/* Control Sidebar */}
            <AnimatePresence>
                {isSidebarOpen && (
                    <motion.div
                        initial={{ x: '100%' }}
                        animate={{ x: 0 }}
                        exit={{ x: '100%' }}
                        className="w-[400px] h-full bg-white/80 dark:bg-slate-900/50 backdrop-blur-3xl border-l border-slate-200 dark:border-white/10 flex flex-col shadow-[-20px_0_50px_rgba(0,0,0,0.1)] dark:shadow-[-20px_0_50px_rgba(0,0,0,0.5)] z-20"
                    >
                        <div className="p-6 border-b border-slate-100 dark:border-white/5 flex justify-between items-center">
                            <h3 className="font-black uppercase tracking-[0.2em] text-primary text-[10px]">Alert Notifications</h3>
                            <Button variant="ghost" size="icon" onClick={() => setIsSidebarOpen(false)} className="hover:bg-slate-100 dark:hover:bg-white/10 h-8 w-8 text-slate-600 dark:text-slate-400">
                                <X className="h-4 w-4" />
                            </Button>
                        </div>

                        <div className="flex-1 overflow-y-auto p-8 space-y-8 custom-scrollbar">
                            {activePin ? (
                                (() => {
                                    const pin = pins.find(p => p.id === activePin);
                                    return (
                                        <motion.div
                                            key={activePin}
                                            initial={{ opacity: 0, y: 10 }}
                                            animate={{ opacity: 1, y: 0 }}
                                            className="space-y-6"
                                        >
                                            <div className="space-y-4">
                                                <div className="flex justify-between items-start">
                                                    <Badge className={cn(
                                                        "font-black uppercase tracking-widest text-[10px] px-3 py-1",
                                                        pin?.type === 'critical' ? 'bg-red-500/10 text-red-500 border-red-500/20' :
                                                            pin?.type === 'warning' ? 'bg-amber-500/10 text-amber-500 border-amber-500/20' :
                                                                'bg-blue-500/10 text-blue-500 border-blue-500/20'
                                                    )}>
                                                        {pin?.type} alert
                                                    </Badge>
                                                    <Badge variant="outline" className="font-mono text-[9px] border-white/5 opacity-50">NODE_ID: {pin?.id}</Badge>
                                                </div>
                                                <h1 className="text-3xl font-black tracking-tighter leading-none text-slate-900 dark:text-white uppercase">{pin?.label}</h1>
                                                <div className="flex items-center gap-2 text-[10px] font-bold text-slate-400">
                                                    <Activity className="h-3 w-3 text-primary" />
                                                    <span className="text-slate-700 dark:text-white/70 uppercase tracking-widest">{pin?.author}</span>
                                                    <span>/</span>
                                                    <span>{pin?.time}</span>
                                                </div>
                                            </div>

                                            <Card className="bg-slate-950/50 border-white/5 shadow-2xl overflow-hidden relative">
                                                <div className="absolute top-0 left-0 w-1 h-full bg-primary/40" />
                                                <CardContent className="p-5 space-y-4 text-sm leading-relaxed text-slate-400 font-medium italic">
                                                    {pin?.desc}
                                                </CardContent>
                                            </Card>

                                            <div className="space-y-5">
                                                <h4 className="text-[10px] font-black uppercase tracking-[0.2em] text-muted-foreground">Discussion Thread</h4>
                                                <div className="space-y-4">
                                                    <div className="flex gap-4">
                                                        <div className="h-8 w-8 rounded-lg bg-blue-500/10 flex items-center justify-center text-[10px] font-black text-blue-500 border border-blue-500/20 shadow-lg shadow-blue-500/5">MT</div>
                                                        <div className="flex-1 bg-white/5 border border-white/10 rounded-2xl rounded-tl-none p-4 text-[11px] text-slate-400 font-bold leading-relaxed shadow-sm">
                                                            Sync confirmed. The 3D model aligns with the latest blueprint.
                                                        </div>
                                                    </div>
                                                    <div className="flex gap-4">
                                                        <div className="h-8 w-8 rounded-lg bg-primary/10 flex items-center justify-center text-[10px] font-black text-primary border border-primary/20 shadow-lg shadow-primary/5">AI</div>
                                                        <div className="flex-1 bg-primary/5 border border-primary/20 rounded-2xl rounded-tl-none p-4 text-[11px] font-black text-white leading-relaxed shadow-[0_0_20px_rgba(var(--primary),0.05)]">
                                                            ACTION: Adjusting structural details based on real-time wind data.
                                                        </div>
                                                    </div>
                                                </div>
                                            </div>
                                        </motion.div>
                                    );
                                })()
                            ) : (
                                <div className="h-full flex flex-col items-center justify-center text-center opacity-30 pb-20">
                                    <Activity className="h-16 w-16 mb-6 text-primary animate-pulse" />
                                    <p className="text-xs font-black uppercase tracking-widest leading-loose">Select an Alert Pin...<br /><span className="text-[10px] opacity-50 font-medium">Click on a highlighted node in the 3D view</span></p>
                                </div>
                            )}
                        </div>

                        <div className="p-8 bg-slate-950/50 border-t border-white/5 mt-auto">
                            <div className="relative">
                                <textarea
                                    placeholder="Post a technical response..."
                                    className="w-full bg-white/5 border border-white/10 rounded-[1.5rem] p-5 text-xs font-bold text-white placeholder-slate-600 focus:outline-none focus:ring-1 focus:ring-primary h-28 resize-none transition-all shadow-inner"
                                />
                                <Button size="sm" className="absolute bottom-4 right-4 rounded-xl bg-primary hover:bg-primary/90 text-slate-900 font-black px-6">
                                    <Send className="h-3 w-3 mr-2" /> SEND
                                </Button>
                            </div>
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    );
}
