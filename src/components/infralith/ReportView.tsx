'use client';

import { Download, FileText, Share2, Printer, CheckCircle, ShieldCheck, AlertTriangle, Clock, Settings, TrendingDown, Wand2, Smartphone, Plane, Sparkles, Mic, Loader2, Send, ChevronRight, Activity, Zap } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from '@/components/ui/dialog';
import { useState } from 'react';
import { Textarea } from '@/components/ui/textarea';
import { useAppContext } from '@/contexts/app-context';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/hooks/use-toast';
import { Separator } from '@/components/ui/separator';

export default function ReportView() {
    const { infralithResult } = useAppContext();
    const { toast } = useToast();

    // Voice-to-RFI State
    const [isRfiOpen, setIsRfiOpen] = useState(false);
    const [isRecording, setIsRecording] = useState(false);
    const [rfiTranscript, setRfiTranscript] = useState('');
    const [isGenerating, setIsGenerating] = useState(false);
    const [draftedRfi, setDraftedRfi] = useState('');
    const [selectedConflict, setSelectedConflict] = useState<any>(null);

    const handleAction = (title: string, desc: string) => {
        toast({ title, description: desc });
    };

    const simulateVoiceRecording = () => {
        setIsRecording(true);
        setTimeout(() => {
            setRfiTranscript("The dimension for the egress corridor physically measures 1.2 meters, but the rule requires 1.5 meters. We need the architect to revise the load-bearing pillar placements on grid C4 to widen the path.");
            setIsRecording(false);
        }, 2500);
    };

    const simulateAIGeneration = () => {
        setIsGenerating(true);
        setTimeout(() => {
            setDraftedRfi(`FORMAL REQUEST FOR INFORMATION (RFI)
Date: ${new Date().toLocaleDateString()}
Subject: Egress Corridor Width Discrepancy - Grid C4

Dear Architectural Team,

During the AI-assisted structural evaluation, a compliance conflict was identified regarding the fire egress corridor. The current design specifies a width of 1.2m, whereas regional code requires a minimum of 1.5m.

We request a revision of the load-bearing pillar placements along Grid C4 to accommodate the required clearance without compromising structural integrity.

Please advise on the revised vector coordinates.

Signed,
Infralith AI Assistant (on behalf of Lead Engineer)`);
            setIsGenerating(false);
        }, 2000);
    };

    if (!infralithResult) {
        return (
            <div className="flex flex-col items-center justify-center p-16 text-center space-y-4 bg-muted/30 rounded-2xl border border-dashed border-border mt-8">
                <div className="h-20 w-20 rounded-full bg-primary/10 flex items-center justify-center mb-4">
                    <FileText className="h-10 w-10 text-primary" />
                </div>
                <h2 className="text-2xl font-bold tracking-tight text-foreground">No Active Report</h2>
                <p className="text-muted-foreground max-w-md">Please upload and analyze a blueprint through the pipeline to generate an enterprise-grade evaluation report.</p>
            </div>
        );
    }

    const { role, timestamp, projectScope } = infralithResult as any;
    const isCritical = (infralithResult as any).conflicts?.some((c: any) => c.riskCategory === 'Critical');

    return (
        <div className="w-full max-w-6xl mx-auto space-y-6 pb-20 animate-in fade-in slide-in-from-bottom-4 duration-500">

            {/* SaaS Page Header */}
            <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 bg-card p-6 rounded-2xl border border-border shadow-sm">
                <div>
                    <div className="flex items-center gap-2 mb-2">
                        <Badge variant="outline" className="text-[10px] uppercase font-bold tracking-wider text-muted-foreground border-border">Report ID: INFRA-{timestamp?.slice(0, 8)}</Badge>
                        <Badge className="bg-primary/10 text-primary hover:bg-primary/20 border-0">{role} View</Badge>
                        {!isCritical ? (
                            <Badge className="bg-emerald-500/10 text-emerald-600 hover:bg-emerald-500/20 border-0"><CheckCircle className="h-3 w-3 mr-1" /> Cleared</Badge>
                        ) : (
                            <Badge className="bg-destructive/10 text-destructive hover:bg-destructive/20 border-0"><AlertTriangle className="h-3 w-3 mr-1" /> Action Required</Badge>
                        )}
                    </div>
                    <h1 className="text-2xl md:text-3xl font-bold tracking-tight text-foreground">{projectScope}</h1>
                    <p className="text-sm text-muted-foreground mt-1 flex items-center gap-2">
                        <Clock className="h-3.5 w-3.5" /> Generated on {new Date(timestamp).toLocaleString()}
                    </p>
                </div>
                <div className="flex items-center gap-3">
                    <Button variant="outline" size="sm" className="hidden sm:flex shadow-sm"><Share2 className="h-4 w-4 mr-2" /> Share</Button>
                    <Button variant="outline" size="sm" className="hidden sm:flex shadow-sm"><Printer className="h-4 w-4 mr-2" /> Print PDF</Button>
                    <Button size="sm" className="shadow-sm shadow-primary/20 bg-primary hover:bg-primary/90 text-primary-foreground font-semibold">
                        <Download className="h-4 w-4 mr-2" /> Export JSON
                    </Button>
                </div>
            </div>

            {/* Main Content Grid */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">

                {/* Left Column (Primary Data) */}
                <div className="col-span-1 lg:col-span-2 space-y-6">

                    {role === 'Engineer' && (
                        <>
                            <Card className="border-border shadow-sm overflow-hidden rounded-2xl">
                                <CardHeader className="bg-muted/30 border-b border-border pb-4">
                                    <div className="flex items-center justify-between">
                                        <div className="flex items-center gap-2">
                                            <ShieldCheck className="h-5 w-5 text-primary" />
                                            <CardTitle className="text-lg">Compliance Analysis</CardTitle>
                                        </div>
                                        <Badge variant="outline" className="font-mono text-xs">AI Confidence: 98.4%</Badge>
                                    </div>
                                    <CardDescription>Automated structural and regulatory tolerance verification.</CardDescription>
                                </CardHeader>
                                <CardContent className="p-0">
                                    {(infralithResult as any).conflicts?.length > 0 ? (
                                        <div className="divide-y divide-border">
                                            {(infralithResult as any).conflicts.map((c: any, i: number) => (
                                                <div key={i} className="p-6 transition-colors hover:bg-muted/20 flex flex-col sm:flex-row justify-between gap-6">
                                                    <div className="space-y-2 flex-1">
                                                        <div className="flex items-center gap-3">
                                                            <Badge className={
                                                                c.riskCategory === 'Critical'
                                                                    ? 'bg-destructive text-destructive-foreground hover:bg-destructive/90'
                                                                    : 'bg-orange-500 text-white hover:bg-orange-600'
                                                            }>
                                                                {c.riskCategory}
                                                            </Badge>
                                                            <span className="text-sm font-semibold text-foreground">{c.regulationRef}</span>
                                                        </div>
                                                        <p className="text-sm text-muted-foreground break-words leading-relaxed">Location: <span className="font-medium text-foreground">{c.location}</span></p>
                                                    </div>

                                                    <div className="flex flex-col sm:items-end justify-center gap-3 bg-muted/40 p-4 rounded-xl border border-border min-w-[220px]">
                                                        <div className="w-full flex justify-between text-sm">
                                                            <span className="text-muted-foreground mr-4">Required:</span>
                                                            <span className="font-medium">{c.requiredValue}</span>
                                                        </div>
                                                        <div className="w-full flex justify-between text-sm">
                                                            <span className="text-muted-foreground mr-4">Measured:</span>
                                                            <span className="font-bold text-destructive">{c.measuredValue}</span>
                                                        </div>
                                                        {c.riskCategory === 'Critical' && (
                                                            <Button size="sm"
                                                                onClick={() => { setSelectedConflict(c); setIsRfiOpen(true); setRfiTranscript(''); setDraftedRfi(''); }}
                                                                variant="default"
                                                                className="w-full mt-2 h-8 text-xs font-semibold shadow-sm"
                                                            >
                                                                <Wand2 className="h-3.5 w-3.5 mr-2" /> Draft AI RFI
                                                            </Button>
                                                        )}
                                                    </div>
                                                </div>
                                            ))}
                                        </div>
                                    ) : (
                                        <div className="p-8 text-center flex flex-col items-center justify-center space-y-3">
                                            <div className="h-12 w-12 rounded-full bg-emerald-500/10 flex items-center justify-center">
                                                <CheckCircle className="h-6 w-6 text-emerald-500" />
                                            </div>
                                            <p className="font-medium text-emerald-600">All tolerances verified. Zero conflicts detected.</p>
                                        </div>
                                    )}
                                </CardContent>
                            </Card>

                            <Card className="border-border shadow-sm rounded-2xl">
                                <CardHeader className="pb-4">
                                    <div className="flex items-center justify-between">
                                        <CardTitle className="text-lg flex items-center gap-2"><Sparkles className="h-5 w-5 text-primary" /> Extracted BOQ</CardTitle>
                                        <Button size="sm" variant="ghost" className="h-8 text-xs text-primary font-semibold" onClick={() => handleAction("Optimizations", "Analyzing alternative composite materials...")}>Optimize Materials</Button>
                                    </div>
                                </CardHeader>
                                <CardContent>
                                    <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                                        {(infralithResult as any).materials?.slice(0, 8).map((m: any, i: number) => (
                                            <div key={i} className="bg-muted/40 p-4 rounded-xl border border-border flex flex-col">
                                                <span className="text-xs font-semibold uppercase text-muted-foreground mb-1 line-clamp-1">{m.item}</span>
                                                <span className="text-lg font-bold text-foreground mt-auto">{m.quantity} <span className="text-sm font-normal text-muted-foreground">{m.unit}</span></span>
                                            </div>
                                        ))}
                                    </div>
                                </CardContent>
                            </Card>
                        </>
                    )}

                    {role === 'Supervisor' && (
                        <>
                            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
                                <Card className="border-border shadow-sm rounded-2xl bg-card">
                                    <CardContent className="p-5 flex flex-col justify-center h-full">
                                        <span className="text-[11px] font-bold uppercase text-muted-foreground tracking-wider mb-2">Readiness Score</span>
                                        <div className="flex items-baseline gap-2">
                                            <span className={`text-3xl font-black ${(infralithResult as any).approvalReadinessScore > 80 ? 'text-emerald-500' : 'text-orange-500'}`}>{(infralithResult as any).approvalReadinessScore}</span>
                                            <span className="text-sm text-muted-foreground font-medium">/ 100</span>
                                        </div>
                                    </CardContent>
                                </Card>
                                <Card className="border-border shadow-sm rounded-2xl bg-card">
                                    <CardContent className="p-5 flex flex-col justify-center h-full">
                                        <span className="text-[11px] font-bold uppercase text-muted-foreground tracking-wider mb-2">Cost Impact</span>
                                        <span className="text-2xl font-black text-foreground">{(infralithResult as any).costImpactEstimate.toLocaleString()} <span className="text-sm text-muted-foreground">{(infralithResult as any).currency}</span></span>
                                    </CardContent>
                                </Card>
                                <Card className="border-border shadow-sm rounded-2xl bg-card">
                                    <CardContent className="p-5 flex flex-col justify-center h-full">
                                        <span className="text-[11px] font-bold uppercase text-muted-foreground tracking-wider mb-2">Delay Risk</span>
                                        <span className={`text-2xl font-black ${(infralithResult as any).delayImpactDays > 0 ? 'text-destructive' : 'text-emerald-500'}`}>+{(infralithResult as any).delayImpactDays} Days</span>
                                    </CardContent>
                                </Card>
                                <Card className="border-border shadow-sm rounded-2xl bg-card">
                                    <CardContent className="p-5 flex flex-col justify-center h-full">
                                        <span className="text-[11px] font-bold uppercase text-muted-foreground tracking-wider mb-2">Blockers</span>
                                        <span className={`text-2xl font-black ${(infralithResult as any).approvalBlockerCount > 0 ? 'text-destructive' : 'text-emerald-500'}`}>{(infralithResult as any).approvalBlockerCount}</span>
                                    </CardContent>
                                </Card>
                            </div>

                            {(infralithResult as any).delayImpactDays > 0 && (
                                <Card className="border-orange-500/30 bg-orange-500/5 shadow-sm rounded-2xl overflow-hidden">
                                    <div className="absolute left-0 top-0 bottom-0 w-1 bg-orange-500" />
                                    <CardContent className="p-5 flex items-start sm:items-center gap-4 relative">
                                        <div className="h-10 w-10 rounded-full bg-orange-500/20 flex items-center justify-center shrink-0">
                                            <Clock className="h-5 w-5 text-orange-600 dark:text-orange-500" />
                                        </div>
                                        <div>
                                            <h4 className="font-bold text-orange-700 dark:text-orange-400 text-sm mb-1">Predictive Schedule Delay Detected</h4>
                                            <p className="text-sm text-orange-600/80 dark:text-orange-500/80">AI models correlate foundational conflicts causing a projected {(infralithResult as any).delayImpactDays} day timeline expansion.</p>
                                        </div>
                                    </CardContent>
                                </Card>
                            )}

                            {(infralithResult as any).redesignRequired && (
                                <Card className="border-destructive/30 bg-destructive/5 shadow-sm rounded-2xl overflow-hidden">
                                    <div className="absolute left-0 top-0 bottom-0 w-1 bg-destructive" />
                                    <CardContent className="p-5 flex items-start sm:items-center gap-4 relative">
                                        <div className="h-10 w-10 rounded-full bg-destructive/20 flex items-center justify-center shrink-0">
                                            <AlertTriangle className="h-5 w-5 text-destructive" />
                                        </div>
                                        <div>
                                            <h4 className="font-bold text-destructive text-sm mb-1">Redesign Action Required</h4>
                                            <p className="text-sm text-destructive-foreground/80 dark:text-destructive/80">Core structural zones exceed safe compliance thresholds. Route back to engineering for revision.</p>
                                        </div>
                                    </CardContent>
                                </Card>
                            )}
                        </>
                    )
                    }

                    {
                        role === 'Admin' && (
                            <Card className="border-border shadow-sm rounded-2xl overflow-hidden">
                                <CardHeader className="bg-muted/30 border-b border-border pb-4">
                                    <CardTitle className="text-lg flex items-center gap-2"><Activity className="h-5 w-5 text-primary" /> Audit & Integrity Log</CardTitle>
                                    <CardDescription>Immutable record of critical pipeline events.</CardDescription>
                                </CardHeader>
                                <CardContent className="p-0">
                                    <div className="divide-y divide-border">
                                        <div className="grid grid-cols-4 gap-4 p-4 items-center text-sm hover:bg-muted/20 transition-colors">
                                            <div className="font-mono text-xs text-muted-foreground">Just now</div>
                                            <div className="font-medium text-foreground">Report Accessed</div>
                                            <div className="flex items-center gap-2 text-muted-foreground">
                                                <div className="h-6 w-6 rounded-md bg-primary/10 text-primary flex items-center justify-center text-[10px] font-bold">A</div>
                                                You (Admin)
                                            </div>
                                            <div className="font-mono text-[11px] text-emerald-600 bg-emerald-500/10 px-2 py-1 rounded w-max flex items-center gap-1"><CheckCircle className="h-3 w-3" /> Validated</div>
                                        </div>
                                        <div className="grid grid-cols-4 gap-4 p-4 items-center text-sm hover:bg-muted/20 transition-colors">
                                            <div className="font-mono text-xs text-muted-foreground">2 mins ago</div>
                                            <div className="font-medium text-foreground">Analysis Completed</div>
                                            <div className="flex items-center gap-2 text-muted-foreground">
                                                <div className="h-6 w-6 rounded-md bg-purple-500/10 text-purple-600 flex items-center justify-center text-[10px] font-bold">AI</div>
                                                Orchestrator Node
                                            </div>
                                            <div className="font-mono text-[11px] text-emerald-600 bg-emerald-500/10 px-2 py-1 rounded w-max flex items-center gap-1"><CheckCircle className="h-3 w-3" /> Validated</div>
                                        </div>
                                        <div className="grid grid-cols-4 gap-4 p-4 items-center text-sm hover:bg-muted/20 transition-colors">
                                            <div className="font-mono text-xs text-muted-foreground">5 mins ago</div>
                                            <div className="font-medium text-foreground">Blueprint Uploaded</div>
                                            <div className="flex items-center gap-2 text-muted-foreground">
                                                <div className="h-6 w-6 rounded-md bg-blue-500/10 text-blue-600 flex items-center justify-center text-[10px] font-bold">E</div>
                                                Lead Engineer
                                            </div>
                                            <div className="font-mono text-[11px] text-emerald-600 bg-emerald-500/10 px-2 py-1 rounded w-max flex items-center gap-1"><CheckCircle className="h-3 w-3" /> Validated</div>
                                        </div>
                                    </div>
                                </CardContent>
                            </Card>
                        )
                    }

                </div >

                {/* Right Column (Actions / Meta) */}
                < div className="col-span-1 space-y-6" >
                    <Card className="border-border shadow-sm rounded-2xl bg-card">
                        <CardHeader className="pb-4">
                            <CardTitle className="text-sm font-bold uppercase tracking-widest text-muted-foreground">Quick Actions</CardTitle>
                        </CardHeader>
                        <CardContent className="space-y-3">
                            {(role === 'Supervisor' || role === 'Engineer') && (
                                <Button className="w-full h-12 font-bold shadow-md hover:-translate-y-0.5 transition-transform" variant={(infralithResult as any).redesignRequired ? "destructive" : "default"}>
                                    {role === 'Supervisor' ? (
                                        <><CheckCircle className="mr-2 h-4 w-4" /> {(infralithResult as any).redesignRequired ? 'REJECT PROJECT' : 'APPROVE PROJECT'}</>
                                    ) : (
                                        <><Download className="mr-2 h-4 w-4" /> EXPORT DOSSIER</>
                                    )}
                                </Button>
                            )}

                            <Separator className="my-2" />

                            {role === 'Engineer' && (
                                <Button onClick={() => handleAction("AR Launched", "Sent matrix to mobile.")} variant="outline" className="w-full justify-start h-10 border-border bg-muted/30">
                                    <Smartphone className="mr-3 h-4 w-4 text-primary" /> Send to AR Headset
                                </Button>
                            )}
                            {role === 'Supervisor' && (
                                <>
                                    <Button onClick={() => handleAction("Drone Path", "KML generated.")} variant="outline" className="w-full justify-start h-10 border-border bg-muted/30">
                                        <Plane className="mr-3 h-4 w-4 text-primary" /> Export Drone Path
                                    </Button>
                                    <Button onClick={() => handleAction("Dossier Created", "Signed successfully.")} variant="outline" className="w-full justify-start h-10 border-border bg-muted/30">
                                        <ShieldCheck className="mr-3 h-4 w-4 text-emerald-500" /> Generate Crypto Audit
                                    </Button>
                                </>
                            )}
                            {role === 'Admin' && (
                                <Button variant="outline" className="w-full justify-start h-10 border-border bg-muted/30">
                                    <Settings className="mr-3 h-4 w-4 text-primary" /> Configure Webhooks
                                </Button>
                            )}
                        </CardContent>
                    </Card>

                    <Card className="border-border shadow-sm rounded-2xl bg-muted/30">
                        <CardHeader className="pb-2">
                            <CardTitle className="text-xs font-bold uppercase tracking-widest text-muted-foreground">System Metadata</CardTitle>
                        </CardHeader>
                        <CardContent className="space-y-2 text-xs">
                            <div className="flex justify-between">
                                <span className="text-muted-foreground">Engine</span>
                                <span className="font-semibold text-foreground">Infralith v2.1.0</span>
                            </div>
                            <div className="flex justify-between">
                                <span className="text-muted-foreground">Processing Time</span>
                                <span className="font-mono text-foreground">4.2s</span>
                            </div>
                            <div className="flex justify-between">
                                <span className="text-muted-foreground">Security</span>
                                <span className="font-medium text-emerald-600">End-to-End Encrypted</span>
                            </div>
                        </CardContent>
                    </Card>
                </div >
            </div >

            {/* Voice-to-RFI Modal */}
            < Dialog open={isRfiOpen} onOpenChange={setIsRfiOpen} >
                <DialogContent className="sm:max-w-lg p-0 overflow-hidden rounded-2xl border-border shadow-2xl">
                    <div className="p-6 bg-muted/30 border-b border-border">
                        <DialogTitle className="flex items-center gap-2 text-xl font-bold">
                            <Zap className="h-5 w-5 text-primary" /> AI Draft Assistant
                        </DialogTitle>
                        <DialogDescription className="mt-2 text-sm">
                            Speak or type your field observation regarding the <span className="font-bold text-foreground">"{selectedConflict?.regulationRef}"</span> conflict.
                        </DialogDescription>
                    </div>

                    <div className="p-6 bg-card">
                        {!draftedRfi ? (
                            <div className="space-y-5">
                                <div className="flex gap-3">
                                    <Button
                                        size="icon"
                                        onClick={simulateVoiceRecording}
                                        className={`h-14 w-14 shrink-0 rounded-xl transition-all shadow-sm ${isRecording ? 'bg-destructive animate-pulse hover:bg-destructive' : 'bg-primary hover:bg-primary/90'}`}
                                    >
                                        <Mic className="h-6 w-6 text-white" />
                                    </Button>
                                    <Textarea
                                        placeholder="I observed that..."
                                        value={rfiTranscript}
                                        onChange={(e) => setRfiTranscript(e.target.value)}
                                        className="resize-none h-24 bg-muted/40 border-border focus-visible:ring-primary/30"
                                    />
                                </div>

                                <Button
                                    className="w-full h-12 font-bold text-sm shadow-md"
                                    onClick={simulateAIGeneration}
                                    disabled={!rfiTranscript || isGenerating}
                                >
                                    {isGenerating ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Structuring Formal Request...</> : 'Generate Formal RFI'}
                                </Button>
                            </div>
                        ) : (
                            <div className="space-y-5">
                                <div className="bg-muted/40 border border-border rounded-xl p-5 font-mono text-xs text-foreground whitespace-pre-wrap h-[240px] overflow-y-auto leading-relaxed">
                                    {draftedRfi}
                                </div>
                                <div className="flex justify-end gap-3 w-full pt-2">
                                    <Button variant="outline" onClick={() => setDraftedRfi('')} className="font-semibold border-border">Discard</Button>
                                    <Button className="font-bold bg-emerald-600 hover:bg-emerald-700 text-white shadow-md transition-transform hover:-translate-y-0.5" onClick={() => {
                                        handleAction("RFI Dispatched", "Secure RFI successfully sent to the architectural review board.");
                                        setIsRfiOpen(false);
                                    }}>
                                        <Send className="mr-2 h-4 w-4" /> Send to Architect
                                    </Button>
                                </div>
                            </div>
                        )}
                    </div>
                </DialogContent >
            </Dialog >
        </div >
    );
}
