
'use client';

import { useState, useRef } from 'react';
import { Upload, FileText, CheckCircle, Loader2, History, ArrowRightLeft, GitCommit } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { useToast } from '@/hooks/use-toast';
import { useAppContext } from '@/contexts/app-context';

export default function BlueprintUpload() {
    const { handleNavigate, user, runInfralithEvaluation } = useAppContext();
    const [isUploading, setIsUploading] = useState(false);
    const [progress, setProgress] = useState(0);
    const [uploaded, setUploaded] = useState(false);
    const [showDiff, setShowDiff] = useState(false);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const { toast } = useToast();

    const isEngineer = user?.role === 'Engineer' || user?.role === 'Admin';

    const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;

        if (!isEngineer) {
            toast({
                title: "Access Denied",
                description: "Only Sr. Structural Engineers can upload new documents.",
                variant: "destructive"
            });
            return;
        }

        setIsUploading(true);
        setUploaded(false);
        setProgress(0);

        try {
            // Trigger the actual AI Workflow via Server Action (Acts as Orchestrator Layer)
            await runInfralithEvaluation(file);

            setIsUploading(false);
            setUploaded(true);
            toast({
                title: "Processing Complete",
                description: `AI Pipeline finished. Intelligence report is ready for ${user?.name}.`,
            });

            // Note: Navigation to 'pipeline' now happens inside runInfralithEvaluation
        } catch (error) {
            setIsUploading(false);
            setProgress(0);
            console.error("Upload/Processing error:", error);
            toast({
                title: "Processing Failed",
                description: "The AI agent orchestration encountered an error.",
                variant: "destructive"
            });
        }
    };


    const triggerFileSelect = () => {
        if (!isEngineer) {
            toast({
                title: "Access Denied",
                description: "Only site engineers can upload new documents.",
                variant: "destructive"
            });
            return;
        }
        fileInputRef.current?.click();
    };

    return (
        <div className="max-w-4xl mx-auto space-y-6">
            <div className="flex flex-col gap-2">
                <h1 className="text-3xl font-bold tracking-tight">Document Upload</h1>
                <p className="text-muted-foreground font-medium">Upload your project documents for intelligent structural analysis.</p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                <Card className="premium-glass premium-glass-hover border-dashed border-primary/30 md:col-span-2">
                    <CardHeader>
                        <CardTitle className="text-xl font-bold">Project Documents</CardTitle>
                        <CardDescription>Select a PDF file to begin the multi-agent evaluation workflow.</CardDescription>
                    </CardHeader>
                    <CardContent className="flex flex-col items-center justify-center p-12 space-y-6">
                        <input
                            type="file"
                            className="hidden"
                            ref={fileInputRef}
                            accept=".pdf,.doc,.docx"
                            onChange={handleFileChange}
                        />

                        {!uploaded ? (
                            <>
                                <div className={`h-24 w-24 rounded-full flex items-center justify-center transition-all duration-500 ${isUploading ? 'bg-primary/20 animate-pulse' : 'bg-primary/10'}`}>
                                    {isUploading ? (
                                        <Loader2 className="h-12 w-12 text-primary animate-spin" />
                                    ) : (
                                        <Upload className="h-12 w-12 text-primary" />
                                    )}
                                </div>

                                <div className="text-center space-y-2">
                                    <h3 className="font-semibold text-2xl">
                                        {isUploading ? 'Analyzing Document...' : 'Select Project Document'}
                                    </h3>
                                    <p className="text-sm text-muted-foreground">Supported formats: PDF, DOC, DOCX (Max 50MB)</p>
                                </div>

                                {isUploading ? (
                                    <div className="w-full max-w-sm space-y-4">
                                        <Progress value={progress} className="h-2" />
                                        <p className="text-xs text-center font-bold text-primary uppercase tracking-wider">
                                            Processing Analysis: {progress}%
                                        </p>
                                    </div>
                                ) : (
                                    <Button onClick={triggerFileSelect} size="lg" className="h-14 px-10 font-bold shadow-lg shadow-primary/20">
                                        <FileText className="mr-2 h-5 w-5" /> Select Document
                                    </Button>
                                )}
                            </>
                        ) : (
                            <div className="flex flex-col items-center space-y-6 animate-in zoom-in duration-500">
                                <div className="h-24 w-24 bg-green-500/10 rounded-full flex items-center justify-center border border-green-500/20">
                                    <CheckCircle className="h-12 w-12 text-green-500" />
                                </div>
                                <div className="text-center">
                                    <h3 className="font-bold text-2xl text-green-500">Analysis Complete</h3>
                                    <p className="text-sm text-muted-foreground mt-1">Foundry Pipeline has finalized structural results.</p>
                                </div>
                                <div className="flex gap-4">
                                    <Button variant="outline" size="lg" className="font-bold h-12 border-2" onClick={() => setUploaded(false)}>
                                        Upload Another
                                    </Button>
                                    <Button size="lg" className="font-bold h-12 bg-primary" onClick={() => handleNavigate('report')}>
                                        View Report
                                    </Button>
                                </div>
                            </div>
                        )}
                    </CardContent>
                </Card>

                <div className="space-y-6">
                    <Card className="premium-glass bg-black/40 border-white/5 h-full">
                        <CardHeader className="pb-4">
                            <CardTitle className="text-sm font-bold flex items-center gap-2 uppercase tracking-widest text-muted-foreground">
                                <History className="h-4 w-4" /> Version History
                            </CardTitle>
                        </CardHeader>
                        <CardContent className="space-y-4">
                            <div className="space-y-4 relative before:absolute before:inset-0 before:ml-2 before:-translate-x-px md:before:mx-auto md:before:translate-x-0 before:h-full before:w-0.5 before:bg-gradient-to-b before:from-transparent before:via-white/10 before:to-transparent">
                                {[
                                    { v: "v2.1", date: "Today", desc: "Corridor egress fixed" },
                                    { v: "v2.0", date: "Yesterday", desc: "Seismic update" },
                                    { v: "v1.0", date: "1w ago", desc: "Initial draft" }
                                ].map((ver, i) => (
                                    <div key={i} className="relative flex items-center justify-between md:justify-normal md:odd:flex-row-reverse group is-active">
                                        <div className="flex items-center justify-center w-5 h-5 rounded-full border border-white/20 bg-background-dark shadow shrink-0 md:order-1 md:group-odd:-translate-x-1/2 md:group-even:translate-x-1/2 absolute left-0 md:left-1/2 -ml-2.5 md:ml-0">
                                            {i === 0 && <div className="w-2 h-2 rounded-full bg-primary animate-pulse" />}
                                        </div>
                                        <div className="ml-8 md:ml-0 md:w-[calc(50%-1.5rem)] bg-white/5 border border-white/10 p-3 rounded-lg hover:border-primary/50 transition-colors w-full cursor-pointer">
                                            <div className="flex justify-between items-center mb-1">
                                                <span className="font-mono text-xs font-bold text-primary">{ver.v}</span>
                                                <span className="text-[10px] text-muted-foreground">{ver.date}</span>
                                            </div>
                                            <p className="text-xs text-muted-foreground">{ver.desc}</p>
                                        </div>
                                    </div>
                                ))}
                            </div>

                            <Button onClick={() => setShowDiff(!showDiff)} variant="outline" className="w-full mt-4 border-primary/30 text-primary hover:bg-primary/10">
                                <ArrowRightLeft className="h-4 w-4 mr-2" /> AI Semantic Diff Viewer
                            </Button>

                            {showDiff && (
                                <div className="bg-black/60 border border-primary/20 rounded-lg p-3 text-xs space-y-2 mt-2 animate-in slide-in-from-top-2">
                                    <div className="flex justify-between font-mono">
                                        <span className="text-muted-foreground">v2.0 <ArrowRightLeft className="h-3 w-3 inline mx-1" /> v2.1</span>
                                    </div>
                                    <div className="space-y-1">
                                        <div className="text-red-400 font-mono bg-red-500/10 p-1 rounded">- Egress width: 1.2m</div>
                                        <div className="text-green-400 font-mono bg-green-500/10 p-1 rounded">+ Egress width: 1.5m</div>
                                    </div>
                                    <p className="text-[10px] text-muted-foreground pt-2 border-t border-white/10">AI Impact: Code compliance increased by 14%.</p>
                                </div>
                            )}
                        </CardContent>
                    </Card>
                </div>
            </div>
        </div>
    );
}
