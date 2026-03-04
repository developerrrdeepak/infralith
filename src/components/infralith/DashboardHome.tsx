
'use client';

import { Activity, BarChart3, CheckSquare, Upload, Zap, MessagesSquare, BadgeInfo, Settings, User as UserIcon, Users, Map, ShieldCheck, Layers, History } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useAppContext } from '@/contexts/app-context';
import { motion } from 'framer-motion';
import LandingHero from './LandingHero';
import { cn } from '@/lib/utils';

function CircularProgress({ value, label, color }: { value: string | number; label: string; color: string }) {
    const numericValue = typeof value === 'number' ? value : parseInt(String(value)) || 0;
    const radius = 22;
    const circumference = 2 * Math.PI * radius;
    const strokeDashoffset = circumference - (numericValue / 100) * circumference;

    return (
        <div className="flex flex-col items-center gap-2 group/metric">
            <div className="relative h-16 w-16 md:h-20 md:w-20 flex items-center justify-center">
                <svg className="h-full w-full -rotate-90 filter drop-shadow-[0_0_12px_rgba(0,0,0,0.1)] dark:drop-shadow-none">
                    <circle
                        cx="50%"
                        cy="50%"
                        r={radius}
                        fill="transparent"
                        stroke="currentColor"
                        strokeWidth="4"
                        className="text-slate-200 dark:text-white/5 transition-colors"
                    />
                    <circle
                        cx="50%"
                        cy="50%"
                        r={radius}
                        fill="transparent"
                        stroke="currentColor"
                        strokeWidth="4"
                        strokeDasharray={circumference}
                        style={{ strokeDashoffset }}
                        strokeLinecap="round"
                        className={cn("transition-all duration-1000 ease-out", color)}
                    />
                </svg>
                <div className="absolute inset-0 flex flex-col items-center justify-center">
                    <span className="text-sm md:text-lg font-black tracking-tighter text-slate-900 dark:text-white">
                        {value}{typeof value === 'number' ? '%' : ''}
                    </span>
                </div>
                {/* Glow ring - only in dark mode or with specific accent */}
                <div className={cn("absolute inset-0 rounded-full opacity-0 group-hover/metric:opacity-20 transition-opacity blur-md", color.replace('text-', 'bg-'))} />
            </div>
            <span className="text-[10px] font-black uppercase tracking-widest text-slate-400 dark:text-white/30 group-hover/metric:text-primary transition-colors text-center leading-none">
                {label}
            </span>
        </div>
    );
}

