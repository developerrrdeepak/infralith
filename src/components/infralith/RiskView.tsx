
'use client';

import { ShieldAlert } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { useAppContext } from '@/contexts/app-context';

function getSeverityColor(severity: string) {
    const s = severity.toLowerCase();
    if (s === 'high') return { bar: 'bg-red-500', text: 'text-red-500', track: 'bg-red-500/10' };
    if (s === 'medium') return { bar: 'bg-orange-500', text: 'text-orange-500', track: 'bg-orange-500/10' };
    return { bar: 'bg-green-500', text: 'text-green-500', track: 'bg-green-500/10' };
}

export default function RiskView() {
    const { infralithResult } = useAppContext();
    const riskData = infralithResult?.risk;

    const hazards = riskData?.hazards.map((h: any) => ({
        title: h.type,
        severity: h.severity.toLowerCase(),
        score: Math.round(h.probability * 100),
        desc: h.mitigation
    })) || [
            { title: 'Foundation Settlement', severity: 'high', score: 85, desc: 'Soil composition signals liquefaction potential in Zone 3.' },
            { title: 'Seismic Vulnerability', severity: 'medium', score: 45, desc: 'Zone 2B compliance meets minimums but additional bracing recommended.' },
            { title: 'Material Fatigue', severity: 'low', score: 12, desc: 'Steel grade selection exceeds minimum requirements.' },
            { title: 'Wind Load', severity: 'low', score: 8, desc: 'Design accounts for hurricane force winds (Category 3).' },
        ];

    const overallScore = riskData?.riskIndex || 68;
    const isHighRisk = overallScore > 60;

    return (
        <div className="space-y-6 max-w-7xl mx-auto">
            <div className="flex flex-col gap-2">
                <h1 className="text-4xl font-black tracking-tight"><span className="text-gradient">Structural Risk</span> Analysis</h1>
                <p className="text-muted-foreground text-sm font-medium">
                    <span className="text-primary font-bold">Advanced AI</span> — analyzing structural failure patterns.
                </p>
            </div>

            <div className="grid gap-6 md:grid-cols-2">
                <Card className="premium-glass premium-glass-hover relative overflow-hidden group">
                    <div className="absolute inset-0 bg-gradient-to-br from-red-500/5 via-transparent to-transparent opacity-50" />
                    <CardHeader>
                        <CardTitle className={cn("flex items-center gap-2 text-lg", isHighRisk ? "text-red-500" : "text-green-500")}>
                            <ShieldAlert className="h-5 w-5" /> Overall Risk Score
                        </CardTitle>
                        <CardDescription className="text-xs">Composite score based on structural factors.</CardDescription>
                    </CardHeader>
                    <CardContent className="relative flex flex-col items-center justify-center py-10 gap-4">
                        <div className={cn("relative h-40 w-40 rounded-full border-[12px] flex items-center justify-center", isHighRisk ? "border-red-500/20" : "border-green-500/20")}>
                            <div
                                className={cn("absolute inset-0 rounded-full border-[12px] border-t-transparent -rotate-45", isHighRisk ? "border-red-500" : "border-green-500")}
                                style={{ transform: `rotate(${((overallScore / 100) * 360) - 90}deg)` }}
                            />
                            <div className="flex flex-col items-center">
                                <span className={cn("text-5xl font-bold drop-shadow-lg", isHighRisk ? "text-red-500 shadow-red-500/30" : "text-green-500 shadow-green-500/30")}>
                                    {overallScore}
                                </span>
                                <span className={cn("text-[10px] font-bold uppercase tracking-widest mt-1", isHighRisk ? "text-red-500/80" : "text-green-500/80")}>Index Score</span>
                            </div>
                        </div>
                        <div className="flex flex-col items-center gap-1">
                            <span className={cn("text-sm font-bold uppercase tracking-[0.2em]", isHighRisk ? "text-red-500" : "text-green-500")}>
                                {isHighRisk ? "Action Required" : "Design Healthy"}
                            </span>
                            <div className={cn("h-1 w-24 rounded-full overflow-hidden", isHighRisk ? "bg-red-500/20" : "bg-green-500/20")}>
                                <div
                                    className={cn("h-full transition-all duration-1000", isHighRisk ? "bg-red-500 animate-pulse" : "bg-green-500")}
                                    style={{ width: `${overallScore}%` }}
                                />
                            </div>
                        </div>
                    </CardContent>
                </Card>

                <Card className="premium-glass premium-glass-hover">
                    <CardHeader>
                        <CardTitle className="text-lg">Hazard Probabilities</CardTitle>
                        <CardDescription className="text-xs">AI-detected potential failure indicators.</CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-6">
                        {hazards.map((risk: any, idx: number) => {
                            const colors = getSeverityColor(risk.severity);
                            return (
                                <div key={idx} className="space-y-1.5">
                                    <div className="flex items-center justify-between text-xs font-semibold">
                                        <span className="opacity-80 uppercase tracking-wider">{risk.title}</span>
                                        <span className={cn(colors.text, "font-mono")}>{risk.score}%</span>
                                    </div>
                                    <div className={cn("w-full h-1.5 rounded-full", colors.track)}>
                                        <div
                                            className={cn("h-full rounded-full transition-all duration-1000", colors.bar)}
                                            style={{ width: `${risk.score}%` }}
                                        />
                                    </div>
                                    <p className="text-[10px] text-muted-foreground leading-snug">{risk.desc}</p>
                                </div>
                            );
                        })}
                    </CardContent>
                </Card>
            </div>
        </div>
    );
}
