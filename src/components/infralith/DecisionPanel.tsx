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

const resolveEnvText = (value: string | undefined, fallback: string) => {
    const trimmed = value?.trim();
    return trimmed ? trimmed : fallback;
};

const parseNumberEnv = (value: string | undefined, fallback: number) => {
    if (!value) return fallback;
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : fallback;
};

const DECISION_COPY = {
    title: resolveEnvText(process.env.NEXT_PUBLIC_DECISION_TITLE, 'Decision Hub'),
    subtitle: resolveEnvText(
        process.env.NEXT_PUBLIC_DECISION_SUBTITLE,
        'Review AI insights and authorize cross-functional project progression.'
    ),
    permissionTitle: resolveEnvText(process.env.NEXT_PUBLIC_DECISION_PERMISSION_TITLE, 'Permission Required'),
    permissionDescription: resolveEnvText(
        process.env.NEXT_PUBLIC_DECISION_PERMISSION_DESC,
        'Only Supervisors or Administrators can authorize project progression.'
    ),
    dataRequiredTitle: resolveEnvText(
        process.env.NEXT_PUBLIC_DECISION_DATA_REQUIRED_TITLE,
        'Live Report Data Required'
    ),
    dataRequiredDescription: resolveEnvText(
        process.env.NEXT_PUBLIC_DECISION_DATA_REQUIRED_DESC,
        'Run AI analysis first. Decision Hub now accepts only live project cost data.'
    ),
    decisionSubmitFailedTitle: resolveEnvText(
        process.env.NEXT_PUBLIC_DECISION_SUBMIT_FAILED_TITLE,
        'Decision Submission Failed'
    ),
    decisionSubmitFailedDescription: resolveEnvText(
        process.env.NEXT_PUBLIC_DECISION_SUBMIT_FAILED_DESC,
        'Could not submit decision to approval API. Please retry.'
    ),
    notifyApprovedTitle: resolveEnvText(process.env.NEXT_PUBLIC_DECISION_NOTIFY_APPROVED_TITLE, 'Project Approved'),
    notifyRejectedTitle: resolveEnvText(process.env.NEXT_PUBLIC_DECISION_NOTIFY_REJECTED_TITLE, 'Project Rejected'),
    notifyApprovedPrefix: resolveEnvText(process.env.NEXT_PUBLIC_DECISION_NOTIFY_APPROVED_PREFIX, 'authorized the project at'),
    notifyApprovedSuffix: resolveEnvText(process.env.NEXT_PUBLIC_DECISION_NOTIFY_APPROVED_SUFFIX, 'Report is now finalized.'),
    notifyRejectedBody: resolveEnvText(
        process.env.NEXT_PUBLIC_DECISION_NOTIFY_REJECTED_BODY,
        'rejected the project. Requires revision before re-submission.'
    ),
    toastApprovedTitle: resolveEnvText(process.env.NEXT_PUBLIC_DECISION_TOAST_APPROVED_TITLE, 'Project Approved'),
    toastRejectedTitle: resolveEnvText(process.env.NEXT_PUBLIC_DECISION_TOAST_REJECTED_TITLE, 'Project Rejected'),
    toastActionRecordedPrefix: resolveEnvText(
        process.env.NEXT_PUBLIC_DECISION_TOAST_ACTION_PREFIX,
        'Action recorded in audit trail by'
    ),
    budgetTitle: resolveEnvText(process.env.NEXT_PUBLIC_DECISION_BUDGET_TITLE, 'Budget What-If Sandbox'),
    budgetSubtitle: resolveEnvText(
        process.env.NEXT_PUBLIC_DECISION_BUDGET_SUBTITLE,
        'Adjust variables to forecast cost and compliance risk impacts.'
    ),
    scheduleLabel: resolveEnvText(process.env.NEXT_PUBLIC_DECISION_SCHEDULE_LABEL, 'Schedule Acceleration Target'),
    scheduleUnit: resolveEnvText(process.env.NEXT_PUBLIC_DECISION_SCHEDULE_UNIT, 'Days'),
    scheduleHelpText: resolveEnvText(
        process.env.NEXT_PUBLIC_DECISION_SCHEDULE_HELP,
        'Accelerating the schedule lowers heavy machinery holding costs but moderately increases logistical collision risk.'
    ),
    qualityLabel: resolveEnvText(process.env.NEXT_PUBLIC_DECISION_QUALITY_LABEL, 'Material Cost Threshold'),
    qualityUnit: resolveEnvText(process.env.NEXT_PUBLIC_DECISION_QUALITY_UNIT, 'Standard'),
    qualityWarningTemplate: resolveEnvText(
        process.env.NEXT_PUBLIC_DECISION_QUALITY_WARNING,
        'Warning: Materials below {threshold}% standard exponentially increase compliance failure risk.'
    ),
    qualityHelpTemplate: resolveEnvText(
        process.env.NEXT_PUBLIC_DECISION_QUALITY_HELP,
        'Targeting cheaper materials (below {threshold}% standard) exponentially increases compliance failure permutations.'
    ),
    projectedCostLabel: resolveEnvText(process.env.NEXT_PUBLIC_DECISION_PROJECTED_COST_LABEL, 'AI Projected Cost'),
    savingsPrefix: resolveEnvText(process.env.NEXT_PUBLIC_DECISION_SAVINGS_PREFIX, 'Saving'),
    checklistTitle: resolveEnvText(process.env.NEXT_PUBLIC_DECISION_CHECKLIST_TITLE, 'Approval Checklist'),
    checklistSubtitle: resolveEnvText(
        process.env.NEXT_PUBLIC_DECISION_CHECKLIST_SUBTITLE,
        'Confirm review of all AI-generated evaluations before authorizing.'
    ),
    checklistCompliance: resolveEnvText(
        process.env.NEXT_PUBLIC_DECISION_CHECKLIST_COMPLIANCE,
        'I acknowledge the compliance violations found in the report.'
    ),
    checklistCost: resolveEnvText(
        process.env.NEXT_PUBLIC_DECISION_CHECKLIST_COST,
        'I accept the projected cost impact and budget timeline.'
    ),
    checklistManual: resolveEnvText(
        process.env.NEXT_PUBLIC_DECISION_CHECKLIST_MANUAL,
        'I confirm manual review of all critical risk factors.'
    ),
    confirmationsLabel: resolveEnvText(process.env.NEXT_PUBLIC_DECISION_CONFIRMATIONS_LABEL, 'Confirmations'),
    rejectAction: resolveEnvText(process.env.NEXT_PUBLIC_DECISION_REJECT_ACTION, 'Reject Project'),
    approveAction: resolveEnvText(process.env.NEXT_PUBLIC_DECISION_APPROVE_ACTION, 'Approve & Generate Report'),
    approvalChainLabel: resolveEnvText(process.env.NEXT_PUBLIC_DECISION_CHAIN_LABEL, 'Approval Chain'),
    approvedByPrefix: resolveEnvText(process.env.NEXT_PUBLIC_DECISION_APPROVED_BY_PREFIX, 'Approved by'),
    rejectedByPrefix: resolveEnvText(process.env.NEXT_PUBLIC_DECISION_REJECTED_BY_PREFIX, 'Rejected by'),
    awaitingSignoff: resolveEnvText(process.env.NEXT_PUBLIC_DECISION_AWAITING_STATUS, 'Awaiting Supervisor Sign-off'),
    pendingStep: resolveEnvText(process.env.NEXT_PUBLIC_DECISION_PENDING_STEP, 'Step 1 of 1 - Authorization pending'),
};

