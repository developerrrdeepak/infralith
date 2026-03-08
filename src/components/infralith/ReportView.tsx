'use client';

import {
  Activity,
  BarChart3,
  CheckCircle,
  ChevronRight,
  ChevronsRight,
  ClipboardList,
  Download,
  FileText,
  Loader2,
  Mic,
  Plane,
  Printer,
  Send,
  Settings,
  Share2,
  ShieldCheck,
  Smartphone,
  Sparkles,
  TriangleAlert,
  Wand2,
  Zap,
} from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Separator } from '@/components/ui/separator';
import { Textarea } from '@/components/ui/textarea';
import { useAppContext } from '@/contexts/app-context';
import { useToast } from '@/hooks/use-toast';

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const NOT_AVAILABLE_TEXT = 'Not available in provided document data';

const valueOrNotAvailable = (value: unknown): string => {
  if (value == null) return NOT_AVAILABLE_TEXT;
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : NOT_AVAILABLE_TEXT;
  const text = String(value).trim();
  return text.length > 0 ? text : NOT_AVAILABLE_TEXT;
};

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
    <div
      className={`grid gap-3 px-4 py-3 text-sm ${
        header
          ? 'bg-muted/50 font-bold text-muted-foreground text-[11px] uppercase tracking-wider border-b border-border'
          : 'border-b border-border/50 hover:bg-muted/20 transition-colors'
      }`}
      style={{ gridTemplateColumns: `repeat(${cells.length}, 1fr)` }}
    >
      {cells.map((c, i) => (
        <span key={i} className={i === 0 && !header ? 'font-medium text-foreground' : ''}>
          {c}
        </span>
      ))}
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

  const handleAction = (title: string, description: string) => toast({ title, description });

  const simulateVoiceRecording = () => {
    setIsRecording(true);
    setTimeout(() => {
      setRfiTranscript('The egress corridor measures 1.2 m; code requires 1.5 m. Architect must revise pillar placement on grid C4.');
      setIsRecording(false);
    }, 2500);
  };

  const simulateAIGeneration = () => {
    setIsGenerating(true);
    setTimeout(() => {
      setDraftedRfi(`REQUEST FOR INFORMATION - RFI-${new Date().getFullYear()}-001
Issued: ${new Date().toLocaleDateString()}
Project: ${valueOrNotAvailable((infralithResult as any)?.projectScope)}
Subject: Compliance discrepancy follow-up

DESCRIPTION:
Ref regulation: ${valueOrNotAvailable(selectedConflict?.regulationRef)}
Measured: ${valueOrNotAvailable(selectedConflict?.measuredValue)}
Required: ${valueOrNotAvailable(selectedConflict?.requiredValue)}

REQUEST:
Provide revised detail and section drawings to resolve this non-compliance.`);
      setIsGenerating(false);
    }, 1600);
  };

  if (!infralithResult) {
    return (
      <div className="flex flex-col items-center justify-center p-16 text-center space-y-4 bg-muted/30 rounded-2xl border border-dashed border-border mt-8">
        <div className="h-20 w-20 rounded-full bg-primary/10 flex items-center justify-center mb-4">
          <FileText className="h-10 w-10 text-primary" />
        </div>
        <h2 className="text-2xl font-bold tracking-tight text-foreground">No Report Generated</h2>
        <p className="text-muted-foreground max-w-md">
          Upload a project document in Document Upload to trigger the AI evaluation pipeline and generate a structured engineering report.
        </p>
      </div>
    );
  }

  const r = infralithResult as any;
  const role = r.role || 'Engineer';
  const timestamp = r.timestamp;
  const projectScope = valueOrNotAvailable(r.projectScope);
  const parsedBlueprint = r.parsedBlueprint || {};
  const materials = Array.isArray(r.materials) && r.materials.length > 0
    ? r.materials
    : (Array.isArray(parsedBlueprint.materials) ? parsedBlueprint.materials : []);
  const extractionQuality = r.extractionQuality || null;
  const extractionWarnings = Array.isArray(extractionQuality?.warnings) ? extractionQuality.warnings : [];
  const extractionMissingFields = Array.isArray(extractionQuality?.missingFields) ? extractionQuality.missingFields : [];
  const extractionCriticalMissing = Array.isArray(extractionQuality?.criticalMissingFields) ? extractionQuality.criticalMissingFields : [];
  const extractionNeedsReview = !!extractionQuality?.reviewRequired || extractionMissingFields.length > 0;
  const conflicts = Array.isArray(r.conflicts) ? r.conflicts : [];
  const isCritical = conflicts.some((c: any) => c.riskCategory === 'Critical');
  const totalConflicts = conflicts.length;
  const criticalCount = conflicts.filter((c: any) => c.riskCategory === 'Critical').length;
  const reportNo = `INFRA-${timestamp?.slice(0, 10)?.replace(/-/g, '') || 'NODATE'}`;
  const formattedDate = timestamp ? new Date(timestamp).toLocaleDateString('en-IN', { day: '2-digit', month: 'long', year: 'numeric' }) : NOT_AVAILABLE_TEXT;
  const formattedTime = timestamp ? new Date(timestamp).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }) : NOT_AVAILABLE_TEXT;
  const pipelineLatencyMs = typeof r.pipelineLatencyMs === 'number' ? r.pipelineLatencyMs : null;
  const pipelineSeconds = pipelineLatencyMs != null ? `${(pipelineLatencyMs / 1000).toFixed(2)}s` : NOT_AVAILABLE_TEXT;
  const complianceUnavailable = r.complianceReport?.analysisStatus === 'not_available';
  const riskUnavailable = r.riskReport?.analysisStatus === 'not_available';
  const costUnavailable = r.costEstimate?.analysisStatus === 'not_available';
  const anyDomainUnavailable = complianceUnavailable || riskUnavailable || costUnavailable;
  const confidenceFromCost = typeof r.costEstimate?.confidenceScore === 'number' ? r.costEstimate.confidenceScore : null;
  const aiConfidencePct = confidenceFromCost != null
    ? Math.round(clamp(confidenceFromCost * 100, 0, 100))
    : (typeof extractionQuality?.coverageScore === 'number' ? clamp(extractionQuality.coverageScore, 0, 100) : 0);
  const readinessScore = typeof r.approvalReadinessScore === 'number' ? r.approvalReadinessScore : null;
  const delayImpactDays = typeof r.delayImpactDays === 'number' ? r.delayImpactDays : null;
  const costImpactDisplay =
    !costUnavailable && typeof r.costImpactEstimate === 'number'
      ? `${r.costImpactEstimate.toLocaleString()} ${typeof r.currency === 'string' ? r.currency : ''}`.trim()
      : NOT_AVAILABLE_TEXT;
  const redesignRequired = !!r.redesignRequired;
  const docInfo = r.documentInfo || null;
  const constructionControlSummary = r.constructionControlSummary || null;
  const constructionGates = Array.isArray(constructionControlSummary?.gates) ? constructionControlSummary.gates : [];
  const ruleReferences: string[] = Array.from(
    new Set(
      conflicts
        .map((item: any) => String(item?.regulationRef || '').trim())
        .filter(Boolean)
    )
  ).slice(0, 6) as string[];
  const approvalStatus = Array.isArray(r.approvalChain) && r.approvalChain.length > 0
    ? String(r.approvalChain[0]?.status || 'pending').toUpperCase()
    : 'PENDING';
  const assumptions = Array.isArray(r.costEstimate?.assumptions) ? r.costEstimate.assumptions : [];

  const handlePrintPdf = () => {
    if (typeof window === 'undefined') return;
    const previousTitle = document.title;
    document.title = `${reportNo}-Final-Report`;
    window.print();
    setTimeout(() => {
      document.title = previousTitle;
    }, 50);
  };

  const handleExportReport = () => {
    if (typeof window === 'undefined') return;
    const reportElement = document.getElementById('infralith-final-report');
    if (!reportElement) {
      toast({ title: 'Export failed', description: 'Report content not found.', variant: 'destructive' });
      return;
    }

    const exportHtml = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${reportNo} Final Report</title>
    <style>
      body { font-family: Arial, sans-serif; margin: 24px; color: #0f172a; }
      h1,h2,h3 { margin-top: 0; }
      .report-export * { box-sizing: border-box; }
      .report-export [data-print-hidden="true"] { display: none !important; }
      .report-export .shadow-sm, .report-export .shadow-md, .report-export .shadow-lg { box-shadow: none !important; }
    </style>
  </head>
  <body>
    <div class="report-export">${reportElement.innerHTML}</div>
  </body>
</html>`;

    const blob = new Blob([exportHtml], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${reportNo}-final-report.html`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
    toast({ title: 'Report exported', description: 'HTML dossier downloaded successfully.' });
  };

  return (
    <div id="infralith-final-report" className="report-print-root w-full max-w-5xl mx-auto space-y-0 pb-24 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="report-section bg-card border border-border rounded-2xl overflow-hidden shadow-sm mb-6">
        <div className="h-1.5 w-full bg-gradient-to-r from-orange-500 via-amber-400 to-orange-500" />
        <div className="p-6 md:p-8">
          <div className="flex flex-col md:flex-row justify-between gap-6">
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
                  ['Prepared By', 'Infralith AI Engine'],
                  ['Reviewed For', role],
                  ['AI Confidence', aiConfidencePct > 0 ? `${aiConfidencePct}%` : NOT_AVAILABLE_TEXT],
                  ['Doc Status', isCritical || extractionNeedsReview ? 'REVIEW REQUIRED' : 'READY'],
                ].map(([k, v]) => (
                  <div key={k} className="flex flex-col gap-0.5">
                    <span className="text-muted-foreground font-semibold">{k}</span>
                    <span className="font-bold text-foreground">{v}</span>
                  </div>
                ))}
              </div>
            </div>

            <div className="flex flex-col gap-2 md:items-end justify-start" data-print-hidden="true">
              <Button variant="outline" size="sm" className="gap-2 w-full md:w-auto">
                <Share2 className="h-3.5 w-3.5" /> Share
              </Button>
              <Button variant="outline" size="sm" className="gap-2 w-full md:w-auto" onClick={handlePrintPdf}>
                <Printer className="h-3.5 w-3.5" /> Print PDF
              </Button>
              <Button size="sm" className="gap-2 w-full md:w-auto bg-primary hover:bg-primary/90 text-primary-foreground font-bold shadow shadow-primary/20" onClick={handleExportReport}>
                <Download className="h-3.5 w-3.5" /> Export Report
              </Button>
            </div>
          </div>
        </div>
      </div>

      <div className="report-section bg-card border border-border rounded-2xl p-6 shadow-sm mb-4">
        <SectionHeading
          icon={FileText}
          title="Section 0 - Project Document Summary"
          subtitle="User-facing metadata from uploaded project document."
        />
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
          {[
            ['Document ID', reportNo],
            ['Issue Status', approvalStatus],
            ['Jurisdiction Focus', 'India'],
            ['Generated On', `${formattedDate} ${formattedTime}`],
            ['File Name', docInfo ? valueOrNotAvailable(docInfo.fileName) : NOT_AVAILABLE_TEXT],
            ['File Type', docInfo ? valueOrNotAvailable(docInfo.extension) : NOT_AVAILABLE_TEXT],
            ['File Size', docInfo ? `${Math.max(0, Number(docInfo.sizeBytes || 0) / (1024 * 1024)).toFixed(2)} MB` : NOT_AVAILABLE_TEXT],
            ['Extraction Coverage', extractionQuality ? `${extractionQuality.coverageScore}%` : NOT_AVAILABLE_TEXT],
          ].map(([k, v]) => (
            <div key={k} className="flex flex-col gap-0.5 border border-border/60 rounded-lg p-3">
              <span className="text-muted-foreground font-semibold">{k}</span>
              <span className="font-bold text-foreground font-mono break-all">{v}</span>
            </div>
          ))}
        </div>
        <div className="mt-4">
          <p className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground mb-2">Code References Detected</p>
          {ruleReferences.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {ruleReferences.map((ref) => (
                <Badge key={ref} variant="outline" className="text-[10px] font-bold uppercase tracking-wide">
                  {ref}
                </Badge>
              ))}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">{NOT_AVAILABLE_TEXT}</p>
          )}
        </div>
      </div>

      <div className="report-section bg-card border border-border rounded-2xl p-6 shadow-sm mb-4">
        <SectionHeading icon={BarChart3} title="Section 1 - Executive Summary" subtitle="High-level indicators extracted by the AI evaluation pipeline." />
        {anyDomainUnavailable && (
          <p className="text-xs text-orange-700 dark:text-orange-400 bg-orange-500/10 border border-orange-500/20 rounded-lg px-3 py-2 mb-3">
            One or more specialist analyses were unavailable. Financial/readiness metrics are marked as {NOT_AVAILABLE_TEXT}.
          </p>
        )}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
          <KPICard label="Total Issues" value={totalConflicts} sub="Non-compliance items" color={totalConflicts > 0 ? 'text-orange-500' : 'text-emerald-500'} />
          <KPICard label="Critical" value={criticalCount} sub="Require immediate action" color={criticalCount > 0 ? 'text-destructive' : 'text-emerald-500'} />
          {role === 'Supervisor' || role === 'Admin' ? (
            <>
              <KPICard label="Readiness Score" value={readinessScore != null ? `${readinessScore}/100` : NOT_AVAILABLE_TEXT} sub="Approval readiness" color={(readinessScore || 0) > 80 ? 'text-emerald-500' : 'text-orange-500'} />
              <KPICard label="Delay Risk" value={delayImpactDays != null ? `+${delayImpactDays} days` : NOT_AVAILABLE_TEXT} sub="Projected schedule slip" color={(delayImpactDays || 0) > 0 ? 'text-destructive' : 'text-emerald-500'} />
              <KPICard label="Cost Impact" value={costImpactDisplay} sub="Remediation estimate" />
            </>
          ) : (
            <>
              <KPICard label="BOQ Items" value={materials.length} sub="Material categories" />
              <KPICard label="Conflicts Found" value={totalConflicts} sub="Regulatory tolerance" color={totalConflicts > 0 ? 'text-destructive' : 'text-emerald-500'} />
              <KPICard label="AI Confidence" value={aiConfidencePct > 0 ? `${aiConfidencePct}%` : NOT_AVAILABLE_TEXT} sub="Pipeline confidence" color="text-emerald-500" />
              <KPICard label="Status" value={isCritical ? 'Review' : 'Passed'} sub="Overall evaluation" color={isCritical ? 'text-destructive' : 'text-emerald-500'} />
            </>
          )}
        </div>
      </div>

      {constructionGates.length > 0 && (
        <div className="report-section bg-card border border-border rounded-2xl overflow-hidden shadow-sm mb-4">
          <div className="p-6">
            <SectionHeading
              icon={ClipboardList}
              title="Section 1A - Construction Control Matrix"
              subtitle={constructionControlSummary?.reportingStandard || 'Execution-focused controls for progress, quality, safety, cost, and code closure.'}
            />
          </div>
          <TableRow header cells={['Control', 'Requirement', 'Status', 'Evidence', 'Action']} />
          {constructionGates.map((gate: any, index: number) => (
            <div key={`${gate?.key || 'gate'}-${index}`} className="grid px-4 py-3 gap-3 border-b border-border/50 hover:bg-muted/20 transition-colors text-sm items-start" style={{ gridTemplateColumns: '9rem 1.2fr 6rem 1.3fr 1.1fr' }}>
              <span className="font-semibold text-foreground text-xs">{gate?.title || 'Control'}</span>
              <span className="text-xs text-muted-foreground">{valueOrNotAvailable(gate?.requirement)}</span>
              <span>
                <Badge className={
                  gate?.status === 'Critical'
                    ? 'bg-destructive text-destructive-foreground text-[10px] font-bold uppercase'
                    : gate?.status === 'Warning'
                      ? 'bg-orange-500/20 text-orange-700 dark:text-orange-400 border-0 text-[10px] font-bold uppercase'
                      : 'bg-emerald-500/10 text-emerald-600 border-0 text-[10px] font-bold uppercase'
                }>
                  {gate?.status || 'Pass'}
                </Badge>
              </span>
              <span className="text-xs text-muted-foreground">{valueOrNotAvailable(gate?.evidence)}</span>
              <span className="text-xs text-foreground">{valueOrNotAvailable(gate?.action)}</span>
            </div>
          ))}
        </div>
      )}

      {extractionQuality && (
        <div className="report-section bg-card border border-border rounded-2xl p-6 shadow-sm mb-4">
          <SectionHeading icon={Activity} title="Section 2 - Extraction Quality" subtitle="Structured fields recovered from uploaded document." />
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-4">
            <KPICard label="Coverage" value={`${extractionQuality.coverageScore}%`} sub="Metadata extraction score" color={extractionQuality.coverageScore >= 70 ? 'text-emerald-500' : 'text-orange-500'} />
            <KPICard label="Fields Found" value={extractionQuality.extractedFields?.length || 0} sub="Parsed successfully" />
            <KPICard label="Missing Fields" value={extractionMissingFields.length} sub="Need clearer docs" color={extractionMissingFields.length > 0 ? 'text-destructive' : 'text-emerald-500'} />
          </div>
          {extractionMissingFields.length > 0 && (
            <p className="text-xs text-muted-foreground mb-2">Missing fields: {extractionMissingFields.join(', ')}</p>
          )}
          {extractionCriticalMissing.length > 0 && (
            <p className="text-xs text-destructive mb-2">
              Critical missing fields for compliance confidence: {extractionCriticalMissing.join(', ')}
            </p>
          )}
          {extractionWarnings.length > 0 && (
            <div className="space-y-2">
              {extractionWarnings.map((warning: string, index: number) => (
                <p key={index} className="text-xs text-orange-700 dark:text-orange-400 bg-orange-500/10 border border-orange-500/20 rounded-lg px-3 py-2">
                  {warning}
                </p>
              ))}
            </div>
          )}
        </div>
      )}

      {(role === 'Engineer' || role === 'Admin') && (
        <div className="report-section bg-card border border-border rounded-2xl overflow-hidden shadow-sm mb-4">
          <div className="p-6">
            <SectionHeading icon={ShieldCheck} title="Section 3 - Compliance and Regulation Analysis" subtitle="Per IS codes, NBC 2016, and project regulation references." />
          </div>
          {totalConflicts > 0 ? (
            <>
              <TableRow header cells={['#', 'Regulation Ref.', 'Location', 'Risk', 'Required', 'Measured', 'Action']} />
              {conflicts.map((c: any, i: number) => (
                <div key={i} className="grid px-4 py-3.5 gap-3 border-b border-border/50 hover:bg-muted/20 transition-colors text-sm items-center" style={{ gridTemplateColumns: '2rem 1fr 1fr 5.5rem 6.2rem 6.2rem 6rem' }}>
                  <span className="font-mono text-muted-foreground text-xs">{String(i + 1).padStart(2, '0')}</span>
                  <div className="min-w-0">
                    <p className="font-semibold text-foreground text-xs truncate">{valueOrNotAvailable(c.regulationRef)}</p>
                    {typeof c.confidenceScore === 'number' && (
                      <p className="text-[10px] text-muted-foreground font-mono">confidence {Math.round(clamp(c.confidenceScore, 0, 1) * 100)}%</p>
                    )}
                  </div>
                  <div className="min-w-0">
                    <p className="text-muted-foreground text-xs truncate">{valueOrNotAvailable(c.location)}</p>
                    {c.evidence && (
                      <p className="text-[10px] text-muted-foreground/90 truncate">evidence: {valueOrNotAvailable(c.evidence)}</p>
                    )}
                    {Array.isArray(c.citationIds) && c.citationIds.length > 0 && (
                      <p className="text-[10px] text-primary/90 truncate">citations: {c.citationIds.join(', ')}</p>
                    )}
                  </div>
                  <span>
                    <Badge className={c.riskCategory === 'Critical' ? 'bg-destructive text-destructive-foreground text-[10px] font-bold uppercase' : 'bg-orange-500/20 text-orange-700 dark:text-orange-400 border-0 text-[10px] font-bold uppercase'}>
                      {valueOrNotAvailable(c.riskCategory)}
                    </Badge>
                  </span>
                  <span className="text-xs font-medium text-emerald-600">{valueOrNotAvailable(c.requiredValue)}</span>
                  <span className="text-xs font-bold text-destructive">{valueOrNotAvailable(c.measuredValue)}</span>
                  {c.riskCategory === 'Critical' ? (
                    <Button size="sm" className="h-7 text-[10px] font-bold px-2" onClick={() => { setSelectedConflict(c); setIsRfiOpen(true); setRfiTranscript(''); setDraftedRfi(''); }}>
                      <Wand2 className="h-3 w-3 mr-1" /> Draft RFI
                    </Button>
                  ) : (
                    <span className="text-[10px] text-muted-foreground font-medium">Monitor</span>
                  )}
                </div>
              ))}
            </>
          ) : (
            <div className="px-6 pb-6 flex items-center gap-4 text-sm">
              <div className="h-10 w-10 rounded-full bg-emerald-500/10 flex items-center justify-center">
                <CheckCircle className="h-5 w-5 text-emerald-500" />
              </div>
              <div>
                <p className="font-bold text-emerald-600">All regulations satisfied</p>
                <p className="text-muted-foreground">Zero non-compliance items detected across structural and regulatory checks.</p>
              </div>
            </div>
          )}
        </div>
      )}

      {materials.length > 0 && (
        <div className="report-section bg-card border border-border rounded-2xl overflow-hidden shadow-sm mb-4">
          <div className="p-6">
            <SectionHeading icon={ClipboardList} title="Section 4 - Bill of Quantities (BOQ)" subtitle="AI-extracted material quantities from uploaded structural drawings." />
          </div>
          <TableRow header cells={['#', 'Material / Item', 'Quantity', 'Unit', 'Remarks']} />
          {materials.map((m: any, i: number) => (
            <div key={i} className="grid px-4 py-3 border-b border-border/50 hover:bg-muted/20 transition-colors text-sm items-center gap-3" style={{ gridTemplateColumns: '2rem 1fr 5rem 4rem 1fr' }}>
              <span className="font-mono text-muted-foreground text-xs">{String(i + 1).padStart(2, '0')}</span>
              <span className="font-semibold text-foreground">{valueOrNotAvailable(m.item)}</span>
              <span className="font-bold text-foreground font-mono">{valueOrNotAvailable(m.quantity)}</span>
              <span className="text-muted-foreground">{valueOrNotAvailable(m.unit)}</span>
              <span className="text-xs text-muted-foreground">{m.spec ? `Spec ${m.spec}` : `${NOT_AVAILABLE_TEXT}; verify with site measure sheet`}</span>
            </div>
          ))}
          <div className="px-6 py-3 bg-muted/20 border-t border-border text-xs text-muted-foreground">
            Quantities are AI-estimated from uploaded documents. Verify with certified site measurement sheets before procurement.
          </div>
        </div>
      )}

      <div className="report-section bg-card border border-border rounded-2xl p-6 shadow-sm mb-4">
        <SectionHeading icon={Sparkles} title="Section 5 - AI Recommendations" subtitle="Priority-ranked action items generated by the AI evaluation pipeline." />
        <div className="space-y-3">
          {isCritical && (
            <div className="flex items-start gap-3 text-sm border border-destructive/20 bg-destructive/5 rounded-xl p-4">
              <ChevronsRight className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
              <div>
                <p className="font-bold text-destructive">P1 - Immediate: Resolve all critical compliance items</p>
                <p className="text-xs text-muted-foreground mt-0.5">Issue formal RFIs for each critical item and obtain written sign-off before resuming structural work.</p>
              </div>
            </div>
          )}
          <div className="flex items-start gap-3 text-sm border border-orange-500/20 bg-orange-500/5 rounded-xl p-4">
            <ChevronRight className="h-4 w-4 text-orange-500 shrink-0 mt-0.5" />
            <div>
              <p className="font-bold text-orange-700 dark:text-orange-400">P2 - Short term: Reconcile BOQ with site measurement sheets</p>
              <p className="text-xs text-muted-foreground mt-0.5">Validate AI-estimated quantities with certified quantity surveyors before procurement orders.</p>
            </div>
          </div>
          {extractionMissingFields.length > 0 && (
            <div className="flex items-start gap-3 text-sm border border-border bg-muted/20 rounded-xl p-4">
              <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
              <div>
                <p className="font-bold text-foreground">P3 - Document quality uplift required</p>
                <p className="text-xs text-muted-foreground mt-0.5">Upload higher clarity drawings with explicit labels for: {extractionMissingFields.join(', ')}.</p>
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="report-section bg-card border border-border rounded-2xl p-6 shadow-sm mb-4">
        <SectionHeading icon={ShieldCheck} title="Section 6 - Assumptions, Limitations, and Sign-off" subtitle="Required governance notes before approvals and submissions." />
        <div className="space-y-3 text-xs">
          <p className="font-semibold text-foreground">Core assumptions and limitations:</p>
          <ul className="list-disc pl-5 space-y-1 text-muted-foreground">
            <li>Report conclusions depend on uploaded document quality and extracted evidence coverage.</li>
            <li>AI outputs are advisory and require licensed engineer validation before statutory submission.</li>
            <li>Any missing structural field or low confidence value requires manual verification workflow.</li>
            {assumptions.map((item: string, idx: number) => (
              <li key={`assumption_${idx}`}>{item}</li>
            ))}
          </ul>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mt-4">
          {[
            ['Prepared By', 'Infralith AI Engine'],
            ['Reviewed By', 'Supervisor / Structural Lead'],
            ['Approved By', 'Authorized Signatory'],
          ].map(([label, value]) => (
            <div key={label} className="border border-border rounded-lg p-3">
              <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">{label}</p>
              <p className="text-xs font-semibold text-foreground mt-2">{value}</p>
              <p className="text-[10px] text-muted-foreground mt-6 border-t border-dashed border-border pt-2">Signature & Date</p>
            </div>
          ))}
        </div>
      </div>

      <div className="report-section bg-muted/30 border border-border rounded-2xl p-6 shadow-sm mb-4">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-xs">
          {[
            ['Processing Time', pipelineSeconds],
            ['Timestamp', formattedDate],
            ['Issue Status', approvalStatus],
            ['Total Issues', String(totalConflicts)],
            ['Critical Issues', String(criticalCount)],
            ...(docInfo ? [
              ['File Name', valueOrNotAvailable(docInfo.fileName)],
              ['File Type', valueOrNotAvailable(docInfo.extension)],
              ['File Size', `${Math.max(0, Number(docInfo.sizeBytes || 0) / (1024 * 1024)).toFixed(2)} MB`],
              ['Extraction Coverage', extractionQuality ? `${extractionQuality.coverageScore}%` : NOT_AVAILABLE_TEXT],
            ] : []),
          ].map(([k, v]) => (
            <div key={`${k}_${v}`} className="flex flex-col gap-0.5">
              <span className="text-muted-foreground font-semibold">{k}</span>
              <span className="font-bold text-foreground font-mono">{v}</span>
            </div>
          ))}
        </div>
        <Separator className="my-4" />
        <p className="text-[11px] text-muted-foreground leading-relaxed">
          This report is generated by the Infralith AI Structural Evaluation Engine. Results are indicative and must be verified by a licensed structural engineer before use in regulatory submissions or site approvals.
        </p>
      </div>

      <div className="flex flex-wrap gap-3" data-print-hidden="true">
        {(role === 'Supervisor' || role === 'Engineer') && (
          <Button className="font-bold shadow-md gap-2" variant={redesignRequired ? 'destructive' : 'default'}>
            <CheckCircle className="h-4 w-4" />
            {role === 'Supervisor' ? (redesignRequired ? 'REJECT PROJECT' : 'APPROVE PROJECT') : 'EXPORT DOSSIER'}
          </Button>
        )}
        {role === 'Engineer' && (
          <Button onClick={() => handleAction('AR Launched', 'Matrix sent to mobile headset.')} variant="outline" className="gap-2">
            <Smartphone className="h-4 w-4 text-primary" /> Send to AR Headset
          </Button>
        )}
        {(role === 'Supervisor' || role === 'Admin') && (
          <Button onClick={() => handleAction('Drone Path', 'KML waypoints generated.')} variant="outline" className="gap-2">
            <Plane className="h-4 w-4 text-primary" /> Export Drone Path
          </Button>
        )}
        {role === 'Admin' && (
          <Button variant="outline" className="gap-2">
            <Settings className="h-4 w-4 text-primary" /> Configure Webhooks
          </Button>
        )}
      </div>

      <Dialog open={isRfiOpen} onOpenChange={setIsRfiOpen}>
        <DialogContent data-print-hidden="true" className="sm:max-w-lg p-0 overflow-hidden rounded-2xl border-border shadow-2xl">
          <div className="p-6 bg-muted/30 border-b border-border">
            <DialogTitle className="flex items-center gap-2 text-xl font-bold">
              <Zap className="h-5 w-5 text-primary" /> AI RFI Draft Assistant
            </DialogTitle>
            <DialogDescription className="mt-1.5 text-sm">
              Generating a formal RFI for conflict: <span className="font-bold text-foreground">"{valueOrNotAvailable(selectedConflict?.regulationRef)}"</span>
            </DialogDescription>
          </div>
          <div className="p-6 bg-card">
            {!draftedRfi ? (
              <div className="space-y-4">
                <div className="flex gap-3">
                  <Button
                    size="icon"
                    onClick={simulateVoiceRecording}
                    className={`h-14 w-14 shrink-0 rounded-xl transition-all ${isRecording ? 'bg-destructive animate-pulse' : 'bg-primary hover:bg-primary/90'}`}
                  >
                    <Mic className="h-6 w-6 text-white" />
                  </Button>
                  <Textarea
                    placeholder="Dictate or type your field observation..."
                    value={rfiTranscript}
                    onChange={(e) => setRfiTranscript(e.target.value)}
                    className="resize-none h-24 bg-muted/40 border-border focus-visible:ring-primary/30 text-sm"
                  />
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
                  <Button
                    className="font-bold bg-emerald-600 hover:bg-emerald-700 text-white gap-2"
                    onClick={() => {
                      handleAction('RFI Dispatched', 'Formal RFI sent to architectural review board.');
                      setIsRfiOpen(false);
                    }}
                  >
                    <Send className="h-4 w-4" /> Send to Architect
                  </Button>
                </div>
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
      <style jsx global>{`
        @page {
          size: A4 portrait;
          margin: 12mm;
        }
        @media print {
          body {
            background: #ffffff !important;
          }
          #stars-container,
          [data-print-hidden='true'] {
            display: none !important;
          }
          .report-print-root {
            max-width: 100% !important;
            margin: 0 !important;
            padding: 0 !important;
          }
          .report-section {
            break-inside: avoid;
            page-break-inside: avoid;
            box-shadow: none !important;
            border-color: #d1d5db !important;
          }
        }
      `}</style>
    </div>
  );
}
