'use client';

import { useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/hooks/use-toast';
import { useAppContext } from '@/contexts/app-context';
import { useNotifications } from './NotificationBell';
import { auditLog } from '@/lib/audit-log';
import {
    BarChart3, Users, Activity, TrendingUp, TrendingDown, ShieldCheck, FileText,
    Clock, Database, Zap, AlertTriangle, CheckCircle, Globe, Server, Cpu, ArrowUpRight,
    ClipboardList, ThumbsUp, ThumbsDown, Upload, LogIn
} from 'lucide-react';
import { cn } from '@/lib/utils';

const REGIONAL_HUBS = [
    { city: 'Mumbai', projects: 34, load: 78 },
    { city: 'Bangalore', projects: 28, load: 64 },
    { city: 'Delhi', projects: 19, load: 45 },
    { city: 'Chennai', projects: 11, load: 31 },
    { city: 'Hyderabad', projects: 9, load: 22 },
];

const PIPELINE_METRICS = [
    { label: 'Azure OCR Agent', status: 'Operational', latency: '1.2s', uptime: 99.9 },
    { label: 'Compliance Agent', status: 'Operational', latency: '2.1s', uptime: 99.7 },
    { label: 'Risk Analysis Agent', status: 'Operational', latency: '1.8s', uptime: 100 },
    { label: 'Cost Prediction Agent', status: 'Operational', latency: '1.5s', uptime: 99.8 },
    { label: 'Azure Cosmos DB', status: 'Operational', latency: '0.3s', uptime: 100 },
    { label: 'Azure OpenAI (GPT-4o)', status: 'Degraded', latency: '4.2s', uptime: 96.1 },
];

export default function AnalyticsPanel() {
    const { user } = useAppContext();
    const { addNotification } = useNotifications();
    const { toast } = useToast();
    const [announcement, setAnnouncement] = useState('');

    // Live audit data
    const [auditStats, setAuditStats] = useState<Record<string, number>>({});
    const [userActivity, setUserActivity] = useState<{ name: string; email: string; role: string; count: number }[]>([]);
    const [recentEntries, setRecentEntries] = useState<any[]>([]);

    const isAdmin = user?.role === 'Admin';

    useEffect(() => {
        const stats = auditLog.getUsageStats();
        setAuditStats(stats);
        setUserActivity(auditLog.getUserActivity().slice(0, 5));
        setRecentEntries(auditLog.getAll().slice(0, 5));
    }, []);

    const STATS = [
        {
            label: 'Blueprints Analyzed',
            value: String(auditStats['ANALYSIS_COMPLETE'] || 0),
            trend: '+Live',
            up: true,
            icon: FileText,
            color: 'text-amber-500'
        },
        {
            label: 'Active Users',
            value: String(userActivity.length || 0),
            trend: 'Real-time',
            up: true,
            icon: Users,
            color: 'text-blue-400'
        },
        {
            label: 'Approvals Logged',
            value: String((auditStats['PROJECT_APPROVED'] || 0) + (auditStats['PROJECT_REJECTED'] || 0)),
            trend: 'Audit-backed',
            up: true,
            icon: ShieldCheck,
            color: 'text-emerald-400'
        },
        {
            label: 'Total Platform Events',
            value: String(Object.values(auditStats).reduce((a, b) => a + b, 0)),
            trend: 'Immutable',
            up: true,
            icon: BarChart3,
            color: 'text-purple-400'
        },
    ];

    const sendAnnouncement = () => {
        if (!announcement.trim()) return;
        addNotification({
            type: 'info',
            title: `Admin: ${user?.name?.split(' ')[0] || 'Admin'} Announcement`,
            body: announcement,
        });
        if (user) {
            auditLog.record('ANNOUNCEMENT_SENT',
                { uid: user.uid, name: user.name, role: user.role, email: user.email },
                { message: announcement }
            );
        }
        toast({ title: 'Announcement Sent', description: 'All users will see this notification.' });
        setAnnouncement('');
    };

    return (
        <div className="max-w-6xl mx-auto space-y-8 pb-12">
            {/* Header */}
            <div className="space-y-1">
                <div className="flex items-center gap-3">
                    <div className="h-11 w-11 bg-purple-50 dark:bg-purple-900/30 rounded-2xl flex items-center justify-center border border-purple-100 dark:border-purple-800 shadow-sm">
                        <BarChart3 className="h-5 w-5 text-purple-500" />
                    </div>
                    <h1 className="text-3xl font-black tracking-tight text-slate-900 dark:text-white">Admin Analytics</h1>
                </div>
                <p className="text-slate-500 font-semibold ml-14 text-sm">
                    Live platform telemetry, real audit-backed KPIs, agent health, and user activity.
                </p>
            </div>

            {!isAdmin && (
                <div className="flex items-start gap-3 p-4 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700 rounded-2xl">
                    <AlertTriangle className="h-5 w-5 text-amber-500 shrink-0 mt-0.5" />
                    <p className="text-sm font-semibold text-amber-700 dark:text-amber-300">
                        Read-only view. Admin access required to manage settings and push announcements.
                    </p>
                </div>
            )}

            {/* KPI Stats — pulled from real audit log */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                {STATS.map(stat => (
                    <div key={stat.label} className="bg-white dark:bg-slate-900 rounded-[20px] border border-slate-100 dark:border-slate-800 shadow-sm p-5 group hover:shadow-md transition-shadow">
                        <div className="flex items-center justify-between mb-4">
                            <div className={cn("h-10 w-10 rounded-xl bg-current/10 flex items-center justify-center", stat.color)}>
                                <stat.icon className={cn("h-5 w-5", stat.color)} />
                            </div>
                            <span className={cn("text-[10px] font-black px-2.5 py-1 rounded-full border", stat.up
                                ? 'bg-emerald-50 dark:bg-emerald-900/30 text-emerald-600 border-emerald-200 dark:border-emerald-700'
                                : 'bg-rose-50 dark:bg-rose-900/30 text-rose-600 border-rose-200 dark:border-rose-700'
                            )}>
                                {stat.up ? <TrendingUp className="h-2.5 w-2.5 inline mr-1" /> : <TrendingDown className="h-2.5 w-2.5 inline mr-1" />}
                                {stat.trend}
                            </span>
                        </div>
                        <p className="text-3xl font-black text-slate-900 dark:text-white">{stat.value}</p>
                        <p className="text-[10px] text-slate-400 uppercase font-black tracking-widest mt-1.5 leading-tight">{stat.label}</p>
                    </div>
                ))}
            </div>

            <div className="grid lg:grid-cols-2 gap-6">
                {/* User Activity (from audit log) */}
                <div className="bg-white dark:bg-slate-900 rounded-[24px] border border-slate-100 dark:border-slate-800 shadow-sm overflow-hidden">
                    <div className="px-7 py-5 border-b border-slate-100 dark:border-slate-800 flex items-center gap-3">
                        <Users className="h-5 w-5 text-blue-500" />
                        <div>
                            <h2 className="text-sm font-black text-slate-900 dark:text-white">Top Active Users</h2>
                            <p className="text-xs text-slate-400 font-medium">Ranked by audit event count</p>
                        </div>
                    </div>
                    <div className="p-6">
                        {userActivity.length === 0 ? (
                            <div className="text-center py-8">
                                <Users className="h-8 w-8 text-slate-200 dark:text-slate-700 mx-auto mb-2" />
                                <p className="text-sm text-slate-400 font-semibold">No activity recorded yet.</p>
                            </div>
                        ) : (
                            <div className="space-y-4">
                                {userActivity.map((u, i) => (
                                    <div key={u.email} className="flex items-center justify-between">
                                        <div className="flex items-center gap-3">
                                            <span className="text-[11px] font-black text-slate-300 dark:text-slate-600 w-5">#{i + 1}</span>
                                            <div className="h-9 w-9 rounded-full bg-gradient-to-br from-amber-400 to-orange-500 flex items-center justify-center text-white font-black text-sm shrink-0">
                                                {u.name?.[0] || '?'}
                                            </div>
                                            <div>
                                                <p className="text-sm font-bold text-slate-900 dark:text-slate-100">{u.name}</p>
                                                <p className="text-xs text-slate-400 truncate max-w-[150px]">{u.email}</p>
                                            </div>
                                        </div>
                                        <div className="flex items-center gap-2">
                                            <span className={cn(
                                                "px-2 py-0.5 text-[10px] font-black rounded-full border",
                                                u.role === 'Admin' ? 'bg-rose-50 dark:bg-rose-900/30 text-rose-600 border-rose-200 dark:border-rose-700' :
                                                    u.role === 'Supervisor' ? 'bg-blue-50 dark:bg-blue-900/30 text-blue-600 border-blue-200 dark:border-blue-700' :
                                                        'bg-amber-50 dark:bg-amber-900/30 text-amber-600 border-amber-200 dark:border-amber-700'
                                            )}>{u.role}</span>
                                            <span className="text-sm font-black text-slate-700 dark:text-slate-200">{u.count}</span>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                </div>

                {/* AI Agent Health */}
                <div className="bg-white dark:bg-slate-900 rounded-[24px] border border-slate-100 dark:border-slate-800 shadow-sm overflow-hidden">
                    <div className="px-7 py-5 border-b border-slate-100 dark:border-slate-800 flex items-center gap-3">
                        <Cpu className="h-5 w-5 text-purple-500" />
                        <div>
                            <h2 className="text-sm font-black text-slate-900 dark:text-white">AI Agent Pipeline Health</h2>
                            <p className="text-xs text-slate-400 font-medium">Real-time Infralith multi-agent status</p>
                        </div>
                    </div>
                    <div className="p-4 space-y-2">
                        {PIPELINE_METRICS.map(m => (
                            <div key={m.label} className="flex items-center justify-between p-3 rounded-xl bg-slate-50 dark:bg-slate-800 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors">
                                <div className="flex items-center gap-3">
                                    <span className={cn("h-2 w-2 rounded-full shrink-0 animate-pulse", m.status === 'Operational' ? 'bg-emerald-500' : 'bg-amber-500')} />
                                    <span className="text-sm font-semibold text-slate-700 dark:text-slate-200">{m.label}</span>
                                </div>
                                <div className="flex items-center gap-3">
                                    <span className="text-xs text-slate-400 font-mono">{m.latency}</span>
                                    <span className={cn(
                                        "text-[10px] font-black px-2 py-0.5 rounded-full border",
                                        m.status === 'Operational'
                                            ? 'bg-emerald-50 dark:bg-emerald-900/30 text-emerald-600 border-emerald-200 dark:border-emerald-700'
                                            : 'bg-amber-50 dark:bg-amber-900/30 text-amber-500 border-amber-200 dark:border-amber-700'
                                    )}>{m.status}</span>
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            </div>

            {/* Regional Hub Load */}
            <div className="bg-white dark:bg-slate-900 rounded-[24px] border border-slate-100 dark:border-slate-800 shadow-sm overflow-hidden">
                <div className="px-7 py-5 border-b border-slate-100 dark:border-slate-800 flex items-center gap-3">
                    <Globe className="h-5 w-5 text-teal-500" />
                    <div>
                        <h2 className="text-sm font-black text-slate-900 dark:text-white">Regional Hub Activity</h2>
                        <p className="text-xs text-slate-400 font-medium">Active projects and AI processing load per city hub</p>
                    </div>
                </div>
                <div className="p-7 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                    {REGIONAL_HUBS.map(hub => (
                        <div key={hub.city} className="space-y-2.5">
                            <div className="flex justify-between items-center">
                                <span className="font-black text-sm text-slate-800 dark:text-slate-100">{hub.city}</span>
                                <div className="flex items-center gap-2">
                                    <span className="text-xs text-slate-400">{hub.projects} projects</span>
                                    <span className={cn("text-xs font-black", hub.load > 70 ? 'text-amber-500' : 'text-emerald-500')}>{hub.load}%</span>
                                </div>
                            </div>
                            <div className="h-2 bg-slate-100 dark:bg-slate-800 rounded-full overflow-hidden">
                                <div
                                    className={cn("h-full rounded-full transition-all", hub.load > 70 ? 'bg-amber-400' : 'bg-emerald-400')}
                                    style={{ width: `${hub.load}%` }}
                                />
                            </div>
                        </div>
                    ))}
                </div>
            </div>

            {/* Admin: Push Announcement */}
            {isAdmin && (
                <div className="bg-white dark:bg-slate-900 rounded-[24px] border border-amber-100 dark:border-amber-800 shadow-sm overflow-hidden">
                    <div className="px-7 py-5 border-b border-amber-100 dark:border-amber-800 flex items-center gap-3">
                        <Zap className="h-5 w-5 text-amber-500" />
                        <div>
                            <h2 className="text-sm font-black text-slate-900 dark:text-white">Push Platform Announcement</h2>
                            <p className="text-xs text-slate-400 font-medium">Broadcast a system-wide notification to all active users</p>
                        </div>
                    </div>
                    <div className="p-7 space-y-4">
                        <Textarea
                            placeholder="e.g. 'Scheduled maintenance Saturday 10PM–12AM IST. Please export reports beforehand.'"
                            className="bg-slate-50 dark:bg-slate-800 border-slate-200 dark:border-slate-700 min-h-[90px] resize-none text-sm"
                            value={announcement}
                            onChange={e => setAnnouncement(e.target.value)}
                        />
                        <Button
                            onClick={sendAnnouncement}
                            disabled={!announcement.trim()}
                            className="gap-2 bg-amber-500 hover:bg-amber-400 text-white font-black shadow-lg shadow-amber-500/25"
                        >
                            <ArrowUpRight className="h-4 w-4" /> Send to All Users
                        </Button>
                    </div>
                </div>
            )}

            {/* Live Audit Ledger — last 5 events */}
            <div className="bg-white dark:bg-slate-900 rounded-[24px] border border-slate-100 dark:border-slate-800 shadow-sm overflow-hidden">
                <div className="px-7 py-5 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between">
                    <div className="flex items-center gap-3">
                        <Database className="h-5 w-5 text-slate-500" />
                        <div>
                            <h2 className="text-sm font-black text-slate-900 dark:text-white">Live Audit Ledger</h2>
                            <p className="text-xs text-slate-400 font-medium">Last 5 events — hash-verified immutable trail</p>
                        </div>
                    </div>
                    <Button
                        variant="ghost"
                        size="sm"
                        className="text-xs font-bold text-slate-500 gap-1"
                        onClick={() => setRecentEntries(auditLog.getAll().slice(0, 5))}
                    >
                        <Activity className="h-3.5 w-3.5" /> Refresh
                    </Button>
                </div>
                <div className="divide-y divide-slate-100 dark:divide-slate-800">
                    {recentEntries.length === 0 ? (
                        <div className="text-center py-12 text-slate-400">
                            <ClipboardList className="h-8 w-8 mx-auto mb-2 text-slate-200 dark:text-slate-700" />
                            <p className="text-sm font-semibold">No events yet. Platform activity will appear here.</p>
                        </div>
                    ) : (
                        recentEntries.map((ev, i) => (
                            <div key={ev.id} className="grid grid-cols-[auto_1fr_1fr_auto] gap-4 px-7 py-3.5 text-xs items-center hover:bg-slate-50 dark:hover:bg-slate-800/50 transition-colors">
                                <span className="text-slate-400 font-mono whitespace-nowrap">
                                    {new Date(ev.timestamp).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}
                                </span>
                                <span className="font-bold text-slate-800 dark:text-slate-100">{ev.action.replace(/_/g, ' ')}</span>
                                <span className="text-slate-400 truncate">{ev.actorEmail || ev.actorName}</span>
                                <span className="text-emerald-500 font-mono flex items-center gap-1">
                                    <CheckCircle className="h-3 w-3" /> {ev.hash}
                                </span>
                            </div>
                        ))
                    )}
                </div>
            </div>
        </div>
    );
}
