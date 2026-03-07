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
  emailAliasesNormalized?: string[];
  name: string;
  avatar: string | null;
  role: string | null;
  createdAt: string;
  updatedAt: string;
};

const normalizeEmail = (value: unknown) => String(value || '').trim().toLowerCase();
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const isLikelyEmail = (value: string) => EMAIL_REGEX.test(value);

const decodeGuestExtUpn = (value: string): string | null => {
  const normalized = normalizeEmail(value);
  const marker = '#ext#@';
  const markerIndex = normalized.indexOf(marker);
  if (markerIndex <= 0) return null;

  const prefix = normalized.slice(0, markerIndex);
  const splitIndex = prefix.lastIndexOf('_');
  if (splitIndex <= 0 || splitIndex >= prefix.length - 1) return null;

  const localPart = prefix.slice(0, splitIndex);
  const domainPart = prefix.slice(splitIndex + 1);
  const decoded = `${localPart}@${domainPart}`;
  return isLikelyEmail(decoded) ? decoded : null;
};

const buildGuestExtPrefix = (value: string): string | null => {
  const normalized = normalizeEmail(value);
  if (!isLikelyEmail(normalized) || normalized.includes('#ext#@')) return null;
  const splitIndex = normalized.lastIndexOf('@');
  if (splitIndex <= 0 || splitIndex >= normalized.length - 1) return null;
  const localPart = normalized.slice(0, splitIndex);
  const domainPart = normalized.slice(splitIndex + 1);
  return `${localPart}_${domainPart}#ext#@`;
};

const uniqueNonEmpty = (values: Array<string | null | undefined>) =>
  Array.from(new Set(values.map((v) => normalizeEmail(v || '')).filter(Boolean)));

const buildEmailAliases = (...values: Array<unknown>) => {
  const aliases = new Set<string>();
  for (const value of values) {
    const normalized = normalizeEmail(value);
    if (!normalized) continue;
    aliases.add(normalized);
    const decoded = decodeGuestExtUpn(normalized);
    if (decoded) aliases.add(decoded);
  }
  return Array.from(aliases);
};

const actorFromSession = (session: any) => ({
  id: String(session?.user?.id || session?.user?.email || '').trim(),
  email: normalizeEmail(session?.user?.email || ''),
  name: String(session?.user?.name || session?.user?.email || 'Team Member'),
  avatar: session?.user?.image ? String(session.user.image) : null,
  role: session?.user?.role ? String(session.user.role) : null,
});

const toUserProfile = (doc: UserDirectoryDoc) => ({
  uid: doc.userId,
  email: decodeGuestExtUpn(doc.emailNormalized || doc.email) || (doc.emailNormalized || doc.email),
  name: doc.name,
  avatar: doc.avatar || null,
  role: doc.role || undefined,
  profileCompleted: true,
});

export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  if (!isCollabStoreConfigured()) {
    return NextResponse.json({ users: [] }, { status: 200 });
  }

  const { searchParams } = new URL(req.url);
  const email = normalizeEmail(searchParams.get('email') || '');
  const q = String(searchParams.get('q') || '').trim().toLowerCase();
  const isAuthenticated = Boolean(session?.user);

  // Allow exact email lookup without an authenticated session so Guest-mode
  // users can still discover portal-registered accounts by email.
  if (!isAuthenticated && !email) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    if (email) {
      const exactCandidates = uniqueNonEmpty([email, decodeGuestExtUpn(email)]);
      let match: UserDirectoryDoc | undefined;

      for (const candidate of exactCandidates) {
        const matches = await queryCollabDocs<UserDirectoryDoc>(
          {
            query:
              'SELECT TOP 1 * FROM c WHERE c.pk = @pk AND c.type = @type AND (LOWER(c.emailNormalized) = @email OR LOWER(c.email) = @email OR ARRAY_CONTAINS(c.emailAliasesNormalized, @email))',
            parameters: [
              { name: '@pk', value: USERS_PK },
              { name: '@type', value: 'userProfile' },
              { name: '@email', value: candidate },
            ],
          },
          { partitionKey: USERS_PK, maxItemCount: 1 }
        );
        if (matches[0]) {
          match = matches[0];
          break;
        }
      }

      if (!match) {
        const guestPrefixes = uniqueNonEmpty(exactCandidates.map(buildGuestExtPrefix));
        for (const prefix of guestPrefixes) {
          const matches = await queryCollabDocs<UserDirectoryDoc>(
            {
              query:
                'SELECT TOP 1 * FROM c WHERE c.pk = @pk AND c.type = @type AND (STARTSWITH(LOWER(c.emailNormalized), @prefix) OR STARTSWITH(LOWER(c.email), @prefix))',
              parameters: [
                { name: '@pk', value: USERS_PK },
                { name: '@type', value: 'userProfile' },
                { name: '@prefix', value: prefix },
              ],
            },
            { partitionKey: USERS_PK, maxItemCount: 1 }
          );
          if (matches[0]) {
            match = matches[0];
            break;
          }
        }
      }

      return NextResponse.json({ user: match ? toUserProfile(match) : null });
    }

    if (q) {
      const users = await queryCollabDocs<UserDirectoryDoc>(
        {
          query:
            'SELECT TOP 50 * FROM c WHERE c.pk = @pk AND c.type = @type AND (CONTAINS(LOWER(c.name), @q) OR CONTAINS(c.emailNormalized, @q) OR CONTAINS(LOWER(c.email), @q)) ORDER BY c.updatedAt DESC',
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

    const aliases = buildEmailAliases(actor.email || String(session.user.email || ''));
    const preferredEmail =
      aliases.find((value) => isLikelyEmail(value) && !value.includes('#ext#@')) ||
      aliases[0] ||
      '';

    const now = new Date().toISOString();
    const doc: UserDirectoryDoc = {
      id: `user:${actor.id}`,
      pk: USERS_PK,
      type: 'userProfile',
      userId: actor.id,
      email: preferredEmail,
      emailNormalized: preferredEmail,
      emailAliasesNormalized: aliases,
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
