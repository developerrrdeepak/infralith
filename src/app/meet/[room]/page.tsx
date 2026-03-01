'use client';

import React, { useEffect, useRef, useState, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useSession } from 'next-auth/react';
import { Button } from '@/components/ui/button';
import {
    Mic, MicOff, Video, VideoOff, PhoneOff,
    Users, ShieldCheck, ScreenShare, ScreenShareOff, Maximize, Loader2, Copy, CheckCheck, Check, X
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

type JoinRequest = {
    peerId: string;
    name?: string;
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
    const [isHost, setIsHost] = useState(false);
    const [isJoinPending, setIsJoinPending] = useState(false);
    const [joinRejected, setJoinRejected] = useState<string | null>(null);
    const [joinRequests, setJoinRequests] = useState<JoinRequest[]>([]);

    // ── Refs ──
    const myVideoRef = useRef<HTMLVideoElement>(null);
    const localStream = useRef<MediaStream | null>(null);
    const screenStream = useRef<MediaStream | null>(null);
    const peersRef = useRef<Map<string, Peer>>(new Map());
    const videoSendersRef = useRef<Map<string, RTCRtpSender>>(new Map());
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
            const sender = pc.addTrack(track, localStream.current!);
            if (track.kind === 'video') {
                videoSendersRef.current.set(remotePeerId, sender);
            }
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
        const eventType = String(data.type || '');

        if (eventType === 'join-request-pending') {
            setIsJoinPending(true);
            setIsConnecting(false);
            return;
        }

        if (eventType === 'join-rejected') {
            setJoinRejected(data.payload?.reason || 'Host denied your room request.');
            setIsJoinPending(false);
            setIsConnecting(false);
            return;
        }

        if (eventType === 'join-request') {
            const request: JoinRequest = {
                peerId: data.peerId,
                name: data.payload?.name,
            };
            setJoinRequests(prev => prev.some(item => item.peerId === request.peerId) ? prev : [...prev, request]);
            return;
        }

        if (eventType === 'join-request-cancelled') {
            setJoinRequests(prev => prev.filter(item => item.peerId !== data.peerId));
            return;
        }

        if (eventType === 'host-updated') {
            setIsHost(data.peerId === peerId);
            return;
        }

        if (eventType === 'joined') {
            setIsConnecting(false);
            setIsJoinPending(false);
            setJoinRejected(null);
            setIsHost(Boolean(data.payload?.isHost));

            const existingPeers = Array.isArray(data.peers) ? (data.peers as string[]) : [];
            for (const existingId of existingPeers) {
                const pc = createPeerConnection(existingId);
                const offer = await pc.createOffer();
                await pc.setLocalDescription(offer);
                signal(existingId, 'offer', offer);
            }
            return;
        }

        if (eventType === 'offer') {
            const peer = peersRef.current.get(data.from);
            const pc = peer?.pc ?? createPeerConnection(data.from);
            await pc.setRemoteDescription(new RTCSessionDescription(data.payload));
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            signal(data.from, 'answer', answer);
            return;
        }

        if (eventType === 'answer') {
            const peer = peersRef.current.get(data.from);
            if (peer) await peer.pc.setRemoteDescription(new RTCSessionDescription(data.payload));
            return;
        }

        if (eventType === 'ice-candidate') {
            const peer = peersRef.current.get(data.from);
            if (peer && data.payload) {
                try { await peer.pc.addIceCandidate(new RTCIceCandidate(data.payload)); } catch { }
            }
            return;
        }

        if (eventType === 'peer-left') {
            const peer = peersRef.current.get(data.peerId);
            peer?.pc.close();
            peersRef.current.delete(data.peerId);
            videoSendersRef.current.delete(data.peerId);
            setPeers(prev => prev.filter(p => p.peerId !== data.peerId));
        }
    }, [createPeerConnection, peerId, signal]);

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
            peersRef.current.clear();
            videoSendersRef.current.clear();
        };
    }, [handleSignal, peerId, roomId, router, status]);

    const handleJoinDecision = useCallback(async (targetPeerId: string, approve: boolean) => {
        if (!isHost) return;
        try {
            const res = await fetch('/api/meet/signal', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    roomId,
                    to: targetPeerId,
                    type: approve ? 'approve-join' : 'reject-join',
                }),
            });

            if (!res.ok) {
                throw new Error(`Signal moderation failed with status ${res.status}`);
            }

            setJoinRequests(prev => prev.filter(item => item.peerId !== targetPeerId));
            toast({
                title: approve ? 'Participant admitted' : 'Join request declined',
                description: `${targetPeerId} ${approve ? 'can now enter the room.' : 'was blocked from entering.'}`,
            });
        } catch (error) {
            console.error('[Meet] Failed to moderate join request:', error);
            toast({ title: 'Action failed', description: 'Could not process join request.', variant: 'destructive' });
        }
    }, [isHost, roomId]);

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
            <div className="relative bg-white rounded-2xl overflow-hidden shadow-md flex items-center justify-center aspect-video">
                {peer.stream ? (
                    <video ref={ref} autoPlay playsInline className="w-full h-full object-cover" />
                ) : (
                    <div className="flex flex-col items-center gap-2 opacity-70">
                        <Users className="h-8 w-8 text-gray-500" />
                        <span className="text-[10px] font-semibold text-gray-500 uppercase tracking-widest">Connecting...</span>
                    </div>
                )}
                <div className="absolute bottom-3 left-3 bg-white/80 backdrop-blur-sm px-3 py-1 rounded-full text-[10px] font-semibold text-gray-800 shadow-sm">
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
    const renegotiatePeer = useCallback(async (remotePeerId: string, pc: RTCPeerConnection) => {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        await signal(remotePeerId, 'offer', offer);
    }, [signal]);

    // Ensure every participant can publish video even when joining audio-only.
    const setOutgoingVideoTrack = useCallback(async (track: MediaStreamTrack | null, sourceStream?: MediaStream | null) => {
        for (const [remotePeerId, { pc }] of peersRef.current.entries()) {
            const existingSender = videoSendersRef.current.get(remotePeerId);
            if (existingSender) {
                await existingSender.replaceTrack(track);
                continue;
            }
            if (!track) continue;

            const streamForTrack = sourceStream || screenStream.current || localStream.current || new MediaStream([track]);
            const sender = pc.addTrack(track, streamForTrack);
            videoSendersRef.current.set(remotePeerId, sender);
            await renegotiatePeer(remotePeerId, pc);
        }
    }, [renegotiatePeer]);

    const toggleScreenShare = useCallback(async () => {
        if (isSharing) {
            // Stop screen share and restore camera
            screenStream.current?.getTracks().forEach(t => t.stop());
            screenStream.current = null;
            setIsSharing(false);

            const cameraTrack = localStream.current?.getVideoTracks()[0] || null;
            await setOutgoingVideoTrack(cameraTrack, localStream.current);

            // Restore local preview
            if (myVideoRef.current && localStream.current) {
                myVideoRef.current.srcObject = localStream.current;
            }
            return;
        }

        try {
            const display = await (navigator.mediaDevices as any).getDisplayMedia({
                video: { cursor: 'always' },
                audio: false,
            });
            screenStream.current = display;
            setIsSharing(true);

            const screenTrack = display.getVideoTracks()[0];
            await setOutgoingVideoTrack(screenTrack, display);

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
    }, [isSharing, setOutgoingVideoTrack]);

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
        <div className="relative h-screen w-full bg-[#f8f6f2] bg-[linear-gradient(to_right,rgba(148,163,184,0.08)_1px,transparent_1px),linear-gradient(to_bottom,rgba(148,163,184,0.08)_1px,transparent_1px)] bg-[size:32px_32px] flex flex-col overflow-hidden text-gray-900 font-sans">

            {/* Top Bar */}
            <div className="h-16 border-b border-gray-200 bg-white flex items-center justify-between px-6 shrink-0 z-20 shadow-sm">
                <div className="flex items-center gap-4">
                    <div className="h-9 w-9 rounded-xl bg-amber-100 flex items-center justify-center shadow-sm">
                        <ShieldCheck className="h-5 w-5 text-amber-700" />
                    </div>
                    <div>
                        <h1 className="text-sm font-semibold tracking-tight text-gray-900">Secure Workspace Meet</h1>
                        <p className="text-[10px] text-gray-500 font-medium uppercase tracking-wide">
                            Internal Room • {roomId?.replace('room-', '#')}
                        </p>
                    </div>
                </div>

                <div className="flex items-center gap-2">
                    {/* Participant count */}
                    <span className="inline-flex items-center gap-1.5 bg-amber-100 rounded-lg px-3 py-1.5 text-[11px] font-semibold text-amber-700 shadow-sm">
                        <Users className="h-3.5 w-3.5 text-amber-700" />
                        {isJoinPending ? 'Awaiting approval' : `${peers.length + 1} in room`}
                    </span>

                    <span className={cn(
                        "inline-flex items-center rounded-lg px-3 py-1 text-[10px] font-semibold uppercase tracking-wider shadow-sm",
                        isHost ? "bg-amber-50 text-amber-700" : "bg-gray-100 text-gray-600"
                    )}>
                        {isHost ? 'Host' : 'Participant'}
                    </span>

                    {/* Live badge */}
                    <span className="inline-flex items-center gap-1.5 bg-green-100 text-green-700 rounded-full px-3 py-1 text-[10px] font-semibold uppercase tracking-widest">
                        <span className="h-1.5 w-1.5 bg-green-600 rounded-full" /> Live
                    </span>

                    {/* Invite */}
                    <Button
                        variant="default"
                        onClick={copyLink}
                        className="h-9 bg-amber-500 hover:bg-amber-600 text-white text-xs font-semibold rounded-lg px-4 py-2 gap-1.5 shadow-sm"
                    >
                        {copied ? <CheckCheck className="h-3.5 w-3.5 text-white" /> : <Copy className="h-3.5 w-3.5" />}
                        <span className="hidden sm:inline">{copied ? 'Copied!' : 'Invite'}</span>
                    </Button>
                </div>
            </div>

            {isHost && joinRequests.length > 0 && (
                <div className="absolute top-20 right-6 z-30 w-[320px] rounded-2xl bg-white border border-gray-200 p-4 shadow-lg">
                    <p className="mb-2 text-xs font-semibold uppercase tracking-widest text-gray-700">
                        Join Requests ({joinRequests.length})
                    </p>
                    <div className="space-y-2 max-h-52 overflow-auto pr-1">
                        {joinRequests.map((request) => (
                            <div key={request.peerId} className="flex items-center justify-between gap-2 rounded-lg bg-gray-50 px-3 py-2 shadow-sm">
                                <div className="min-w-0">
                                    <p className="text-xs font-semibold text-gray-900 truncate">{request.name || request.peerId}</p>
                                    <p className="text-[10px] text-gray-500 truncate">{request.peerId}</p>
                                </div>
                                <div className="flex items-center gap-1">
                                    <button
                                        onClick={() => handleJoinDecision(request.peerId, true)}
                                        className="h-7 w-7 rounded-md bg-amber-500 hover:bg-amber-600 flex items-center justify-center"
                                        title="Approve"
                                    >
                                        <Check className="h-4 w-4 text-white" />
                                    </button>
                                    <button
                                        onClick={() => handleJoinDecision(request.peerId, false)}
                                        className="h-7 w-7 rounded-md bg-gray-200 hover:bg-gray-300 flex items-center justify-center"
                                        title="Reject"
                                    >
                                        <X className="h-4 w-4 text-gray-700" />
                                    </button>
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {/* Video Grid */}
            <div className="flex-1 relative flex items-center justify-center p-6 overflow-hidden">
                {joinRejected ? (
                    <div className="flex flex-col items-center gap-4 text-center max-w-md">
                        <div className="h-16 w-16 rounded-full bg-red-600/20 border border-red-500/30 flex items-center justify-center">
                            <X className="h-8 w-8 text-red-400" />
                        </div>
                        <div>
                            <p className="text-xl font-semibold text-gray-800">Entry request rejected</p>
                            <p className="text-sm text-gray-500 mt-2">{joinRejected}</p>
                        </div>
                        <Button onClick={handleLeave} className="bg-red-500 hover:bg-red-600 text-white rounded-lg px-5 font-medium">
                            Leave Room
                        </Button>
                    </div>
                ) : isJoinPending ? (
                    <div className="flex flex-col items-center gap-5 text-center">
                        <div className="relative">
                            <div className="h-20 w-20 rounded-full border border-amber-500/20 animate-pulse absolute inset-0" />
                            <div className="h-20 w-20 rounded-full bg-amber-600/10 flex items-center justify-center border border-amber-500/20 relative">
                                <Loader2 className="h-8 w-8 text-amber-400 animate-spin" />
                            </div>
                        </div>
                        <div>
                            <p className="text-xl font-semibold text-gray-800">Waiting for host approval</p>
                            <p className="text-sm text-gray-500 mt-2">The host must accept your request before you enter this room.</p>
                        </div>
                        <Button variant="default" onClick={handleLeave} className="border border-gray-200 bg-white text-gray-700 hover:bg-gray-100 rounded-lg px-4">
                            Cancel Request
                        </Button>
                    </div>
                ) : isConnecting ? (
                    <div className="flex flex-col items-center gap-5 text-center">
                        <div className="relative">
                            <div className="h-20 w-20 rounded-full border border-blue-500/20 animate-ping absolute inset-0" />
                            <div className="h-20 w-20 rounded-full bg-blue-600/10 flex items-center justify-center border border-blue-500/20 relative">
                                <Loader2 className="h-8 w-8 text-blue-500 animate-spin" />
                            </div>
                        </div>
                        <div>
                            <p className="text-xl font-semibold text-gray-800">Joining room...</p>
                            <p className="text-sm text-gray-500 mt-2">Requesting camera & setting up connection</p>
                        </div>
                    </div>
                ) : (
                    <div className={cn(
                        "w-full h-full max-w-6xl mx-auto rounded-2xl shadow-md bg-[#efe9df] p-4 grid gap-4 auto-rows-fr",
                        peers.length === 0 ? "grid-cols-1 max-w-3xl" :
                            peers.length === 1 ? "grid-cols-2" :
                                peers.length <= 3 ? "grid-cols-2" :
                                    "grid-cols-3"
                    )}>

                        {/* Local (my) video */}
                        <div className="relative bg-white rounded-2xl overflow-hidden shadow-md flex items-center justify-center group">
                            {isVideoOff || cameraError ? (
                                <div className="flex flex-col items-center gap-3 opacity-60">
                                    <div className="h-20 w-20 rounded-full bg-gradient-to-br from-amber-200 to-amber-400 shadow-inner flex items-center justify-center text-2xl font-semibold text-amber-900">ME</div>
                                    {isMuted && <span className="text-xs text-gray-500 flex items-center gap-1"><MicOff className="h-3 w-3" /> Muted</span>}
                                </div>
                            ) : (
                                <video
                                    ref={attachLocalVideo}
                                    autoPlay playsInline muted
                                    className="w-full h-full object-cover [transform:scaleX(-1)]"
                                />
                            )}
                            <div className="absolute bottom-3 left-3 bg-white/80 backdrop-blur-sm rounded-full px-3 py-1 text-xs text-gray-800 shadow-sm flex items-center gap-2">
                                <span className="text-xs font-medium">You ({isHost ? 'Host' : 'Participant'})</span>
                                {isMuted && <MicOff className="h-3 w-3 text-red-400" />}
                            </div>

                            {/* No peers - show invite prompt */}
                            {peers.length === 0 && (
                                <div className="absolute inset-0 flex items-end justify-center pb-16 pointer-events-none">
                                    <div className="bg-white/80 backdrop-blur-sm px-6 py-3 rounded-2xl shadow-sm text-center">
                                        <p className="text-gray-800 text-sm font-semibold">Waiting for others to join...</p>
                                        <p className="text-gray-500 text-xs mt-1">Click <strong>Invite</strong> to share your room link</p>
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
            <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-30 bg-white rounded-xl shadow-lg border border-gray-200 px-6 py-3 flex items-center justify-center gap-4">

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

                <div className="w-px h-6 bg-gray-200 mx-1 hidden sm:block" />

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
                    className="h-11 px-5 rounded-lg bg-red-500 hover:bg-red-600 text-white border-none font-medium gap-2 ml-3"
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
        <div className={cn("flex flex-col items-center gap-1 text-gray-600", className)}>
            <button
                onClick={onClick}
                title={label}
                className={cn(
                    "h-11 w-11 rounded-lg flex items-center justify-center transition-all duration-200",
                    danger
                        ? "bg-red-500 text-white hover:bg-red-600"
                        : active
                            ? "bg-amber-100 text-amber-700 hover:bg-amber-200"
                            : "bg-gray-100 text-gray-600 hover:bg-gray-200"
                )}
            >
                {icon}
            </button>
            {label && <span className="text-[9px] text-gray-500 font-medium hidden sm:block uppercase tracking-wider">{label}</span>}
        </div>
    );
}
