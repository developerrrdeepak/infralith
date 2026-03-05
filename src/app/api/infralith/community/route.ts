import crypto from 'crypto';
import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { authOptions } from '@/lib/auth';
import {
  deleteCollabDoc,
  queryCollabDocs,
  readCollabDoc,
  upsertCollabDoc,
  isCollabStoreConfigured,
} from '@/lib/cosmos-collab-service';

type ReactionType = 'like' | 'insightful' | 'celebrate' | 'support';
const REACTIONS: ReactionType[] = ['like', 'insightful', 'celebrate', 'support'];
const COMMUNITY_PK = 'community';

type CommunityPostDoc = {
  id: string;
  pk: string;
  type: 'communityPost';
  authorId: string;
  authorName: string;
  authorAvatar: string;
  authorHandle: string;
  authorRole?: string;
  verified?: boolean;
  content: string;
  image?: string | null;
  timestamp: number;
  likes: Record<string, boolean>;
  likeCount: number;
  commentCount: number;
  shares: number;
  tags?: string[];
  isBounty?: boolean;
  bountyAmount?: number;
  postType?: 'update' | 'project' | 'hiring' | 'announcement';
  reactions?: Record<string, ReactionType>;
  reactionTotals?: Partial<Record<ReactionType, number>>;
  reactionCount?: number;
  savedBy?: Record<string, boolean>;
  saveCount?: number;
  repostOf?: string | null;
  repostPreview?: {
    authorName: string;
    content: string;
    image?: string | null;
    tags?: string[];
    postType?: string;
  } | null;
  createdAt: string;
  updatedAt: string;
};

type CommunityCommentDoc = {
  id: string;
  pk: string;
  type: 'communityComment';
  postId: string;
  authorId: string;
  authorName: string;
  authorAvatar: string;
  text: string;
  timestamp: number;
  createdAt: string;
  updatedAt: string;
};

const idWithPrefix = (prefix: string) =>
  `${prefix}_${Date.now()}_${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`;

const normalizeTags = (tags: unknown) => {
  if (!Array.isArray(tags)) return ['#CommunityUpdate'];
  const normalized = tags
    .map((tag) => String(tag || '').trim())
    .filter(Boolean)
    .map((tag) => (tag.startsWith('#') ? tag : `#${tag}`))
    .slice(0, 8);
  return normalized.length > 0 ? normalized : ['#CommunityUpdate'];
};

const normalizeReactions = (input: Record<string, ReactionType> | undefined) => {
  const reactions: Record<string, ReactionType> = {};
  Object.entries(input || {}).forEach(([uid, value]) => {
    if (REACTIONS.includes(value)) reactions[uid] = value;
  });

  const totals: Partial<Record<ReactionType, number>> = {
    like: 0,
    insightful: 0,
    celebrate: 0,
    support: 0,
  };
  Object.values(reactions).forEach((reaction) => {
    totals[reaction] = (totals[reaction] || 0) + 1;
  });
  const reactionCount = REACTIONS.reduce((sum, type) => sum + (totals[type] || 0), 0);
  return { reactions, totals, reactionCount, likeCount: totals.like || 0 };
};

const actorFromSession = (session: any) => {
  const id = session?.user?.id || session?.user?.email || 'unknown-user';
  return {
    id,
    name: session?.user?.name || session?.user?.email || 'Community Member',
    avatar: session?.user?.image || '',
    role: session?.user?.role || 'Engineer',
  };
};

async function getPostById(postId: string): Promise<CommunityPostDoc | null> {
  return readCollabDoc<CommunityPostDoc>(postId, COMMUNITY_PK);
}

async function listComments(postId: string): Promise<CommunityCommentDoc[]> {
  const comments = await queryCollabDocs<CommunityCommentDoc>(
    {
      query:
        'SELECT * FROM c WHERE c.pk = @pk AND c.type = @type ORDER BY c.timestamp ASC',
      parameters: [
        { name: '@pk', value: `post:${postId}` },
        { name: '@type', value: 'communityComment' },
      ],
    },
    { partitionKey: `post:${postId}` }
  );
  return comments;
}

