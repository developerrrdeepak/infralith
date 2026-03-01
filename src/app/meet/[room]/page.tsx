'use client';

import React, { useEffect, useRef, useState, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useSession } from 'next-auth/react';
import { Button } from '@/components/ui/button';
import {
    Mic, MicOff, Video, VideoOff, PhoneOff,
    Users, ShieldCheck, ScreenShare, ScreenShareOff, Maximize, Loader2, Copy, CheckCheck
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { toast } from '@/hooks/use-toast';

// ── Free Google STUN servers — no API key required ──
const ICE_SERVERS = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
    ],
};

type Peer = {
    peerId: string;
    pc: RTCPeerConnection;
    stream?: MediaStream;
    videoRef?: React.RefObject<HTMLVideoElement>;
};

export default function MeetRoomPage() {
    const params = useParams();
    const router = useRouter();
    const { data: session, status } = useSession();
    const roomId = params.room as string;
    const peerId = session?.user?.id || '';

    // ── State ──
    const [isMuted, setIsMuted] = useState(false);
    const [isVideoOff, setIsVideoOff] = useState(false);
    const [isConnecting, setIsConnecting] = useState(true);
    const [cameraError, setCameraError] = useState(false);
    const [peers, setPeers] = useState<Peer[]>([]);
    const [copied, setCopied] = useState(false);
    const [isSharing, setIsSharing] = useState(false);

    // ── Refs ──
    const myVideoRef = useRef<HTMLVideoElement>(null);
    const localStream = useRef<MediaStream | null>(null);
    const screenStream = useRef<MediaStream | null>(null);
    const peersRef = useRef<Map<string, Peer>>(new Map());
    const sseRef = useRef<EventSource | null>(null);

    // ── Signal helpers ──
    const signal = useCallback(async (to: string, type: string, payload: any) => {
        if (!peerId) return;
        await fetch('/api/meet/signal', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ roomId, to, type, payload }),
        });
    }, [peerId, roomId]);

    // ── Create a new RTCPeerConnection for a remote peer ──
    const createPeerConnection = useCallback((remotePeerId: string): RTCPeerConnection => {
        const pc = new RTCPeerConnection(ICE_SERVERS);

        // Send local tracks to remote peer
        localStream.current?.getTracks().forEach(track => {
            pc.addTrack(track, localStream.current!);
        });

        // Send ICE candidates as they're found
        pc.onicecandidate = (e) => {
            if (e.candidate) signal(remotePeerId, 'ice-candidate', e.candidate);
        };

        // Receive remote video/audio
        pc.ontrack = (e) => {
            const remoteStream = e.streams[0];
            setPeers(prev => {
                const existing = prev.find(p => p.peerId === remotePeerId);
                if (!existing) return prev;
                const updated = { ...existing, stream: remoteStream };
                peersRef.current.set(remotePeerId, { ...peersRef.current.get(remotePeerId)!, stream: remoteStream });
                return prev.map(p => p.peerId === remotePeerId ? updated : p);
            });
        };

        peersRef.current.set(remotePeerId, { peerId: remotePeerId, pc });

        setPeers(prev => {
            if (prev.find(p => p.peerId === remotePeerId)) return prev;
            return [...prev, { peerId: remotePeerId, pc }];
        });

        return pc;
    }, [signal]);

    // ── Handle incoming SSE events ──
    const handleSignal = useCallback(async (event: MessageEvent) => {
        const data = JSON.parse(event.data);

        if (data.type === 'joined') {
            // We joined — initiate call with every existing peer
            setIsConnecting(false);
            for (const existingId of (data.peers as string[])) {
                const pc = createPeerConnection(existingId);
                const offer = await pc.createOffer();
                await pc.setLocalDescription(offer);
                signal(existingId, 'offer', offer);
            }
            if (data.peers.length === 0) setIsConnecting(false);
        }

        if (data.type === 'peer-joined') {
            // Someone new joined — they'll send us an offer shortly, just wait
        }

        if (data.type === 'offer') {
            let peer = peersRef.current.get(data.from);
            const pc = peer?.pc ?? createPeerConnection(data.from);
            await pc.setRemoteDescription(new RTCSessionDescription(data.payload));
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            signal(data.from, 'answer', answer);
        }

        if (data.type === 'answer') {
            const peer = peersRef.current.get(data.from);
            if (peer) await peer.pc.setRemoteDescription(new RTCSessionDescription(data.payload));
        }

        if (data.type === 'ice-candidate') {
            const peer = peersRef.current.get(data.from);
            if (peer && data.payload) {
                try { await peer.pc.addIceCandidate(new RTCIceCandidate(data.payload)); } catch { }
            }
        }

        if (data.type === 'peer-left') {
            const peer = peersRef.current.get(data.peerId);
            peer?.pc.close();
            peersRef.current.delete(data.peerId);
            setPeers(prev => prev.filter(p => p.peerId !== data.peerId));
        }
    }, [createPeerConnection, signal]);

    // ── Initialize camera, then connect SSE signaling ──
    useEffect(() => {
        let mounted = true;
        if (status === 'loading') return;
        if (status === 'unauthenticated') {
            router.push('/');
            return;
        }
        if (!peerId) return;

        const init = async () => {
            try {
                const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
                if (!mounted) { stream.getTracks().forEach(t => t.stop()); return; }
                localStream.current = stream;
                if (myVideoRef.current) {
                    myVideoRef.current.srcObject = stream;
                }
            } catch (err) {
                console.warn('[Meet] Camera/mic access denied:', err);
                setCameraError(true);
                toast({ title: 'Camera Access Denied', description: 'Joining audio-only.', variant: 'destructive' });
            }

            if (!mounted) return;

            // Open SSE connection to signaling server
            const sse = new EventSource(`/api/meet/signal?roomId=${encodeURIComponent(roomId)}&peerId=${encodeURIComponent(peerId)}`);
            sseRef.current = sse;
            sse.onmessage = handleSignal;
            sse.onerror = () => console.error('[Meet] SSE error — signaling disrupted');
        };

        init();

        return () => {
            mounted = false;
            localStream.current?.getTracks().forEach(t => t.stop());
            sseRef.current?.close();
            peersRef.current.forEach(p => p.pc.close());
        };
    }, [handleSignal, peerId, roomId, router, status]);

    // ── Attach local stream when video element mounts ──
    const attachLocalVideo = useCallback((el: HTMLVideoElement | null) => {
        if (el) {
            (myVideoRef as any).current = el;
            if (localStream.current) el.srcObject = localStream.current;
        }
    }, []);

    // ── Attach remote stream when video element mounts ──
    const RemoteVideo = ({ peer }: { peer: Peer }) => {
        const ref = useRef<HTMLVideoElement>(null);
        useEffect(() => {
            if (ref.current && peer.stream) ref.current.srcObject = peer.stream;
        }, [peer.stream]);
        return (
            <div className="relative bg-[#111827] rounded-xl overflow-hidden border border-white/5 flex items-center justify-center aspect-video">
                {peer.stream ? (
                    <video ref={ref} autoPlay playsInline className="w-full h-full object-cover" />
                ) : (
                    <div className="flex flex-col items-center gap-2 opacity-50">
                        <Users className="h-8 w-8 text-slate-500" />
                        <span className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Connecting…</span>
                    </div>
                )}
                <div className="absolute bottom-2 left-2 bg-black/60 backdrop-blur-sm px-2 py-1 rounded text-[10px] font-bold text-white">
                    {peer.peerId.replace('peer-', 'Guest #')}
                </div>
            </div>
        );
    };

    // ── Mic / camera toggles ──
    useEffect(() => {
        localStream.current?.getAudioTracks().forEach(t => { t.enabled = !isMuted; });
    }, [isMuted]);

    useEffect(() => {
        localStream.current?.getVideoTracks().forEach(t => { t.enabled = !isVideoOff; });
    }, [isVideoOff]);

    // ── Screen share toggle ──
    const toggleScreenShare = useCallback(async () => {
        if (isSharing) {
            // Stop screen share and restore camera
            screenStream.current?.getTracks().forEach(t => t.stop());
            screenStream.current = null;
            setIsSharing(false);

            // Put camera video track back into all peer connections
            const cameraTrack = localStream.current?.getVideoTracks()[0];
            if (cameraTrack) {
                peersRef.current.forEach(({ pc }) => {
                    const sender = pc.getSenders().find(s => s.track?.kind === 'video');
                    sender?.replaceTrack(cameraTrack);
                });
            }
            // Restore local preview
            if (myVideoRef.current && localStream.current) {
                myVideoRef.current.srcObject = localStream.current;
            }
        } else {
            try {
                const display = await (navigator.mediaDevices as any).getDisplayMedia({
                    video: { cursor: 'always' },
                    audio: false,
                });
                screenStream.current = display;
                setIsSharing(true);

                const screenTrack = display.getVideoTracks()[0];

                // Replace video track in every peer connection
                peersRef.current.forEach(({ pc }) => {
                    const sender = pc.getSenders().find(s => s.track?.kind === 'video');
                    sender?.replaceTrack(screenTrack);
                });

                // Show screen in local preview
                if (myVideoRef.current) {
                    myVideoRef.current.srcObject = display;
                }

                // When user clicks the browser "Stop Sharing" button
                screenTrack.addEventListener('ended', () => {
                    toggleScreenShare();
                });
            } catch (err: any) {
                if (err.name !== 'NotAllowedError') {
                    toast({ title: 'Screen Share Failed', description: err.message, variant: 'destructive' });
                }
            }
        }
    }, [isSharing]);

    // ── Fullscreen toggle ──
    const toggleFullscreen = useCallback(() => {
        if (!document.fullscreenElement) {
            document.documentElement.requestFullscreen().catch(() => { });
        } else {
            document.exitFullscreen().catch(() => { });
        }
    }, []);

    // ── Leave ──
    const handleLeave = () => {
        localStream.current?.getTracks().forEach(t => t.stop());
        sseRef.current?.close();
        peersRef.current.forEach(p => p.pc.close());
        router.push('/#messages');
    };

    // ── Copy invite link ──
    const copyLink = () => {
        navigator.clipboard.writeText(window.location.href);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
        toast({ title: 'Link copied!', description: 'Share this link to invite others.' });
    };

    // ── Render ──
    return (
        <div className="h-screen w-full bg-[#0a0f1c] flex flex-col overflow-hidden text-slate-100 font-sans">

            {/* Top Bar */}
            <div className="h-16 border-b border-white/5 bg-[#0d1425] flex items-center justify-between px-5 shrink-0 z-20">
                <div className="flex items-center gap-3">
                    <div className="h-9 w-9 rounded-xl bg-blue-600/20 flex items-center justify-center border border-blue-500/20">
                        <ShieldCheck className="h-5 w-5 text-blue-400" />
                    </div>
                    <div>
                        <h1 className="text-sm font-bold tracking-tight">Secure Workspace Meet</h1>
                        <p className="text-[10px] text-slate-400 font-mono uppercase">
                            Internal Room • {roomId?.replace('room-', '#')}
                        </p>
                    </div>
                </div>

                <div className="flex items-center gap-2">
                    {/* Participant count */}
                    <span className="inline-flex items-center gap-1.5 bg-white/5 rounded-lg px-3 py-1.5 text-[11px] font-bold border border-white/10">
                        <Users className="h-3.5 w-3.5 text-slate-400" />
                        {peers.length + 1} in room
                    </span>

                    {/* Live badge */}
                    <span className="inline-flex items-center gap-1.5 bg-emerald-500/10 text-emerald-400 rounded-full px-3 py-1 text-[10px] font-bold uppercase tracking-widest border border-emerald-500/20">
                        <span className="h-1.5 w-1.5 bg-emerald-400 rounded-full animate-pulse" /> Live
                    </span>

                    {/* Invite */}
                    <Button
                        variant="outline"
                        onClick={copyLink}
                        className="h-8 border-white/10 bg-white/5 hover:bg-white/10 text-white text-xs font-bold gap-1.5"
                    >
                        {copied ? <CheckCheck className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
                        <span className="hidden sm:inline">{copied ? 'Copied!' : 'Invite'}</span>
                    </Button>
                </div>
            </div>

            {/* Video Grid */}
            <div className="flex-1 relative bg-[#0a0f1c] flex items-center justify-center p-4 overflow-hidden">
                {isConnecting ? (
                    <div className="flex flex-col items-center gap-5 text-center">
                        <div className="relative">
                            <div className="h-20 w-20 rounded-full border border-blue-500/20 animate-ping absolute inset-0" />
                            <div className="h-20 w-20 rounded-full bg-blue-600/10 flex items-center justify-center border border-blue-500/20 relative">
                                <Loader2 className="h-8 w-8 text-blue-500 animate-spin" />
                            </div>
                        </div>
                        <div>
                            <p className="text-base font-bold text-white">Joining room…</p>
                            <p className="text-xs text-slate-400 mt-1">Requesting camera & setting up connection</p>
                        </div>
                    </div>
                ) : (
                    <div className={cn(
                        "w-full h-full max-w-7xl grid gap-3 auto-rows-fr",
                        peers.length === 0 ? "grid-cols-1 max-w-3xl" :
                            peers.length === 1 ? "grid-cols-2" :
                                peers.length <= 3 ? "grid-cols-2" :
                                    "grid-cols-3"
                    )}>

                        {/* Local (my) video */}
                        <div className="relative bg-[#111827] rounded-2xl overflow-hidden border border-white/5 shadow-2xl flex items-center justify-center group">
                            {isVideoOff || cameraError ? (
                                <div className="flex flex-col items-center gap-3 opacity-60">
                                    <div className="h-20 w-20 rounded-full bg-slate-800 flex items-center justify-center border border-white/10 text-2xl font-black text-slate-300">ME</div>
                                    {isMuted && <span className="text-xs text-slate-500 flex items-center gap-1"><MicOff className="h-3 w-3" /> Muted</span>}
                                </div>
                            ) : (
                                <video
                                    ref={attachLocalVideo}
                                    autoPlay playsInline muted
                                    className="w-full h-full object-cover [transform:scaleX(-1)]"
                                />
                            )}
                            <div className="absolute bottom-3 left-3 bg-black/70 backdrop-blur-md px-3 py-1.5 rounded-lg border border-white/10 flex items-center gap-2">
                                <span className="text-xs font-bold">You (Host)</span>
                                {isMuted && <MicOff className="h-3 w-3 text-red-400" />}
                            </div>

                            {/* No peers — show invite prompt */}
                            {peers.length === 0 && (
                                <div className="absolute inset-0 flex items-end justify-center pb-16 pointer-events-none">
                                    <div className="bg-black/60 backdrop-blur-md px-6 py-3 rounded-2xl border border-white/10 text-center">
                                        <p className="text-white font-bold text-sm">Waiting for others to join…</p>
                                        <p className="text-slate-400 text-xs mt-1">Click <strong>Invite</strong> to share your room link</p>
                                    </div>
                                </div>
                            )}
                        </div>

                        {/* Remote peers */}
                        {peers.map(peer => (
                            <RemoteVideo key={peer.peerId} peer={peer} />
                        ))}

                    </div>
                )}
            </div>

            {/* Control Bar */}
            <div className="h-20 bg-[#0d1425] border-t border-white/5 flex items-center justify-center gap-3 shrink-0 z-20">

                <CtrlBtn
                    active={!isMuted} danger={isMuted}
                    onClick={() => setIsMuted(p => !p)}
                    icon={isMuted ? <MicOff className="h-5 w-5" /> : <Mic className="h-5 w-5" />}
                    label={isMuted ? 'Unmute' : 'Mute'}
                />

                <CtrlBtn
                    active={!isVideoOff} danger={isVideoOff}
                    onClick={() => setIsVideoOff(p => !p)}
                    icon={isVideoOff ? <VideoOff className="h-5 w-5" /> : <Video className="h-5 w-5" />}
                    label={isVideoOff ? 'Start Video' : 'Stop Video'}
                />

                <div className="w-[1px] h-6 bg-white/10 mx-1 hidden sm:block" />

                <CtrlBtn
                    active={!isSharing}
                    danger={isSharing}
                    onClick={toggleScreenShare}
                    icon={isSharing ? <ScreenShareOff className="h-5 w-5" /> : <ScreenShare className="h-5 w-5" />}
                    label={isSharing ? 'Stop Share' : 'Share Screen'}
                    className="hidden sm:flex"
                />
                <CtrlBtn active onClick={toggleFullscreen} icon={<Maximize className="h-5 w-5" />} label="Fullscreen" className="hidden sm:flex" />

                <Button
                    onClick={handleLeave}
                    className="h-12 px-6 rounded-full bg-red-600 hover:bg-red-700 text-white border-none font-bold gap-2 ml-3 shadow-lg shadow-red-900/30"
                >
                    <PhoneOff className="h-5 w-5" />
                    <span className="hidden sm:inline">Leave</span>
                </Button>

            </div>
        </div>
    );
}

// ── Reusable control button ──
function CtrlBtn({ active, danger, onClick, icon, label, className }: {
    active: boolean; danger?: boolean; onClick: () => void;
    icon: React.ReactNode; label?: string; className?: string;
}) {
    return (
        <div className={cn("flex flex-col items-center gap-1", className)}>
            <button
                onClick={onClick}
                title={label}
                className={cn(
                    "h-12 w-12 rounded-full flex items-center justify-center shadow-lg transition-all border",
                    danger
                        ? "bg-red-600 hover:bg-red-700 border-red-700 text-white"
                        : "bg-[#1f2937] hover:bg-[#374151] border-white/10 text-white"
                )}
            >
                {icon}
            </button>
            {label && <span className="text-[9px] text-slate-500 font-medium hidden sm:block uppercase tracking-wider">{label}</span>}
        </div>
    );
}
