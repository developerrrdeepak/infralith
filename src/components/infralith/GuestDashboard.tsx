'use client';

import { motion } from 'framer-motion';
import {
    Shield, Users, HardHat, Lock, ArrowRight, Sparkles,
    Building2, ShieldCheck, TrendingUp, FileSearch, Cpu, ChevronRight
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useAppContext } from '@/contexts/app-context';
import { cn } from '@/lib/utils';
import { useState } from 'react';

const roles = [
    {
        id: 'Engineer',
        title: 'Structural Engineer',
        description: 'Analyze blueprints, run structural simulations, and identify risks using AI.',
        icon: HardHat,
        color: 'text-orange-500',
        bg: 'bg-orange-500/10',
        border: 'border-orange-200 dark:border-orange-500/30',
        glow: 'shadow-orange-500/10',
        features: ['Blueprint Analysis', '2D to 3D Generator', 'Compliance Scan', 'Risk Detection'],
    },
    {
        id: 'Supervisor',
        title: 'Project Supervisor',
        description: 'Oversee site progress, manage teams, and monitor safety protocols in real-time.',
        icon: Users,
        color: 'text-emerald-500',
        bg: 'bg-emerald-500/10',
        border: 'border-emerald-200 dark:border-emerald-500/30',
        glow: 'shadow-emerald-500/10',
        features: ['Site Pipeline', 'Team Chat', 'War Room', 'CAPEX Forecast'],
    },
    {
        id: 'Admin',
        title: 'System Administrator',
        description: 'Manage users, configure platform settings, and access enterprise analytics.',
        icon: Shield,
        color: 'text-indigo-500',
        bg: 'bg-indigo-500/10',
        border: 'border-indigo-200 dark:border-indigo-500/30',
        glow: 'shadow-indigo-500/10',
        features: ['User Management', 'Audit Logs', 'Analytics', 'Configurations'],
    },
];

const lockedFeatures = [
    { icon: Building2, label: 'Blueprint AI Analysis' },
    { icon: ShieldCheck, label: 'Compliance Checker' },
    { icon: TrendingUp, label: 'Cost Prediction Engine' },
    { icon: FileSearch, label: 'Azure AI Search' },
    { icon: Cpu, label: '2D → 3D Generator' },
    { icon: Shield, label: 'Risk Dashboard' },
];

const container = {
    hidden: { opacity: 0 },
    show: { opacity: 1, transition: { staggerChildren: 0.07 } }
};
const item = { hidden: { opacity: 0, y: 18 }, show: { opacity: 1, y: 0 } };