export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!isCollabStoreConfigured()) {
    return NextResponse.json({ error: 'Collab DB not configured' }, { status: 503 });
  }

  const { searchParams } = new URL(req.url);
  const postId = searchParams.get('postId');
  const resource = searchParams.get('resource');

  try {
    if (resource === 'comments' && postId) {
      const comments = await listComments(postId);
      return NextResponse.json({ comments });
    }

    if (postId) {
      const post = await getPostById(postId);
      return NextResponse.json({ post });
    }

    const posts = await queryCollabDocs<CommunityPostDoc>(
      {
        query: 'SELECT * FROM c WHERE c.pk = @pk AND c.type = @type ORDER BY c.timestamp DESC',
        parameters: [
          { name: '@pk', value: COMMUNITY_PK },
          { name: '@type', value: 'communityPost' },
        ],
      },
      { partitionKey: COMMUNITY_PK }
    );

    return NextResponse.json({ posts });
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

  const action = String(payload?.action || '').trim().toLowerCase();
  const actor = actorFromSession(session);

  try {
    if (action === 'create_post') {
      const content = String(payload?.content || '').trim();
      const image = typeof payload?.image === 'string' ? payload.image : null;
      if (!content && !image) {
        return NextResponse.json({ error: 'Post must include content or image' }, { status: 400 });
      }

      const timestamp = Date.now();
      const id = idWithPrefix('post');
      const post: CommunityPostDoc = {
        id,
        pk: COMMUNITY_PK,
        type: 'communityPost',
        authorId: actor.id,
        authorName: String(payload?.authorName || actor.name),
        authorAvatar: String(payload?.authorAvatar || actor.avatar || ''),
        authorHandle: String(payload?.authorHandle || actor.name).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20) || `user${timestamp}`,
        authorRole: String(payload?.authorRole || actor.role || 'Engineer'),
        verified: !!payload?.verified,
        content,
        image,
        timestamp,
        likes: {},
        likeCount: 0,
        commentCount: 0,
        shares: 0,
        tags: normalizeTags(payload?.tags),
        isBounty: !!payload?.isBounty,
        bountyAmount: payload?.isBounty ? Number(payload?.bountyAmount || 0) || undefined : undefined,
        postType: payload?.postType || 'update',
        reactions: {},
        reactionTotals: { like: 0, insightful: 0, celebrate: 0, support: 0 },
        reactionCount: 0,
        savedBy: {},
        saveCount: 0,
        repostOf: payload?.repostOf || null,
        repostPreview: payload?.repostPreview || null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      await upsertCollabDoc(post);
      return NextResponse.json({ id: post.id, post });
    }

    if (action === 'delete_post') {
      const postId = String(payload?.postId || '').trim();
      if (!postId) return NextResponse.json({ error: 'postId required' }, { status: 400 });
      const post = await getPostById(postId);
      if (!post) return NextResponse.json({ success: true });
      const isAdmin = actor.role === 'Admin';
      if (post.authorId !== actor.id && !isAdmin) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
      }

      await deleteCollabDoc(post.id, COMMUNITY_PK);
      const comments = await listComments(postId);
      await Promise.all(comments.map((comment) => deleteCollabDoc(comment.id, comment.pk)));
      return NextResponse.json({ success: true });
    }

    if (action === 'toggle_like' || action === 'set_reaction') {
      const postId = String(payload?.postId || '').trim();
      if (!postId) return NextResponse.json({ error: 'postId required' }, { status: 400 });
      const post = await getPostById(postId);
      if (!post) return NextResponse.json({ error: 'Post not found' }, { status: 404 });

      const reactions = { ...(post.reactions || {}) } as Record<string, ReactionType>;
      if (action === 'toggle_like') {
        if (reactions[actor.id] === 'like') delete reactions[actor.id];
        else reactions[actor.id] = 'like';
      } else {
        const reaction = payload?.reaction;
        if (reaction == null) {
          delete reactions[actor.id];
        } else {
          if (!REACTIONS.includes(reaction)) {
            return NextResponse.json({ error: 'Invalid reaction' }, { status: 400 });
          }
          reactions[actor.id] = reaction as ReactionType;
        }
      }

      const normalized = normalizeReactions(reactions);
      const updatedPost: CommunityPostDoc = {
        ...post,
        reactions: normalized.reactions,
        reactionTotals: normalized.totals,
        reactionCount: normalized.reactionCount,
        likeCount: normalized.likeCount,
        likes: Object.fromEntries(Object.keys(normalized.reactions).map((uid) => [uid, normalized.reactions[uid] === 'like'])),
        updatedAt: new Date().toISOString(),
      };
      await upsertCollabDoc(updatedPost);
      return NextResponse.json({
        userReaction: updatedPost.reactions?.[actor.id] || null,
        reactionTotals: updatedPost.reactionTotals,
        reactionCount: updatedPost.reactionCount,
        likeCount: updatedPost.likeCount,
      });
    }

    if (action === 'toggle_save') {
      const postId = String(payload?.postId || '').trim();
      if (!postId) return NextResponse.json({ error: 'postId required' }, { status: 400 });
      const post = await getPostById(postId);
      if (!post) return NextResponse.json({ error: 'Post not found' }, { status: 404 });
      const savedBy = { ...(post.savedBy || {}) } as Record<string, boolean>;
      if (savedBy[actor.id]) delete savedBy[actor.id];
      else savedBy[actor.id] = true;

      const updatedPost: CommunityPostDoc = {
        ...post,
        savedBy,
        saveCount: Object.keys(savedBy).length,
        updatedAt: new Date().toISOString(),
      };
      await upsertCollabDoc(updatedPost);
      return NextResponse.json({ saved: !!savedBy[actor.id], saveCount: updatedPost.saveCount || 0 });
    }

    if (action === 'increment_share') {
      const postId = String(payload?.postId || '').trim();
      if (!postId) return NextResponse.json({ error: 'postId required' }, { status: 400 });
      const post = await getPostById(postId);
      if (!post) return NextResponse.json({ error: 'Post not found' }, { status: 404 });
      const updatedPost: CommunityPostDoc = {
        ...post,
        shares: (post.shares || 0) + 1,
        updatedAt: new Date().toISOString(),
      };
      await upsertCollabDoc(updatedPost);
      return NextResponse.json({ shares: updatedPost.shares });
    }

    if (action === 'add_comment') {
      const postId = String(payload?.postId || '').trim();
      const text = String(payload?.text || '').trim();
      if (!postId || !text) {
        return NextResponse.json({ error: 'postId and text required' }, { status: 400 });
      }
      const post = await getPostById(postId);
      if (!post) return NextResponse.json({ error: 'Post not found' }, { status: 404 });

      const comment: CommunityCommentDoc = {
        id: idWithPrefix('comment'),
        pk: `post:${postId}`,
        type: 'communityComment',
        postId,
        authorId: actor.id,
        authorName: String(payload?.authorName || actor.name),
        authorAvatar: String(payload?.authorAvatar || actor.avatar || ''),
        text,
        timestamp: Date.now(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await upsertCollabDoc(comment);

      const updatedPost: CommunityPostDoc = {
        ...post,
        commentCount: Math.max(0, (post.commentCount || 0) + 1),
        updatedAt: new Date().toISOString(),
      };
      await upsertCollabDoc(updatedPost);

      return NextResponse.json({ id: comment.id, comment });
    }

    if (action === 'create_repost') {
      const originalPostId = String(payload?.originalPostId || '').trim();
      if (!originalPostId) return NextResponse.json({ error: 'originalPostId required' }, { status: 400 });
      const original = await getPostById(originalPostId);
      if (!original) return NextResponse.json({ error: 'Original post not found' }, { status: 404 });

      const content = String(payload?.commentary || '').trim();
      const id = idWithPrefix('post');
      const post: CommunityPostDoc = {
        ...original,
        id,
        authorId: actor.id,
        authorName: String(payload?.authorName || actor.name),
        authorAvatar: String(payload?.authorAvatar || actor.avatar || ''),
        authorRole: String(payload?.authorRole || actor.role || 'Engineer'),
        verified: !!payload?.verified,
        content,
        image: null,
        timestamp: Date.now(),
        likes: {},
        likeCount: 0,
        commentCount: 0,
        shares: 0,
        reactions: {},
        reactionTotals: { like: 0, insightful: 0, celebrate: 0, support: 0 },
        reactionCount: 0,
        savedBy: {},
        saveCount: 0,
        repostOf: original.id,
        repostPreview: {
          authorName: original.authorName,
          content: original.content,
          image: original.image || null,
          tags: original.tags || [],
          postType: original.postType,
        },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await upsertCollabDoc(post);
      return NextResponse.json({ id: post.id, post });
    }

    return NextResponse.json({ error: 'Unsupported action' }, { status: 400 });
  } catch (error: any) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
