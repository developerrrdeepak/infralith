import { WorkflowResult } from '@/ai/flows/infralith/types';

export const normalizeEmail = (email: string) => (email || '').trim().toLowerCase();

export type UserProfileData = {
  uid: string;
  name: string;
  email: string;
  role?: string;
  mobile?: string;
  dob?: string;
  gender?: string;
  age?: number;
  country?: string;
  language?: string;
  fieldOfInterest?: string;
  college?: string;
  degree?: string;
  gradYear?: number;
  skills?: string[];
  experience?: string;
  linkedin?: string;
  github?: string;
  portfolio?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  avatar?: string | null;
  profileCompleted?: boolean;
  createdAt?: any;
  chats?: any;
}

export type SignUpData = {
  firstName: string;
  lastName: string;
  email: string;
  password?: string;
  mobile: string;
  age: string;
  gender: string;
  country: string;
  language: string;
  fieldOfInterest: string;
  avatar?: string | null;
}

// --- COMMUNITY TYPES ---
export type Comment = {
  id: string;
  authorId: string;
  authorName: string;
  authorAvatar: string;
  text: string;
  timestamp: number;
};

export type Post = {
  id: string;
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
};

// --- DM TYPES ---
export type ChatMessage = {
  id: string;
  senderId: string;
  text: string;
  imageUrl?: string | null;
  timestamp: number;
};

export type ChatSummary = {
  chatId: string;
  otherUserId: string;
  otherUserName: string;
  otherUserAvatar: string;
  lastMessage: string;
  timestamp: number;
  status?: 'pending' | 'accepted';
  isGroup?: boolean;
  participantIds?: string[];
  unreadCount?: number;
};

export type ReactionType = 'like' | 'insightful' | 'celebrate' | 'support';

// --- MOCK DATABASE HELPER (Local Storage) ---
const getStorageItem = (key: string) => {
  if (typeof window === 'undefined') return null;
  const item = localStorage.getItem(key);
  return item ? JSON.parse(item) : null;
};

const setStorageItem = (key: string, value: any) => {
  if (typeof window === 'undefined') return;
  localStorage.setItem(key, JSON.stringify(value));
};

let externalLookupBackoffUntil = 0;
const EXTERNAL_LOOKUP_BACKOFF_MS = 5 * 60 * 1000;

const getLocalDirectoryUsers = (): UserProfileData[] => {
  const users = getStorageItem('infralith_users') || {};
  return (Object.values(users) as UserProfileData[]).map((user) => ({
    ...user,
    email: normalizeEmail(user.email || ''),
  }));
};

const mergeDirectoryUsers = (...lists: UserProfileData[][]): UserProfileData[] => {
  const merged = new Map<string, UserProfileData>();

  lists.flat().forEach((user) => {
    const normalizedEmail = normalizeEmail(user.email || '');
    const key = String(user.uid || normalizedEmail).trim();
    if (!key) return;

    const normalizedUser: UserProfileData = {
      ...user,
      email: normalizedEmail,
    };

    if (!merged.has(key)) {
      merged.set(key, normalizedUser);
      return;
    }

    const existing = merged.get(key)!;
    merged.set(key, {
      ...existing,
      ...normalizedUser,
      name: normalizedUser.name || existing.name,
      avatar: normalizedUser.avatar ?? existing.avatar ?? null,
      role: normalizedUser.role || existing.role,
    });
  });

  return Array.from(merged.values());
};

