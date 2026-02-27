'use client';

import React, { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
    Play, Pause, RotateCcw, Cpu, Thermometer, Wind, Droplets,
    AlertTriangle, CheckCircle2, Clock, Users, Truck, HardHat,
    Activity, Zap, BarChart3, Map, Calendar, TrendingUp
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

type SiteZone = {
    id: string;
    name: string;
    x: number;
    y: number;
    w: number;
    h: number;
    color: string;
    status: 'active' | 'idle' | 'alert' | 'complete';
    workers: number;
    progress: number;
};

type SiteEvent = {
    id: string;
    time: string;
    message: string;
    severity: 'info' | 'warning' | 'success';
};

const INITIAL_ZONES: SiteZone[] = [
    { id: 'z1', name: 'Foundation', x: 5, y: 5, w: 30, h: 20, color: '#f97316', status: 'complete', workers: 0, progress: 100 },
    { id: 'z2', name: 'Structure A', x: 40, y: 5, w: 25, h: 25, color: '#3b82f6', status: 'active', workers: 12, progress: 67 },
    { id: 'z3', name: 'Structure B', x: 70, y: 5, w: 25, h: 25, color: '#8b5cf6', status: 'active', workers: 8, progress: 45 },
    { id: 'z4', name: 'MEP Works', x: 5, y: 30, w: 35, h: 20, color: '#10b981', status: 'idle', workers: 4, progress: 22 },
    { id: 'z5', name: 'Interiors', x: 45, y: 35, w: 25, h: 20, color: '#f59e0b', status: 'idle', workers: 2, progress: 10 },
    { id: 'z6', name: 'Exterior', x: 75, y: 35, w: 20, h: 20, color: '#ec4899', status: 'alert', workers: 0, progress: 35 },
];

const INITIAL_EVENTS: SiteEvent[] = [
    { id: 'e1', time: '09:12', message: 'Concrete pour completed in Zone A', severity: 'success' },
    { id: 'e2', time: '09:35', message: 'Material delivery delay: Steel rebar – ETA 2hr', severity: 'warning' },
    { id: 'e3', time: '10:02', message: 'Zone 6 safety inspection flagged', severity: 'warning' },
    { id: 'e4', time: '10:15', message: 'Shift change: 12 workers onboarded', severity: 'info' },
    { id: 'e5', time: '10:48', message: 'Foundation QC passed – 100% milestone', severity: 'success' },
];

const SENSOR_DATA = [
    { label: 'Temperature', value: 32, unit: '°C', icon: Thermometer, color: '#f97316', max: 50 },
    { label: 'Wind Speed', value: 14, unit: 'km/h', icon: Wind, color: '#3b82f6', max: 60 },
    { label: 'Humidity', value: 68, unit: '%', icon: Droplets, color: '#10b981', max: 100 },
    { label: 'PM2.5', value: 45, unit: 'µg', icon: Activity, color: '#8b5cf6', max: 150 },
];

export default function SmartSiteSimulator() {
    const [zones, setZones] = useState<SiteZone[]>(INITIAL_ZONES);
    const [events, setEvents] = useState<SiteEvent[]>(INITIAL_EVENTS);
    const [isRunning, setIsRunning] = useState(false);
    const [simTime, setSimTime] = useState(0); // seconds
    const [selectedZone, setSelectedZone] = useState<SiteZone | null>(null);
    const [sensors, setSensors] = useState(SENSOR_DATA);
    const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

    const formatSimTime = (seconds: number) => {
        const h = Math.floor(seconds / 3600).toString().padStart(2, '0');
        const m = Math.floor((seconds % 3600) / 60).toString().padStart(2, '0');
        const s = (seconds % 60).toString().padStart(2, '0');
        return `${h}:${m}:${s}`;
    };

    useEffect(() => {
        if (isRunning) {
            intervalRef.current = setInterval(() => {
                setSimTime(t => t + 1);

                // Randomly evolve zone progress
                setZones(prev => prev.map(z => {
                    if (z.status === 'active' && z.progress < 100) {
                        const newProgress = Math.min(100, z.progress + Math.random() * 0.3);
                        return { ...z, progress: newProgress, status: newProgress >= 100 ? 'complete' : 'active' };
                    }
                    return z;
                }));

                // Randomly fluctuate sensors
                setSensors(prev => prev.map(s => ({
                    ...s,
                    value: Math.max(1, Math.min(s.max - 5, s.value + (Math.random() - 0.5) * 2))
                })));

                // Occasionally generate events
                if (Math.random() < 0.02) {
                    const newMessages = [
                        'Crane lift operation initiated at Block B',
                        'Safety harness inspection completed',
                        'Concrete batch M25 approved by QC',
                        'Electrical conduit layout started',
                        'Perimeter fencing secured',
                    ];
                    const msg = newMessages[Math.floor(Math.random() * newMessages.length)];
                    const now = new Date();
                    setEvents(prev => [
                        { id: `e${Date.now()}`, time: `${now.getHours()}:${now.getMinutes().toString().padStart(2, '0')}`, message: msg, severity: 'info' },
                        ...prev.slice(0, 19),
                    ]);
                }
            }, 200);
        } else {
            if (intervalRef.current) clearInterval(intervalRef.current);
        }
        return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
    }, [isRunning]);

    const handleReset = () => {
        setIsRunning(false);
        setSimTime(0);
        setZones(INITIAL_ZONES);
        setEvents(INITIAL_EVENTS);
        setSensors(SENSOR_DATA);
        setSelectedZone(null);
    };

    const totalWorkers = zones.reduce((sum, z) => sum + z.workers, 0);
    const overallProgress = Math.round(zones.reduce((sum, z) => sum + z.progress, 0) / zones.length);

    return (
        <div className="h-full w-full space-y-4 animate-in fade-in duration-500">

            {/* Header */}
            <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
                <div>
                    <h1 className="text-2xl font-black tracking-tight">
                        Smart Site <span className="text-primary">Simulator</span>
                    </h1>
                    <p className="text-sm text-muted-foreground mt-0.5">Real-time construction site digital twin with IoT sensor feeds</p>
                </div>
                <div className="flex items-center gap-3">
                    <div className="flex items-center gap-2 px-4 py-2 bg-background border border-border rounded-xl font-mono text-sm font-bold text-foreground">
                        <Clock className="h-4 w-4 text-primary" />
                        {formatSimTime(simTime)}
                    </div>
                    <Button
                        onClick={() => setIsRunning(r => !r)}
                        className={cn('h-10 px-5 font-black gap-2', isRunning ? 'bg-amber-500 hover:bg-amber-600 text-white' : 'bg-primary hover:bg-primary/90 text-primary-foreground')}
                    >
                        {isRunning ? <><Pause className="h-4 w-4" /> Pause</> : <><Play className="h-4 w-4" /> Run Simulation</>}
                    </Button>
                    <Button variant="outline" size="icon" onClick={handleReset} className="h-10 w-10 border-border">
                        <RotateCcw className="h-4 w-4" />
                    </Button>
                </div>
            </div>

            {/* Stat Strip */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                {[
                    { label: 'Overall Progress', value: `${overallProgress}%`, icon: TrendingUp, color: 'text-primary' },
                    { label: 'Active Workers', value: totalWorkers, icon: Users, color: 'text-blue-500' },
                    { label: 'Active Zones', value: zones.filter(z => z.status === 'active').length, icon: Map, color: 'text-emerald-500' },
                    { label: 'Alerts', value: zones.filter(z => z.status === 'alert').length, icon: AlertTriangle, color: 'text-red-500' },
                ].map((stat, i) => (
                    <div key={i} className="bg-background border border-border rounded-2xl p-4 flex items-center gap-3">
                        <div className="h-10 w-10 rounded-xl bg-secondary flex items-center justify-center shrink-0">
                            <stat.icon className={cn('h-5 w-5', stat.color)} />
                        </div>
                        <div>
                            <p className="text-xs text-muted-foreground font-medium">{stat.label}</p>
                            <p className="text-xl font-black text-foreground">{stat.value}</p>
                        </div>
                    </div>
                ))}
            </div>

            <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">

                {/* Site Map */}
                <div className="xl:col-span-2 bg-background border border-border rounded-2xl p-4">
                    <div className="flex items-center justify-between mb-3">
                        <h2 className="font-black text-sm uppercase tracking-widest text-foreground">Live Site Map</h2>
                        <div className="flex gap-2 text-[10px] font-bold text-muted-foreground">
                            {[{ label: 'Active', color: 'bg-blue-500' }, { label: 'Alert', color: 'bg-red-500' }, { label: 'Idle', color: 'bg-yellow-500' }, { label: 'Done', color: 'bg-emerald-500' }].map(l => (
                                <span key={l.label} className="flex items-center gap-1"><span className={cn('h-2 w-2 rounded-full', l.color)} />{l.label}</span>
                            ))}
                        </div>
                    </div>
                    <div className="relative w-full bg-secondary/30 rounded-xl overflow-hidden border border-border" style={{ aspectRatio: '16/9' }}>
                        <svg width="100%" height="100%" viewBox="0 0 100 60" preserveAspectRatio="xMidYMid meet">
                            {/* Grid */}
                            {Array.from({ length: 10 }).map((_, i) => (
                                <line key={`hg${i}`} x1="0" y1={i * 6} x2="100" y2={i * 6} stroke="currentColor" strokeOpacity="0.05" strokeWidth="0.3" />
                            ))}
                            {Array.from({ length: 10 }).map((_, i) => (
                                <line key={`vg${i}`} x1={i * 10} y1="0" x2={i * 10} y2="60" stroke="currentColor" strokeOpacity="0.05" strokeWidth="0.3" />
                            ))}

                            {zones.map(zone => {
                                const statusColors: Record<string, string> = {
                                    active: '#3b82f6',
                                    alert: '#ef4444',
                                    idle: '#f59e0b',
                                    complete: '#10b981',
                                };
                                const c = statusColors[zone.status];
                                return (
                                    <g key={zone.id} onClick={() => setSelectedZone(zone === selectedZone ? null : zone)} className="cursor-pointer">
                                        <rect
                                            x={zone.x} y={zone.y} width={zone.w} height={zone.h}
                                            fill={c} fillOpacity={selectedZone?.id === zone.id ? 0.35 : 0.15}
                                            stroke={c} strokeWidth={selectedZone?.id === zone.id ? 0.8 : 0.4}
                                            rx="1"
                                        />
                                        {/* Progress bar */}
                                        <rect x={zone.x + 1} y={zone.y + zone.h - 2.5} width={(zone.w - 2) * (zone.progress / 100)} height="1.5" fill={c} fillOpacity={0.9} rx="0.5" />
                                        <rect x={zone.x + 1} y={zone.y + zone.h - 2.5} width={zone.w - 2} height="1.5" fill={c} fillOpacity={0.2} rx="0.5" />
                                        <text x={zone.x + zone.w / 2} y={zone.y + zone.h / 2} textAnchor="middle" dominantBaseline="middle" fill={c} fontSize="2.5" fontWeight="bold">{zone.name}</text>
                                        {zone.status === 'alert' && (
                                            <text x={zone.x + zone.w - 3} y={zone.y + 4} textAnchor="middle" fontSize="4">⚠</text>
                                        )}
                                        {zone.workers > 0 && (
                                            <text x={zone.x + 3} y={zone.y + 4} fill={c} fontSize="2.2">👷 {zone.workers}</text>
                                        )}
                                    </g>
                                );
                            })}
                        </svg>

                        {/* Zone detail popup */}
                        <AnimatePresence>
                            {selectedZone && (
                                <motion.div initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.9 }}
                                    className="absolute bottom-3 left-3 bg-background/95 backdrop-blur-xl border border-border rounded-xl p-3 shadow-2xl min-w-[180px] z-10"
                                >
                                    <p className="font-black text-foreground text-sm">{selectedZone.name}</p>
                                    <p className="text-[10px] text-muted-foreground uppercase tracking-widest mb-2">{selectedZone.status}</p>
                                    <div className="space-y-1 text-[11px] text-muted-foreground">
                                        <div className="flex justify-between"><span>Progress</span><span className="font-bold text-foreground">{Math.round(selectedZone.progress)}%</span></div>
                                        <div className="flex justify-between"><span>Workers</span><span className="font-bold text-foreground">{selectedZone.workers}</span></div>
                                    </div>
                                    <div className="mt-2 h-1.5 bg-secondary rounded-full overflow-hidden">
                                        <div className="h-full bg-primary rounded-full transition-all" style={{ width: `${selectedZone.progress}%` }} />
                                    </div>
                                </motion.div>
                            )}
                        </AnimatePresence>
                    </div>
                </div>

                {/* Right Panel */}
                <div className="space-y-4">
                    {/* Sensors */}
                    <div className="bg-background border border-border rounded-2xl p-4">
                        <h2 className="font-black text-sm uppercase tracking-widest text-foreground mb-3 flex items-center gap-2">
                            <Cpu className="h-4 w-4 text-primary" /> IoT Sensors
                        </h2>
                        <div className="space-y-3">
                            {sensors.map((s, i) => (
                                <div key={i}>
                                    <div className="flex items-center justify-between mb-1">
                                        <div className="flex items-center gap-2 text-[12px] text-muted-foreground font-medium">
                                            <s.icon className="h-3.5 w-3.5" style={{ color: s.color }} />{s.label}
                                        </div>
                                        <span className="text-[12px] font-black text-foreground">{Math.round(s.value)}{s.unit}</span>
                                    </div>
                                    <div className="h-1.5 bg-secondary rounded-full overflow-hidden">
                                        <motion.div
                                            className="h-full rounded-full"
                                            style={{ backgroundColor: s.color, width: `${(s.value / s.max) * 100}%` }}
                                            animate={{ width: `${(s.value / s.max) * 100}%` }}
                                            transition={{ duration: 0.5 }}
                                        />
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>

                    {/* Event Log */}
                    <div className="bg-background border border-border rounded-2xl p-4 flex flex-col" style={{ maxHeight: '280px' }}>
                        <h2 className="font-black text-sm uppercase tracking-widest text-foreground mb-3 flex items-center gap-2 shrink-0">
                            <Activity className="h-4 w-4 text-primary" /> Event Log
                            {isRunning && <span className="ml-auto h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />}
                        </h2>
                        <div className="overflow-y-auto space-y-2 pr-1 flex-1">
                            <AnimatePresence>
                                {events.slice(0, 10).map(event => (
                                    <motion.div
                                        key={event.id}
                                        initial={{ opacity: 0, x: -10 }}
                                        animate={{ opacity: 1, x: 0 }}
                                        exit={{ opacity: 0 }}
                                        className="flex items-start gap-2"
                                    >
                                        <span className="text-[10px] font-mono text-muted-foreground mt-0.5 shrink-0">{event.time}</span>
                                        <div className={cn(
                                            'flex-1 text-[11px] leading-snug px-2 py-1 rounded-lg border',
                                            event.severity === 'success' && 'bg-emerald-500/10 border-emerald-500/20 text-emerald-600',
                                            event.severity === 'warning' && 'bg-amber-500/10 border-amber-500/20 text-amber-600',
                                            event.severity === 'info' && 'bg-secondary border-border text-muted-foreground',
                                        )}>
                                            {event.message}
                                        </div>
                                    </motion.div>
                                ))}
                            </AnimatePresence>
                        </div>
                    </div>
                </div>
            </div>

            {/* Zone Progress Table */}
            <div className="bg-background border border-border rounded-2xl p-4">
                <h2 className="font-black text-sm uppercase tracking-widest text-foreground mb-4 flex items-center gap-2">
                    <BarChart3 className="h-4 w-4 text-primary" /> Zone Progress Overview
                </h2>
                <div className="overflow-x-auto">
                    <table className="w-full text-[12px]">
                        <thead>
                            <tr className="border-b border-border text-muted-foreground font-bold uppercase tracking-widest text-[10px]">
                                <th className="pb-2 text-left">Zone</th>
                                <th className="pb-2 text-center">Status</th>
                                <th className="pb-2 text-center">Workers</th>
                                <th className="pb-2 text-right pr-4">Progress</th>
                                <th className="pb-2 w-40">Bar</th>
                            </tr>
                        </thead>
                        <tbody className="space-y-1">
                            {zones.map(zone => {
                                const statusBadgeMap: Record<string, string> = {
                                    active: 'bg-blue-500/10 text-blue-600 border-blue-500/20',
                                    alert: 'bg-red-500/10 text-red-600 border-red-500/20',
                                    idle: 'bg-amber-500/10 text-amber-600 border-amber-500/20',
                                    complete: 'bg-emerald-500/10 text-emerald-600 border-emerald-500/20',
                                };
                                return (
                                    <tr key={zone.id} className="border-b border-border/40 hover:bg-secondary/30 transition-colors cursor-pointer" onClick={() => setSelectedZone(zone === selectedZone ? null : zone)}>
                                        <td className="py-2 font-bold text-foreground">{zone.name}</td>
                                        <td className="py-2 text-center">
                                            <span className={cn('px-2 py-0.5 rounded-full border text-[9px] font-bold uppercase tracking-widest', statusBadgeMap[zone.status])}>
                                                {zone.status}
                                            </span>
                                        </td>
                                        <td className="py-2 text-center text-muted-foreground">{zone.workers}</td>
                                        <td className="py-2 text-right pr-4 font-black text-foreground">{Math.round(zone.progress)}%</td>
                                        <td className="py-2">
                                            <div className="h-1.5 bg-secondary rounded-full overflow-hidden">
                                                <motion.div
                                                    className="h-full rounded-full"
                                                    style={{ backgroundColor: zone.color }}
                                                    animate={{ width: `${zone.progress}%` }}
                                                    transition={{ duration: 0.5 }}
                                                />
                                            </div>
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>
            </div>
        </div>
    );
}
