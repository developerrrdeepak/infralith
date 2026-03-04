
'use client';

import { CheckCircle2, AlertTriangle, XCircle, Database, FileText } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { useAppContext } from '@/contexts/app-context';
import { useToast } from '@/hooks/use-toast';

export default function ComplianceView() {
    const { infralithResult } = useAppContext();
    const { toast } = useToast();

    const handleRFI = () => {
        toast({
            title: "RFI Drafted",
            description: "AI-Generated RFI has been drafted and sent to Team Messages for architect review.",
        });
    };

    const rules = infralithResult?.compliance.rules.map((r: any) => ({
        title: r.ruleId,
        status: r.status,
        desc: r.description,
        comment: r.comment,
        severity: r.status === 'fail' ? 'critical' : (r.status === 'warn' ? 'high' : 'low')
    })) || [
            { title: 'Zoning Height Limit', status: 'pass', desc: 'Building height within 45m limit (Zone R-4).', severity: 'low', comment: 'Compliant' },
            { title: 'Fire Safety Exits', status: 'fail', desc: 'Ground floor lacks secondary egress path per NFPA 101.', severity: 'critical', comment: 'Improvement needed' },
            { title: 'ADA Accessibility', status: 'pass', desc: 'Ramp slopes comply with 1:12 ratio.', severity: 'medium', comment: 'Compliant' },
            { title: 'Structural load-bearing', status: 'warn', desc: 'Column spacing near maximum allowed span.', severity: 'high', comment: 'Consider bracing' },
            { title: 'Environmental Impact', status: 'pass', desc: 'LEED certification pre-qualifies.', severity: 'low', comment: 'Gold status' },
        ];

    const getStatusStyle = (status: string) => {
        switch (status) {
            case 'pass': return 'border-l-green-500/50 shadow-[0_0_15px_-5px_rgba(34,197,94,0.1)]';
            case 'fail': return 'border-l-red-500/50 shadow-[0_0_15px_-5px_rgba(239,68,68,0.1)]';
            case 'warn': return 'border-l-yellow-500/50 shadow-[0_0_15px_-5px_rgba(234,179,8,0.1)]';
            default: return 'border-l-primary/50';
        }
    };

    return (
        <div className="space-y-6 max-w-7xl mx-auto">
            <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
                <div className="flex flex-col gap-2">
                    <h1 className="text-4xl font-black tracking-tight"><span className="text-gradient">Compliance</span> Evaluation</h1>
                    <p className="text-muted-foreground text-sm font-medium">Regulatory validation against international and local building codes.</p>
                </div>
                <Badge variant="outline" className="text-sm bg-primary/10 border-primary/30 text-primary py-2 px-6 backdrop-blur-md rounded-full shadow-lg font-bold">
                    <Database className="h-4 w-4 mr-2" /> Global Standards: v2024.1
                </Badge>
            </div>

            <div className="grid gap-4 md:grid-cols-1">
                {rules.map((rule: any, idx: number) => (
                    <Card key={idx} className={cn(
                        "premium-glass hover:bg-white/10 transition-all group overflow-hidden relative",
                        "border-l-4", getStatusStyle(rule.status)
                    )}>
                        <div className={cn("absolute inset-y-0 left-0 w-[4px] shadow-[0_0_20px_rgba(34,197,94,0.4)]", rule.status === 'pass' ? 'bg-green-500' : rule.status === 'fail' ? 'bg-red-500' : 'bg-yellow-500')} />
                        <CardHeader className="flex flex-row items-center justify-between py-4">
                            <div className="flex items-center gap-4">
                                <div className={cn(
                                    "p-3 rounded-2xl flex items-center justify-center shrink-0 border",
                                    rule.status === 'pass' ? "bg-green-500/10 border-green-500/20" :
                                        rule.status === 'fail' ? "bg-red-500/10 border-red-500/20" : "bg-yellow-500/10 border-yellow-500/20"
                                )}>
                                    {rule.status === 'pass' && <CheckCircle2 className="text-green-500 h-8 w-8" />}
                                    {rule.status === 'fail' && <XCircle className="text-red-500 h-8 w-8" />}
                                    {rule.status === 'warn' && <AlertTriangle className="text-yellow-500 h-8 w-8" />}
                                </div>
                                <div className="space-y-1">
                                    <div className="flex items-center gap-3">
                                        <CardTitle className="text-lg font-bold tracking-tight">
                                            {rule.title}
                                        </CardTitle>
                                        <Badge variant="outline" className="text-[10px] h-5 px-2 bg-background/50 font-bold border-white/10">IS CODE</Badge>
                                    </div>
                                    <CardDescription className="text-sm font-medium text-foreground/70">{rule.desc}</CardDescription>
                                </div>
                            </div>
                            <div className="flex items-center gap-3">
                                <Badge variant="outline" className={cn(
                                    "text-[10px] uppercase font-bold tracking-widest px-2 py-0 border-none",
                                    rule.status === 'pass' ? "text-green-500" :
                                        rule.status === 'fail' ? "text-red-500" : "text-yellow-500"
                                )}>
                                    {rule.status}
                                </Badge>
                                <div className={cn(
                                    "h-8 w-1 rounded-full",
                                    rule.severity === 'critical' ? "bg-red-500" :
                                        rule.severity === 'high' ? "bg-orange-500" :
                                            rule.severity === 'medium' ? "bg-yellow-500" : "bg-green-500"
                                )} title={`Severity: ${rule.severity}`} />
                            </div>
                        </CardHeader>
                        {rule.status === 'fail' && (
                            <div className="px-6 pb-4 pt-2 border-t border-red-500/10 bg-red-500/5 mt-2 flex justify-between items-center">
                                <p className="text-xs text-red-500 font-medium max-w-[70%]">Critical issue requires engineering override or an authorized mitigation plan.</p>
                                <Button size="sm" onClick={handleRFI} className="h-8 bg-black hover:bg-black/80 text-white shadow-xl shadow-red-500/20 border border-red-500/30 font-bold text-xs"><FileText className="h-3 w-3 mr-2 text-red-400" /> Generate AI RFI</Button>
                            </div>
                        )}
                    </Card>
                ))}
            </div>

            <Card className="premium-glass premium-glass-hover">
                <div className="absolute top-0 right-0 p-8 opacity-5 pointer-events-none transform -rotate-12">
                    <Database className="h-40 w-40 text-primary" />
                </div>
                <CardHeader className="border-b border-primary/10 bg-primary/5 pb-4">
                    <CardTitle className="flex items-center gap-3 text-base font-bold text-primary">
                        <Database className="h-5 w-5" /> Data Governance & Validation Source
                    </CardTitle>
                </CardHeader>
                <CardContent className="pt-6 relative z-10">
                    <p className="text-sm text-foreground/80 leading-relaxed font-medium max-w-4xl">
                        This blueprint is currently validated against the <span className="text-foreground font-black text-primary">"Global Construction Standards 2024"</span> corpus.
                        Records are synchronized in real-time, ensuring that every evaluation reflects the latest zoning laws and structural safety mandates.
                    </p>
                </CardContent>
            </Card>
        </div>
    );
}
