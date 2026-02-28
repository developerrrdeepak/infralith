/**
 * WebRTC Signaling Server - Room-based, in-memory
 * Supports: join, offer, answer, ice-candidate, leave
 * Transport: Server-Sent Events (SSE) per client
 */

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

function getOrCreateRoom(roomId: string): Room {
    if (!rooms.has(roomId)) rooms.set(roomId, new Map());
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
    room.forEach((ctrl, peerId) => {
        if (peerId !== excludeId) sendTo(room, peerId, event);
    });
}

// GET /api/meet/signal?roomId=xxx&peerId=yyy  → SSE stream
export async function GET(req: Request) {
    const { searchParams } = new URL(req.url);
    const roomId = searchParams.get('roomId');
    const peerId = searchParams.get('peerId');

    if (!roomId || !peerId) {
        return new Response('roomId and peerId are required', { status: 400 });
    }

    const room = getOrCreateRoom(roomId);

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
            } catch { }

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

    return new Response(stream, {
        headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no', // Disable Nginx buffering (for Azure/etc)
        },
    });
}

// POST /api/meet/signal  → relay a signal to a specific peer
export async function POST(req: Request) {
    const body: SignalEvent = await req.json();
    const { roomId, to, from, type, payload } = body;

    if (!roomId || !to || !from || !type) {
        return Response.json({ error: 'Missing fields' }, { status: 400 });
    }

    const room = rooms.get(roomId);
    if (!room) return Response.json({ error: 'Room not found' }, { status: 404 });

    sendTo(room, to, { type, from, payload });
    return Response.json({ ok: true });
}
