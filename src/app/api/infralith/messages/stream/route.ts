import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { authOptions } from '@/lib/auth';
import { isCollabStoreConfigured, queryCollabDocs } from '@/lib/cosmos-collab-service';

type MessageProbeDoc = {
  id: string;
  updatedAt?: string;
  timestamp?: number;
  unreadCount?: number;
  lastMessage?: string;
};

const encoder = new TextEncoder();
const userPk = (uid: string) => `user:${uid}`;

const eventChunk = (event: string, data: Record<string, unknown>) =>
  encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

const actorFromSession = (session: any) => ({
  id: session?.user?.id || session?.user?.email || 'unknown-user',
});

const readMessagesCursor = async (userId: string): Promise<string> => {
  const docs = await queryCollabDocs<MessageProbeDoc>(
    {
      query:
        'SELECT TOP 1 c.id, c.updatedAt, c.timestamp, c.unreadCount, c.lastMessage FROM c WHERE c.pk = @pk AND c.type = @type ORDER BY c.updatedAt DESC',
      parameters: [
        { name: '@pk', value: userPk(userId) },
        { name: '@type', value: 'chatMember' },
      ],
    },
    { partitionKey: userPk(userId), maxItemCount: 1 }
  );

  const latest = docs[0];
  if (!latest) return 'empty';
  const stamp = latest.updatedAt || String(latest.timestamp || 0);
  return [
    latest.id,
    stamp,
    latest.unreadCount || 0,
    latest.lastMessage || '',
  ].join('|');
};

export const runtime = 'nodejs';

export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!isCollabStoreConfigured()) {
    return NextResponse.json({ error: 'Collab DB not configured' }, { status: 503 });
  }

  const actor = actorFromSession(session);

  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;
      let inFlight = false;
      let cursor = 'empty';

      const close = () => {
        if (closed) return;
        closed = true;
        clearInterval(pollTimer);
        clearInterval(heartbeatTimer);
        try {
          controller.close();
        } catch {
          // no-op
        }
      };

      const push = (event: string, data: Record<string, unknown>) => {
        if (closed) return;
        controller.enqueue(eventChunk(event, data));
      };

      const poll = async () => {
        if (closed || inFlight) return;
        inFlight = true;
        try {
          const next = await readMessagesCursor(actor.id);
          if (next !== cursor) {
            cursor = next;
            push('update', { cursor, ts: Date.now() });
          }
        } catch {
          push('error', { message: 'messages_stream_poll_failed' });
        } finally {
          inFlight = false;
        }
      };

      try {
        cursor = await readMessagesCursor(actor.id);
      } catch {
        cursor = 'empty';
      }

      push('ready', { cursor, ts: Date.now() });
      const pollTimer = setInterval(() => {
        void poll();
      }, 1200);
      const heartbeatTimer = setInterval(() => {
        push('ping', { ts: Date.now() });
      }, 15000);

      req.signal.addEventListener('abort', close);
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
