/**
 * WebRTC Signaling Server - Room-based, in-memory
 * Supports: join approval, offer, answer, ice-candidate, leave
 * Transport: Server-Sent Events (SSE) per client
 *
 * Hardening:
 * - Requires authenticated session (NextAuth)
 * - Host approves/rejects new entrants
 * - Validates room/peer identifiers
 * - Caps room and peer counts to avoid unbounded memory growth
 */

import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth/next';
import type { Session } from 'next-auth';
import { authOptions } from '@/lib/auth';

type SignalEvent = {
    type: string;
    from?: string;
    to?: string;
    payload?: unknown;
    roomId?: string;
    peerId?: string;
    peers?: string[];
};

type PeerController = ReadableStreamDefaultController<Uint8Array>;
type RoomState = {
    hostId: string;
    members: Map<string, PeerController>;
    pending: Map<string, PeerController>;
};

const rooms = new Map<string, RoomState>(); // roomId -> room state
const sseEncoder = new TextEncoder();

const ROOM_ID_REGEX = /^[a-zA-Z0-9_-]{3,64}$/;
const PEER_ID_REGEX = /^[a-zA-Z0-9_-]{3,64}$/;
const EVENT_TYPE_REGEX = /^[a-z][a-z0-9-]{1,63}$/i;
const MAX_ROOMS = Number(process.env.MEET_MAX_ROOMS || 200);
const MAX_PEERS_PER_ROOM = Number(process.env.MEET_MAX_PEERS_PER_ROOM || 12);
const MAX_SIGNAL_PAYLOAD_BYTES = 256 * 1024;

function getSessionPeerId(session: Session | null): string | null {
    const explicitId = String(session?.user?.id || '').trim();
    if (PEER_ID_REGEX.test(explicitId)) return explicitId;

    const email = String(session?.user?.email || '').trim().toLowerCase();
    if (!email) return null;

    const localPart = email
        .split('@')[0]
        ?.replace(/[^a-z0-9_-]/gi, '-')
        .replace(/-+/g, '-')
        .slice(0, 64);
    return localPart && PEER_ID_REGEX.test(localPart) ? localPart : null;
}

function payloadSizeInBytes(value: unknown): number {
    try {
        return Buffer.byteLength(JSON.stringify(value ?? null), 'utf8');
    } catch {
        return Number.POSITIVE_INFINITY;
    }
}

function queueEvent(ctrl: PeerController, event: SignalEvent) {
    ctrl.enqueue(sseEncoder.encode(`data: ${JSON.stringify(event)}\n\n`));
}

function sendToPeer(room: RoomState, peerId: string, event: SignalEvent) {
    const ctrl = room.members.get(peerId) || room.pending.get(peerId);
    if (!ctrl) return false;
    try {
        queueEvent(ctrl, event);
        return true;
    } catch {
        room.members.delete(peerId);
        room.pending.delete(peerId);
        return false;
    }
}

function broadcastMembers(room: RoomState, excludeId: string, event: SignalEvent) {
    room.members.forEach((ctrl, peerId) => {
        if (peerId === excludeId) return;
        try {
            queueEvent(ctrl, event);
        } catch {
            room.members.delete(peerId);
        }
    });
}

