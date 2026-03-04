'use client';

import { useState, useEffect } from 'react';
import { auditLog, AuditEntry, AuditAction } from '@/lib/audit-log';
import { useAppContext } from '@/contexts/app-context';
import { cn } from '@/lib/utils';
import {
    ClipboardList, Shield, Download, RefreshCw, CheckCircle2,
    LogIn, LogOut, Upload, BarChart2, Eye, FileDown, ThumbsUp, ThumbsDown,
    Bell, Settings, Trash2, UserPlus, Megaphone, MessageSquare, Lock, AlertCircle
} from 'lucide-react';
import { Button } from '@/components/ui/button';

const ACTION_META: Record<AuditAction, { label: string; icon: any; color: string }> = {
    USER_LOGIN: { label: 'User Login', icon: LogIn, color: 'text-emerald-500' },
    USER_LOGOUT: { label: 'User Logout', icon: LogOut, color: 'text-slate-400' },
    BLUEPRINT_UPLOADED: { label: 'Blueprint Uploaded', icon: Upload, color: 'text-blue-500' },
    ANALYSIS_COMPLETE: { label: 'Analysis Complete', icon: BarChart2, color: 'text-amber-500' },
    REPORT_VIEWED: { label: 'Report Viewed', icon: Eye, color: 'text-purple-500' },
    REPORT_EXPORTED: { label: 'Report Exported', icon: FileDown, color: 'text-teal-500' },
    PROJECT_APPROVED: { label: 'Project Approved', icon: ThumbsUp, color: 'text-emerald-500' },
    PROJECT_REJECTED: { label: 'Project Rejected', icon: ThumbsDown, color: 'text-rose-500' },
    APPROVAL_REQUESTED: { label: 'Approval Requested', icon: Bell, color: 'text-amber-400' },
    SETTINGS_CHANGED: { label: 'Settings Changed', icon: Settings, color: 'text-slate-500' },
    USER_CREATED: { label: 'User Created', icon: UserPlus, color: 'text-emerald-600' },
    USER_DELETED: { label: 'User Deleted', icon: Trash2, color: 'text-rose-600' },
    ANNOUNCEMENT_SENT: { label: 'Announcement Sent', icon: Megaphone, color: 'text-orange-500' },
    MESSAGE_SENT: { label: 'Message Sent', icon: MessageSquare, color: 'text-blue-400' },
    ADMIN_ACCESS: { label: 'Admin Access', icon: Lock, color: 'text-rose-400' },
};

function fmtTime(iso: string): string {
    const d = new Date(iso);
    return d.toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: true });
}

function roleColor(role: string): string {
    if (role === 'Admin') return 'bg-rose-50 dark:bg-rose-900/30 text-rose-600 dark:text-rose-400 border-rose-200 dark:border-rose-700';
    if (role === 'Supervisor') return 'bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400 border-blue-200 dark:border-blue-700';
    return 'bg-amber-50 dark:bg-amber-900/30 text-amber-600 dark:text-amber-400 border-amber-200 dark:border-amber-700';
}

