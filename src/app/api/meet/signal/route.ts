/**
 * WebRTC Signaling Server - Room-based, in-memory
 * Supports: join, offer, answer, ice-candidate, leave
 * Transport: Server-Sent Events (SSE) per client
 *
 * Hardening:
 * - Requires authenticated session (NextAuth)
 * - Validates room/peer identifiers
 * - Caps room and peer counts to avoid unbounded memory growth
 */

import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { authOptions } from '@/lib/auth';

type SignalEvent = {
    type: string;
    from?: string;
    to?: string;
    payload?: any;
    roomId?: string;
    peerId?: string;
    peers?: string[];
};

type Room = Map<string, ReadableStreamDefaultController>; // peerId -> SSE controller

const rooms = new Map<string, Room>(); // roomId -> Room

const ROOM_ID_REGEX = /^[a-zA-Z0-9_-]{3,64}$/;
const PEER_ID_REGEX = /^[a-zA-Z0-9_-]{3,64}$/;
const MAX_ROOMS = Number(process.env.MEET_MAX_ROOMS || 200);
const MAX_PEERS_PER_ROOM = Number(process.env.MEET_MAX_PEERS_PER_ROOM || 12);

function validateIds(roomId: string, peerId: string) {
    return ROOM_ID_REGEX.test(roomId) && PEER_ID_REGEX.test(peerId);
}

function getOrCreateRoom(roomId: string): Room | null {
    if (!rooms.has(roomId)) {
        if (rooms.size >= MAX_ROOMS) return null;
        rooms.set(roomId, new Map());
    }
    return rooms.get(roomId)!;
}

function sendTo(room: Room, peerId: string, event: SignalEvent) {
    const ctrl = room.get(peerId);
    if (ctrl) {
        try {
            ctrl.enqueue(`data: ${JSON.stringify(event)}\n\n`);
        } catch {
            room.delete(peerId);
        }
    }
}

function broadcast(room: Room, excludeId: string, event: SignalEvent) {
    room.forEach((_ctrl, peerId) => {
        if (peerId !== excludeId) sendTo(room, peerId, event);
    });
}

// GET /api/meet/signal?roomId=xxx&peerId=yyy  → SSE stream
export async function GET(req: NextRequest) {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { searchParams } = new URL(req.url);
    const roomId = searchParams.get('roomId') || '';
    const peerId = searchParams.get('peerId') || session.user.id; // bind to authenticated identity if not provided

    if (!validateIds(roomId, peerId)) {
        return NextResponse.json({ error: 'Invalid roomId or peerId format' }, { status: 400 });
    }

    const room = getOrCreateRoom(roomId);
    if (!room) {
        return NextResponse.json({ error: 'Room limit reached' }, { status: 429 });
    }

    if (!room.has(peerId) && room.size >= MAX_PEERS_PER_ROOM) {
        return NextResponse.json({ error: 'Room is full' }, { status: 429 });
    }

    const encoder = new TextEncoder();
    let controller: ReadableStreamDefaultController;

    const stream = new ReadableStream({
        start(ctrl) {
            controller = ctrl;

            // Register this peer
            room.set(peerId, controller);

            // Tell the new peer who is already in the room
            const existingPeers = Array.from(room.keys()).filter(id => id !== peerId);
            const joinedEvent: SignalEvent = { type: 'joined', peerId, peers: existingPeers };
            try {
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(joinedEvent)}\n\n`));
            } catch {
                /* ignore enqueue failures */
            }

            // Tell existing peers about the new joiner
            broadcast(room, peerId, { type: 'peer-joined', peerId });

            console.log(`[Signal] Peer ${peerId} joined room ${roomId}. Total: ${room.size}`);
        },
        cancel() {
            room.delete(peerId);
            if (room.size === 0) rooms.delete(roomId);
            // Tell remaining peers
            const leftRoom = rooms.get(roomId);
            if (leftRoom) broadcast(leftRoom, peerId, { type: 'peer-left', peerId });
            console.log(`[Signal] Peer ${peerId} left room ${roomId}.`);
        },
    });

    return new NextResponse(stream, {
        headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no', // Disable Nginx buffering (for Azure/etc)
        },
    });
}

// POST /api/meet/signal  → relay a signal to a specific peer
export async function POST(req: NextRequest) {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body: SignalEvent = await req.json();
    const { roomId = '', to = '', from = session.user.id, type, payload } = body;

    if (!type || !validateIds(roomId, to) || !validateIds(roomId, from)) {
        return NextResponse.json({ error: 'Missing or invalid fields' }, { status: 400 });
    }

    // Prevent spoofing another authenticated user id
    if (from !== session.user.id) {
        return NextResponse.json({ error: 'Forbidden: sender mismatch' }, { status: 403 });
    }

    const room = rooms.get(roomId);
    if (!room) return NextResponse.json({ error: 'Room not found' }, { status: 404 });
    if (!room.has(to)) return NextResponse.json({ error: 'Recipient not in room' }, { status: 404 });

    sendTo(room, to, { type, from, payload, roomId });
    return NextResponse.json({ ok: true });
}