const DECISION_SETTINGS = {
    locale: resolveEnvText(process.env.NEXT_PUBLIC_DECISION_LOCALE, 'en-US'),
    currency: resolveEnvText(process.env.NEXT_PUBLIC_DECISION_CURRENCY, 'USD'),
    baseCost: parseNumberEnv(process.env.NEXT_PUBLIC_DECISION_BASE_COST, 2_500_000),
    scheduleCostDelta: parseNumberEnv(process.env.NEXT_PUBLIC_DECISION_SCHEDULE_COST_DELTA, -12_500),
    qualityCostDelta: parseNumberEnv(process.env.NEXT_PUBLIC_DECISION_QUALITY_COST_DELTA, -5_000),
    scheduleMax: parseNumberEnv(process.env.NEXT_PUBLIC_DECISION_SCHEDULE_MAX, 30),
    qualityMin: parseNumberEnv(process.env.NEXT_PUBLIC_DECISION_QUALITY_MIN, 70),
    qualityMax: parseNumberEnv(process.env.NEXT_PUBLIC_DECISION_QUALITY_MAX, 100),
    qualityStep: parseNumberEnv(process.env.NEXT_PUBLIC_DECISION_QUALITY_STEP, 5),
    qualityRiskThreshold: parseNumberEnv(process.env.NEXT_PUBLIC_DECISION_QUALITY_RISK_THRESHOLD, 85),
};

