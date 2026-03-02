
'use client';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ShieldCheck, Cpu, Network, FileSearch, Calculator, AlertTriangle, Layers, CheckCircle } from 'lucide-react';
import { useAppContext } from '@/contexts/app-context';
import { Button } from '@/components/ui/button';
import { PIPELINE_STAGE_COUNT, PIPELINE_STAGES } from '@/ai/flows/infralith/pipeline';

const stageIcons = {
    gateway: Network,
    parse: FileSearch,
    cost: Calculator,
    risk: AlertTriangle,
    compliance: ShieldCheck,
    aggregate: Layers,
} as const;

export default function PipelineStatus() {
    const { handleNavigate, pipelineStage } = useAppContext();
    const boundedStage = Math.max(0, pipelineStage);
    const currentIndex = Math.min(boundedStage, PIPELINE_STAGE_COUNT);
    const isPipelineComplete = currentIndex >= PIPELINE_STAGE_COUNT;


    return (
        <div className="max-w-4xl mx-auto space-y-8 pb-12">
            <div className="flex flex-col gap-2">
                <div className="flex items-center gap-3">
                    <div className="h-10 w-10 rounded-xl bg-primary/20 flex items-center justify-center">
                        <Cpu className="h-6 w-6 text-primary" />
                    </div>
                    <h1 className="text-3xl font-black tracking-tight uppercase">AI FOUNDRY PIPELINE</h1>
                </div>
                <p className="text-muted-foreground font-mono text-sm tracking-widest">SYSTEM STATUS: [ REGIONAL ENGINE ACTIVE ]</p>
            </div>

            <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
                {PIPELINE_STAGES.map((stage, idx) => {
                    const isDone = idx < currentIndex;
                    const isCurrent = idx === currentIndex && !isPipelineComplete;
                    const Icon = stageIcons[stage.key];

                    return (
                        <Card key={idx} className={`premium-glass relative overflow-hidden transition-all duration-500 premium-glass-hover ${isCurrent ? 'border-primary ring-4 ring-primary/30 scale-[1.02] shadow-primary/40 shadow-2xl z-10' : 'opacity-50 hover:opacity-100'}`}>
                            <CardHeader className="pb-2">
                                <div className="flex items-center justify-between mb-4">
                                    <div className={`p-3 rounded-xl ${isDone ? 'bg-green-500/20 text-green-500' : isCurrent ? 'bg-primary/20 text-primary animate-pulse' : 'bg-muted text-muted-foreground'}`}>
                                        <Icon className="h-6 w-6" />
                                    </div>
                                    <Badge variant={isDone ? 'default' : isCurrent ? 'outline' : 'secondary'} className={`uppercase font-black px-4 ${isCurrent ? 'animate-pulse bg-primary text-primary-foreground' : ''}`}>
                                        {isDone ? 'COMPLETED' : isCurrent ? 'PROCESSING' : 'QUEUE'}
                                    </Badge>
                                </div>
                                <CardTitle className="text-lg font-black tracking-tighter uppercase">{stage.title}</CardTitle>
                                <CardDescription className="text-sm leading-relaxed">{stage.description}</CardDescription>
                            </CardHeader>
                            <CardContent />
                            {isCurrent && (
                                <div className="absolute bottom-0 left-0 w-full h-1.5 bg-primary/20 overflow-hidden">
                                    <div className="h-full w-full bg-primary origin-left animate-progress" />
                                </div>
                            )}
                        </Card>
                    );
                })}
            </div>

            {isPipelineComplete && (
                <div className="flex flex-col items-center justify-center p-12 bg-primary/5 rounded-3xl border-2 border-primary/20 border-dashed animate-in fade-in zoom-in duration-700">
                    <div className="p-6 bg-green-500/20 rounded-full mb-6">
                        <CheckCircle className="h-12 w-12 text-green-500" />
                    </div>
                    <h3 className="text-3xl font-black uppercase mb-4 tracking-tighter text-center">INTELLIGENCE SYNC SUCCESS</h3>
                    <p className="text-muted-foreground text-center max-w-sm mb-8 font-medium">
                        Deployment review and structural validation complete. Intelligence agents have established monitoring hooks.
                    </p>
                    <div className="flex gap-4">
                        <Button size="lg" className="h-14 px-10 bg-primary font-black uppercase tracking-widest shadow-xl shadow-primary/30" onClick={() => handleNavigate('compliance')}>
                            SCAN RESULTS
                        </Button>
                        <Button variant="outline" size="lg" className="h-14 px-10 font-black uppercase tracking-widest border-2" onClick={() => handleNavigate('report')}>
                            DOSSIER
                        </Button>
                    </div>
                </div>
            )}

            <style jsx global>{`
                @keyframes progress {
                    0% { transform: scaleX(0); }
                    100% { transform: scaleX(1); }
                }
                .animate-progress {
                    animation: progress 4s linear infinite;
                }
            `}</style>
        </div>
    );
}
