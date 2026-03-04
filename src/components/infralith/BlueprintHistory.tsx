'use client';

import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import {
    FileText,
    CheckCircle,
    AlertCircle,
    XCircle,
    Database,
    UploadCloud
} from 'lucide-react';
import { useAppContext } from '@/contexts/app-context';
import { cn } from '@/lib/utils';
import { motion } from 'framer-motion';
import { infralithService } from '@/lib/services';
import { format } from 'date-fns';

type BlueprintRecord = {
    id: string;
    fileName: string;
    projectScope: string;
    timestamp: string;
    overallStatus: 'Warning' | 'Pass' | 'Fail';
};

export default function BlueprintHistory() {
    const { user, handleNavigate } = useAppContext();
    const [history, setHistory] = useState<BlueprintRecord[]>([]);
    const [isLoading, setIsLoading] = useState(true);

    useEffect(() => {
        const loadHistory = async () => {
            if (!user?.uid) return;
            setIsLoading(true);
            try {
                const data = await infralithService.getEvaluations(user.uid);
                const mapped: BlueprintRecord[] = data.map((res: any) => ({
                    id: res.id,
                    fileName: res.fileName || 'blueprint.pdf',
                    projectScope: res.projectScope || 'Unnamed Project',
                    timestamp: res.timestamp,
                    overallStatus: res.complianceReport?.overallStatus === 'Pass' ? 'Pass' : res.complianceReport?.overallStatus === 'Fail' ? 'Fail' : 'Warning',
                }));
                setHistory(mapped);
            } catch (e) {
                console.error("Failed to load history:", e);
            } finally {
                setIsLoading(false);
            }
        };
        loadHistory();
    }, [user?.uid]);

    const statusConfig = {
        Pass: { color: 'text-emerald-600', bg: 'bg-emerald-50 dark:bg-emerald-900/30', border: 'border-emerald-100 dark:border-emerald-800', icon: CheckCircle, label: 'Passed' },
        Warning: { color: 'text-amber-600', bg: 'bg-amber-50 dark:bg-amber-900/30', border: 'border-amber-100 dark:border-amber-800', icon: AlertCircle, label: 'Warnings' },
        Fail: { color: 'text-rose-600', bg: 'bg-rose-50 dark:bg-rose-900/30', border: 'border-rose-100 dark:border-rose-800', icon: XCircle, label: 'Failed' },
    };

    const stats = [
        { label: 'Total Analyses', value: history.length, color: 'text-amber-600' },
        { label: 'Passed', value: history.filter(b => b.overallStatus === 'Pass').length, color: 'text-emerald-500' },
        { label: 'Warnings', value: history.filter(b => b.overallStatus === 'Warning').length, color: 'text-amber-500' },
        { label: 'Failed', value: history.filter(b => b.overallStatus === 'Fail').length, color: 'text-rose-500' },
    ];

    return (
        <div className="w-full space-y-8 pb-12">
            {/* Header */}
            <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
                <div className="space-y-1">
                    <div className="flex items-center gap-3">
                        <Database className="h-7 w-7 text-amber-500" />
                        <h1 className="text-3xl font-black tracking-tight text-slate-900 dark:text-white">Blueprint History</h1>
                    </div>
                    <p className="text-slate-500 font-semibold ml-10">All past AI analysis records stored in your Azure Cosmos DB workspace.</p>
                </div>
                <Button
                    onClick={() => handleNavigate('upload')}
                    className="bg-amber-500 hover:bg-amber-400 text-white font-bold h-11 px-6 rounded-xl shadow-lg shadow-amber-500/20 gap-2 shrink-0"
                >
                    <UploadCloud className="h-4 w-4" /> Upload New Blueprint
                </Button>
            </div>

            {/* Stats Row */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-5">
                {stats.map((stat, i) => (
                    <div key={i} className="bg-white dark:bg-slate-900 rounded-[20px] border border-slate-100 dark:border-slate-800 shadow-sm p-6 text-center">
                        <p className={cn("text-4xl font-black tracking-tighter mb-1", stat.color)}>{stat.value}</p>
                        <p className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-400">{stat.label}</p>
                    </div>
                ))}
            </div>

            {/* Table */}
            <div className="bg-white dark:bg-slate-900 rounded-[28px] shadow-[0_8px_40px_-12px_rgba(0,0,0,0.06)] border border-slate-100 dark:border-slate-800 overflow-hidden">
                <div className="overflow-x-auto">
                    <table className="w-full text-left border-collapse">
                        <thead>
                            <tr className="border-b border-slate-100 dark:border-slate-800">
                                <th className="px-8 py-5 text-[11px] font-black uppercase tracking-[0.15em] text-slate-400">Blueprint Name</th>
                                <th className="px-8 py-5 text-[11px] font-black uppercase tracking-[0.15em] text-slate-400">Date</th>
                                <th className="px-8 py-5 text-[11px] font-black uppercase tracking-[0.15em] text-slate-400 text-center">Status</th>
                                <th className="px-8 py-5 text-[11px] font-black uppercase tracking-[0.15em] text-slate-400 text-right">Action</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-50 dark:divide-slate-800">
                            {isLoading ? (
                                <tr>
                                    <td colSpan={4} className="py-16 text-center">
                                        <div className="flex flex-col items-center gap-3">
                                            <div className="h-8 w-8 border-4 border-amber-500/20 border-t-amber-500 rounded-full animate-spin" />
                                            <span className="text-sm font-bold text-slate-400">Loading records...</span>
                                        </div>
                                    </td>
                                </tr>
                            ) : history.length === 0 ? (
                                <tr>
                                    <td colSpan={4} className="py-16 text-center">
                                        <div className="flex flex-col items-center gap-2 opacity-30">
                                            <FileText className="h-10 w-10 text-slate-400" />
                                            <span className="text-sm font-bold text-slate-500">No blueprints analyzed yet.</span>
                                        </div>
                                    </td>
                                </tr>
                            ) : (
                                history.map((record, i) => {
                                    const config = statusConfig[record.overallStatus];
                                    return (
                                        <motion.tr
                                            key={record.id}
                                            initial={{ opacity: 0, y: 8 }}
                                            animate={{ opacity: 1, y: 0 }}
                                            transition={{ delay: i * 0.04 }}
                                            className="group hover:bg-slate-50/80 dark:hover:bg-slate-800/40 transition-colors"
                                        >
                                            <td className="px-8 py-5">
                                                <div className="flex items-center gap-3">
                                                    <div className="h-9 w-9 rounded-xl bg-slate-50 dark:bg-slate-800 flex items-center justify-center border border-slate-100 dark:border-slate-700 shrink-0">
                                                        <FileText className="h-4 w-4 text-slate-400" />
                                                    </div>
                                                    <span className="font-bold text-slate-800 dark:text-slate-100">{record.projectScope}</span>
                                                </div>
                                            </td>
                                            <td className="px-8 py-5">
                                                <span className="text-sm font-semibold text-slate-500 dark:text-slate-400">
                                                    {format(new Date(record.timestamp), 'MMM dd, yyyy')}
                                                </span>
                                            </td>
                                            <td className="px-8 py-5 text-center">
                                                <div className="flex justify-center">
                                                    <span className={cn(
                                                        "inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full border text-[11px] font-black uppercase tracking-wider",
                                                        config.bg, config.color, config.border
                                                    )}>
                                                        <config.icon className="h-3.5 w-3.5" strokeWidth={2.5} />
                                                        {config.label}
                                                    </span>
                                                </div>
                                            </td>
                                            <td className="px-8 py-5 text-right">
                                                <button
                                                    onClick={() => handleNavigate('report')}
                                                    className="text-sm font-black text-slate-400 hover:text-amber-500 dark:hover:text-amber-400 transition-colors uppercase tracking-widest"
                                                >
                                                    View
                                                </button>
                                            </td>
                                        </motion.tr>
                                    );
                                })
                            )}
                        </tbody>
                    </table>
                </div>
            </div>
        </div>
    );
}
