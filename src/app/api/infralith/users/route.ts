import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { authOptions } from '@/lib/auth';
import { isCollabStoreConfigured, queryCollabDocs, upsertCollabDoc } from '@/lib/cosmos-collab-service';

const USERS_PK = 'users';

type UserDirectoryDoc = {
  id: string;
  pk: string;
  type: 'userProfile';
  userId: string;
  email: string;
  emailNormalized: string;
  name: string;
  avatar: string | null;
  role: string | null;
  createdAt: string;
  updatedAt: string;
};

const normalizeEmail = (value: unknown) => String(value || '').trim().toLowerCase();

const actorFromSession = (session: any) => ({
  id: String(session?.user?.id || session?.user?.email || '').trim(),
  email: normalizeEmail(session?.user?.email || ''),
  name: String(session?.user?.name || session?.user?.email || 'Team Member'),
  avatar: session?.user?.image ? String(session.user.image) : null,
  role: session?.user?.role ? String(session.user.role) : null,
});

const toUserProfile = (doc: UserDirectoryDoc) => ({
  uid: doc.userId,
  email: doc.emailNormalized || doc.email,
  name: doc.name,
  avatar: doc.avatar || null,
  role: doc.role || undefined,
  profileCompleted: true,
});

export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!isCollabStoreConfigured()) {
    return NextResponse.json({ users: [] }, { status: 200 });
  }

  const { searchParams } = new URL(req.url);
  const email = normalizeEmail(searchParams.get('email') || '');
  const q = String(searchParams.get('q') || '').trim().toLowerCase();

  try {
    if (email) {
      const matches = await queryCollabDocs<UserDirectoryDoc>(
        {
          query:
            'SELECT TOP 1 * FROM c WHERE c.pk = @pk AND c.type = @type AND c.emailNormalized = @email',
          parameters: [
            { name: '@pk', value: USERS_PK },
            { name: '@type', value: 'userProfile' },
            { name: '@email', value: email },
          ],
        },
        { partitionKey: USERS_PK, maxItemCount: 1 }
      );

      const match = matches[0];
      return NextResponse.json({ user: match ? toUserProfile(match) : null });
    }

    if (q) {
      const users = await queryCollabDocs<UserDirectoryDoc>(
        {
          query:
            'SELECT TOP 50 * FROM c WHERE c.pk = @pk AND c.type = @type AND (CONTAINS(LOWER(c.name), @q) OR CONTAINS(c.emailNormalized, @q)) ORDER BY c.updatedAt DESC',
          parameters: [
            { name: '@pk', value: USERS_PK },
            { name: '@type', value: 'userProfile' },
            { name: '@q', value: q },
          ],
        },
        { partitionKey: USERS_PK, maxItemCount: 50 }
      );
      return NextResponse.json({ users: users.map(toUserProfile) });
    }

    const users = await queryCollabDocs<UserDirectoryDoc>(
      {
        query: 'SELECT TOP 200 * FROM c WHERE c.pk = @pk AND c.type = @type ORDER BY c.updatedAt DESC',
        parameters: [
          { name: '@pk', value: USERS_PK },
          { name: '@type', value: 'userProfile' },
        ],
      },
      { partitionKey: USERS_PK, maxItemCount: 200 }
    );
    return NextResponse.json({ users: users.map(toUserProfile) });
  } catch (error: any) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!isCollabStoreConfigured()) {
    return NextResponse.json({ error: 'Collab DB not configured' }, { status: 503 });
  }

  let payload: any = {};
  try {
    payload = await req.json();
  } catch {
    payload = {};
  }

  const action = String(payload?.action || 'register_current').trim().toLowerCase();
  if (action !== 'register_current') {
    return NextResponse.json({ error: 'Unsupported action' }, { status: 400 });
  }

  try {
    const actor = actorFromSession(session);
    if (!actor.id) {
      return NextResponse.json({ error: 'Invalid session user' }, { status: 400 });
    }

    const now = new Date().toISOString();
    const doc: UserDirectoryDoc = {
      id: `user:${actor.id}`,
      pk: USERS_PK,
      type: 'userProfile',
      userId: actor.id,
      email: actor.email || String(session.user.email || ''),
      emailNormalized: actor.email,
      name: actor.name,
      avatar: actor.avatar,
      role: actor.role,
      createdAt: now,
      updatedAt: now,
    };

    await upsertCollabDoc<UserDirectoryDoc>(doc);
    return NextResponse.json({ success: true, user: toUserProfile(doc) });
  } catch (error: any) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