// --- USER DB SERVICE ---
export const userDbService = {
  lookupRemoteUser: async (email: string): Promise<UserProfileData | null> => {
    if (typeof fetch === 'undefined') return null;
    const normalized = normalizeEmail(email);

    // Primary lookup: internal Infralith directory (Cosmos-backed API).
    try {
      const internalRes = await fetch(
        `/api/infralith/users?email=${encodeURIComponent(normalized)}`,
        {
          method: 'GET',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
        }
      );
      if (internalRes.ok) {
        const internal = await internalRes.json();
        // If API returns explicit `user` shape and includes a valid user, use it.
        // If user is null/missing, continue to external fallback.
        if (internal && typeof internal === 'object' && 'user' in (internal as Record<string, unknown>)) {
          if ((internal as any)?.user?.uid) {
            return {
              uid: (internal as any).user.uid,
              name: (internal as any).user.name || '',
              email: normalizeEmail((internal as any).user.email || normalized),
              avatar: (internal as any).user.avatar || null,
              role: (internal as any).user.role || undefined,
              profileCompleted: true,
            } as UserProfileData;
          }
        }
      }
    } catch (error) {
      console.warn('Internal user lookup failed, trying external directory fallback', error);
    }

    // Secondary lookup: optional external corporate directory proxy.
    if (Date.now() < externalLookupBackoffUntil) {
      return null;
    }
    try {
      const res = await fetch(`/api/user-lookup?email=${encodeURIComponent(normalized)}`, {
        method: 'GET',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
      });
      if (!res.ok) {
        if (res.status >= 500 || res.status === 429) {
          externalLookupBackoffUntil = Date.now() + EXTERNAL_LOOKUP_BACKOFF_MS;
        }
        return null;
      }
      const data = await res.json();
      if (!data) return null;
      return {
        uid: data.uid || data.id,
        name: data.name || data.fullName || '',
        email: normalizeEmail(data.email || normalized),
        avatar: data.avatar || data.image || null,
        role: data.role || data.title,
        profileCompleted: true,
      } as UserProfileData;
    } catch (error) {
      externalLookupBackoffUntil = Date.now() + EXTERNAL_LOOKUP_BACKOFF_MS;
      console.warn('External user lookup failed, falling back to local storage', error);
      return null;
    }
  },

  getUser: async (uid: string): Promise<UserProfileData | null> => {
    const users = getStorageItem('infralith_users') || {};
    return users[uid] || null;
  },

  getAllUsers: async (): Promise<UserProfileData[]> => {
    const localUsers = getLocalDirectoryUsers();

    if (typeof fetch !== 'undefined') {
      try {
        const res = await fetch('/api/infralith/users', {
          method: 'GET',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
        });
        if (res.ok) {
          const payload = await res.json();
          if (Array.isArray(payload?.users)) {
            const remoteUsers = (payload.users as UserProfileData[]).map((user) => ({
              ...user,
              email: normalizeEmail(user.email || ''),
            }));
            return mergeDirectoryUsers(remoteUsers, localUsers);
          }
        }
      } catch (error) {
        console.warn('Failed to load users from directory API, using local fallback', error);
      }
    }

    return localUsers;
  },

  searchUsers: async (query: string): Promise<UserProfileData[]> => {
    const q = String(query || '').trim().toLowerCase();
    if (!q) {
      return await userDbService.getAllUsers();
    }

    if (typeof fetch !== 'undefined') {
      try {
        const res = await fetch(`/api/infralith/users?q=${encodeURIComponent(q)}`, {
          method: 'GET',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
        });
        if (res.ok) {
          const payload = await res.json();
          if (Array.isArray(payload?.users)) {
            const remoteUsers = (payload.users as UserProfileData[]).map((user) => ({
              ...user,
              email: normalizeEmail(user.email || ''),
            }));
            if (remoteUsers.length > 0) return remoteUsers;
          }
        }
      } catch (error) {
        console.warn('Failed to search users from directory API, using local fallback', error);
      }
    }

    const allUsers = await userDbService.getAllUsers();
    return allUsers.filter(
      (user) =>
        (user.name || '').toLowerCase().includes(q) ||
        normalizeEmail(user.email || '').includes(q)
    );
  },

  getUserByEmail: async (email: string): Promise<UserProfileData | null> => {
    const target = normalizeEmail(email);
    if (!target) return null;

    // Try remote directory first (production) then fallback to local mock.
    const remote = await userDbService.lookupRemoteUser(target);
    if (remote) return remote;

    // Fallback to current directory snapshot/cached users for cases where
    // a profile exists but direct email lookup is temporarily stale.
    try {
      const directoryUsers = await userDbService.getAllUsers();
      const match = directoryUsers.find((u) => normalizeEmail(u.email || '') === target);
      if (match) return { ...match, email: normalizeEmail(match.email || target) };
    } catch (error) {
      console.warn('Directory snapshot lookup failed, using local fallback', error);
    }

    if (process.env.NODE_ENV === 'production') return null;

    const users = getStorageItem('infralith_users') || {};
    const all: UserProfileData[] = Object.values(users);
    return all.find((u) => normalizeEmail(u.email || '') === target) || null;
  },

  updateUser: async (uid: string, data: Partial<UserProfileData>) => {
    const users = getStorageItem('infralith_users') || {};
    if (users[uid]) {
      users[uid] = { ...users[uid], ...data };
      setStorageItem('infralith_users', users);
    }
  }
};

