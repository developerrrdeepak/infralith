
'use client';

import { useState } from 'react';
import {
    Video,
    Mic,
    MicOff,
    VideoOff,
    PhoneOff,
    Users,
    Settings,
    Monitor,
    Hand,
    Smile,
    Bot,
    Sparkles,
    FileText,
    CheckCircle2,
    Clock,
    Send,
    LayoutGrid,
    MoreHorizontal,
    Volume2
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { motion } from 'framer-motion';
import { useAppContext } from '@/contexts/app-context';
import { cn } from '@/lib/utils';

export default function ConferenceRoom() {
    const { user, handleNavigate } = useAppContext();
    const [isMicOn, setIsMicOn] = useState(true);
    const [isVideoOn, setIsVideoOn] = useState(true);
    const [isSummarizing, setIsSummarizing] = useState(false);
    const [summaryResult, setSummaryResult] = useState<any | null>(null);
    const [transcripts] = useState([
        { author: "Marcus Thorne", text: "We need to address the structural load variance in Sector 4." },
        { author: "Dr. Sarah Chen", text: "Agreed. The seismic isolation clips should be upgraded to Type-A." },
        { author: "Devid Lin", text: "I can update the procurement list for those by EOD." }
    ]);

    const handleSummarize = () => {
        setIsSummarizing(true);
        // Simulate AI summarization
        setTimeout(() => {
            setSummaryResult({
                title: "Sector 4 Structural Alignment",
                tasks: [
                    "Upgrade seismic isolation clips to Type-A in Sector 4 blueprints.",
                    "Update procurement list for dampening hardware by EOD.",
                    "Schedule follow-up audit for foundation settlement sensors."
                ],
                decisions: [
                    "Type-A clips approved for immediate integration.",
                    "Load variance threshold increased to 0.5%."
                ]
            });
            setIsSummarizing(false);
        }, 2500);
    };

    return (
        <div className="flex flex-col h-[calc(100vh-120px)] bg-slate-950 rounded-3xl border border-white/5 overflow-hidden">
            {/* Header */}
            <div className="p-4 border-b border-white/5 flex justify-between items-center bg-black/40 backdrop-blur-md">
                <div className="flex items-center gap-4">
                    <div className="h-10 w-10 rounded-xl bg-primary/20 flex items-center justify-center border border-primary/30">
                        <Video className="h-5 w-5 text-primary" />
                    </div>
                    <div>
                        <h2 className="text-lg font-bold">Project Alpha Sync - Mumbai</h2>
                        <div className="flex items-center gap-2 text-[10px] text-muted-foreground font-bold uppercase tracking-widest">
                            <span className="flex items-center gap-1"><Clock className="h-3 w-3" /> 42:15</span>
                            <span>•</span>
                            <span className="text-green-500 flex items-center gap-1"><Users className="h-3 w-3" /> 4 Participated</span>
                            <span>•</span>
                            <span className="bg-red-500/20 text-red-500 px-1.5 rounded flex items-center gap-1 animate-pulse"><Volume2 className="h-3 w-3" /> REC</span>
                        </div>
                    </div>
                </div>
                <div className="flex gap-2">
                    <Button variant="outline" size="sm" className="bg-white/5 border-white/10 hover:bg-white/10 gap-2">
                        <Users className="h-4 w-4" /> Participants
                    </Button>
                    <Button variant="outline" size="sm" className="bg-white/5 border-white/10 hover:bg-white/10 gap-2">
                        <Settings className="h-4 w-4" />
                    </Button>
                </div>
            </div>

            {/* Main Content Area */}
            <div className="flex-1 flex overflow-hidden">
                {/* Video Grid */}
                <div className="flex-1 p-6 grid grid-cols-2 gap-4 auto-rows-fr overflow-y-auto">
                    {[
                        { name: "Sarah Chen", role: "Structural Lead", active: true, color: "from-blue-600 to-indigo-700" },
                        { name: "Marcus Thorne", role: "Supervisor", active: false, color: "from-purple-600 to-pink-700" },
                        { name: "David Lin", role: "Procurement", active: false, color: "from-emerald-600 to-teal-700" },
                        { name: user?.name || "You", role: "Engineer", active: false, color: "from-orange-600 to-red-700" }
                    ].map((p, i) => (
                        <div key={i} className="relative rounded-2xl overflow-hidden bg-slate-900 border border-white/5 group shadow-xl">
                            {/* Static Gradient Avatar for Demo */}
                            <div className={cn("absolute inset-0 bg-gradient-to-br opacity-20", p.color)} />
                            <div className="absolute inset-0 flex items-center justify-center">
                                <div className={cn("h-32 w-32 rounded-full bg-gradient-to-br flex items-center justify-center text-4xl font-black text-white shadow-2xl transition-transform duration-500 group-hover:scale-110", p.color)}>
                                    {p.name[0]}
                                </div>
                            </div>

                            {/* Overlay Info */}
                            <div className="absolute top-4 left-4 flex gap-2">
                                <Badge className="bg-black/60 backdrop-blur-md border-white/10 font-bold px-3 py-1">
                                    {p.name}
                                </Badge>
                                <Badge variant="outline" className="bg-black/40 border-white/5 text-[10px] text-white/50">
                                    {p.role}
                                </Badge>
                            </div>

                            <div className="absolute bottom-4 right-4 flex gap-2">
                                <div className="p-2 rounded-full bg-black/60 backdrop-blur-md border border-white/5 text-white/70">
                                    {i === 2 ? <MicOff className="h-4 w-4 text-red-500" /> : <Mic className="h-4 w-4" />}
                                </div>
                            </div>

                            {p.active && (
                                <div className="absolute inset-0 border-2 border-primary/50 rounded-2xl pointer-events-none ring-4 ring-primary/20 animate-pulse" />
                            )}
                        </div>
                    ))}
                </div>

                {/* Sidebar - AI & Chat */}
                <div className="w-96 border-l border-white/5 bg-slate-900/40 backdrop-blur-xl flex flex-col shadow-2xl">
                    <div className="p-4 border-b border-white/5 flex items-center justify-around">
                        <Button variant="ghost" className="text-primary font-bold border-b-2 border-primary rounded-none px-6">AI Intel</Button>
                        <Button variant="ghost" className="text-muted-foreground font-bold px-6">Chat</Button>
                    </div>

                    <div className="flex-1 overflow-y-auto p-4 custom-scrollbar space-y-6">
                        {/* Live Transcript */}
                        <div className="space-y-4">
                            <h3 className="text-[10px] uppercase font-bold tracking-widest text-muted-foreground flex items-center gap-2">
                                <Clock className="h-3 w-3" /> Live Transcription
                            </h3>
                            <div className="space-y-3">
                                {transcripts.map((t, i) => (
                                    <div key={i} className="text-xs space-y-1">
                                        <span className="font-bold text-primary">{t.author}:</span>
                                        <p className="text-white/70 bg-white/5 p-2 rounded-lg border border-white/5 leading-relaxed">{t.text}</p>
                                    </div>
                                ))}
                            </div>
                        </div>

                        {/* AI Summary Section */}
                        <div className="pt-4 space-y-4">
                            {!summaryResult ? (
                                <div className="p-6 rounded-2xl bg-primary/5 border border-primary/20 flex flex-col items-center text-center gap-4">
                                    <div className="h-12 w-12 rounded-full bg-primary/20 flex items-center justify-center">
                                        <Bot className="h-6 w-6 text-primary" />
                                    </div>
                                    <div>
                                        <h4 className="font-bold text-sm">Automated Intelligence</h4>
                                        <p className="text-xs text-muted-foreground mt-1">Let the Infralith agent analyze this discussion and generate actionable tasks.</p>
                                    </div>
                                    <Button
                                        onClick={handleSummarize}
                                        disabled={isSummarizing}
                                        className="w-full bg-primary hover:bg-primary/80 font-bold gap-2"
                                    >
                                        {isSummarizing ? <Sparkles className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
                                        {isSummarizing ? "Analyzing Meeting..." : "Generate Action Plan"}
                                    </Button>
                                </div>
                            ) : (
                                <motion.div
                                    initial={{ opacity: 0, scale: 0.95 }}
                                    animate={{ opacity: 1, scale: 1 }}
                                    className="space-y-4"
                                >
                                    <div className="flex justify-between items-center">
                                        <h4 className="font-bold text-sm flex items-center gap-2 text-primary">
                                            <CheckCircle2 className="h-4 w-4" /> AI Action Summary
                                        </h4>
                                        <Button variant="ghost" size="sm" onClick={() => setSummaryResult(null)} className="h-7 text-[10px] uppercase font-bold text-muted-foreground">Reset</Button>
                                    </div>

                                    <div className="space-y-3">
                                        <div className="p-3 rounded-xl bg-black/40 border border-white/10 space-y-2">
                                            <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest flex items-center gap-2">
                                                <LayoutGrid className="h-3 w-3" /> Extracted Tasks
                                            </p>
                                            <div className="space-y-2">
                                                {summaryResult.tasks.map((t: string, i: number) => (
                                                    <div key={i} className="flex gap-2 text-xs text-white/80">
                                                        <span className="text-primary">•</span> {t}
                                                    </div>
                                                ))}
                                            </div>
                                        </div>

                                        <div className="p-3 rounded-xl bg-primary/10 border border-primary/20 space-y-2">
                                            <p className="text-[10px] font-bold text-primary uppercase tracking-widest flex items-center gap-2">
                                                <FileText className="h-3 w-3" /> Core Decisions
                                            </p>
                                            <div className="space-y-2">
                                                {summaryResult.decisions.map((d: string, i: number) => (
                                                    <div key={i} className="flex gap-2 text-xs font-semibold text-primary">
                                                        <CheckCircle2 className="h-3 w-3 mt-0.5" /> {d}
                                                    </div>
                                                ))}
                                            </div>
                                        </div>

                                        <Button className="w-full bg-emerald-600 hover:bg-emerald-500 font-bold text-xs">
                                            Push to Dashboard Tasks
                                        </Button>
                                    </div>
                                </motion.div>
                            )}
                        </div>
                    </div>

                    <div className="p-4 border-t border-white/5 bg-black/20">
                        <div className="relative">
                            <input
                                type="text"
                                placeholder="Send message..."
                                className="w-full bg-white/5 border border-white/10 rounded-full py-2 px-4 pr-10 text-xs focus:ring-1 focus:ring-primary outline-none"
                            />
                            <Send className="absolute right-3 top-2.5 h-3.5 w-3.5 text-muted-foreground cursor-pointer hover:text-primary transition-colors" />
                        </div>
                    </div>
                </div>
            </div>

            {/* Bottom Controls Bar */}
            <div className="p-6 bg-black/60 backdrop-blur-2xl border-t border-white/5 flex items-center justify-between">
                <div className="flex items-center gap-2">
                    <Badge variant="outline" className="bg-primary/10 text-primary border-primary/30 h-10 px-4 font-mono">
                        ROOM ID: INFR-T42-MUM
                    </Badge>
                </div>

                <div className="flex items-center gap-4">
                    <Button
                        size="icon"
                        variant="outline"
                        onClick={() => setIsMicOn(!isMicOn)}
                        className={cn("h-14 w-14 rounded-2xl border-white/10 transition-all", isMicOn ? "bg-white/5 hover:bg-white/10" : "bg-red-500/20 border-red-500/50 hover:bg-red-500/30")}
                    >
                        {isMicOn ? <Mic className="h-6 w-6" /> : <MicOff className="h-6 w-6 text-red-500" />}
                    </Button>
                    <Button
                        size="icon"
                        variant="outline"
                        onClick={() => setIsVideoOn(!isVideoOn)}
                        className={cn("h-14 w-14 rounded-2xl border-white/10 transition-all", isVideoOn ? "bg-white/5 hover:bg-white/10" : "bg-red-500/20 border-red-500/50 hover:bg-red-500/30")}
                    >
                        {isVideoOn ? <Video className="h-6 w-6" /> : <VideoOff className="h-6 w-6 text-red-500" />}
                    </Button>
                    <Button size="icon" variant="outline" className="h-14 w-14 rounded-2xl bg-white/5 border-white/10 hover:bg-white/10">
                        <Monitor className="h-6 w-6" />
                    </Button>
                    <Button size="icon" variant="outline" className="h-14 w-14 rounded-2xl bg-white/5 border-white/10 hover:bg-white/10">
                        <Hand className="h-6 w-6" />
                    </Button>
                    <Button size="icon" variant="outline" className="h-14 w-14 rounded-2xl bg-white/5 border-white/10 hover:bg-white/10">
                        <Smile className="h-6 w-6" />
                    </Button>
                    <Button size="icon" variant="outline" className="h-14 w-14 rounded-2xl bg-white/5 border-white/10 hover:bg-white/10">
                        <MoreHorizontal className="h-6 w-6" />
                    </Button>
                    <div className="h-10 w-px bg-white/10 mx-2" />
                    <Button onClick={() => handleNavigate('home')} className="h-14 px-8 rounded-2xl bg-red-600 hover:bg-red-700 font-bold gap-3 shadow-[0_0_20px_rgba(220,38,38,0.3)]">
                        <PhoneOff className="h-6 w-6" /> End Session
                    </Button>
                </div>

                <div className="flex items-center gap-4">
                    <div className="flex flex-col items-end">
                        <span className="text-[10px] font-bold text-primary uppercase tracking-tighter">Connection</span>
                        <span className="text-xs font-bold text-white uppercase tracking-widest">Excellent</span>
                    </div>
                </div>
            </div>
        </div>
    );
}
