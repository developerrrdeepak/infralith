'use client';

import { useState, useRef } from 'react';
import { Upload, FileText, CheckCircle, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { useToast } from '@/hooks/use-toast';
import { useAppContext } from '@/contexts/app-context';
import { pipelineStageToProgress } from '@/ai/flows/infralith/pipeline';

const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
const ALLOWED_EXTENSIONS = new Set(['.pdf', '.doc', '.docx', '.png', '.jpg', '.jpeg', '.webp']);

export default function BlueprintUpload() {
    const { handleNavigate, user, runInfralithEvaluation, pipelineStage } = useAppContext();
    const [isUploading, setIsUploading] = useState(false);
    const [uploaded, setUploaded] = useState(false);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const { toast } = useToast();
    const progress = pipelineStageToProgress(pipelineStage);

    const canUpload = !!user;

    const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;

        if (!canUpload) {
            toast({ title: "Access Denied", description: "Please sign in to upload documents.", variant: "destructive" });
            e.target.value = '';
            return;
        }

        const lower = file.name.toLowerCase();
        const dotIndex = lower.lastIndexOf('.');
        const extension = dotIndex >= 0 ? lower.slice(dotIndex) : '';
        if (!ALLOWED_EXTENSIONS.has(extension)) {
            toast({
                title: "Unsupported format",
                description: "Upload PDF, DOC, DOCX, PNG, JPG, JPEG, or WEBP files only.",
                variant: "destructive"
            });
            e.target.value = '';
            return;
        }
        if (file.size > MAX_UPLOAD_BYTES) {
            toast({
                title: "File too large",
                description: "Upload size limit is 100MB.",
                variant: "destructive"
            });
            e.target.value = '';
            return;
        }

        setIsUploading(true);
        setUploaded(false);

        try {
            await runInfralithEvaluation(file);
            setUploaded(true);
            toast({ title: "Processing Complete", description: `AI Pipeline finished. Intelligence report is ready for ${user?.name}.` });
        } catch (error) {
            const message = error instanceof Error ? error.message : "The AI agent orchestration encountered an error.";
            toast({ title: "Processing Failed", description: message, variant: "destructive" });
        } finally {
            setIsUploading(false);
            e.target.value = '';
        }
    };

    const triggerFileSelect = () => {
        if (!canUpload) {
            toast({ title: "Access Denied", description: "Please sign in to upload documents.", variant: "destructive" });
            return;
        }
        fileInputRef.current?.click();
    };

    return (
        <div className="w-full flex flex-col items-center pb-12">
            {/* Page Header */}
            <div className="w-full max-w-[600px] mb-2">
                <h1 className="text-3xl font-black tracking-tight text-slate-900 dark:text-white mb-1">Project Documents</h1>
                <p className="text-slate-500 font-semibold">Select a PDF file to begin the multi-agent evaluation workflow.</p>
            </div>

            {/* Main Card */}
            <div className="w-full max-w-[600px] mt-8 bg-white dark:bg-slate-900 rounded-[28px] shadow-[0_8px_40px_-12px_rgba(0,0,0,0.08)] border border-slate-100 dark:border-slate-800 overflow-hidden">
                <div className="flex flex-col items-center px-10 py-16">
                    <input
                        type="file"
                        className="hidden"
                        ref={fileInputRef}
                        accept=".pdf,.doc,.docx,.png,.jpg,.jpeg,.webp"
                        onChange={handleFileChange}
                    />

                    {!uploaded ? (
                        <>
                            {isUploading ? (
                                <div className="flex flex-col items-center w-full">
                                    <div className="h-28 w-28 rounded-full bg-orange-50 dark:bg-orange-900/20 flex items-center justify-center mb-8">
                                        <Loader2 className="h-12 w-12 text-[#f97316] animate-spin" strokeWidth={2.5} />
                                    </div>
                                    <h3 className="text-xl font-bold text-slate-800 dark:text-white mb-2">Analyzing Document</h3>
                                    <p className="text-sm text-slate-500 mb-6 text-center">Agent Foundry is extracting structural vectors.</p>
                                    <Progress value={progress} className="w-full max-w-[280px] h-2 bg-orange-100 dark:bg-orange-900/30 [&>div]:bg-[#f97316]" />
                                    <p className="text-[12px] font-black text-[#f97316] mt-2 uppercase tracking-widest">{progress}%</p>
                                </div>
                            ) : (
                                <div className="flex flex-col items-center w-full">
                                    <div className="h-32 w-32 bg-orange-50 dark:bg-orange-900/20 rounded-full flex items-center justify-center mb-8">
                                        <Upload className="h-14 w-14 text-[#f97316]" strokeWidth={2.5} />
                                    </div>
                                    <h3 className="text-[28px] font-black text-slate-900 dark:text-white mb-2 tracking-tight">Select Project Document</h3>
                                    <p className="text-[15px] text-slate-400 mb-10">Supported: PDF, DOC, DOCX, PNG, JPG, JPEG, WEBP (Max 100MB)</p>
                                    <Button
                                        onClick={triggerFileSelect}
                                        className="bg-[#f97316] hover:bg-[#ea580c] text-white font-bold h-14 px-10 rounded-[14px] text-[16px] shadow-lg shadow-orange-500/20 transition-all flex items-center gap-3"
                                    >
                                        <FileText className="h-5 w-5" /> Select Document
                                    </Button>
                                </div>
                            )}
                        </>
                    ) : (
                        <div className="flex flex-col items-center w-full">
                            <div className="h-28 w-28 bg-emerald-50 dark:bg-emerald-900/20 rounded-full flex items-center justify-center mb-8">
                                <CheckCircle className="h-14 w-14 text-emerald-500" strokeWidth={2.5} />
                            </div>
                            <h3 className="text-2xl font-black text-slate-900 dark:text-white mb-2 tracking-tight">Analysis Synchronized</h3>
                            <p className="text-[15px] text-slate-500 mb-10 text-center max-w-[340px]">Foundry AI Pipeline has successfully finalized the structural test results.</p>
                            <div className="flex gap-4">
                                <Button variant="outline" className="border-slate-200 dark:border-slate-700 text-slate-500 font-bold h-12 rounded-[14px] hover:bg-slate-50 px-8" onClick={() => setUploaded(false)}>
                                    Reset
                                </Button>
                                <Button className="bg-[#f97316] hover:bg-[#ea580c] text-white font-bold h-12 rounded-[14px] px-8" onClick={() => handleNavigate('report')}>
                                    View Report
                                </Button>
                            </div>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