// --- INVITE SERVICE ---
export type InviteRecord = {
  id: string;
  senderUid: string;
  senderName: string;
  senderEmail: string;
  recipientEmail: string;
  sentAt: number;
  status: 'pending' | 'sent';
};

export const inviteService = {
  sendInvite: (invite: Omit<InviteRecord, 'id'>) => {
    const invites: Record<string, InviteRecord> = getStorageItem('infralith_invites') || {};
    const id = `inv_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const normalizedEmail = normalizeEmail(invite.recipientEmail);
    invites[id] = { ...invite, id, recipientEmail: normalizedEmail };
    setStorageItem('infralith_invites', invites);
    return id;
  },

  hasInvited: (senderUid: string, recipientEmail: string): boolean => {
    const invites: Record<string, InviteRecord> = getStorageItem('infralith_invites') || {};
    const normalizedEmail = normalizeEmail(recipientEmail);
    return Object.values(invites).some(
      (i) => i.senderUid === senderUid && normalizeEmail(i.recipientEmail) === normalizedEmail
    );
  },
};

// --- AUTH SERVICE (Mocked for Enterprise context) ---
export const authService = {
  signUp: async (data: Partial<SignUpData>) => {
    console.log("Mock signup for:", data.email);
    return { uid: 'mock-uid', email: data.email };
  },

  updateProfile: async (uid: string, data: Partial<UserProfileData>) => {
    await userDbService.updateUser(uid, data);
    return await userDbService.getUser(uid);
  },

  deleteAccount: async (uid: string) => {
    const users = getStorageItem('infralith_users') || {};
    delete users[uid];
    setStorageItem('infralith_users', users);
  }
};

export type ChatSession = {
  id: string;
  title: string;
  timestamp: number;
};


// --- INFRALITH INTELLIGENCE SERVICE ---
export const infralithService = {
  saveEvaluation: async (userId: string, result: WorkflowResult) => {
    const evals = getStorageItem(`evaluations_${userId}`) || [];
    evals.push({ ...result, id: `eval_${Date.now()}`, createdAt: new Date().toISOString() });
    setStorageItem(`evaluations_${userId}`, evals);
  },
  getEvaluations: async (userId: string): Promise<WorkflowResult[]> => {
    const evals = getStorageItem(`evaluations_${userId}`) || [];
    return evals.sort((a: any, b: any) =>
      new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
  }
};

// --- COMMUNITY POST SERVICE ---
type CreatePostOptions = {
  tags?: string[];
  isBounty?: boolean;
  bountyAmount?: number;
  authorRole?: string;
  verified?: boolean;
  postType?: 'update' | 'project' | 'hiring' | 'announcement';
  repostOf?: string | null;
  repostPreview?: Post['repostPreview'];
};

type SeedPostInput = Partial<Post> & Pick<Post, 'id' | 'authorId' | 'authorName' | 'content'>;
const REACTION_TYPES: ReactionType[] = ['like', 'insightful', 'celebrate', 'support'];

const toReactionTotals = (reactions: Record<string, ReactionType>) => {
  const totals: Partial<Record<ReactionType, number>> = {};
  REACTION_TYPES.forEach((type) => {
    totals[type] = 0;
  });

  Object.values(reactions).forEach((type) => {
    totals[type] = (totals[type] || 0) + 1;
  });
  return totals;
};

const toReactionCount = (totals: Partial<Record<ReactionType, number>>) =>
  REACTION_TYPES.reduce((sum, type) => sum + (totals[type] || 0), 0);

const normalizePostRecord = (post: Post): Post => {
  const reactions: Record<string, ReactionType> = {};
  Object.entries(post.reactions || {}).forEach(([userId, type]) => {
    if (REACTION_TYPES.includes(type as ReactionType)) {
      reactions[userId] = type as ReactionType;
    }
  });

  // Backward compatibility with legacy like map.
  Object.entries(post.likes || {}).forEach(([userId, liked]) => {
    if (liked && !reactions[userId]) reactions[userId] = 'like';
  });

  const reactionTotals = toReactionTotals(reactions);
  const reactionCount = toReactionCount(reactionTotals);

  return {
    ...post,
    postType: post.postType || 'update',
    reactions,
    reactionTotals,
    reactionCount,
    likes: Object.fromEntries(Object.keys(reactions).map((userId) => [userId, reactions[userId] === 'like'])),
    likeCount: reactionTotals.like || 0,
    savedBy: post.savedBy || {},
    saveCount: typeof post.saveCount === 'number' ? post.saveCount : Object.keys(post.savedBy || {}).length,
    repostOf: post.repostOf || null,
    repostPreview: post.repostPreview || null,
  };
};

export const postService = {
  createPost: async (
    userId: string,
    authorName: string,
    authorAvatar: string,
    email: string,
    content: string,
    image: string | null,
    options?: CreatePostOptions
  ) => {
    const posts: Post[] = getStorageItem('infralith_posts') || [];
    const trimmedContent = content.trim();
    if (!trimmedContent && !image) {
      throw new Error('Post must include content or an image.');
    }
    const fallbackHandle = authorName.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20) || `user${Date.now()}`;
    const emailHandle = normalizeEmail(email).split('@')[0];
    const newPost = normalizePostRecord({
      id: `post_${Date.now()}`,
      authorId: userId,
      authorName,
      authorHandle: emailHandle || fallbackHandle,
      authorAvatar: authorAvatar || '',
      authorRole: options?.authorRole || 'Engineer',
      verified: options?.verified ?? false,
      content: trimmedContent,
      image,
      timestamp: Date.now(),
      likeCount: 0,
      commentCount: 0,
      shares: 0,
      likes: {},
      tags: options?.tags && options.tags.length > 0 ? options.tags : ['#CommunityUpdate'],
      isBounty: !!options?.isBounty,
      bountyAmount: options?.isBounty ? options?.bountyAmount : undefined,
      postType: options?.postType || 'update',
      reactions: {},
      reactionTotals: {},
      reactionCount: 0,
      savedBy: {},
      saveCount: 0,
      repostOf: options?.repostOf || null,
      repostPreview: options?.repostPreview || null,
    } as Post);
    posts.unshift(newPost);
    setStorageItem('infralith_posts', posts);
    return newPost.id;
  },

  seedPosts: async (seedPosts: SeedPostInput[]) => {
    const existingPosts: Post[] = getStorageItem('infralith_posts') || [];
    if (existingPosts.length > 0) {
      const normalizedExisting = existingPosts.map(normalizePostRecord).sort((a, b) => b.timestamp - a.timestamp);
      setStorageItem('infralith_posts', normalizedExisting);
      return normalizedExisting;
    }

    const seeded: Post[] = seedPosts
      .map((seed, index) => {
        const normalizedName = (seed.authorName || 'Community Member').trim();
        const normalizedHandle =
          seed.authorHandle ||
          normalizedName.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20) ||
          `seed${index + 1}`;
        const isBounty = !!seed.isBounty;
        return normalizePostRecord({
          id: seed.id || `seed_post_${index + 1}`,
          authorId: seed.authorId || `seed_author_${index + 1}`,
          authorName: normalizedName,
          authorHandle: normalizedHandle,
          authorAvatar: seed.authorAvatar || '',
          authorRole: seed.authorRole || 'Engineer',
          verified: seed.verified ?? true,
          content: seed.content || '',
          image: seed.image || null,
          timestamp: typeof seed.timestamp === 'number' ? seed.timestamp : Date.now() - index * 60_000,
          likes: seed.likes || {},
          likeCount: typeof seed.likeCount === 'number' ? seed.likeCount : 0,
          commentCount: typeof seed.commentCount === 'number' ? seed.commentCount : 0,
          shares: typeof seed.shares === 'number' ? seed.shares : 0,
          tags: Array.isArray(seed.tags) && seed.tags.length > 0 ? seed.tags : ['#CommunityUpdate'],
          isBounty,
          bountyAmount: isBounty ? seed.bountyAmount : undefined,
          postType: seed.postType || (isBounty ? 'announcement' : 'update'),
          reactions: seed.reactions || {},
          reactionTotals: seed.reactionTotals || {},
          reactionCount: typeof seed.reactionCount === 'number' ? seed.reactionCount : undefined,
          savedBy: seed.savedBy || {},
          saveCount: seed.saveCount,
          repostOf: seed.repostOf || null,
          repostPreview: seed.repostPreview || null,
        } as Post);
      })
      .sort((a, b) => b.timestamp - a.timestamp);

    setStorageItem('infralith_posts', seeded);
    return seeded;
  },

  deletePost: async (postId: string) => {
    const posts: Post[] = getStorageItem('infralith_posts') || [];
    const filtered = posts.filter((p) => p.id !== postId);
    setStorageItem('infralith_posts', filtered);
    if (typeof window !== 'undefined') {
      localStorage.removeItem(`comments_${postId}`);
    }
  },

  getAllPosts: async () => {
    const posts: Post[] = getStorageItem('infralith_posts') || [];
    const normalized = posts.map(normalizePostRecord).sort((a, b) => b.timestamp - a.timestamp);
    setStorageItem('infralith_posts', normalized);
    return normalized;
  },

  getPostById: async (postId: string) => {
    const posts: Post[] = getStorageItem('infralith_posts') || [];
    const found = posts.find((p) => p.id === postId);
    return found ? normalizePostRecord(found) : null;
  },

  setReaction: async (postId: string, userId: string, reaction: ReactionType | null) => {
    const posts: Post[] = getStorageItem('infralith_posts') || [];
    const index = posts.findIndex((p) => p.id === postId);
    if (index < 0) return null;

    const post = normalizePostRecord(posts[index]);
    if (reaction == null) {
      delete post.reactions![userId];
    } else {
      post.reactions![userId] = reaction;
    }

    post.reactionTotals = toReactionTotals(post.reactions!);
    post.reactionCount = toReactionCount(post.reactionTotals);
    post.likes = Object.fromEntries(Object.keys(post.reactions!).map((id) => [id, post.reactions![id] === 'like']));
    post.likeCount = post.reactionTotals.like || 0;

    posts[index] = post;
    setStorageItem('infralith_posts', posts);
    return {
      userReaction: post.reactions![userId] || null,
      reactionTotals: post.reactionTotals,
      reactionCount: post.reactionCount,
      likeCount: post.likeCount,
    };
  },

  toggleLike: async (postId: string, userId: string) => {
    const post = await postService.getPostById(postId);
    if (!post) return null;
    const next = post.reactions?.[userId] === 'like' ? null : 'like';
    return postService.setReaction(postId, userId, next);
  },

  toggleSave: async (postId: string, userId: string) => {
    const posts: Post[] = getStorageItem('infralith_posts') || [];
    const index = posts.findIndex((p) => p.id === postId);
    if (index < 0) return { saved: false, saveCount: 0 };

    const post = normalizePostRecord(posts[index]);
    const savedBy = { ...(post.savedBy || {}) };
    if (savedBy[userId]) {
      delete savedBy[userId];
    } else {
      savedBy[userId] = true;
    }
    post.savedBy = savedBy;
    post.saveCount = Object.keys(savedBy).length;
    posts[index] = post;
    setStorageItem('infralith_posts', posts);
    return { saved: !!savedBy[userId], saveCount: post.saveCount };
  },

  createRepost: async (
    userId: string,
    authorName: string,
    authorAvatar: string,
    email: string,
    originalPostId: string,
    commentary = '',
    options?: Pick<CreatePostOptions, 'authorRole' | 'verified'>
  ) => {
    const original = await postService.getPostById(originalPostId);
    if (!original) throw new Error('Original post not found');

    const baseTags = Array.isArray(original.tags) ? original.tags : [];
    const repostTag = '#Repost';
    const nextTags = baseTags.includes(repostTag) ? baseTags : [repostTag, ...baseTags];

    return postService.createPost(
      userId,
      authorName,
      authorAvatar,
      email,
      commentary.trim(),
      null,
      {
        tags: nextTags.slice(0, 8),
        authorRole: options?.authorRole,
        verified: options?.verified,
        postType: 'announcement',
        repostOf: original.id,
        repostPreview: {
          authorName: original.authorName,
          content: original.content,
          image: original.image,
          tags: original.tags,
          postType: original.postType,
        },
      }
    );
  },

  incrementShare: async (postId: string) => {
    const posts: Post[] = getStorageItem('infralith_posts') || [];
    const post = posts.find((p) => p.id === postId);
    if (!post) return 0;
    post.shares = typeof post.shares === 'number' ? post.shares + 1 : 1;
    setStorageItem('infralith_posts', posts);
    return post.shares;
  },

  addComment: async (postId: string, userId: string, authorName: string, authorAvatar: string, text: string) => {
    const comments: Comment[] = getStorageItem(`comments_${postId}`) || [];
    const newComment: Comment = {
      id: `comment_${Date.now()}`,
      authorId: userId,
      authorName,
      authorAvatar,
      text,
      timestamp: Date.now(),
    };
    comments.push(newComment);
    setStorageItem(`comments_${postId}`, comments);

    // Update post count
    const posts: Post[] = getStorageItem('infralith_posts') || [];
    const post = posts.find((p) => p.id === postId);
    if (post) {
      post.commentCount = (post.commentCount || 0) + 1;
      setStorageItem('infralith_posts', posts);
    }
    return newComment.id;
  },

  getComments: async (postId: string) => {
    return (getStorageItem(`comments_${postId}`) || []) as Comment[];
  }
};

const buildMessageId = () => `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const buildGroupMetaKey = (chatId: string) => `dm_group_meta_${chatId}`;

type GroupMeta = {
  chatId: string;
  name: string;
  participantIds: string[];
  createdBy: string;
  createdAt: number;
};

const readInbox = (userId: string): Record<string, ChatSummary> => {
  return getStorageItem(`inbox_${userId}`) || {};
};

const writeInbox = (userId: string, inbox: Record<string, ChatSummary>) => {
  setStorageItem(`inbox_${userId}`, inbox);
};

const normalizeMessageText = (text: string) => text.replace(/\r/g, '').trim();

const updateInboxEntry = (
  userId: string,
  chatId: string,
  updater: (entry: ChatSummary | undefined) => ChatSummary
) => {
  const inbox = readInbox(userId);
  inbox[chatId] = updater(inbox[chatId]);
  writeInbox(userId, inbox);
};

// --- DM SERVICE ---
export const dmService = {
  getChatId: (uid1: string, uid2: string) => {
    return [uid1, uid2].sort().join('_');
  },

  sendMessage: async (
    currentUserId: string,
    otherUserId: string,
    otherUserName: string,
    otherUserAvatar: string,
    currentUserName: string,
    currentUserAvatar: string,
    text: string,
    imageUrl?: string | null
  ) => {
    const isGroup = otherUserId.startsWith('group_');
    const chatId = isGroup ? otherUserId : dmService.getChatId(currentUserId, otherUserId);
    const cleanText = normalizeMessageText(text || '');
    const hasImage = !!imageUrl;
    if (!cleanText && !hasImage) {
      return false;
    }

    const now = Date.now();
    const messages: ChatMessage[] = getStorageItem(`dm_messages_${chatId}`) || [];

    messages.push({
      id: buildMessageId(),
      senderId: currentUserId,
      text: cleanText,
      imageUrl,
      timestamp: now
    });
    setStorageItem(`dm_messages_${chatId}`, messages);

    const previewText = cleanText || 'Sent an attachment';

    if (isGroup) {
      const groupMeta: GroupMeta | null = getStorageItem(buildGroupMetaKey(chatId));
      const senderInbox = readInbox(currentUserId);
      const senderEntry = senderInbox[chatId];
      const fallbackParticipantIds = senderEntry?.participantIds || [];
      const participants = Array.from(
        new Set([
          ...(groupMeta?.participantIds || []),
          ...fallbackParticipantIds,
          currentUserId,
        ])
      );

      participants.forEach((participantId) => {
        updateInboxEntry(participantId, chatId, (entry) => ({
          chatId,
          otherUserId: chatId,
          otherUserName: groupMeta?.name || entry?.otherUserName || otherUserName || 'Team Group',
          otherUserAvatar: '',
          isGroup: true,
          participantIds: participants,
          lastMessage: previewText,
          timestamp: now,
          status: 'accepted',
          unreadCount: participantId === currentUserId ? 0 : (entry?.unreadCount || 0) + 1,
        }));
      });
      if (groupMeta) {
        setStorageItem(buildGroupMetaKey(chatId), { ...groupMeta, participantIds: participants });
      }
    } else {
      updateInboxEntry(currentUserId, chatId, (entry) => ({
        chatId,
        otherUserId,
        otherUserName,
        otherUserAvatar,
        lastMessage: previewText,
        timestamp: now,
        status: 'accepted',
        unreadCount: 0,
      }));

      updateInboxEntry(otherUserId, chatId, (entry) => ({
        chatId,
        otherUserId: currentUserId,
        otherUserName: currentUserName || 'Unknown User',
        otherUserAvatar: currentUserAvatar || '',
        lastMessage: previewText,
        timestamp: now,
        status: entry?.status || 'pending',
        unreadCount: (entry?.unreadCount || 0) + 1,
      }));
    }
    return true;
  },

  markChatRead: async (userId: string, chatId: string) => {
    const inbox = readInbox(userId);
    if (!inbox[chatId]) return;
    inbox[chatId] = {
      ...inbox[chatId],
      unreadCount: 0,
    };
    writeInbox(userId, inbox);
  },

  deleteMessage: async (chatId: string, messageId: string) => {
    const messages = getStorageItem(`dm_messages_${chatId}`) || [];
    const filtered = messages.filter((m: any) => m.id !== messageId);
    setStorageItem(`dm_messages_${chatId}`, filtered);
  },

  getUserChatsRef: (userId: string) => {
    return `inbox_${userId}`;
  },

  getMessagesRef: (chatId: string) => {
    return `dm_messages_${chatId}`;
  },

  acceptChatRequest: async (userId: string, chatId: string) => {
    const inbox = readInbox(userId);
    const current = inbox[chatId];
    if (!current) return;

    inbox[chatId] = { ...current, status: 'accepted', unreadCount: 0 };
    writeInbox(userId, inbox);

    if (!current.isGroup && current.otherUserId) {
      const peerInbox = readInbox(current.otherUserId);
      const peerCurrent = peerInbox[chatId];
      if (peerCurrent) {
        peerInbox[chatId] = { ...peerCurrent, status: 'accepted' };
        writeInbox(current.otherUserId, peerInbox);
      }
    }
  },

  removeChat: async (userId: string, chatId: string) => {
    const inbox = readInbox(userId);
    delete inbox[chatId];
    writeInbox(userId, inbox);
  },

  createGroup: async (creatorId: string, creatorName: string, _creatorAvatar: string, groupName: string, participantIds: string[]) => {
    const normalizedName = groupName.trim() || 'Project Group';
    const chatId = `group_${Date.now()}`;
    const allParticipantIds = Array.from(new Set([creatorId, ...participantIds]));
    const now = Date.now();

    const groupMeta: GroupMeta = {
      chatId,
      name: normalizedName,
      participantIds: allParticipantIds,
      createdBy: creatorId,
      createdAt: now,
    };
    setStorageItem(buildGroupMetaKey(chatId), groupMeta);

    allParticipantIds.forEach((id) => {
      updateInboxEntry(id, chatId, () => ({
        chatId,
        otherUserId: chatId,
        otherUserName: normalizedName,
        otherUserAvatar: '',
        isGroup: true,
        participantIds: allParticipantIds,
        lastMessage: 'Group created',
        timestamp: now,
        status: 'accepted',
        unreadCount: 0,
      }));
    });

    const messages: ChatMessage[] = [{
      id: buildMessageId(),
      senderId: 'system',
      text: `${creatorName} created group "${normalizedName}"`,
      timestamp: now
    }];
    setStorageItem(`dm_messages_${chatId}`, messages);

    return chatId;
  },

  seedMockDMs: async (userId: string) => {
    const sarahId = 'sarah-chen-id';
    const marcusId = 'marcus-thorne-id';

    const users = getStorageItem('infralith_users') || {};
    if (!users[sarahId]) {
      users[sarahId] = { uid: sarahId, name: 'Dr. Sarah Chen', email: 'sarah@infralith.com', avatar: '', role: 'Engineer' };
    }
    if (!users[marcusId]) {
      users[marcusId] = { uid: marcusId, name: 'Marcus Thorne', email: 'marcus@infralith.com', avatar: '', role: 'Supervisor' };
    }
    setStorageItem('infralith_users', users);

    await dmService.sendMessage(
      sarahId, userId, 'Your Name', '', 'Dr. Sarah Chen', '',
      'Hey, did you check the seismic reinforcement on Section B-B? The Mumbai Phase 1 blueprint seems a bit thin there.'
    );

    await dmService.sendMessage(
      marcusId, userId, 'Your Name', '', 'Marcus Thorne', '',
      'The regional audit is coming up on Tuesday. Please ensure all your compliance reports are synced to the Azure Foundry gateway.'
    );
  }
};

