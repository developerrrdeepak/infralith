import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { authOptions } from '@/lib/auth';
import { isCollabStoreConfigured, queryCollabDocs } from '@/lib/cosmos-collab-service';

type CommunityProbeDoc = {
  id: string;
  updatedAt?: string;
  timestamp?: number;
  reactionCount?: number;
  commentCount?: number;
  shares?: number;
  saveCount?: number;
};

const COMMUNITY_PK = 'community';
const encoder = new TextEncoder();

const eventChunk = (event: string, data: Record<string, unknown>) =>
  encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

const readCommunityCursor = async (): Promise<string> => {
  const docs = await queryCollabDocs<CommunityProbeDoc>(
    {
      query:
        'SELECT TOP 1 c.id, c.updatedAt, c.timestamp, c.reactionCount, c.commentCount, c.shares, c.saveCount FROM c WHERE c.pk = @pk AND c.type = @type ORDER BY c.updatedAt DESC',
      parameters: [
        { name: '@pk', value: COMMUNITY_PK },
        { name: '@type', value: 'communityPost' },
      ],
    },
    { partitionKey: COMMUNITY_PK, maxItemCount: 1 }
  );

  const latest = docs[0];
  if (!latest) return 'empty';
  const stamp = latest.updatedAt || String(latest.timestamp || 0);
  return [
    latest.id,
    stamp,
    latest.reactionCount || 0,
    latest.commentCount || 0,
    latest.shares || 0,
    latest.saveCount || 0,
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
          const next = await readCommunityCursor();
          if (next !== cursor) {
            cursor = next;
            push('update', { cursor, ts: Date.now() });
          }
        } catch {
          push('error', { message: 'community_stream_poll_failed' });
        } finally {
          inFlight = false;
        }
      };

      try {
        cursor = await readCommunityCursor();
      } catch {
        cursor = 'empty';
      }

      push('ready', { cursor, ts: Date.now() });
      const pollTimer = setInterval(() => {
        void poll();
      }, 1500);
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
