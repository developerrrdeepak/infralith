'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Slider } from '@/components/ui/slider';
import { useToast } from '@/hooks/use-toast';
import {
    Loader2, ShieldCheck, AlertCircle, SlidersHorizontal,
    Calculator, CheckCircle2, TrendingDown, Zap, Clock, ThumbsUp, ThumbsDown
} from 'lucide-react';
import { useAppContext } from '@/contexts/app-context';
import { useNotifications } from './NotificationBell';
import { auditLog } from '@/lib/audit-log';
import { cn } from '@/lib/utils';

export default function DecisionPanel() {
    const { handleNavigate, user, infralithResult } = useAppContext();
    const { toast } = useToast();
    const { addNotification } = useNotifications();

    const [agreed, setAgreed] = useState({ compliance: false, cost: false, manual: false });
    const [schedule, setSchedule] = useState([0]);
    const [quality, setQuality] = useState([100]);
    const [submitting, setSubmitting] = useState(false);
    const [decisionMade, setDecisionMade] = useState<'approved' | 'rejected' | null>(null);
    const [decisionTime, setDecisionTime] = useState<string | null>(null);

    const baseCost = 2_500_000;
    const dynamicCost = baseCost + (schedule[0] * -12500) + ((100 - quality[0]) * -5000);
    const savings = baseCost - dynamicCost;
    const fmt = (v: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(v);

    const canApprove = agreed.compliance && agreed.cost && agreed.manual;
    const hasPrivilege = user?.role === 'Engineer' || user?.role === 'Supervisor' || user?.role === 'Admin';
    const qualityRisk = quality[0] < 85;

    const handleDecision = async (approved: boolean) => {
        if (!hasPrivilege) {
            toast({ title: "Permission Required", description: "Only Engineers, Supervisors, or Administrators can authorize project progression.", variant: "destructive" });
            return;
        }
        setSubmitting(true);
        await new Promise(r => setTimeout(r, 1000));
        setSubmitting(false);

        const now = new Date().toISOString();
        setDecisionMade(approved ? 'approved' : 'rejected');
        setDecisionTime(now);

        // Audit log the decision
        if (user) {
            auditLog.record(
                approved ? 'PROJECT_APPROVED' : 'PROJECT_REJECTED',
                { uid: user.uid, name: user.name, role: user.role, email: user.email },
                {
                    reportId: infralithResult?.id || 'unknown',
                    projectScope: infralithResult?.projectScope || 'unknown',
                    budgetApproved: fmt(dynamicCost),
                    qualityLevel: quality[0],
                    scheduleAcceleration: schedule[0],
                    timestamp: now,
                }
            );
        }

        // Push notification
        addNotification({
            type: approved ? 'success' : 'warning',
            title: approved ? '✅ Project Approved' : '❌ Project Rejected',
            body: approved
                ? `${user?.name} authorized the project at ${fmt(dynamicCost)}. Report is now finalized.`
                : `${user?.name} rejected the project. Requires revision before re-submission.`,
        });

        toast({
            title: approved ? "Project Approved" : "Project Rejected",
            description: `Action recorded in audit trail by ${user?.name}.`,
            variant: approved ? "default" : "destructive",
        });

        if (approved) handleNavigate('report');
    };

    return (
        <div className="w-full max-w-3xl mx-auto space-y-8 pb-12">

            {/* Page Header */}
            <div className="space-y-1">
                <div className="flex items-center gap-3">
                    <div className="h-11 w-11 bg-amber-50 dark:bg-amber-900/30 rounded-2xl flex items-center justify-center border border-amber-100 dark:border-amber-800 shadow-sm">
                        <SlidersHorizontal className="h-5 w-5 text-amber-500" />
                    </div>
                    <h1 className="text-3xl font-black tracking-tight text-slate-900 dark:text-white">Decision Hub</h1>
                </div>
                <p className="text-slate-500 font-semibold ml-14 text-sm">Review AI insights and authorize cross-functional project progression.</p>
            </div>

            {/* Budget Sandbox Card */}
            <div className="bg-white dark:bg-slate-900 rounded-[28px] border border-slate-100 dark:border-slate-800 shadow-[0_8px_40px_-12px_rgba(0,0,0,0.07)] overflow-hidden">
                {/* Card Header */}
                <div className="px-8 pt-8 pb-6 border-b border-slate-100 dark:border-slate-800 flex items-center gap-4">
                    <div className="h-10 w-10 bg-amber-50 dark:bg-amber-900/30 rounded-xl flex items-center justify-center border border-amber-100 dark:border-amber-800 shrink-0">
                        <Calculator className="h-5 w-5 text-amber-500" />
                    </div>
                    <div>
                        <h2 className="text-lg font-black text-slate-900 dark:text-white tracking-tight">Budget "What-If" Sandbox</h2>
                        <p className="text-sm text-slate-500 font-medium">Adjust variables to forecast cost and compliance risk impacts.</p>
                    </div>
                </div>

                {/* Sliders */}
                <div className="px-8 py-8 space-y-10">
                    {/* Schedule Slider */}
                    <div className="space-y-4">
                        <div className="flex items-center justify-between">
                            <div className="flex items-center gap-2.5">
                                <Clock className="h-4 w-4 text-slate-400" />
                                <span className="font-black text-slate-800 dark:text-slate-100 text-sm">Schedule Acceleration Target</span>
                            </div>
                            <div className="px-3.5 py-1.5 bg-amber-50 dark:bg-amber-900/30 border border-amber-200 dark:border-amber-700 rounded-full">
                                <span className="text-[11px] font-black text-amber-600 dark:text-amber-400 tracking-widest uppercase">{schedule[0]} Days</span>
                            </div>
                        </div>
                        <Slider
                            value={schedule}
                            onValueChange={setSchedule}
                            max={30}
                            step={1}
                            className="[&>span:first-child]:bg-slate-200 dark:[&>span:first-child]:bg-slate-700 [&>span:first-child>span]:bg-amber-500 [&>span[role=slider]]:bg-amber-500 [&>span[role=slider]]:border-amber-400 [&>span[role=slider]]:shadow-lg [&>span[role=slider]]:shadow-amber-500/30"
                        />
                        <p className="text-xs text-slate-400 leading-relaxed font-medium">Accelerating the schedule lowers heavy machinery holding costs but moderately increases logistical collision risk.</p>
                    </div>

                    {/* Quality Slider */}
                    <div className="space-y-4">
                        <div className="flex items-center justify-between">
                            <div className="flex items-center gap-2.5">
                                <Zap className="h-4 w-4 text-slate-400" />
                                <span className="font-black text-slate-800 dark:text-slate-100 text-sm">Material Cost Threshold</span>
                            </div>
                            <div className={cn(
                                "px-3.5 py-1.5 rounded-full border",
                                qualityRisk
                                    ? "bg-rose-50 dark:bg-rose-900/30 border-rose-200 dark:border-rose-700"
                                    : "bg-emerald-50 dark:bg-emerald-900/30 border-emerald-200 dark:border-emerald-700"
                            )}>
                                <span className={cn(
                                    "text-[11px] font-black tracking-widest uppercase",
                                    qualityRisk ? "text-rose-500" : "text-emerald-600 dark:text-emerald-400"
                                )}>{quality[0]}% Standard</span>
                            </div>
                        </div>
                        <Slider
                            value={quality}
                            onValueChange={setQuality}
                            min={70}
                            max={100}
                            step={5}
                            className={cn(
                                "[&>span:first-child]:bg-slate-200 dark:[&>span:first-child]:bg-slate-700 [&>span[role=slider]]:shadow-lg",
                                qualityRisk
                                    ? "[&>span:first-child>span]:bg-rose-500 [&>span[role=slider]]:bg-rose-500 [&>span[role=slider]]:border-rose-400 [&>span[role=slider]]:shadow-rose-500/30"
                                    : "[&>span:first-child>span]:bg-emerald-500 [&>span[role=slider]]:bg-emerald-500 [&>span[role=slider]]:border-emerald-400 [&>span[role=slider]]:shadow-emerald-500/30"
                            )}
                        />
                        {qualityRisk && (
                            <div className="flex items-start gap-2 p-3 bg-rose-50 dark:bg-rose-900/20 border border-rose-100 dark:border-rose-800 rounded-xl">
                                <AlertCircle className="h-4 w-4 text-rose-500 mt-0.5 shrink-0" />
                                <p className="text-xs text-rose-600 dark:text-rose-400 font-semibold leading-relaxed">Warning: Materials below 90% ISO standard exponentially increase compliance failure risk.</p>
                            </div>
                        )}
                        {!qualityRisk && <p className="text-xs text-slate-400 leading-relaxed font-medium">Targeting cheaper materials (below 90% ISO standard) exponentially increases compliance failure permutations.</p>}
                    </div>
                </div>

                {/* Cost Footer */}
                <div className="mx-8 mb-8 p-6 bg-slate-50 dark:bg-slate-800 rounded-[20px] border border-slate-100 dark:border-slate-700 flex items-center justify-between">
                    <div className="space-y-1">
                        <p className="text-[10px] font-black uppercase tracking-[0.25em] text-slate-400">AI Projected Cost</p>
                        {savings > 0 && (
                            <div className="flex items-center gap-1.5">
                                <TrendingDown className="h-3.5 w-3.5 text-emerald-500" />
                                <span className="text-xs font-black text-emerald-500">Saving {fmt(savings)}</span>
                            </div>
                        )}
                    </div>
                    <span className="text-4xl font-black tracking-tighter text-amber-500">{fmt(dynamicCost)}</span>
                </div>
            </div>

            {/* Approval Checklist Card */}
            <div className="bg-white dark:bg-slate-900 rounded-[28px] border border-slate-100 dark:border-slate-800 shadow-[0_8px_40px_-12px_rgba(0,0,0,0.07)] overflow-hidden">
                <div className="px-8 pt-8 pb-6 border-b border-slate-100 dark:border-slate-800">
                    <h2 className="text-lg font-black text-slate-900 dark:text-white tracking-tight">Approval Checklist</h2>
                    <p className="text-sm text-slate-500 font-medium mt-0.5">Confirm review of all AI-generated evaluations before authorizing.</p>
                </div>

                <div className="px-8 py-8 space-y-5">
                    {[
                        { key: 'compliance', label: 'I acknowledge the compliance violations found in the report.', val: agreed.compliance },
                        { key: 'cost', label: 'I accept the projected cost impact and budget timeline.', val: agreed.cost },
                        { key: 'manual', label: 'I confirm manual review of all critical risk factors.', val: agreed.manual },
                    ].map(item => (
                        <label
                            key={item.key}
                            htmlFor={item.key}
                            className={cn(
                                "flex items-start gap-4 p-5 rounded-[18px] border-2 cursor-pointer transition-all",
                                item.val
                                    ? "border-emerald-200 dark:border-emerald-700 bg-emerald-50 dark:bg-emerald-900/20"
                                    : "border-slate-100 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 hover:border-slate-200 dark:hover:border-slate-600"
                            )}
                        >
                            <Checkbox
                                id={item.key}
                                checked={item.val}
                                onCheckedChange={c => setAgreed(prev => ({ ...prev, [item.key]: !!c }))}
                                className={cn(
                                    "mt-0.5 shrink-0 h-5 w-5 rounded-md border-2 transition-colors",
                                    item.val
                                        ? "border-emerald-500 data-[state=checked]:bg-emerald-500 data-[state=checked]:border-emerald-500"
                                        : "border-slate-300 dark:border-slate-600"
                                )}
                            />
                            <span className={cn("text-sm font-semibold leading-relaxed", item.val ? "text-emerald-700 dark:text-emerald-300" : "text-slate-600 dark:text-slate-300")}>
                                {item.label}
                            </span>
                            {item.val && <CheckCircle2 className="h-5 w-5 text-emerald-500 shrink-0 ml-auto mt-0.5" />}
                        </label>
                    ))}
                </div>

                {/* Progress Indicator */}
                <div className="px-8 pb-2">
                    <div className="h-1.5 bg-slate-100 dark:bg-slate-800 rounded-full overflow-hidden">
                        <div
                            className="h-full bg-gradient-to-r from-amber-400 to-emerald-500 rounded-full transition-all duration-500"
                            style={{ width: `${(Object.values(agreed).filter(Boolean).length / 3) * 100}%` }}
                        />
                    </div>
                    <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mt-2 mb-6">
                        {Object.values(agreed).filter(Boolean).length} / 3 Confirmations
                    </p>
                </div>

                {/* Actions */}
                <div className="px-8 pb-6 flex flex-col sm:flex-row gap-3">
                    <Button
                        variant="ghost"
                        onClick={() => handleDecision(false)}
                        disabled={submitting}
                        className="flex-1 h-12 text-rose-500 hover:text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-900/20 font-bold rounded-[14px] border border-rose-100 dark:border-rose-900 gap-2"
                    >
                        {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <AlertCircle className="h-4 w-4" />}
                        Reject Project
                    </Button>
                    <Button
                        onClick={() => handleDecision(true)}
                        disabled={!canApprove || submitting}
                        className={cn(
                            "flex-1 h-12 font-black rounded-[14px] gap-2 transition-all",
                            canApprove
                                ? "bg-emerald-500 hover:bg-emerald-400 text-white shadow-xl shadow-emerald-500/30 hover:scale-[1.02]"
                                : "bg-slate-100 dark:bg-slate-800 text-slate-400 dark:text-slate-500 cursor-not-allowed"
                        )}
                    >
                        {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
                        Approve & Generate Report
                    </Button>
                </div>

                {/* Approval Chain Status */}

                <div className="px-8 pb-8 pt-2">
                    <div className="p-5 bg-slate-50 dark:bg-slate-800 rounded-[18px] border border-slate-100 dark:border-slate-700">
                        <p className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-4">Approval Chain</p>
                        <div className="flex items-center gap-3">
                            <div className={cn(
                                "h-9 w-9 rounded-full flex items-center justify-center shrink-0 border-2 transition-all",
                                decisionMade === 'approved' ? 'bg-emerald-500 border-emerald-500' :
                                    decisionMade === 'rejected' ? 'bg-rose-500 border-rose-500' :
                                        'bg-amber-50 dark:bg-amber-900/20 border-amber-300 dark:border-amber-600 animate-pulse'
                            )}>
                                {decisionMade === 'approved' ? <ThumbsUp className="h-4 w-4 text-white" /> :
                                    decisionMade === 'rejected' ? <ThumbsDown className="h-4 w-4 text-white" /> :
                                        <Clock className="h-4 w-4 text-amber-500" />}
                            </div>
                            <div className="flex-1">
                                <p className="text-sm font-black text-slate-800 dark:text-slate-100">
                                    {decisionMade === 'approved' ? 'Approved by ' + user?.name :
                                        decisionMade === 'rejected' ? 'Rejected by ' + user?.name :
                                            'Awaiting Supervisor Sign-off'}
                                </p>
                                <p className="text-xs text-slate-400 font-medium">
                                    {decisionMade && decisionTime
                                        ? new Date(decisionTime).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })
                                        : 'Step 1 of 1 — Authorization pending'}
                                </p>
                            </div>
                            <span className={cn(
                                "text-[10px] font-black px-2.5 py-1 rounded-full border",
                                decisionMade === 'approved' ? 'bg-emerald-50 dark:bg-emerald-900/30 text-emerald-600 border-emerald-200 dark:border-emerald-700' :
                                    decisionMade === 'rejected' ? 'bg-rose-50 dark:bg-rose-900/30 text-rose-600 border-rose-200 dark:border-rose-700' :
                                        'bg-amber-50 dark:bg-amber-900/30 text-amber-500 border-amber-200 dark:border-amber-700'
                            )}>
                                {decisionMade ? decisionMade.toUpperCase() : 'PENDING'}
                            </span>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}