export default function DashboardHome() {
    const { user, handleNavigate, authed, infralithResult } = useAppContext();

    if (!authed) {
        return <LandingHero />;
    }

    const role = user?.role || 'Engineer';

    const roleConfigs: Record<string, any> = {
        'Supervisor': {
            title: 'Junior Site Observer',
            metrics: [
                { value: 100, label: 'Safety Induction', color: 'text-green-500' },
                { value: 65, label: 'Site Knowledge', color: 'text-blue-500' },
                { value: 10, label: 'Protocols Read', color: 'text-purple-500' },
            ],
            actions: [
                { label: 'Chat', icon: MessagesSquare, route: 'chat' },
                { label: 'Community', icon: Users, route: 'community' },
                { label: 'History', icon: History, route: 'history' },
                { label: 'Profile', icon: UserIcon, route: 'profile' },
            ],
            tasks: [
                "Complete the high-altitude safety training module.",
                "Review historical logs for Mumbai Phase 1.",
                "Join the monthly engineering sync as an observer."
            ]
        },
        'Engineer': {
            title: 'Sr. Structural Engineer',
            metrics: [
                { value: infralithResult?.complianceReport?.overallStatus === 'Pass' ? 100 : 94, label: 'Compliance', color: 'text-green-500' },
                { value: 100 - (infralithResult?.riskReport?.riskIndex || 32), label: 'Safety Rating', color: 'text-red-500' },
                { value: 85, label: 'Eval Speed', color: 'text-blue-500' },
            ],
            actions: [
                { label: 'Chat', icon: MessagesSquare, route: 'chat' },
                { label: '3D Simulation', icon: Zap, route: 'simulation' },
                { label: '2D to 3D', icon: Layers, route: 'blueprint3d' },
                { label: 'Document Upload', icon: Upload, route: 'upload' },
                { label: 'Decisions', icon: CheckSquare, route: 'decision' },
            ],
            tasks: [
                "Section B-B missing reinforcement details in evaluation #42.",
                "Identify seismic non-compliance in Ground Floor layout.",
                "Approve calculated structural load limits for Phase 2."
            ]
        },
        'Admin': {
            title: 'Chief Systems Admin',
            metrics: [
                { value: '99.9', label: 'System Uptime', color: 'text-cyan-500' },
                { value: '124', label: 'Active Users', color: 'text-indigo-500' },
                { value: '100', label: 'Data Sync', color: 'text-green-500' },
            ],
            actions: [
                { label: 'Chat', icon: MessagesSquare, route: 'chat' },
                { label: 'Simulation', icon: Zap, route: 'simulation' },
                { label: 'Settings', icon: Settings, route: 'settings' },
                { label: 'Analytics', icon: BarChart3, route: 'analytics' },
                { label: 'Profile', icon: UserIcon, route: 'profile' },
            ],
            tasks: [
                "Update master compliance ruleset to v2024.2.",
                "Review system audit logs for last 24h.",
                "Optimize Azure OpenAI token distribution among hubs."
            ]
        },
        'Guest': {
            title: 'External Guest',
            metrics: [
                { value: 0, label: 'Access Level', color: 'text-slate-500' },
                { value: 100, label: 'Auth Status', color: 'text-green-500' },
                { value: 0, label: 'Evaluations', color: 'text-slate-500' },
            ],
            actions: [
                { label: 'Chat', icon: MessagesSquare, route: 'chat' },
                { label: 'Support', icon: BadgeInfo, route: 'chat' },
                { label: 'Profile', icon: UserIcon, route: 'profile' },
            ],
            tasks: [
                "Request upgrade to Junior Site Observer for more features.",
                "Explore the community feed items."
            ]
        }
    };

    const config = roleConfigs[role] || roleConfigs['Engineer'];

    const container = {
        hidden: { opacity: 0 },
        show: {
            opacity: 1,
            transition: {
                staggerChildren: 0.1
            }
        }
    };

    const item = {
        hidden: { opacity: 0, y: 20 },
        show: { opacity: 1, y: 0 }
    };

    return (
        <motion.div
            className="space-y-8 pb-20 relative px-4 md:px-0"
            variants={container}
            initial="hidden"
            animate="show"
        >
            {/* Background Decoration for Dashboard */}
            <div className="absolute inset-0 -z-10 pointer-events-none overflow-hidden">
                <div className="absolute top-0 right-1/4 w-[500px] h-[500px] bg-primary/5 rounded-full blur-[120px] opacity-50" />
                <div className="absolute bottom-0 left-1/4 w-[400px] h-[400px] bg-accent/5 rounded-full blur-[100px] opacity-30" />
            </div>
            {/* Top Dashboard Row - Profile & Quick Actions */}
            <motion.div variants={item} className="grid grid-cols-1 xl:grid-cols-3 gap-6">
                {/* User Profile Card */}
                <Card className="xl:col-span-2 relative overflow-hidden group border border-slate-200 dark:border-white/10 shadow-sm rounded-2xl bg-white dark:bg-slate-900">
                    <div className="absolute top-0 right-0 w-64 h-64 bg-primary/5 rounded-full blur-[80px] pointer-events-none" />
                    <CardContent className="flex flex-col md:flex-row items-center md:items-start justify-between gap-10 p-8 lg:p-10 relative z-10 h-full">
                        {/* Avatar & Info */}
                        <div className="flex flex-col md:flex-row items-center md:items-start gap-8 flex-1 min-w-0">
                            <div className="relative shrink-0">
                                {/* Glow ring */}
                                <div className="absolute -inset-4 bg-gradient-to-br from-orange-200 to-amber-100 dark:from-primary/20 dark:to-accent/20 rounded-full opacity-50 blur-xl pointer-events-none" />
                                <button
                                    onClick={() => handleNavigate('profile')}
                                    className="h-24 w-24 md:h-28 md:w-28 rounded-2xl bg-slate-100 dark:bg-slate-800 flex items-center justify-center text-4xl font-bold text-orange-500 dark:text-primary border-4 border-white dark:border-slate-900 shadow-sm hover:scale-105 transition-transform duration-300 cursor-pointer overflow-hidden z-20 relative outline-none"
                                    title="View Profile"
                                >
                                    {user?.avatar
                                        ? <img src={user.avatar} alt={user.name} className="h-full w-full object-cover" />
                                        : (user?.name?.[0].toUpperCase() || 'E')
                                    }
                                </button>
                                {/* Status dot */}
                                <div className="absolute -bottom-2 -right-2 h-6 w-6 rounded-full bg-emerald-500 border-4 border-white dark:border-slate-900 z-30 shadow-sm" />
                            </div>

                            <div className="space-y-3 text-center md:text-left pt-2 flex-1 min-w-0 w-full">
                                <h2 className="text-3xl md:text-4xl lg:text-5xl font-bold tracking-tight text-slate-900 dark:text-white truncate">
                                    {user?.name || 'Engineer'}
                                </h2>
                                <div className="pt-2">
                                    <Badge variant="secondary" className="px-3 py-1 bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-200 border-none text-[11px] font-semibold tracking-wider uppercase transition-colors rounded-lg">
                                        {config.title === 'Sr. Structural Engineer' ? 'Lead Structural Engineer' : config.title}
                                    </Badge>
                                </div>
                                <p className="text-sm text-slate-500 dark:text-slate-400 max-w-sm font-medium leading-relaxed">
                                    Welcome back. Your compliance and risk analysis engines are online.
                                </p>
                            </div>
                        </div>

                        {/* Tri-Metrics */}
                        <div className="flex flex-col gap-6 shrink-0 relative w-full md:w-auto items-center justify-center md:items-end">
                            <div className="flex justify-center md:justify-center w-full mb-2 lg:pr-14">
                                <CircularProgress value={config.metrics[0].value} label={config.metrics[0].label} color={config.metrics[0].color} />
                            </div>
                            <div className="flex gap-10 justify-center">
                                <CircularProgress value={config.metrics[1].value} label={config.metrics[1].label} color={config.metrics[1].color} />
                                <CircularProgress value={config.metrics[2].value} label={config.metrics[2].label} color={config.metrics[2].color} />
                            </div>
                        </div>
                    </CardContent>
                </Card>

                {/* Quick Actions Card */}
                <Card className="xl:col-span-1 relative overflow-hidden group border border-slate-200 dark:border-white/10 shadow-sm rounded-2xl bg-white dark:bg-slate-900">
                    <CardContent className="p-8 h-full flex flex-col">
                        <h3 className="text-xs font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-6 flex items-center gap-2">
                            <span className="w-2 h-2 rounded-sm bg-primary" />
                            Quick Actions
                        </h3>
                        <div className="grid grid-cols-2 gap-4 flex-1">
                            {config.actions.map((action: any, idx: number) => (
                                <button
                                    key={idx}
                                    onClick={() => handleNavigate(action.route)}
                                    className="flex flex-col items-center justify-center gap-3 p-4 rounded-xl bg-slate-50 dark:bg-slate-800/50 border border-slate-100 dark:border-white/5 hover:border-slate-300 dark:hover:border-white/20 hover:bg-white dark:hover:bg-slate-800 transition-all group outline-none"
                                >
                                    <div className="h-10 w-10 rounded-lg bg-white dark:bg-slate-900 border border-slate-100 dark:border-white/5 flex items-center justify-center text-slate-400 group-hover:text-primary transition-all shadow-sm">
                                        <action.icon className="h-4 w-4" />
                                    </div>
                                    <span className="text-[12px] font-semibold text-slate-600 dark:text-slate-300">
                                        {action.label}
                                    </span>
                                </button>
                            ))}
                        </div>
                    </CardContent>
                </Card>
            </motion.div>

            <div className="space-y-6">
                {role === 'Supervisor' && (
                    <motion.div variants={item}>
                        <Card className="premium-glass premium-glass-hover relative overflow-hidden group border-primary/20">
                            <div className="absolute top-0 right-0 w-96 h-96 bg-primary/10 rounded-full blur-[80px] pointer-events-none -translate-y-1/2 translate-x-1/3" />
                            <CardHeader className="flex flex-row items-center justify-between relative z-10 border-b border-primary/10 pb-4">
                                <div className="space-y-1">
                                    <CardTitle className="text-xl font-bold flex items-center gap-2">
                                        <Map className="h-6 w-6 text-primary" /> Regional Portfolio Map
                                    </CardTitle>
                                    <CardDescription className="text-xs font-medium text-foreground/70">
                                        Live geographic telemetry and risk orchestration across all active regional sites.
                                    </CardDescription>
                                </div>
                                <Badge variant="outline" className="text-xs tracking-wider font-bold bg-primary/10 text-primary border-primary/30 py-1.5 px-3">
                                    Live Telemetry
                                </Badge>
                            </CardHeader>
                            <CardContent className="p-0 relative z-10 h-[400px] bg-slate-950/80 flex items-center justify-center overflow-hidden border-t border-white/5">
                                {/* Simulated Azure Map Texture / Grid */}
                                <div className="absolute inset-0 bg-[url('https://www.transparenttextures.com/patterns/blueprint.png')] opacity-10 mix-blend-overlay"></div>
                                <div className="absolute inset-0" style={{ backgroundImage: 'linear-gradient(rgba(255,255,255,0.03) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.03) 1px, transparent 1px)', backgroundSize: '50px 50px' }} />

                                {/* Topographic/Geographic Mock Lines */}
                                <svg className="absolute inset-0 w-full h-full opacity-20 pointer-events-none" xmlns="http://www.w3.org/2000/svg">
                                    <path d="M0 100 Q 200 150 400 50 T 800 200 T 1200 100" fill="none" stroke="currentColor" strokeWidth="2" className="text-primary/40" />
                                    <path d="M0 200 Q 300 300 500 150 T 900 300 T 1200 200" fill="none" stroke="currentColor" strokeWidth="1" className="text-primary/20" />
                                    <path d="M0 300 Q 400 200 600 350 T 1000 250 T 1200 350" fill="none" stroke="currentColor" strokeWidth="1" className="text-primary/10" />
                                </svg>

                                {/* Project Alpha - Safe */}
                                <div className="absolute top-[35%] left-[45%] flex flex-col items-center group/pin cursor-pointer z-20">
                                    <div className="h-5 w-5 bg-green-500 rounded-full shadow-[0_0_20px_rgba(34,197,94,0.9)] animate-pulse border-2 border-white/20" />
                                    <div className="absolute top-6 bg-black/90 backdrop-blur-md border border-white/10 px-4 py-2 rounded-lg opacity-0 group-hover/pin:opacity-100 transition-all duration-300 pointer-events-none whitespace-nowrap shadow-2xl flex flex-col gap-1 translate-y-2 group-hover/pin:translate-y-0">
                                        <p className="text-xs font-bold text-white flex items-center gap-2">Project Alpha (Mumbai) <span className="h-2 w-2 rounded-full bg-green-500"></span></p>
                                        <p className="text-[10px] text-muted-foreground font-semibold">Phase: Foundation Execution</p>
                                        <div className="h-px w-full bg-white/10 my-0.5" />
                                        <p className="text-[10px] font-bold text-green-400">Oracle Risk Index: 12 (Optimal)</p>
                                    </div>
                                </div>

                                {/* Project Beta - Critical */}
                                <div className="absolute top-[60%] left-[30%] flex flex-col items-center group/pin cursor-pointer z-20">
                                    <div className="h-5 w-5 bg-red-500 rounded-full shadow-[0_0_20px_rgba(239,68,68,0.9)] animate-pulse border-2 border-white/20" />
                                    <div className="absolute top-6 bg-black/90 backdrop-blur-md border border-white/10 px-4 py-2 rounded-lg opacity-0 group-hover/pin:opacity-100 transition-all duration-300 pointer-events-none whitespace-nowrap shadow-2xl flex flex-col gap-1 translate-y-2 group-hover/pin:translate-y-0">
                                        <p className="text-xs font-bold text-white flex items-center gap-2">Project Beta (Bangalore) <span className="h-2 w-2 rounded-full bg-red-500"></span></p>
                                        <p className="text-[10px] text-muted-foreground font-semibold">Phase: Structural Framing</p>
                                        <div className="h-px w-full bg-white/10 my-0.5" />
                                        <p className="text-[10px] font-bold text-red-500">Oracle Risk Index: 85 (Action Required)</p>
                                    </div>
                                </div>

                                {/* Project Gamma - Warning */}
                                <div className="absolute top-[40%] left-[70%] flex flex-col items-center group/pin cursor-pointer z-20">
                                    <div className="h-5 w-5 bg-amber-500 rounded-full shadow-[0_0_20px_rgba(245,158,11,0.9)] animate-pulse border-2 border-white/20" />
                                    <div className="absolute top-6 bg-black/90 backdrop-blur-md border border-white/10 px-4 py-2 rounded-lg opacity-0 group-hover/pin:opacity-100 transition-all duration-300 pointer-events-none whitespace-nowrap shadow-2xl flex flex-col gap-1 translate-y-2 group-hover/pin:translate-y-0">
                                        <p className="text-xs font-bold text-white flex items-center gap-2">Project Gamma (Kolkata) <span className="h-2 w-2 rounded-full bg-amber-500"></span></p>
                                        <p className="text-[10px] text-muted-foreground font-semibold">Phase: Site Preparation</p>
                                        <div className="h-px w-full bg-white/10 my-0.5" />
                                        <p className="text-[10px] font-bold text-amber-500">Oracle Risk Index: 45 (Review Alert)</p>
                                    </div>
                                </div>

                                <div className="absolute bottom-4 left-4 right-4 flex justify-between items-end pointer-events-none">
                                    <div className="bg-black/60 backdrop-blur-md border border-white/10 px-4 py-2 rounded-lg">
                                        <p className="text-[10px] font-bold uppercase tracking-widest text-primary opacity-80 mb-1">Regional Health Summary</p>
                                        <div className="flex gap-4">
                                            <span className="text-xs font-semibold flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-green-500"></span> 1 Optimal</span>
                                            <span className="text-xs font-semibold flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-amber-500"></span> 1 Review</span>
                                            <span className="text-xs font-semibold flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-red-500"></span> 1 Critical</span>
                                        </div>
                                    </div>
                                    <div className="bg-primary/20 backdrop-blur-md border border-primary/30 p-2 rounded-full animate-pulse shadow-[0_0_15px_rgba(var(--primary),0.3)]">
                                        <Activity className="h-5 w-5 text-primary" />
                                    </div>
                                </div>

                            </CardContent>
                        </Card>
                    </motion.div>
                )
                }



                {
                    role === 'Admin' && (
                        <motion.div variants={item} className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-stretch">

                            {/* Workspace Members Card */}
                            <Card className="premium-glass premium-glass-hover relative overflow-hidden group border-indigo-500/20 h-full flex flex-col">
                                <div className="absolute top-0 right-0 w-96 h-96 bg-indigo-500/10 rounded-full blur-[80px] pointer-events-none -translate-y-1/2 translate-x-1/3" />
                                <CardHeader className="flex flex-row items-center justify-between relative z-10 border-b border-indigo-500/10 pb-4">
                                    <div className="space-y-1">
                                        <CardTitle className="text-xl font-bold flex items-center gap-2">
                                            <Users className="h-6 w-6 text-indigo-500" /> Workspace Members
                                        </CardTitle>
                                        <CardDescription className="text-xs font-medium text-foreground/70">
                                            Manage your enterprise organization's seats and role assignments.
                                        </CardDescription>
                                    </div>
                                    <Button variant="outline" size="sm" className="h-8 border-indigo-500/30 bg-indigo-500/10 text-indigo-400 hover:bg-indigo-500/20 hover:text-indigo-300">
                                        Manage Directory
                                    </Button>
                                </CardHeader>
                                <CardContent className="p-6 relative z-10 space-y-4 flex-1">
                                    {[
                                        { n: "Dr. Sarah Chen", r: "Lead Engineer", s: "Active" },
                                        { n: "Marcus Thorne", r: "Regional Supervisor", s: "Online" },
                                        { n: "David Lin", r: "Engineer", s: "Away" },
                                    ].map((mem, i) => (
                                        <div key={i} className="flex justify-between items-center p-3 bg-white/5 border border-white/5 rounded-lg hover:border-indigo-500/30 transition-colors">
                                            <div className="flex items-center gap-3">
                                                <div className="h-8 w-8 rounded-full bg-indigo-500/20 flex items-center justify-center font-bold text-indigo-400 text-xs shadow-sm">
                                                    {mem.n[0]}
                                                </div>
                                                <div>
                                                    <p className="text-sm font-bold text-foreground lead-none">{mem.n}</p>
                                                    <p className="text-[10px] text-muted-foreground">{mem.r}</p>
                                                </div>
                                            </div>
                                            <Badge variant="outline" className={cn("text-[10px] uppercase font-bold tracking-widest px-2 py-0.5", mem.s === 'Active' ? 'text-green-500 border-green-500/30 bg-green-500/10' : mem.s === 'Online' ? 'text-blue-500 border-blue-500/30 bg-blue-500/10' : 'text-slate-400 border-slate-500/30 bg-slate-500/10')}>{mem.s}</Badge>
                                        </div>
                                    ))}
                                    <div className="pt-2 text-center">
                                        <p className="text-xs text-muted-foreground">121 other active members in network.</p>
                                    </div>
                                </CardContent>
                            </Card>

                            {/* Config Toggles */}
                            <Card className="premium-glass premium-glass-hover relative overflow-hidden group border-cyan-500/20 h-full flex flex-col">
                                <div className="absolute top-0 right-0 w-96 h-96 bg-cyan-500/10 rounded-full blur-[80px] pointer-events-none -translate-y-1/2 translate-x-1/3" />
                                <CardHeader className="flex flex-row items-center justify-between relative z-10 border-b border-cyan-500/10 pb-4">
                                    <div className="space-y-1">
                                        <CardTitle className="text-xl font-bold flex items-center gap-2">
                                            <Settings className="h-6 w-6 text-cyan-500" /> Platform Configuration
                                        </CardTitle>
                                        <CardDescription className="text-xs font-medium text-foreground/70">
                                            Toggle AI capabilities exposed to your organization. Backend engines are managed automatically.
                                        </CardDescription>
                                    </div>
                                </CardHeader>
                                <CardContent className="p-6 relative z-10 space-y-4 flex-1">
                                    {[
                                        { label: "Enable 6th Agent (Predictive Schedule)", on: true },
                                        { label: "Auto-Draft AI RFIs for Engineers", on: true },
                                        { label: "Allow Dynamic Material Substitution", on: true },
                                        { label: "Enforce Multi-Factor Auth (Admin Only)", on: false },
                                    ].map((tog, i) => (
                                        <div key={i} className="flex justify-between items-center bg-black/40 border border-white/5 p-4 rounded-xl hover:bg-white/5 transition-colors">
                                            <span className="text-sm font-semibold">{tog.label}</span>
                                            <button className={cn("relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center justify-center rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-cyan-500 focus:ring-offset-2", tog.on ? "bg-cyan-500" : "bg-slate-700")}>
                                                <span aria-hidden="true" className={cn("pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out", tog.on ? "translate-x-2" : "-translate-x-2")} />
                                            </button>
                                        </div>
                                    ))}
                                </CardContent>
                                <div className="p-4 border-t border-white/5 bg-black/40 flex justify-between items-center mt-auto">
                                    <p className="text-[10px] text-muted-foreground uppercase tracking-widest font-bold flex items-center gap-2">
                                        <ShieldCheck className="h-3 w-3 text-cyan-500" /> Master regulations synced via Azure
                                    </p>
                                </div>
                            </Card>
                        </motion.div>
                    )
                }

                <div className="grid grid-cols-1 md:grid-cols-2 gap-6 items-stretch">
                    {/* Trending Insights */}
                    <motion.div variants={item} className="h-full">
                        <Card className="premium-glass premium-glass-hover h-full flex flex-col group relative overflow-hidden">
                            <div className="absolute top-0 right-0 -mr-8 -mt-8 w-48 h-48 bg-amber-500/10 rounded-full blur-[40px] group-hover:bg-amber-500/20 transition-all pointer-events-none"></div>
                            <CardHeader className="flex flex-row items-center justify-between relative z-10">
                                <CardTitle className="flex items-center gap-2 text-lg font-bold">
                                    <Zap className="h-5 w-5 text-amber-500" /> Trending Construction Insights
                                </CardTitle>
                                <Button variant="ghost" size="icon" className="h-8 w-8 opacity-50 hover:bg-white/10"><Activity className="h-4 w-4" /></Button>
                            </CardHeader>
                            <CardContent className="space-y-4">
                                {[
                                    {
                                        title: "New BIS standards for high-rise residential projects",
                                        desc: "The Bureau of Indian Standards has updated seismic requirements for projects exceeding 70m in height.",
                                        time: "2h ago"
                                    },
                                    {
                                        title: "AI-driven cost optimization in infrastructure",
                                        desc: "How structural engineers are leveraging predictive modeling to reduce material waste by 15%.",
                                        time: "5h ago"
                                    }
                                ].map((news, i) => (
                                    <div key={i} className="p-4 rounded-lg bg-white/5 border border-white/5 hover:bg-white/10 transition-colors cursor-pointer group">
                                        <div className="flex justify-between items-start mb-1">
                                            <h4 className="font-semibold text-sm group-hover:text-primary transition-colors leading-snug">{news.title}</h4>
                                            <span className="text-[10px] opacity-40 uppercase font-bold">{news.time}</span>
                                        </div>
                                        <p className="text-xs text-muted-foreground line-clamp-2">{news.desc}</p>
                                    </div>
                                ))}
                            </CardContent>
                        </Card>
                    </motion.div>

                    {/* Structural Trends */}
                    <motion.div variants={item} className="h-full">
                        <Card className="premium-glass premium-glass-hover h-full flex flex-col group relative overflow-hidden">
                            <div className="absolute bottom-0 right-0 -mr-8 -mb-8 w-56 h-56 bg-indigo-500/10 rounded-full blur-[40px] group-hover:bg-indigo-500/20 transition-all pointer-events-none"></div>
                            <CardHeader className="relative z-10">
                                <CardTitle className="flex items-center gap-2 text-lg font-bold">
                                    <BarChart3 className="h-5 w-5 text-blue-500" /> Structural Trends & Material Utilization
                                </CardTitle>
                            </CardHeader>
                            <CardContent className="grid grid-cols-1 md:grid-cols-3 gap-10">
                                {[
                                    { label: infralithResult?.parsedBlueprint?.materials?.[0]?.item || 'Reinforcement Steel', val: infralithResult ? 75 : 75, color: 'bg-blue-500', desc: 'Critical Path Material' },
                                    { label: infralithResult?.parsedBlueprint?.materials?.[1]?.item || 'Ready-mix Concrete', val: infralithResult ? 45 : 45, color: 'bg-emerald-500', desc: 'Active procurement phase' },
                                    { label: 'Structural Timber', val: 25, color: 'bg-amber-500', desc: 'Low priority inventory' },
                                ].map((trend, i) => (
                                    <div key={i} className="space-y-3">
                                        <div className="flex justify-between text-xs font-bold uppercase tracking-wider opacity-60">
                                            <span className="truncate">{trend.label}</span>
                                            <span>{trend.val}%</span>
                                        </div>
                                        <div className="h-3 w-full bg-white/5 rounded-full overflow-hidden">
                                            <motion.div
                                                initial={{ width: 0 }}
                                                animate={{ width: `${trend.val}%` }}
                                                transition={{ duration: 1, delay: i * 0.2 }}
                                                className={cn("h-full rounded-full", trend.color)}
                                            />
                                        </div>
                                        <p className="text-[10px] text-muted-foreground italic">{trend.desc}</p>
                                    </div>
                                ))}
                            </CardContent>
                            <div className="bg-primary/5 p-4 border-t border-white/5 text-center mt-auto">
                                <p className="text-[10px] text-muted-foreground uppercase tracking-widest font-bold">
                                    AI-aggregated data based on {infralithResult ? 'your blueprint' : '124 active regional projects'}.
                                </p>
                            </div>
                        </Card>
                    </motion.div>
                </div>
            </div >
        </motion.div >
    );
}
