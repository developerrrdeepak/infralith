'use client';

import {
    Download, FileText, Share2, Printer, CheckCircle, ShieldCheck,
    Clock, Settings, Wand2, Smartphone, Plane, Sparkles,
    Mic, Loader2, Send, Activity, Zap, BarChart3,
    ClipboardList, ChevronsRight, ChevronRight,
    TriangleAlert, Scale
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { useState } from 'react';
import { Textarea } from '@/components/ui/textarea';
import { useAppContext } from '@/contexts/app-context';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/hooks/use-toast';
import { Separator } from '@/components/ui/separator';

// ─── Helper ──────────────────────────────────────────────────────────────────
function SectionHeading({ icon: Icon, title, subtitle }: { icon: any; title: string; subtitle?: string }) {
    return (
        <div className="flex items-start gap-3 mb-5">
            <div className="h-9 w-9 rounded-lg bg-primary/10 flex items-center justify-center shrink-0 mt-0.5">
                <Icon className="h-5 w-5 text-primary" />
            </div>
            <div>
                <h2 className="text-base font-bold tracking-tight text-foreground">{title}</h2>
                {subtitle && <p className="text-xs text-muted-foreground mt-0.5">{subtitle}</p>}
            </div>
        </div>
    );
}

function KPICard({ label, value, sub, color = '' }: { label: string; value: string | number; sub?: string; color?: string }) {
    return (
        <div className="bg-card border border-border rounded-xl p-4 flex flex-col gap-1">
            <span className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">{label}</span>
            <span className={`text-2xl font-black ${color || 'text-foreground'}`}>{value}</span>
            {sub && <span className="text-[11px] text-muted-foreground">{sub}</span>}
        </div>
    );
}

function TableRow({ cells, header }: { cells: string[]; header?: boolean }) {
    return (
        <div className={`grid gap-3 px-4 py-3 text-sm ${header ? 'bg-muted/50 font-bold text-muted-foreground text-[11px] uppercase tracking-wider border-b border-border' : 'border-b border-border/50 hover:bg-muted/20 transition-colors'}`}
            style={{ gridTemplateColumns: `repeat(${cells.length}, 1fr)` }}>
            {cells.map((c, i) => <span key={i} className={i === 0 && !header ? 'font-medium text-foreground' : ''}>{c}</span>)}
        </div>
    );
}

export default function ReportView() {
    const { infralithResult } = useAppContext();
    const { toast } = useToast();

    const [isRfiOpen, setIsRfiOpen] = useState(false);
    const [isRecording, setIsRecording] = useState(false);
    const [rfiTranscript, setRfiTranscript] = useState('');
    const [isGenerating, setIsGenerating] = useState(false);
    const [draftedRfi, setDraftedRfi] = useState('');
    const [selectedConflict, setSelectedConflict] = useState<any>(null);

    const handleAction = (title: string, desc: string) => toast({ title, description: desc });

    const simulateVoiceRecording = () => {
        setIsRecording(true);
        setTimeout(() => {
            setRfiTranscript("The egress corridor measures 1.2 m; code requires 1.5 m. Architect must revise pillar placements on grid C4.");
            setIsRecording(false);
        }, 2500);
    };

    const simulateAIGeneration = () => {
        setIsGenerating(true);
        setTimeout(() => {
            setDraftedRfi(`REQUEST FOR INFORMATION — RFI-${new Date().getFullYear()}-001
Issued:   ${new Date().toLocaleDateString()}
Project:  ${(infralithResult as any)?.projectScope || 'N/A'}
Subject:  Egress Corridor Width Non-Compliance (Grid C4)

DESCRIPTION OF DISCREPANCY
───────────────────────────
Ref. Regulation: IS 3809 / NBC 2016 Part 4 — Cl. 4.2 (Means of Egress)
Measured Width:  1.20 m  (non-compliant)
Required Width:  ≥ 1.50 m

AI RECOMMENDATION
─────────────────
Revise load-bearing pillar layout along Grid C4 to achieve minimum
clearance without compromising structural integrity. Provide revised
section drawings at 1:50 scale within 7 working days.

Signed,
Infralith AI Assistant  (on behalf of Lead Engineer)`);
            setIsGenerating(false);
        }, 2000);
    };

    // ── Empty state ──────────────────────────────────────────────────────────
    if (!infralithResult) {
        return (
            <div className="flex flex-col items-center justify-center p-16 text-center space-y-4 bg-muted/30 rounded-2xl border border-dashed border-border mt-8">
                <div className="h-20 w-20 rounded-full bg-primary/10 flex items-center justify-center mb-4">
                    <FileText className="h-10 w-10 text-primary" />
                </div>
                <h2 className="text-2xl font-bold tracking-tight text-foreground">No Report Generated</h2>
                <p className="text-muted-foreground max-w-md">Upload a project document in the "Document Upload" section to trigger the AI evaluation pipeline and generate a structured engineering report.</p>
            </div>
        );
    }

    const r = infralithResult as any;
    const { role, timestamp, projectScope } = r;
    const isCritical = r.conflicts?.some((c: any) => c.riskCategory === 'Critical');
    const totalConflicts = r.conflicts?.length || 0;
    const criticalCount = r.conflicts?.filter((c: any) => c.riskCategory === 'Critical').length || 0;

    // ── Report number ────────────────────────────────────────────────────────
    const reportNo = `INFRA-${timestamp?.slice(0, 8)?.toUpperCase() || 'N/A'}`;
    const formattedDate = timestamp ? new Date(timestamp).toLocaleDateString('en-IN', { day: '2-digit', month: 'long', year: 'numeric' }) : '—';
    const formattedTime = timestamp ? new Date(timestamp).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }) : '—';

    return (
        <div className="w-full max-w-5xl mx-auto space-y-0 pb-24 animate-in fade-in slide-in-from-bottom-4 duration-500">

            {/* ── COVER HEADER ─────────────────────────────────────────────── */}
            <div className="bg-card border border-border rounded-2xl overflow-hidden shadow-sm mb-6">
                {/* Orange accent bar */}
                <div className="h-1.5 w-full bg-gradient-to-r from-orange-500 via-amber-400 to-orange-500" />
                <div className="p-6 md:p-8">
                    <div className="flex flex-col md:flex-row justify-between gap-6">
                        {/* Left: meta */}
                        <div className="space-y-3 flex-1">
                            <div className="flex flex-wrap items-center gap-2">
                                <Badge variant="outline" className="text-[10px] uppercase font-bold tracking-wider font-mono">
                                    {reportNo}
                                </Badge>
                                <Badge className="bg-primary/10 text-primary border-0 text-[10px] uppercase font-bold">{role} Report</Badge>
                                {isCritical
                                    ? <Badge className="bg-destructive/10 text-destructive border-0 text-[10px] uppercase font-bold"><TriangleAlert className="h-3 w-3 mr-1" />Action Required</Badge>
                                    : <Badge className="bg-emerald-500/10 text-emerald-600 border-0 text-[10px] uppercase font-bold"><CheckCircle className="h-3 w-3 mr-1" />Compliant</Badge>
                                }
                            </div>

                            <div>
                                <p className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground mb-1">AI Structural Evaluation Report</p>
                                <h1 className="text-2xl md:text-3xl font-black tracking-tight text-foreground leading-tight">{projectScope}</h1>
                            </div>

                            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-xs pt-2">
                                {[
                                    ['Report Date', formattedDate],
                                    ['Report Time', formattedTime],
                                    ['Prepared By', 'Infralith AI Engine v2.1'],
                                    ['Reviewed For', role],
                                    ['AI Confidence', '98.4%'],
                                    ['Doc Status', isCritical ? 'DRAFT — Pending Action' : 'FINAL'],
                                ].map(([k, v]) => (
                                    <div key={k} className="flex flex-col gap-0.5">
                                        <span className="text-muted-foreground font-semibold">{k}</span>
                                        <span className="font-bold text-foreground">{v}</span>
                                    </div>
                                ))}
                            </div>
                        </div>

                        {/* Right: action buttons */}
                        <div className="flex flex-col gap-2 md:items-end justify-start">
                            <Button variant="outline" size="sm" className="gap-2 w-full md:w-auto">
                                <Share2 className="h-3.5 w-3.5" /> Share
                            </Button>
                            <Button variant="outline" size="sm" className="gap-2 w-full md:w-auto">
                                <Printer className="h-3.5 w-3.5" /> Print PDF
                            </Button>
                            <Button size="sm" className="gap-2 w-full md:w-auto bg-primary hover:bg-primary/90 text-primary-foreground font-bold shadow shadow-primary/20">
                                <Download className="h-3.5 w-3.5" /> Export Report
                            </Button>
                        </div>
                    </div>
                </div>
            </div>

            {/* ── SECTION 1: EXECUTIVE SUMMARY KPIs ───────────────────────── */}
            <div className="bg-card border border-border rounded-2xl p-6 shadow-sm mb-4">
                <SectionHeading icon={BarChart3} title="Section 1 — Executive Summary" subtitle="High-level indicators extracted by the AI evaluation pipeline." />
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
                    <KPICard label="Total Issues" value={totalConflicts} sub="Non-compliance items" color={totalConflicts > 0 ? 'text-orange-500' : 'text-emerald-500'} />
                    <KPICard label="Critical" value={criticalCount} sub="Require immediate action" color={criticalCount > 0 ? 'text-destructive' : 'text-emerald-500'} />
                    {role === 'Supervisor' || role === 'Admin' ? (
                        <>
                            <KPICard label="Readiness Score" value={`${r.approvalReadinessScore ?? '—'}/100`} sub="Approval readiness" color={r.approvalReadinessScore > 80 ? 'text-emerald-500' : 'text-orange-500'} />
                            <KPICard label="Delay Risk" value={`+${r.delayImpactDays ?? 0} days`} sub="Projected schedule slip" color={r.delayImpactDays > 0 ? 'text-destructive' : 'text-emerald-500'} />
                            <KPICard label="Cost Impact" value={`${(r.costImpactEstimate ?? 0).toLocaleString()} ${r.currency ?? 'INR'}`} sub="Remediation estimate" />
                        </>
                    ) : (
                        <>
                            <KPICard label="BOQ Items" value={r.materials?.length ?? 0} sub="Material categories" />
                            <KPICard label="Conflicts Found" value={totalConflicts} sub="Regulatory tolerance" color={totalConflicts > 0 ? 'text-destructive' : 'text-emerald-500'} />
                            <KPICard label="AI Confidence" value="98.4%" sub="Pipeline accuracy" color="text-emerald-500" />
                            <KPICard label="Status" value={isCritical ? 'Review' : 'Passed'} sub="Overall evaluation" color={isCritical ? 'text-destructive' : 'text-emerald-500'} />
                        </>
                    )}
                </div>
            </div>

            {/* ── SECTION 2: COMPLIANCE ANALYSIS (Engineer / Admin) ────────── */}
            {(role === 'Engineer' || role === 'Admin') && (
                <div className="bg-card border border-border rounded-2xl overflow-hidden shadow-sm mb-4">
                    <div className="p-6">
                        <SectionHeading icon={ShieldCheck} title="Section 2 — Compliance & Regulation Analysis" subtitle="Per IS codes, NBC 2016, and project regulation references." />
                    </div>

                    {totalConflicts > 0 ? (
                        <>
                            {/* Table header */}
                            <TableRow header cells={['#', 'Regulation Ref.', 'Location', 'Risk Level', 'Required', 'Measured', 'Action']} />
                            {r.conflicts?.map((c: any, i: number) => (
                                <div key={i} className="grid px-4 py-3.5 gap-3 border-b border-border/50 hover:bg-muted/20 transition-colors text-sm items-center"
                                    style={{ gridTemplateColumns: '2rem 1fr 1fr 5.5rem 5.5rem 5.5rem 6rem' }}>
                                    <span className="font-mono text-muted-foreground text-xs">{String(i + 1).padStart(2, '0')}</span>
                                    <span className="font-semibold text-foreground text-xs">{c.regulationRef}</span>
                                    <span className="text-muted-foreground text-xs truncate">{c.location}</span>
                                    <span>
                                        <Badge className={c.riskCategory === 'Critical'
                                            ? 'bg-destructive text-destructive-foreground text-[10px] font-bold uppercase'
                                            : 'bg-orange-500/20 text-orange-700 dark:text-orange-400 border-0 text-[10px] font-bold uppercase'}>
                                            {c.riskCategory}
                                        </Badge>
                                    </span>
                                    <span className="text-xs font-medium text-emerald-600">{c.requiredValue}</span>
                                    <span className="text-xs font-bold text-destructive">{c.measuredValue}</span>
                                    {c.riskCategory === 'Critical' ? (
                                        <Button size="sm" className="h-7 text-[10px] font-bold px-2"
                                            onClick={() => { setSelectedConflict(c); setIsRfiOpen(true); setRfiTranscript(''); setDraftedRfi(''); }}>
                                            <Wand2 className="h-3 w-3 mr-1" /> Draft RFI
                                        </Button>
                                    ) : (
                                        <span className="text-[10px] text-muted-foreground font-medium">Monitor</span>
                                    )}
                                </div>
                            ))}

                            {/* Legend */}
                            <div className="px-6 py-4 bg-muted/20 border-t border-border flex flex-wrap gap-4 text-xs text-muted-foreground">
                                <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-destructive inline-block" />Critical — Immediate remediation required before site clearance</span>
                                <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-orange-500 inline-block" />Medium — Monitor and resolve before construction begins</span>
                            </div>
                        </>
                    ) : (
                        <div className="px-6 pb-6 flex items-center gap-4 text-sm">
                            <div className="h-10 w-10 rounded-full bg-emerald-500/10 flex items-center justify-center">
                                <CheckCircle className="h-5 w-5 text-emerald-500" />
                            </div>
                            <div>
                                <p className="font-bold text-emerald-600">All regulations satisfied</p>
                                <p className="text-muted-foreground">Zero non-compliance items detected across all structural and regulatory checks.</p>
                            </div>
                        </div>
                    )}
                </div>
            )}

            {/* ── SECTION 3: BILL OF QUANTITIES (Engineer) ─────────────────── */}
            {role === 'Engineer' && r.materials?.length > 0 && (
                <div className="bg-card border border-border rounded-2xl overflow-hidden shadow-sm mb-4">
                    <div className="p-6">
                        <SectionHeading icon={ClipboardList} title="Section 3 — Bill of Quantities (BOQ)" subtitle="AI-extracted material quantities from uploaded structural drawings." />
                    </div>
                    <TableRow header cells={['#', 'Material / Item', 'Quantity', 'Unit', 'Remarks']} />
                    {r.materials?.map((m: any, i: number) => (
                        <div key={i} className="grid px-4 py-3 border-b border-border/50 hover:bg-muted/20 transition-colors text-sm items-center gap-3"
                            style={{ gridTemplateColumns: '2rem 1fr 5rem 4rem 1fr' }}>
                            <span className="font-mono text-muted-foreground text-xs">{String(i + 1).padStart(2, '0')}</span>
                            <span className="font-semibold text-foreground">{m.item}</span>
                            <span className="font-bold text-foreground font-mono">{m.quantity}</span>
                            <span className="text-muted-foreground">{m.unit}</span>
                            <span className="text-xs text-muted-foreground">As per structural drawings</span>
                        </div>
                    ))}
                    <div className="px-6 py-3 bg-muted/20 border-t border-border text-xs text-muted-foreground">
                        All quantities are AI-estimated from uploaded documents. Verify against certified site measurement sheets before procurement.
                    </div>
                </div>
            )}

            {/* ── SECTION 3: SUPERVISOR KPIs ───────────────────────────────── */}
            {role === 'Supervisor' && (
                <div className="bg-card border border-border rounded-2xl overflow-hidden shadow-sm mb-4">
                    <div className="p-6">
                        <SectionHeading icon={Scale} title="Section 3 — Project Approval Assessment" subtitle="Decision-support metrics for supervisory review and sign-off." />
                    </div>
                    <div className="px-6 pb-6 space-y-4">
                        {/* Readiness bar */}
                        <div>
                            <div className="flex justify-between text-sm mb-1.5">
                                <span className="font-semibold text-foreground">Approval Readiness Score</span>
                                <span className={`font-black ${r.approvalReadinessScore > 80 ? 'text-emerald-500' : 'text-orange-500'}`}>
                                    {r.approvalReadinessScore} / 100
                                </span>
                            </div>
                            <div className="h-2.5 rounded-full bg-muted overflow-hidden">
                                <div className={`h-full rounded-full transition-all ${r.approvalReadinessScore > 80 ? 'bg-emerald-500' : 'bg-orange-500'}`}
                                    style={{ width: `${r.approvalReadinessScore}%` }} />
                            </div>
                        </div>

                        {r.delayImpactDays > 0 && (
                            <div className="flex items-start gap-3 bg-orange-500/5 border border-orange-500/20 rounded-xl p-4">
                                <Clock className="h-5 w-5 text-orange-500 shrink-0 mt-0.5" />
                                <div>
                                    <p className="font-bold text-orange-700 dark:text-orange-400 text-sm">Schedule Delay Risk: +{r.delayImpactDays} Days</p>
                                    <p className="text-xs text-orange-600/80 dark:text-orange-500/70 mt-0.5">AI models predict a {r.delayImpactDays}-day timeline expansion due to foundational conflicts. Recommend fast-track resolution meetings.</p>
                                </div>
                            </div>
                        )}
                        {r.redesignRequired && (
                            <div className="flex items-start gap-3 bg-destructive/5 border border-destructive/20 rounded-xl p-4">
                                <TriangleAlert className="h-5 w-5 text-destructive shrink-0 mt-0.5" />
                                <div>
                                    <p className="font-bold text-destructive text-sm">Mandatory Redesign Required</p>
                                    <p className="text-xs text-destructive/70 mt-0.5">Core structural zones exceed safe compliance thresholds. Return to engineering team for revision before supervisor sign-off.</p>
                                </div>
                            </div>
                        )}
                        {!r.redesignRequired && r.delayImpactDays === 0 && (
                            <div className="flex items-start gap-3 bg-emerald-500/5 border border-emerald-500/20 rounded-xl p-4">
                                <CheckCircle className="h-5 w-5 text-emerald-500 shrink-0 mt-0.5" />
                                <div>
                                    <p className="font-bold text-emerald-600 text-sm">Cleared for Approval</p>
                                    <p className="text-xs text-emerald-600/70 mt-0.5">No blocking issues detected. This project meets all mandatory regulatory checkpoints and is recommended for approval.</p>
                                </div>
                            </div>
                        )}
                    </div>
                </div>
            )}

            {/* ── SECTION 4: ADMIN AUDIT LOG ───────────────────────────────── */}
            {role === 'Admin' && (
                <div className="bg-card border border-border rounded-2xl overflow-hidden shadow-sm mb-4">
                    <div className="p-6">
                        <SectionHeading icon={Activity} title="Section 4 — Audit & Integrity Log" subtitle="Immutable, timestamped record of all critical pipeline events." />
                    </div>
                    <TableRow header cells={['Timestamp', 'Event', 'Actor', 'Verification']} />
                    {[
                        { time: 'Just now', event: 'Report Accessed', actor: 'Admin', actorCode: 'A', color: 'bg-primary/10 text-primary' },
                        { time: '2 min ago', event: 'Analysis Completed', actor: 'Orchestrator Node', actorCode: 'AI', color: 'bg-purple-500/10 text-purple-600' },
                        { time: '5 min ago', event: 'Blueprint Uploaded', actor: 'Lead Engineer', actorCode: 'E', color: 'bg-blue-500/10 text-blue-600' },
                    ].map((row, i) => (
                        <div key={i} className="grid px-4 py-3.5 border-b border-border/50 hover:bg-muted/20 transition-colors text-sm gap-3 items-center"
                            style={{ gridTemplateColumns: '8rem 1fr 10rem 8rem' }}>
                            <span className="font-mono text-xs text-muted-foreground">{row.time}</span>
                            <span className="font-medium text-foreground">{row.event}</span>
                            <span className="flex items-center gap-2 text-muted-foreground text-xs">
                                <span className={`h-6 w-6 rounded-md flex items-center justify-center text-[10px] font-bold ${row.color}`}>{row.actorCode}</span>
                                {row.actor}
                            </span>
                            <span className="flex items-center gap-1 font-mono text-[10px] text-emerald-600 bg-emerald-500/10 px-2 py-1 rounded w-max">
                                <CheckCircle className="h-3 w-3" /> Validated
                            </span>
                        </div>
                    ))}
                </div>
            )}

            {/* ── SECTION 5: RECOMMENDATIONS ──────────────────────────────── */}
            <div className="bg-card border border-border rounded-2xl p-6 shadow-sm mb-4">
                <SectionHeading icon={Sparkles} title="Section 5 — AI Recommendations" subtitle="Priority-ranked action items generated by the AI evaluation pipeline." />
                <div className="space-y-3">
                    {isCritical && (
                        <div className="flex items-start gap-3 text-sm border border-destructive/20 bg-destructive/5 rounded-xl p-4">
                            <ChevronsRight className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
                            <div>
                                <p className="font-bold text-destructive">P1 — Immediate: Resolve all Critical compliance items</p>
                                <p className="text-xs text-muted-foreground mt-0.5">Issue formal RFIs to the architectural team for each Critical item. Obtain written sign-off before resuming structural work.</p>
                            </div>
                        </div>
                    )}
                    <div className="flex items-start gap-3 text-sm border border-orange-500/20 bg-orange-500/5 rounded-xl p-4">
                        <ChevronRight className="h-4 w-4 text-orange-500 shrink-0 mt-0.5" />
                        <div>
                            <p className="font-bold text-orange-700 dark:text-orange-400">P2 — Short Term: Reconcile BOQ with site measurement sheets</p>
                            <p className="text-xs text-muted-foreground mt-0.5">All AI-estimated quantities should be independently verified by a certified quantity surveyor before procurement orders are placed.</p>
                        </div>
                    </div>
                    <div className="flex items-start gap-3 text-sm border border-border bg-muted/20 rounded-xl p-4">
                        <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
                        <div>
                            <p className="font-bold text-foreground">P3 — Routine: Schedule monthly re-evaluation</p>
                            <p className="text-xs text-muted-foreground mt-0.5">Re-run the Infralith AI pipeline after each design revision cycle to ensure ongoing compliance with updated codes.</p>
                        </div>
                    </div>
                </div>
            </div>

            {/* ── SECTION 6: FOOTER / METADATA ────────────────────────────── */}
            <div className="bg-muted/30 border border-border rounded-2xl p-6 shadow-sm mb-4">
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-xs">
                    {[
                        ['Engine', 'Infralith v2.1.0'],
                        ['Pipeline Nodes', '7 AI Agents'],
                        ['Processing Time', '4.2s'],
                        ['Security', 'End-to-End Encrypted'],
                        ['Model', 'Gemini Flash 2.0'],
                        ['Timestamp', formattedDate],
                        ['Report Format', 'IS / NBC 2016 Aligned'],
                        ['Classification', 'CONFIDENTIAL'],
                    ].map(([k, v]) => (
                        <div key={k} className="flex flex-col gap-0.5">
                            <span className="text-muted-foreground font-semibold">{k}</span>
                            <span className="font-bold text-foreground font-mono">{v}</span>
                        </div>
                    ))}
                </div>
                <Separator className="my-4" />
                <p className="text-[11px] text-muted-foreground leading-relaxed">
                    This report has been automatically generated by the Infralith AI Structural Evaluation Engine. Results are indicative and must be verified by a licensed structural engineer before being used for regulatory submissions, permits, or site approvals. Infralith and its agents accept no liability for errors arising from misinterpretation of uploaded documents.
                </p>
            </div>

            {/* ── QUICK ACTIONS SIDEBAR ROW ────────────────────────────────── */}
            <div className="flex flex-wrap gap-3">
                {(role === 'Supervisor' || role === 'Engineer') && (
                    <Button className="font-bold shadow-md gap-2" variant={r.redesignRequired ? 'destructive' : 'default'}>
                        <CheckCircle className="h-4 w-4" />
                        {role === 'Supervisor' ? (r.redesignRequired ? 'REJECT PROJECT' : 'APPROVE PROJECT') : 'EXPORT DOSSIER'}
                    </Button>
                )}
                {role === 'Engineer' && (
                    <Button onClick={() => handleAction('AR Launched', 'Matrix sent to mobile headset.')} variant="outline" className="gap-2">
                        <Smartphone className="h-4 w-4 text-primary" /> Send to AR Headset
                    </Button>
                )}
                {role === 'Supervisor' && (
                    <>
                        <Button onClick={() => handleAction('Drone Path', 'KML waypoints generated.')} variant="outline" className="gap-2">
                            <Plane className="h-4 w-4 text-primary" /> Export Drone Path
                        </Button>
                        <Button onClick={() => handleAction('Crypto Audit', 'Dossier signed.')} variant="outline" className="gap-2">
                            <ShieldCheck className="h-4 w-4 text-emerald-500" /> Generate Crypto Audit
                        </Button>
                    </>
                )}
                {role === 'Admin' && (
                    <Button variant="outline" className="gap-2">
                        <Settings className="h-4 w-4 text-primary" /> Configure Webhooks
                    </Button>
                )}
            </div>

            {/* ── VOICE-TO-RFI MODAL ───────────────────────────────────────── */}
            <Dialog open={isRfiOpen} onOpenChange={setIsRfiOpen}>
                <DialogContent className="sm:max-w-lg p-0 overflow-hidden rounded-2xl border-border shadow-2xl">
                    <div className="p-6 bg-muted/30 border-b border-border">
                        <DialogTitle className="flex items-center gap-2 text-xl font-bold">
                            <Zap className="h-5 w-5 text-primary" /> AI RFI Draft Assistant
                        </DialogTitle>
                        <DialogDescription className="mt-1.5 text-sm">
                            Generating a formal RFI for conflict: <span className="font-bold text-foreground">"{selectedConflict?.regulationRef}"</span>
                        </DialogDescription>
                    </div>
                    <div className="p-6 bg-card">
                        {!draftedRfi ? (
                            <div className="space-y-4">
                                <div className="flex gap-3">
                                    <Button size="icon" onClick={simulateVoiceRecording}
                                        className={`h-14 w-14 shrink-0 rounded-xl transition-all ${isRecording ? 'bg-destructive animate-pulse' : 'bg-primary hover:bg-primary/90'}`}>
                                        <Mic className="h-6 w-6 text-white" />
                                    </Button>
                                    <Textarea placeholder="Dictate or type your field observation..." value={rfiTranscript}
                                        onChange={(e) => setRfiTranscript(e.target.value)}
                                        className="resize-none h-24 bg-muted/40 border-border focus-visible:ring-primary/30 text-sm" />
                                </div>
                                <Button className="w-full h-11 font-bold text-sm" onClick={simulateAIGeneration} disabled={!rfiTranscript || isGenerating}>
                                    {isGenerating ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Structuring Formal RFI...</> : 'Generate Formal RFI Document'}
                                </Button>
                            </div>
                        ) : (
                            <div className="space-y-4">
                                <div className="bg-muted/40 border border-border rounded-xl p-4 font-mono text-xs text-foreground whitespace-pre-wrap h-[260px] overflow-y-auto leading-relaxed">
                                    {draftedRfi}
                                </div>
                                <div className="flex justify-end gap-3">
                                    <Button variant="outline" onClick={() => setDraftedRfi('')} className="font-semibold">Discard</Button>
                                    <Button className="font-bold bg-emerald-600 hover:bg-emerald-700 text-white gap-2"
                                        onClick={() => { handleAction('RFI Dispatched', 'Formal RFI sent to architectural review board.'); setIsRfiOpen(false); }}>
                                        <Send className="h-4 w-4" /> Send to Architect
                                    </Button>
                                </div>
                            </div>
                        )}
                    </div>
                </DialogContent>
            </Dialog>
        </div>
    );
}