export default function AuditLogPanel() {
    const { user } = useAppContext();
    const [entries, setEntries] = useState<AuditEntry[]>([]);
    const [filter, setFilter] = useState<AuditAction | 'ALL'>('ALL');
    const [refreshKey, setRefreshKey] = useState(0);

    const isPrivileged = user?.role === 'Admin' || user?.role === 'Supervisor';

    useEffect(() => {
        setEntries(auditLog.getAll());
    }, [refreshKey]);

    const displayed = filter === 'ALL' ? entries : entries.filter(e => e.action === filter);

    const stats = auditLog.getUsageStats();
    const userActivity = auditLog.getUserActivity().slice(0, 5);

    const exportCSV = () => {
        const headers = 'Timestamp,Action,Actor Name,Actor Role,Actor Email,Metadata Hash\n';
        const rows = entries.map(e =>
            `"${e.timestamp}","${e.action}","${e.actorName}","${e.actorRole}","${e.actorEmail}","${e.hash}"`
        ).join('\n');
        const blob = new Blob([headers + rows], { type: 'text/csv' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = `infralith-audit-${Date.now()}.csv`;
        a.click(); URL.revokeObjectURL(url);
    };

    return (
        <div className="max-w-6xl mx-auto space-y-8 pb-12">
            {/* Header */}
            <div className="space-y-1">
                <div className="flex items-center gap-3">
                    <div className="h-11 w-11 bg-rose-50 dark:bg-rose-900/30 rounded-2xl flex items-center justify-center border border-rose-100 dark:border-rose-800 shadow-sm">
                        <ClipboardList className="h-5 w-5 text-rose-500" />
                    </div>
                    <h1 className="text-3xl font-black tracking-tight text-slate-900 dark:text-white">Audit Log</h1>
                </div>
                <p className="text-slate-500 font-semibold ml-14 text-sm">
                    Immutable action ledger — every platform event is recorded, hashed and timestamped.
                </p>
            </div>

            {/* Access Warning */}
            {!isPrivileged && (
                <div className="flex items-start gap-3 p-4 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700 rounded-2xl">
                    <AlertCircle className="h-5 w-5 text-amber-500 shrink-0 mt-0.5" />
                    <p className="text-sm text-amber-700 dark:text-amber-300 font-semibold">
                        You are viewing your own audit trail. Supervisor or Admin access is required to view the full platform ledger.
                    </p>
                </div>
            )}

            {/* Stats Row */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                {[
                    { label: 'Total Events', value: entries.length, icon: ClipboardList, color: 'text-slate-600 dark:text-slate-300', bg: 'bg-slate-50 dark:bg-slate-800' },
                    { label: 'Blueprints Analyzed', value: stats['ANALYSIS_COMPLETE'] || 0, icon: BarChart2, color: 'text-amber-500', bg: 'bg-amber-50 dark:bg-amber-900/30' },
                    { label: 'Approvals Logged', value: (stats['PROJECT_APPROVED'] || 0) + (stats['PROJECT_REJECTED'] || 0), icon: Shield, color: 'text-emerald-500', bg: 'bg-emerald-50 dark:bg-emerald-900/30' },
                    { label: 'Active Users', value: userActivity.length, icon: UserPlus, color: 'text-blue-500', bg: 'bg-blue-50 dark:bg-blue-900/30' },
                ].map(s => (
                    <div key={s.label} className="bg-white dark:bg-slate-900 rounded-[20px] border border-slate-100 dark:border-slate-800 p-5 shadow-sm">
                        <div className={cn("h-9 w-9 rounded-xl flex items-center justify-center mb-3", s.bg)}>
                            <s.icon className={cn("h-4.5 w-4.5", s.color)} />
                        </div>
                        <p className="text-2xl font-black text-slate-900 dark:text-white">{s.value}</p>
                        <p className="text-[10px] font-black uppercase tracking-widest text-slate-400 mt-1">{s.label}</p>
                    </div>
                ))}
            </div>

            {/* User Activity (Admin only) */}
            {isPrivileged && userActivity.length > 0 && (
                <div className="bg-white dark:bg-slate-900 rounded-[24px] border border-slate-100 dark:border-slate-800 shadow-sm overflow-hidden">
                    <div className="px-7 py-5 border-b border-slate-100 dark:border-slate-800">
                        <h2 className="text-sm font-black text-slate-900 dark:text-white uppercase tracking-widest">Top Active Users</h2>
                    </div>
                    <div className="divide-y divide-slate-100 dark:divide-slate-800">
                        {userActivity.map((u, i) => (
                            <div key={u.email} className="px-7 py-4 flex items-center justify-between">
                                <div className="flex items-center gap-4">
                                    <span className="text-[11px] font-black text-slate-400 w-5">#{i + 1}</span>
                                    <div>
                                        <p className="text-sm font-bold text-slate-900 dark:text-slate-100">{u.name}</p>
                                        <p className="text-xs text-slate-400">{u.email}</p>
                                    </div>
                                </div>
                                <div className="flex items-center gap-3">
                                    <span className={cn("px-2.5 py-1 text-[10px] font-black rounded-full border", roleColor(u.role))}>{u.role}</span>
                                    <span className="text-sm font-black text-slate-900 dark:text-slate-100">{u.count} events</span>
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {/* Log Table */}
            <div className="bg-white dark:bg-slate-900 rounded-[24px] border border-slate-100 dark:border-slate-800 shadow-sm overflow-hidden">
                {/* Controls */}
                <div className="px-7 py-5 border-b border-slate-100 dark:border-slate-800 flex flex-wrap items-center justify-between gap-4">
                    <div className="flex items-center gap-2 flex-wrap">
                        {(['ALL', 'BLUEPRINT_UPLOADED', 'ANALYSIS_COMPLETE', 'PROJECT_APPROVED', 'PROJECT_REJECTED', 'USER_LOGIN'] as const).map(f => (
                            <button
                                key={f}
                                onClick={() => setFilter(f)}
                                className={cn(
                                    "px-3 py-1.5 rounded-full text-[11px] font-black uppercase tracking-wider border transition-all",
                                    filter === f
                                        ? "bg-slate-900 dark:bg-white text-white dark:text-slate-900 border-slate-900 dark:border-white"
                                        : "text-slate-500 border-slate-200 dark:border-slate-700 hover:border-slate-400"
                                )}
                            >
                                {f === 'ALL' ? 'All Events' : ACTION_META[f as AuditAction]?.label || f}
                            </button>
                        ))}
                    </div>
                    <div className="flex items-center gap-2">
                        <Button variant="ghost" size="sm" onClick={() => setRefreshKey(k => k + 1)} className="h-8 w-8 p-0 text-slate-400 hover:text-slate-600">
                            <RefreshCw className="h-3.5 w-3.5" />
                        </Button>
                        <Button variant="ghost" size="sm" onClick={exportCSV} className="gap-1.5 text-slate-500 hover:text-slate-700 font-bold h-8 px-3 text-xs">
                            <Download className="h-3.5 w-3.5" /> Export CSV
                        </Button>
                    </div>
                </div>

                {/* Table Header */}
                <div className="grid grid-cols-[1fr_2fr_2fr_1fr_1.5fr] gap-4 px-7 py-3 bg-slate-50 dark:bg-slate-800/50 text-[10px] font-black uppercase tracking-widest text-slate-400">
                    <span>Time</span>
                    <span>Action</span>
                    <span>Actor</span>
                    <span>Role</span>
                    <span>Integrity</span>
                </div>

                {/* Entries */}
                {displayed.length === 0 ? (
                    <div className="text-center py-16">
                        <ClipboardList className="h-10 w-10 text-slate-200 dark:text-slate-700 mx-auto mb-3" />
                        <p className="text-sm font-bold text-slate-400">No audit events recorded yet.</p>
                        <p className="text-xs text-slate-300 dark:text-slate-600 mt-1">Events will appear here after platform activity.</p>
                    </div>
                ) : (
                    <div className="divide-y divide-slate-100 dark:divide-slate-800 max-h-[520px] overflow-y-auto">
                        {displayed.map((entry) => {
                            const meta = ACTION_META[entry.action];
                            const Icon = meta?.icon || ClipboardList;
                            return (
                                <div key={entry.id} className="grid grid-cols-[1fr_2fr_2fr_1fr_1.5fr] gap-4 px-7 py-4 hover:bg-slate-50 dark:hover:bg-slate-800/50 transition-colors items-center">
                                    <span className="text-[11px] font-mono text-slate-400">{fmtTime(entry.timestamp)}</span>
                                    <div className="flex items-center gap-2.5">
                                        <div className={cn("h-7 w-7 rounded-lg bg-slate-50 dark:bg-slate-800 flex items-center justify-center shrink-0", meta?.color)}>
                                            <Icon className="h-3.5 w-3.5" />
                                        </div>
                                        <span className="text-xs font-bold text-slate-800 dark:text-slate-100">{meta?.label || entry.action}</span>
                                    </div>
                                    <div>
                                        <p className="text-xs font-bold text-slate-800 dark:text-slate-100">{entry.actorName}</p>
                                        <p className="text-[10px] text-slate-400 truncate">{entry.actorEmail}</p>
                                    </div>
                                    <span className={cn("px-2 py-0.5 text-[10px] font-black rounded-full border w-fit", roleColor(entry.actorRole))}>
                                        {entry.actorRole}
                                    </span>
                                    <div className="flex items-center gap-1.5">
                                        <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500 shrink-0" />
                                        <span className="text-[10px] font-mono text-emerald-600 dark:text-emerald-400">{entry.hash}</span>
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>
        </div>
    );
}