export default function GuestDashboard() {
    const { user, handleSelectRole } = useAppContext();
    const [selected, setSelected] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);

    const firstName = user?.name?.split(' ')[0] || 'Guest';

    const onEnter = async () => {
        if (!selected) return;
        setLoading(true);
        await new Promise((r) => setTimeout(r, 500));
        handleSelectRole(selected);
    };

    return (
        <motion.div
            className="min-h-full pb-20 space-y-10 px-2 md:px-0"
            variants={container}
            initial="hidden"
            animate="show"
        >
            {/* Hero */}
            <motion.div variants={item} className="relative rounded-2xl overflow-hidden border border-slate-200 dark:border-white/10 bg-white dark:bg-slate-900 shadow-sm">
                <div className="absolute top-0 right-0 w-80 h-80 bg-orange-500/5 rounded-full blur-[100px] pointer-events-none" />
                <div className="absolute bottom-0 left-0 w-60 h-60 bg-indigo-500/5 rounded-full blur-[80px] pointer-events-none" />

                <div className="relative z-10 p-8 md:p-12 flex flex-col md:flex-row items-start md:items-center justify-between gap-8">
                    <div className="space-y-4 max-w-xl">
                        <div className="flex items-center gap-2">
                            <Badge className="gap-1.5 px-3 py-1 bg-orange-500/10 text-orange-600 dark:text-orange-400 border-orange-200 dark:border-orange-500/20 text-xs font-semibold rounded-full">
                                <Sparkles className="h-3 w-3" />
                                Guest Access
                            </Badge>
                        </div>
                        <h1 className="text-3xl md:text-4xl lg:text-5xl font-bold tracking-tight text-slate-900 dark:text-white">
                            Welcome, <span className="text-orange-500">{firstName}</span>
                        </h1>
                        <p className="text-slate-500 dark:text-slate-400 text-base md:text-lg leading-relaxed max-w-md">
                            You're signed in to Infralith. Select your role below to unlock the full Construction Intelligence Platform.
                        </p>
                    </div>

                    {/* Locked features preview */}
                    <div className="shrink-0 grid grid-cols-3 gap-2">
                        {lockedFeatures.map((f, i) => (
                            <div
                                key={i}
                                className="flex flex-col items-center gap-1.5 px-3 py-3 rounded-xl bg-slate-50 dark:bg-slate-800/50 border border-slate-100 dark:border-white/5 relative"
                            >
                                <Lock className="absolute top-1.5 right-1.5 h-2.5 w-2.5 text-slate-300 dark:text-slate-600" />
                                <f.icon className="h-5 w-5 text-slate-400 dark:text-slate-500" />
                                <span className="text-[10px] font-semibold text-slate-400 dark:text-slate-500 text-center leading-tight">{f.label}</span>
                            </div>
                        ))}
                    </div>
                </div>
            </motion.div>

            {/* Role Selection */}
            <motion.div variants={item}>
                <div className="flex items-center gap-2 mb-5">
                    <span className="w-2 h-2 rounded-sm bg-orange-500" />
                    <h2 className="text-sm font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">Choose Your Role</h2>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    {roles.map((role) => {
                        const isSelected = selected === role.id;
                        return (
                            <button
                                key={role.id}
                                onClick={() => setSelected(role.id)}
                                className={cn(
                                    'text-left p-6 rounded-2xl border-2 transition-all duration-300 relative group focus:outline-none',
                                    isSelected
                                        ? cn('bg-white dark:bg-slate-800', role.border, 'shadow-xl', role.glow)
                                        : 'border-slate-100 dark:border-white/5 bg-white dark:bg-slate-900 hover:border-slate-200 dark:hover:border-white/10 hover:shadow-md'
                                )}
                            >
                                {isSelected && (
                                    <motion.div
                                        layoutId="role-selected-glow"
                                        className={cn('absolute inset-0 rounded-2xl opacity-30 blur-xl', role.bg)}
                                    />
                                )}

                                <div className="relative z-10 space-y-4">
                                    <div className={cn('h-12 w-12 rounded-xl flex items-center justify-center transition-transform duration-300 group-hover:scale-110', role.bg, role.color)}>
                                        <role.icon className="h-6 w-6" />
                                    </div>

                                    <div>
                                        <h3 className={cn('text-base font-bold mb-1', isSelected ? 'text-slate-900 dark:text-white' : 'text-slate-700 dark:text-slate-200')}>
                                            {role.title}
                                        </h3>
                                        <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
                                            {role.description}
                                        </p>
                                    </div>

                                    <div className="space-y-1.5">
                                        {role.features.map((feat) => (
                                            <div key={feat} className="flex items-center gap-2">
                                                <ChevronRight className={cn('h-3 w-3 shrink-0', role.color)} />
                                                <span className="text-[11px] font-medium text-slate-500 dark:text-slate-400">{feat}</span>
                                            </div>
                                        ))}
                                    </div>
                                </div>

                                {isSelected && (
                                    <motion.div
                                        initial={{ scale: 0 }}
                                        animate={{ scale: 1 }}
                                        className={cn('absolute top-4 right-4 h-6 w-6 rounded-full flex items-center justify-center', role.bg, role.color, 'border', role.border)}
                                    >
                                        <Shield className="h-3 w-3" />
                                    </motion.div>
                                )}
                            </button>
                        );
                    })}
                </div>
            </motion.div>

            {/* CTA */}
            <motion.div variants={item} className="flex items-center justify-between flex-wrap gap-4">
                <p className="text-sm text-slate-400 dark:text-slate-500">
                    {selected
                        ? `You selected "${roles.find((r) => r.id === selected)?.title}". Click Enter Dashboard to proceed.`
                        : 'Select a role above to continue.'}
                </p>
                <Button
                    size="lg"
                    className="h-12 px-8 rounded-xl font-bold gap-2 bg-orange-500 hover:bg-orange-600 text-white shadow-lg shadow-orange-500/20 transition-all hover:-translate-y-0.5 disabled:opacity-40 disabled:translate-y-0"
                    disabled={!selected || loading}
                    onClick={onEnter}
                >
                    {loading ? (
                        <span className="flex items-center gap-2">
                            <motion.span
                                animate={{ rotate: 360 }}
                                transition={{ duration: 0.8, repeat: Infinity, ease: 'linear' }}
                                className="block h-4 w-4 border-2 border-white/30 border-t-white rounded-full"
                            />
                            Entering...
                        </span>
                    ) : (
                        <>
                            Enter Dashboard
                            <ArrowRight className="h-4 w-4" />
                        </>
                    )}
                </Button>
            </motion.div>
        </motion.div>
    );
}