// GET /api/meet/signal?roomId=xxx&peerId=yyy  -> SSE stream
export async function GET(req: NextRequest) {
    const session = await getServerSession(authOptions);
    const sessionPeerId = getSessionPeerId(session);
    if (!sessionPeerId) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const peerDisplayName = session?.user?.name || session?.user?.email || sessionPeerId;

    const { searchParams } = new URL(req.url);
    const roomId = searchParams.get('roomId') || '';
    const requestedPeerId = searchParams.get('peerId') || '';
    const peerId = requestedPeerId || sessionPeerId;

    if (requestedPeerId && requestedPeerId !== sessionPeerId) {
        return NextResponse.json({ error: 'Forbidden: peer mismatch' }, { status: 403 });
    }
    if (!ROOM_ID_REGEX.test(roomId) || !PEER_ID_REGEX.test(peerId)) {
        return NextResponse.json({ error: 'Invalid roomId or peerId format' }, { status: 400 });
    }

    let room = rooms.get(roomId);
    if (!room) {
        if (rooms.size >= MAX_ROOMS) {
            return NextResponse.json({ error: 'Room limit reached' }, { status: 429 });
        }
        room = { hostId: peerId, members: new Map(), pending: new Map() };
        rooms.set(roomId, room);
    } else {
        const isKnownPeer = room.members.has(peerId) || room.pending.has(peerId) || room.hostId === peerId;
        if (!isKnownPeer && room.members.size >= MAX_PEERS_PER_ROOM) {
            return NextResponse.json({ error: 'Room is full' }, { status: 429 });
        }
    }

    const stream = new ReadableStream<Uint8Array>({
        start(ctrl) {
            if (!room) return;

            const isHost = room.hostId === peerId;
            const isApprovedMember = isHost || room.members.has(peerId);

            if (isApprovedMember) {
                room.pending.delete(peerId);
                room.members.set(peerId, ctrl);

                const existingPeers = Array.from(room.members.keys()).filter(id => id !== peerId);
                queueEvent(ctrl, {
                    type: 'joined',
                    peerId,
                    peers: existingPeers,
                    roomId,
                    payload: { isHost, hostId: room.hostId },
                });

                if (!isHost) {
                    broadcastMembers(room, peerId, { type: 'peer-joined', peerId, roomId });
                }

                console.log(`[Signal] Peer ${peerId} joined room ${roomId}. Approved peers: ${room.members.size}`);
                return;
            }

            // Non-host peers enter pending queue until host approves.
            room.pending.set(peerId, ctrl);
            queueEvent(ctrl, {
                type: 'join-request-pending',
                peerId,
                roomId,
                payload: { hostId: room.hostId },
            });

            sendToPeer(room, room.hostId, {
                type: 'join-request',
                peerId,
                roomId,
                payload: { name: peerDisplayName },
            });

            console.log(`[Signal] Peer ${peerId} is pending host approval in room ${roomId}.`);
        },
        cancel() {
            const activeRoom = rooms.get(roomId);
            if (!activeRoom) return;

            const wasPending = activeRoom.pending.delete(peerId);
            const wasMember = activeRoom.members.delete(peerId);

            if (wasPending) {
                sendToPeer(activeRoom, activeRoom.hostId, { type: 'join-request-cancelled', peerId, roomId });
            }

            if (wasMember) {
                broadcastMembers(activeRoom, peerId, { type: 'peer-left', peerId, roomId });
            }

            // Handle host departure.
            if (activeRoom.hostId === peerId) {
                if (activeRoom.members.size > 0) {
                    const nextHostId = activeRoom.members.keys().next().value as string;
                    activeRoom.hostId = nextHostId;
                    broadcastMembers(activeRoom, '', { type: 'host-updated', peerId: nextHostId, roomId });

                    // Replay outstanding pending requests to the new host.
                    activeRoom.pending.forEach((_ctrl, pendingPeerId) => {
                        sendToPeer(activeRoom, nextHostId, { type: 'join-request', peerId: pendingPeerId, roomId });
                    });
                } else {
                    // No approved members left to host the room; reject pending participants and close room.
                    activeRoom.pending.forEach((pendingCtrl, pendingPeerId) => {
                        try {
                            queueEvent(pendingCtrl, {
                                type: 'join-rejected',
                                peerId: pendingPeerId,
                                roomId,
                                payload: { reason: 'Host left the room' },
                            });
                            pendingCtrl.close();
                        } catch {
                            // Ignore send/close failures on teardown.
                        }
                    });
                    activeRoom.pending.clear();
                    rooms.delete(roomId);
                    return;
                }
            }

            if (activeRoom.members.size === 0 && activeRoom.pending.size === 0) {
                rooms.delete(roomId);
            }

            console.log(`[Signal] Peer ${peerId} left room ${roomId}.`);
        },
    });

    return new NextResponse(stream, {
        headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no',
        },
    });
}

// POST /api/meet/signal  -> host moderation + relay a signal to a peer
export async function POST(req: NextRequest) {
    const session = await getServerSession(authOptions);
    const from = getSessionPeerId(session);
    if (!from) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    let body: unknown;
    try {
        body = await req.json();
    } catch {
        return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    if (!body || typeof body !== 'object') {
        return NextResponse.json({ error: 'Invalid signal payload' }, { status: 400 });
    }

    const event = body as SignalEvent;
    const roomId = String(event.roomId || '').trim();
    const to = String(event.to || '').trim();
    const type = String(event.type || '').trim();
    const payload = event.payload;

    if (!type || !EVENT_TYPE_REGEX.test(type) || !ROOM_ID_REGEX.test(roomId)) {
        return NextResponse.json({ error: 'Missing or invalid roomId/type' }, { status: 400 });
    }
    if (payloadSizeInBytes(payload) > MAX_SIGNAL_PAYLOAD_BYTES) {
        return NextResponse.json({ error: 'Signal payload too large' }, { status: 413 });
    }

    const room = rooms.get(roomId);
    if (!room) return NextResponse.json({ error: 'Room not found' }, { status: 404 });

    // Host moderation controls for pending participants.
    if (type === 'approve-join' || type === 'reject-join') {
        if (from !== room.hostId) {
            return NextResponse.json({ error: 'Only the host can moderate join requests' }, { status: 403 });
        }
        if (!PEER_ID_REGEX.test(to)) {
            return NextResponse.json({ error: 'Missing or invalid recipient' }, { status: 400 });
        }

        const pendingCtrl = room.pending.get(to);
        if (!pendingCtrl) {
            return NextResponse.json({ error: 'Pending participant not found' }, { status: 404 });
        }

        if (type === 'approve-join') {
            room.pending.delete(to);
            room.members.set(to, pendingCtrl);

            const peers = Array.from(room.members.keys()).filter(id => id !== to);
            queueEvent(pendingCtrl, {
                type: 'joined',
                peerId: to,
                peers,
                roomId,
                payload: { isHost: false, hostId: room.hostId },
            });
            broadcastMembers(room, to, { type: 'peer-joined', peerId: to, roomId });
            return NextResponse.json({ ok: true, approved: true });
        }

        queueEvent(pendingCtrl, {
            type: 'join-rejected',
            peerId: to,
            roomId,
            payload: { reason: 'Host denied join request' },
        });
        try { pendingCtrl.close(); } catch { /* ignore */ }
        room.pending.delete(to);
        return NextResponse.json({ ok: true, approved: false });
    }

    if (!PEER_ID_REGEX.test(to) || !PEER_ID_REGEX.test(from)) {
        return NextResponse.json({ error: 'Missing or invalid recipient/sender' }, { status: 400 });
    }

    if (!room.members.has(from)) {
        return NextResponse.json({ error: 'Sender not in room' }, { status: 403 });
    }
    if (!room.members.has(to)) {
        return NextResponse.json({ error: 'Recipient not in room' }, { status: 404 });
    }

    sendToPeer(room, to, { type, from, payload, roomId });
    return NextResponse.json({ ok: true });
}
