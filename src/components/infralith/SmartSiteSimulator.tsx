'use client';

import React, { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import {
    Zap,
    Activity,
    Wind,
    Thermometer,
    Shield,
    Play,
    Weight,
    ChevronRight,
    BarChart3
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { Progress } from '@/components/ui/progress';
import { cn } from '@/lib/utils';

export default function SmartSiteSimulator() {
    const [status, setStatus] = useState<'idle' | 'simulating' | 'complete'>('idle');
    const [progress, setProgress] = useState(0);
    const [logs, setLogs] = useState<string[]>([]);

    useEffect(() => {
        let interval: any;
        if (status === 'simulating') {
            interval = setInterval(() => {
                setProgress(prev => {
                    const next = prev + 0.8;
                    if (next >= 100) {
                        setStatus('complete');
                        addLog("Simulation successfully completed. Structural integrity confirmed at 98.4%.");
                        return 100;
                    }
                    if (Math.floor(next) % 15 === 0 && Math.floor(next) !== Math.floor(prev)) {
                        addLog(`Analyzing load distribution at ${Math.floor(next)}%...`);
                    }
                    return next;
                });
            }, 80);
        }
        return () => clearInterval(interval);
    }, [status]);

    const addLog = (msg: string) => {
        setLogs(prev => [`[${new Date().toLocaleTimeString()}] ${msg}`, ...prev].slice(0, 10));
    };

    const startSim = () => {
        setStatus('simulating');
        setProgress(0);
        setLogs([]);
        addLog("Initializing High-Fidelity Physics Engine...");
        addLog("Loading BIM Twin coordinates into Azure Compute Cluster...");
    };

    const resetSim = () => {
        setStatus('idle');
        setProgress(0);
        setLogs([]);
    };

    return (
        <div className="w-full space-y-8 pb-12">
            {/* Page Title */}
            <div className="flex items-end gap-4">
                <div>
                    <div className="flex items-center gap-3 mb-1">
                        <Zap className="h-8 w-8 text-amber-500 fill-amber-500" strokeWidth={2} />
                        <h1 className="text-3xl font-black tracking-tight text-slate-900 dark:text-white">Site Simulator</h1>
                    </div>
                    <p className="text-slate-500 font-semibold ml-11">Stress-test your architectural design</p>
                </div>
            </div>

            {/* Main Card */}
            <div className="w-full bg-white dark:bg-slate-900 rounded-[28px] shadow-[0_8px_40px_-12px_rgba(0,0,0,0.08)] border border-slate-100 dark:border-slate-800 overflow-hidden">
                <div className="p-8 space-y-8">

                    {/* Parameters Row */}
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 divide-y sm:divide-y-0 sm:divide-x divide-slate-100 dark:divide-slate-800 bg-slate-50/70 dark:bg-slate-800/30 rounded-[20px] border border-slate-100 dark:border-slate-800 overflow-hidden">
                        {[
                            { icon: Wind, label: "Wind Velocity", value: "120 km/h", color: "text-slate-500", bg: "bg-white dark:bg-slate-800" },
                            { icon: Activity, label: "Seismic Scale", value: "7.2 Richter", color: "text-amber-500", bg: "bg-amber-50/60 dark:bg-amber-900/20" },
                            { icon: Thermometer, label: "Thermal Expansion", value: "+45°C", color: "text-orange-400", bg: "bg-orange-50/60 dark:bg-orange-900/20" },
                            { icon: Weight, label: "Load Factor", value: "3.5x", color: "text-amber-600", bg: "bg-amber-100/40 dark:bg-amber-900/20" },
                        ].map((param, i) => (
                            <div key={i} className={cn("flex items-center gap-4 p-6 transition-colors group", param.bg)}>
                                <div className="h-12 w-12 rounded-full bg-white dark:bg-slate-700 flex items-center justify-center shadow-sm border border-slate-100 dark:border-slate-600 group-hover:scale-110 transition-transform duration-300">
                                    <param.icon className={cn("h-5 w-5", param.color)} strokeWidth={2.5} />
                                </div>
                                <div>
                                    <p className="text-[11px] font-bold text-slate-400 uppercase tracking-widest leading-none">{param.label}</p>
                                    <p className="text-xl font-black text-slate-800 dark:text-white tracking-tight leading-none pt-1.5">{param.value}</p>
                                </div>
                            </div>
                        ))}
                    </div>

                    {/* Simulation Viewport */}
                    <div className="relative min-h-[320px] bg-slate-50/70 dark:bg-slate-800/20 border border-slate-100 dark:border-slate-800 rounded-[24px] flex flex-col items-center justify-center overflow-hidden p-10">
                        <AnimatePresence mode="wait">
                            {status === 'idle' && (
                                <motion.div
                                    key="idle"
                                    initial={{ opacity: 0, scale: 0.95 }}
                                    animate={{ opacity: 1, scale: 1 }}
                                    exit={{ opacity: 0, scale: 1.05 }}
                                    className="flex flex-col items-center"
                                >
                                    <div className="h-20 w-20 bg-white dark:bg-slate-700 rounded-3xl shadow-md border border-slate-100 dark:border-slate-600 flex items-center justify-center mb-6">
                                        <Shield className="h-10 w-10 text-slate-300" strokeWidth={1.5} />
                                    </div>
                                    <h3 className="text-2xl font-black text-slate-700 dark:text-slate-200 mb-8 tracking-tight">Ready for Simulation</h3>
                                    <Button
                                        onClick={startSim}
                                        className="bg-amber-500 hover:bg-amber-400 text-white font-black h-14 px-12 rounded-[16px] text-[16px] shadow-xl shadow-amber-500/30 transition-all hover:scale-105 active:scale-[0.98] flex items-center gap-3"
                                    >
                                        <Play className="h-5 w-5 fill-current" />
                                        Launch Simulation
                                    </Button>
                                </motion.div>
                            )}

                            {status === 'simulating' && (
                                <motion.div
                                    key="simulating"
                                    initial={{ opacity: 0 }}
                                    animate={{ opacity: 1 }}
                                    exit={{ opacity: 0 }}
                                    className="flex flex-col items-center w-full max-w-sm"
                                >
                                    <div className="relative h-24 w-24 mb-8">
                                        <div className="absolute inset-0 rounded-full border-4 border-amber-500/15 border-t-amber-500 animate-spin" style={{ animationDuration: '0.8s' }} />
                                        <div className="absolute inset-0 flex items-center justify-center">
                                            <Zap className="h-9 w-9 text-amber-500 animate-pulse" fill="currentColor" />
                                        </div>
                                    </div>
                                    <p className="text-[11px] font-black text-amber-500 mb-5 uppercase tracking-[0.3em]">Computing Stress Points</p>
                                    <div className="w-full space-y-3">
                                        <Progress value={progress} className="h-2.5 bg-slate-200 dark:bg-slate-700 [&>div]:bg-amber-500 rounded-full" />
                                        <div className="flex justify-between text-[12px] font-black px-0.5">
                                            <span className="text-slate-400 uppercase tracking-widest">Progress</span>
                                            <span className="text-amber-500">{Math.floor(progress)}%</span>
                                        </div>
                                    </div>
                                </motion.div>
                            )}

                            {status === 'complete' && (
                                <motion.div
                                    key="complete"
                                    initial={{ opacity: 0, scale: 0.95 }}
                                    animate={{ opacity: 1, scale: 1 }}
                                    className="flex flex-col items-center"
                                >
                                    <div className="h-20 w-20 bg-emerald-50 dark:bg-emerald-900/30 rounded-3xl border border-emerald-100 dark:border-emerald-800 flex items-center justify-center mb-6">
                                        <Shield className="h-10 w-10 text-emerald-500" strokeWidth={2.5} />
                                    </div>
                                    <h3 className="text-2xl font-black text-slate-800 dark:text-white mb-2 tracking-tight">Simulation Finalized</h3>
                                    <p className="text-slate-500 font-semibold mb-8">
                                        Structural score: <span className="text-emerald-500 font-black text-xl ml-1">98.4 / PASS</span>
                                    </p>
                                    <div className="flex gap-4">
                                        <Button
                                            onClick={resetSim}
                                            variant="outline"
                                            className="border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 font-bold h-12 rounded-2xl px-8 text-[13px] uppercase tracking-wider hover:bg-slate-50 dark:hover:bg-slate-800"
                                        >
                                            Reset
                                        </Button>
                                        <Button
                                            className="bg-slate-900 dark:bg-white dark:text-slate-900 hover:bg-slate-700 text-white font-bold h-12 rounded-2xl px-8 text-[13px] uppercase tracking-wider"
                                        >
                                            Export Report
                                        </Button>
                                    </div>
                                </motion.div>
                            )}
                        </AnimatePresence>
                    </div>

                    {/* Logs */}
                    <div className="space-y-4">
                        <div className="flex items-center gap-2.5">
                            <BarChart3 className="h-4 w-4 text-slate-400" />
                            <h4 className="text-[11px] font-black text-slate-400 uppercase tracking-[0.25em]">Technical Log Stream</h4>
                        </div>
                        <div className="bg-slate-50/70 dark:bg-slate-800/30 rounded-[20px] p-6 border border-slate-100 dark:border-slate-800 min-h-[120px] font-mono">
                            <AnimatePresence initial={false}>
                                {logs.length === 0 ? (
                                    <p className="text-slate-400 text-sm italic">No simulation data currently available.</p>
                                ) : (
                                    <div className="space-y-2.5">
                                        {logs.map((log, i) => (
                                            <motion.div
                                                key={log + i}
                                                initial={{ opacity: 0, x: -8 }}
                                                animate={{ opacity: 1, x: 0 }}
                                                className="flex items-start gap-3 text-[12px]"
                                            >
                                                <ChevronRight className="h-4 w-4 text-amber-500 mt-0.5 shrink-0" />
                                                <p className={cn(
                                                    "leading-relaxed",
                                                    log.includes("completed") ? "text-emerald-600 dark:text-emerald-400 font-bold" : "text-slate-500 dark:text-slate-400"
                                                )}>
                                                    {log}
                                                </p>
                                            </motion.div>
                                        ))}
                                    </div>
                                )}
                            </AnimatePresence>
                        </div>
                    </div>

                </div>
            </div>
        </div>
    );
}
