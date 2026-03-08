'use client';

import { motion, AnimatePresence } from 'framer-motion';
import { Shield, Users, HardHat, Check, ArrowRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useAppContext } from '@/contexts/app-context';
import { cn } from '@/lib/utils';
import { useState } from 'react';

const roles = [
    {
        id: 'Admin',
        title: 'System Administrator',
        description: 'Manage users, platform configurations, and system analytics.',
        icon: Shield,
        color: 'text-indigo-500',
        bg: 'bg-indigo-500/10',
        border: 'border-indigo-500/30'
    },
    {
        id: 'Supervisor',
        title: 'Project Supervisor',
        description: 'Oversee site progress, regional telemetry, and safety protocols.',
        icon: Users,
        color: 'text-emerald-500',
        bg: 'bg-emerald-500/10',
        border: 'border-emerald-500/30'
    },
    {
        id: 'Engineer',
        title: 'Structural Engineer',
        description: 'Analyze blueprints, run simulations, and identify structural risks.',
        icon: HardHat,
        color: 'text-orange-500',
        bg: 'bg-orange-500/10',
        border: 'border-orange-500/30'
    }
];

export default function RoleSelectionDialog() {
    const { showRoleSelection, handleSelectRole } = useAppContext();
    const [selectedRole, setSelectedRole] = useState<string | null>(null);

    if (!showRoleSelection) return null;

    return (
        <AnimatePresence>
            <div className="fixed inset-0 z-[100] flex items-center justify-center px-4">
                <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    className="absolute inset-0 bg-black/60 backdrop-blur-md"
                />

                <motion.div
                    initial={{ scale: 0.9, opacity: 0, y: 20 }}
                    animate={{ scale: 1, opacity: 1, y: 0 }}
                    exit={{ scale: 0.9, opacity: 0, y: 20 }}
                    className="relative z-10 w-full max-w-2xl bg-slate-900 border border-white/10 rounded-[2.5rem] p-8 md:p-12 shadow-2xl overflow-hidden"
                >
                    {/* Background glow */}
                    <div className="absolute top-0 left-1/2 -translate-x-1/2 w-full h-1/2 bg-primary/10 blur-[100px] pointer-events-none" />

                    <div className="text-center space-y-4 mb-10 relative z-10">
                        <h2 className="text-4xl md:text-5xl font-black tracking-tighter text-white">
                            Choose Your Identity
                        </h2>
                        <p className="text-slate-400 text-lg max-w-md mx-auto">
                            Infralith tailors its intelligence interface based on your operational domain.
                        </p>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4 relative z-10">
                        {roles.map((role) => (
                            <button
                                key={role.id}
                                onClick={() => setSelectedRole(role.id)}
                                className={cn(
                                    "flex flex-col items-center text-center p-6 rounded-3xl border-2 transition-all duration-300 group relative",
                                    selectedRole === role.id
                                        ? cn("bg-white/5", role.border, "shadow-xl scale-[1.02]")
                                        : "border-transparent bg-slate-800/50 hover:bg-slate-800 hover:border-white/5"
                                )}
                            >
                                <div className={cn(
                                    "h-16 w-16 rounded-2xl flex items-center justify-center mb-4 transition-transform duration-500 group-hover:scale-110 shadow-lg",
                                    role.bg, role.color
                                )}>
                                    <role.icon className="h-8 w-8" />
                                </div>
                                <h3 className="text-lg font-bold text-white mb-2">{role.title}</h3>
                                <p className="text-xs text-slate-500 leading-relaxed">{role.description}</p>

                                {selectedRole === role.id && (
                                    <motion.div
                                        layoutId="check"
                                        className="absolute top-4 right-4 h-6 w-6 rounded-full bg-primary flex items-center justify-center shadow-lg"
                                    >
                                        <Check className="h-3 w-3 text-white" />
                                    </motion.div>
                                )}
                            </button>
                        ))}
                    </div>

                    <div className="mt-10 flex justify-center relative z-10">
                        <Button
                            size="lg"
                            className="px-10 h-14 rounded-full text-lg font-black tracking-tight group"
                            disabled={!selectedRole}
                            onClick={() => selectedRole && handleSelectRole(selectedRole)}
                        >
                            Enter Dashboard
                            <ArrowRight className="ml-2 h-5 w-5 transition-transform group-hover:translate-x-1" />
                        </Button>
                    </div>
                </motion.div>
            </div>
        </AnimatePresence>
    );
}