export default function DecisionPanel() {
    const { handleNavigate, user, infralithResult } = useAppContext();
    const { toast } = useToast();
    const { addNotification } = useNotifications();

    const [agreed, setAgreed] = useState({ compliance: false, cost: false, manual: false });
    const [schedule, setSchedule] = useState([0]);
    const [quality, setQuality] = useState([DECISION_SETTINGS.qualityMax]);
    const [submitting, setSubmitting] = useState(false);
    const [decisionMade, setDecisionMade] = useState<'approved' | 'rejected' | null>(null);
    const [decisionTime, setDecisionTime] = useState<string | null>(null);

    const checklistItems = [
        { key: 'compliance' as const, label: DECISION_COPY.checklistCompliance, val: agreed.compliance },
        { key: 'cost' as const, label: DECISION_COPY.checklistCost, val: agreed.cost },
        { key: 'manual' as const, label: DECISION_COPY.checklistManual, val: agreed.manual },
    ];
    const completedChecklistCount = checklistItems.filter((item) => item.val).length;
    const totalChecklistCount = checklistItems.length;
    const actorName = user?.name || 'System User';
    const qualityWarningText = DECISION_COPY.qualityWarningTemplate.replace('{threshold}', `${DECISION_SETTINGS.qualityRiskThreshold}`);
    const qualityHelpText = DECISION_COPY.qualityHelpTemplate.replace('{threshold}', `${DECISION_SETTINGS.qualityRiskThreshold}`);

    const reportBaseCost =
        typeof infralithResult?.costEstimate?.total === 'number'
            ? infralithResult.costEstimate.total
            : typeof infralithResult?.costImpactEstimate === 'number'
                ? infralithResult.costImpactEstimate
                : null;
    const reportCurrency =
        typeof infralithResult?.costEstimate?.currency === 'string' && infralithResult.costEstimate.currency.trim()
            ? infralithResult.costEstimate.currency.trim()
            : typeof infralithResult?.currency === 'string' && infralithResult.currency.trim()
                ? infralithResult.currency.trim()
                : null;
    const hasRealReportData =
        !!infralithResult?.id &&
        Number.isFinite(Number(reportBaseCost)) &&
        Number(reportBaseCost) > 0 &&
        !!reportCurrency;

    const baseCost = hasRealReportData ? Number(reportBaseCost) : 0;
    const dynamicCost =
        baseCost +
        (schedule[0] * DECISION_SETTINGS.scheduleCostDelta) +
        ((DECISION_SETTINGS.qualityMax - quality[0]) * DECISION_SETTINGS.qualityCostDelta);
    const savings = baseCost - dynamicCost;
    const fmt = (v: number) =>
        reportCurrency
            ? new Intl.NumberFormat(DECISION_SETTINGS.locale, {
                style: 'currency',
                currency: reportCurrency,
                maximumFractionDigits: 0,
            }).format(v)
            : 'N/A';

    const canApprove = hasRealReportData && completedChecklistCount === totalChecklistCount;
    const hasPrivilege = user?.role === 'Supervisor' || user?.role === 'Admin';
    const qualityRisk = quality[0] < DECISION_SETTINGS.qualityRiskThreshold;

    const handleDecision = async (approved: boolean) => {
        if (!hasPrivilege) {
            toast({
                title: DECISION_COPY.permissionTitle,
                description: DECISION_COPY.permissionDescription,
                variant: 'destructive',
            });
            return;
        }
        if (!hasRealReportData) {
            toast({
                title: DECISION_COPY.dataRequiredTitle,
                description: DECISION_COPY.dataRequiredDescription,
                variant: 'destructive',
            });
            return;
        }

        setSubmitting(true);
        try {
            const response = await fetch('/api/infralith/approve', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    approved,
                    reportId: infralithResult.id,
                    projectScope: infralithResult.projectScope,
                    budgetApproved: dynamicCost,
                    currency: reportCurrency,
                    qualityLevel: quality[0],
                    scheduleAcceleration: schedule[0],
                    reason: approved ? undefined : 'Rejected from Decision Hub',
                }),
            });

            if (!response.ok) {
                throw new Error(`Approval API failed with status ${response.status}`);
            }

            const approvalPayload = await response.json();
            const now = typeof approvalPayload?.audit?.timestamp === 'string'
                ? approvalPayload.audit.timestamp
                : new Date().toISOString();

            setDecisionMade(approved ? 'approved' : 'rejected');
            setDecisionTime(now);

            if (user) {
                auditLog.record(
                    approved ? 'PROJECT_APPROVED' : 'PROJECT_REJECTED',
                    { uid: user.uid, name: user.name, role: user.role, email: user.email },
                    {
                        reportId: infralithResult.id,
                        projectScope: infralithResult.projectScope,
                        budgetApproved: fmt(dynamicCost),
                        qualityLevel: quality[0],
                        scheduleAcceleration: schedule[0],
                        timestamp: now,
                    }
                );
            }

            addNotification({
                type: approved ? 'success' : 'warning',
                title: approved ? DECISION_COPY.notifyApprovedTitle : DECISION_COPY.notifyRejectedTitle,
                body: approved
                    ? `${actorName} ${DECISION_COPY.notifyApprovedPrefix} ${fmt(dynamicCost)}. ${DECISION_COPY.notifyApprovedSuffix}`
                    : `${actorName} ${DECISION_COPY.notifyRejectedBody}`,
            });

            toast({
                title: approved ? DECISION_COPY.toastApprovedTitle : DECISION_COPY.toastRejectedTitle,
                description: `${DECISION_COPY.toastActionRecordedPrefix} ${actorName}.`,
                variant: approved ? 'default' : 'destructive',
            });

            if (approved) handleNavigate('report');
        } catch (error) {
            console.error('Decision submit failed', error);
            toast({
                title: DECISION_COPY.decisionSubmitFailedTitle,
                description: DECISION_COPY.decisionSubmitFailedDescription,
                variant: 'destructive',
            });
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <div className="w-full max-w-3xl mx-auto space-y-8 pb-12">

            {/* Page Header */}
            <div className="space-y-1">
                <div className="flex items-center gap-3">
                    <div className="h-11 w-11 bg-amber-50 dark:bg-amber-900/30 rounded-2xl flex items-center justify-center border border-amber-100 dark:border-amber-800 shadow-sm">
                        <SlidersHorizontal className="h-5 w-5 text-amber-500" />
                    </div>
                    <h1 className="text-3xl font-black tracking-tight text-slate-900 dark:text-white">{DECISION_COPY.title}</h1>
                </div>
                <p className="text-slate-500 font-semibold ml-14 text-sm">{DECISION_COPY.subtitle}</p>
            </div>
            {!hasRealReportData && (
                <div className="rounded-2xl border border-rose-200 dark:border-rose-800 bg-rose-50 dark:bg-rose-900/20 px-5 py-4">
                    <p className="text-sm font-black text-rose-700 dark:text-rose-300">{DECISION_COPY.dataRequiredTitle}</p>
                    <p className="text-xs mt-1 text-rose-600 dark:text-rose-400">{DECISION_COPY.dataRequiredDescription}</p>
                </div>
            )}

            {/* Budget Sandbox Card */}
            <div className="bg-white dark:bg-slate-900 rounded-[28px] border border-slate-100 dark:border-slate-800 shadow-[0_8px_40px_-12px_rgba(0,0,0,0.07)] overflow-hidden">
                {/* Card Header */}
                <div className="px-8 pt-8 pb-6 border-b border-slate-100 dark:border-slate-800 flex items-center gap-4">
                    <div className="h-10 w-10 bg-amber-50 dark:bg-amber-900/30 rounded-xl flex items-center justify-center border border-amber-100 dark:border-amber-800 shrink-0">
                        <Calculator className="h-5 w-5 text-amber-500" />
                    </div>
                    <div>
                        <h2 className="text-lg font-black text-slate-900 dark:text-white tracking-tight">{DECISION_COPY.budgetTitle}</h2>
                        <p className="text-sm text-slate-500 font-medium">{DECISION_COPY.budgetSubtitle}</p>
                    </div>
                </div>

                {/* Sliders */}
                <div className="px-8 py-8 space-y-10">
                    {/* Schedule Slider */}
                    <div className="space-y-4">
                        <div className="flex items-center justify-between">
                            <div className="flex items-center gap-2.5">
                                <Clock className="h-4 w-4 text-slate-400" />
                                <span className="font-black text-slate-800 dark:text-slate-100 text-sm">{DECISION_COPY.scheduleLabel}</span>
                            </div>
                            <div className="px-3.5 py-1.5 bg-amber-50 dark:bg-amber-900/30 border border-amber-200 dark:border-amber-700 rounded-full">
                                <span className="text-[11px] font-black text-amber-600 dark:text-amber-400 tracking-widest uppercase">
                                    {schedule[0]} {DECISION_COPY.scheduleUnit}
                                </span>
                            </div>
                        </div>
                        <Slider
                            value={schedule}
                            onValueChange={setSchedule}
                            max={DECISION_SETTINGS.scheduleMax}
                            step={1}
                            disabled={!hasRealReportData || submitting}
                            className="[&>span:first-child]:bg-slate-200 dark:[&>span:first-child]:bg-slate-700 [&>span:first-child>span]:bg-amber-500 [&>span[role=slider]]:bg-amber-500 [&>span[role=slider]]:border-amber-400 [&>span[role=slider]]:shadow-lg [&>span[role=slider]]:shadow-amber-500/30"
                        />
                        <p className="text-xs text-slate-400 leading-relaxed font-medium">{DECISION_COPY.scheduleHelpText}</p>
                    </div>

                    {/* Quality Slider */}
                    <div className="space-y-4">
                        <div className="flex items-center justify-between">
                            <div className="flex items-center gap-2.5">
                                <Zap className="h-4 w-4 text-slate-400" />
                                <span className="font-black text-slate-800 dark:text-slate-100 text-sm">{DECISION_COPY.qualityLabel}</span>
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
                                )}>
                                    {quality[0]}% {DECISION_COPY.qualityUnit}
                                </span>
                            </div>
                        </div>
                        <Slider
                            value={quality}
                            onValueChange={setQuality}
                            min={DECISION_SETTINGS.qualityMin}
                            max={DECISION_SETTINGS.qualityMax}
                            step={DECISION_SETTINGS.qualityStep}
                            disabled={!hasRealReportData || submitting}
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
                                <p className="text-xs text-rose-600 dark:text-rose-400 font-semibold leading-relaxed">{qualityWarningText}</p>
                            </div>
                        )}
                        {!qualityRisk && <p className="text-xs text-slate-400 leading-relaxed font-medium">{qualityHelpText}</p>}
                    </div>
                </div>

                {/* Cost Footer */}
                <div className="mx-8 mb-8 p-6 bg-slate-50 dark:bg-slate-800 rounded-[20px] border border-slate-100 dark:border-slate-700 flex items-center justify-between">
                    <div className="space-y-1">
                        <p className="text-[10px] font-black uppercase tracking-[0.25em] text-slate-400">{DECISION_COPY.projectedCostLabel}</p>
                        {hasRealReportData && savings > 0 && (
                            <div className="flex items-center gap-1.5">
                                <TrendingDown className="h-3.5 w-3.5 text-emerald-500" />
                                <span className="text-xs font-black text-emerald-500">{DECISION_COPY.savingsPrefix} {fmt(savings)}</span>
                            </div>
                        )}
                    </div>
                    <span className="text-4xl font-black tracking-tighter text-amber-500">{fmt(dynamicCost)}</span>
                </div>
            </div>

            {/* Approval Checklist Card */}
            <div className="bg-white dark:bg-slate-900 rounded-[28px] border border-slate-100 dark:border-slate-800 shadow-[0_8px_40px_-12px_rgba(0,0,0,0.07)] overflow-hidden">
                <div className="px-8 pt-8 pb-6 border-b border-slate-100 dark:border-slate-800">
                    <h2 className="text-lg font-black text-slate-900 dark:text-white tracking-tight">{DECISION_COPY.checklistTitle}</h2>
                    <p className="text-sm text-slate-500 font-medium mt-0.5">{DECISION_COPY.checklistSubtitle}</p>
                </div>

                <div className="px-8 py-8 space-y-5">
                    {checklistItems.map((item) => (
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
                            style={{ width: `${(completedChecklistCount / totalChecklistCount) * 100}%` }}
                        />
                    </div>
                    <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mt-2 mb-6">
                        {completedChecklistCount} / {totalChecklistCount} {DECISION_COPY.confirmationsLabel}
                    </p>
                </div>

                {/* Actions */}
                <div className="px-8 pb-6 flex flex-col sm:flex-row gap-3">
                    <Button
                        variant="ghost"
                        onClick={() => handleDecision(false)}
                        disabled={!hasRealReportData || submitting || !hasPrivilege}
                        className="flex-1 h-12 text-rose-500 hover:text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-900/20 font-bold rounded-[14px] border border-rose-100 dark:border-rose-900 gap-2"
                    >
                        {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <AlertCircle className="h-4 w-4" />}
                        {DECISION_COPY.rejectAction}
                    </Button>
                    <Button
                        onClick={() => handleDecision(true)}
                        disabled={!canApprove || submitting || !hasPrivilege}
                        className={cn(
                            "flex-1 h-12 font-black rounded-[14px] gap-2 transition-all",
                            canApprove
                                ? "bg-emerald-500 hover:bg-emerald-400 text-white shadow-xl shadow-emerald-500/30 hover:scale-[1.02]"
                                : "bg-slate-100 dark:bg-slate-800 text-slate-400 dark:text-slate-500 cursor-not-allowed"
                        )}
                    >
                        {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
                        {DECISION_COPY.approveAction}
                    </Button>
                </div>

                {/* Approval Chain Status */}

                <div className="px-8 pb-8 pt-2">
                    <div className="p-5 bg-slate-50 dark:bg-slate-800 rounded-[18px] border border-slate-100 dark:border-slate-700">
                        <p className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-4">{DECISION_COPY.approvalChainLabel}</p>
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
                                    {decisionMade === 'approved' ? `${DECISION_COPY.approvedByPrefix} ${actorName}` :
                                        decisionMade === 'rejected' ? `${DECISION_COPY.rejectedByPrefix} ${actorName}` :
                                            DECISION_COPY.awaitingSignoff}
                                </p>
                                <p className="text-xs text-slate-400 font-medium">
                                    {decisionMade && decisionTime
                                        ? new Date(decisionTime).toLocaleString(DECISION_SETTINGS.locale, { dateStyle: 'medium', timeStyle: 'short' })
                                        : DECISION_COPY.pendingStep}
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
