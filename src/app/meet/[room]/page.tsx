'use client';

import React, { useEffect, useRef, useState, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import {
    Mic, MicOff, Video, VideoOff, PhoneOff,
    MessageSquare, Users, Settings, ScreenShare, ShieldCheck, Maximize, Loader2
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { toast } from '@/hooks/use-toast';

export default function MeetRoomPage() {
    const params = useParams();
    const router = useRouter();
    const roomId = params.room as string;

    const videoRef = useRef<HTMLVideoElement>(null);
    const streamRef = useRef<MediaStream | null>(null);

    const [isMuted, setIsMuted] = useState(false);
    const [isVideoOff, setIsVideoOff] = useState(false);
    const [isConnecting, setIsConnecting] = useState(true);
    const [cameraOk, setCameraOk] = useState(false);

    // Attach stream to video element once it mounts and stream is ready
    const attachVideo = useCallback((el: HTMLVideoElement | null) => {
        if (el && streamRef.current) {
            el.srcObject = streamRef.current;
            videoRef.current = el;
        }
    }, []);

    useEffect(() => {
        let stopped = false;

        const initCamera = async () => {
            try {
                const userStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
                if (stopped) {
                    userStream.getTracks().forEach(t => t.stop());
                    return;
                }
                streamRef.current = userStream;
                setCameraOk(true);
                // Attach to video ref if already rendered
                if (videoRef.current) {
                    videoRef.current.srcObject = userStream;
                }
                setTimeout(() => setIsConnecting(false), 1200);
            } catch (err) {
                console.error('[Meet] Camera/mic error:', err);
                setIsConnecting(false);
                setIsVideoOff(true);
                toast({
                    title: 'Camera Access Denied',
                    description: 'Please allow camera & microphone permissions.',
                    variant: 'destructive',
                });
            }
        };

        initCamera();

        return () => {
            stopped = true;
            streamRef.current?.getTracks().forEach(t => t.stop());
        };
    }, []);

    // Toggle audio tracks
    useEffect(() => {
        streamRef.current?.getAudioTracks().forEach(t => { t.enabled = !isMuted; });
    }, [isMuted]);

    // Toggle video tracks
    useEffect(() => {
        streamRef.current?.getVideoTracks().forEach(t => { t.enabled = !isVideoOff; });
    }, [isVideoOff]);

    const handleEndCall = () => {
        streamRef.current?.getTracks().forEach(t => t.stop());
        router.push('/dashboard/team-directory?tab=messages');
    };

    return (
        <div className="h-screen w-full bg-[#0a0f1c] flex flex-col overflow-hidden text-slate-100 font-sans">

            {/* ── Top Bar ── */}
            <div className="h-16 border-b border-white/5 bg-[#0d1425] flex items-center justify-between px-6 shrink-0 z-20">
                <div className="flex items-center gap-3">
                    <div className="h-9 w-9 rounded-xl bg-blue-600/20 flex items-center justify-center border border-blue-500/20">
                        <ShieldCheck className="h-5 w-5 text-blue-400" />
                    </div>
                    <div>
                        <h1 className="text-sm font-bold tracking-tight">Secure Workspace Meet</h1>
                        <p className="text-[10px] text-slate-400 font-mono uppercase tracking-wider">
                            Internal • {roomId?.replace('room-', '#')}
                        </p>
                    </div>
                </div>
                <div className="flex items-center gap-2">
                    <span className="inline-flex items-center gap-1.5 bg-emerald-500/10 text-emerald-400 rounded-full px-3 py-1 text-[10px] font-bold uppercase tracking-widest border border-emerald-500/20">
                        <span className="h-1.5 w-1.5 bg-emerald-400 rounded-full animate-pulse" />
                        Live
                    </span>
                    <div className="hidden sm:flex items-center bg-white/5 rounded-lg p-1 border border-white/5 gap-0.5">
                        <Button variant="ghost" size="icon" className="h-8 w-8 text-slate-400 hover:text-white hover:bg-white/10"><Users className="h-4 w-4" /></Button>
                        <Button variant="ghost" size="icon" className="h-8 w-8 text-slate-400 hover:text-white hover:bg-white/10"><MessageSquare className="h-4 w-4" /></Button>
                        <Button variant="ghost" size="icon" className="h-8 w-8 text-slate-400 hover:text-white hover:bg-white/10"><Settings className="h-4 w-4" /></Button>
                    </div>
                </div>
            </div>

            {/* ── Video Area ── */}
            <div className="flex-1 relative bg-[#0a0f1c] flex items-center justify-center p-4 sm:p-6 overflow-hidden">
                {isConnecting ? (
                    <div className="flex flex-col items-center justify-center gap-5 text-center">
                        <div className="relative">
                            <div className="h-20 w-20 rounded-full border border-blue-500/20 animate-ping absolute inset-0" />
                            <div className="h-20 w-20 rounded-full bg-blue-600/10 flex items-center justify-center border border-blue-500/20 relative">
                                <Loader2 className="h-8 w-8 text-blue-500 animate-spin" />
                            </div>
                        </div>
                        <div>
                            <p className="text-base font-bold text-white">Setting up your room…</p>
                            <p className="text-xs text-slate-400 mt-1">Requesting camera & microphone access</p>
                        </div>
                    </div>
                ) : (
                    <div className="relative w-full max-w-6xl h-full max-h-[700px] flex gap-4">

                        {/* Main Camera Feed */}
                        <div className="relative flex-1 bg-[#111827] rounded-2xl overflow-hidden border border-white/5 shadow-2xl flex items-center justify-center group">
                            {isVideoOff || !cameraOk ? (
                                <div className="flex flex-col items-center gap-3">
                                    <div className="h-24 w-24 rounded-full bg-slate-800 flex items-center justify-center border border-white/10 text-3xl font-black text-slate-300">
                                        ME
                                    </div>
                                    {!cameraOk && (
                                        <p className="text-xs text-slate-500">Camera not available</p>
                                    )}
                                </div>
                            ) : (
                                <video
                                    ref={attachVideo}
                                    autoPlay
                                    playsInline
                                    muted
                                    className="w-full h-full object-cover [transform:scaleX(-1)]"
                                />
                            )}

                            {/* Name tag */}
                            <div className="absolute bottom-4 left-4 bg-black/70 backdrop-blur-md px-3 py-1.5 rounded-lg border border-white/10 flex items-center gap-2">
                                <span className="text-xs font-bold text-white">You (Host)</span>
                                {isMuted && <MicOff className="h-3 w-3 text-red-400" />}
                            </div>

                            {/* Hover banner */}
                            <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
                                <div className="bg-black/70 backdrop-blur-md px-6 py-3 rounded-2xl border border-white/10 text-center">
                                    <p className="text-white font-bold text-sm">Waiting for others to join…</p>
                                    <p className="text-slate-400 text-xs mt-1">Share the room link from Team Messages</p>
                                </div>
                            </div>
                        </div>

                        {/* Side participant slots (desktop) */}
                        <div className="hidden lg:flex w-[260px] shrink-0 flex-col gap-4">
                            {[1, 2].map(i => (
                                <div key={i} className="aspect-video bg-[#111827] rounded-xl border border-white/5 flex flex-col items-center justify-center gap-2 opacity-50">
                                    <Users className="h-7 w-7 text-slate-600" />
                                    <span className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Empty Seat</span>
                                </div>
                            ))}
                        </div>
                    </div>
                )}
            </div>

            {/* ── Control Bar ── */}
            <div className="h-20 bg-[#0d1425] border-t border-white/5 flex items-center justify-center gap-3 sm:gap-4 shrink-0 z-20 px-4">

                <ControlBtn
                    active={!isMuted}
                    onClick={() => setIsMuted(p => !p)}
                    icon={isMuted ? <MicOff className="h-5 w-5" /> : <Mic className="h-5 w-5" />}
                    danger={isMuted}
                />

                <ControlBtn
                    active={!isVideoOff}
                    onClick={() => setIsVideoOff(p => !p)}
                    icon={isVideoOff ? <VideoOff className="h-5 w-5" /> : <Video className="h-5 w-5" />}
                    danger={isVideoOff}
                />

                <div className="w-[1px] h-6 bg-white/10 mx-1 hidden sm:block" />

                <ControlBtn active onClick={() => { }} icon={<ScreenShare className="h-5 w-5" />} className="hidden sm:flex" />
                <ControlBtn active onClick={() => { }} icon={<Maximize className="h-5 w-5" />} className="hidden sm:flex" />

                <Button
                    onClick={handleEndCall}
                    className="h-12 px-6 rounded-full bg-red-600 hover:bg-red-700 text-white border-none font-bold gap-2 ml-2 shadow-lg shadow-red-900/30"
                >
                    <PhoneOff className="h-5 w-5" />
                    <span className="hidden sm:inline">Leave Room</span>
                </Button>

            </div>
        </div>
    );
}

// Reusable control button
function ControlBtn({ active, danger, onClick, icon, className }: {
    active: boolean; danger?: boolean; onClick: () => void;
    icon: React.ReactNode; className?: string;
}) {
    return (
        <button
            onClick={onClick}
            className={cn(
                "h-12 w-12 rounded-full flex items-center justify-center shadow-lg transition-all border",
                danger
                    ? "bg-red-600 hover:bg-red-700 border-red-700 text-white"
                    : "bg-[#1f2937] hover:bg-[#374151] border-white/10 text-white",
                className
            )}
        >
            {icon}
        </button>
    );
}
