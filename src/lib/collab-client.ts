import {
  dmService as localDmService,
  postService as localPostService,
  type ChatMessage,
  type ChatSummary,
  type Comment,
  type Post,
  type ReactionType,
} from '@/lib/services';

const parseJsonSafe = async (response: Response) => {
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) return null;
  try {
    return await response.json();
  } catch {
    return null;
  }
};

const apiGet = async <T>(url: string): Promise<T | null> => {
  if (typeof window === 'undefined') return null;
  try {
    const res = await fetch(url, { method: 'GET', credentials: 'include' });
    if (!res.ok) return null;
    return (await parseJsonSafe(res)) as T;
  } catch {
    return null;
  }
};

const apiPost = async <T>(url: string, body: Record<string, unknown>): Promise<T | null> => {
  if (typeof window === 'undefined') return null;
  try {
    const res = await fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) return null;
    return (await parseJsonSafe(res)) as T;
  } catch {
    return null;
  }
};

const allowLocalFallback = process.env.NODE_ENV !== 'production';

const fallbackOrThrow = async <T>(operation: string, fallback: () => Promise<T> | T): Promise<T> => {
  if (!allowLocalFallback) {
    throw new Error(`${operation} requires the collab API in production.`);
  }
  return await Promise.resolve(fallback());
};

const getLocalChatsFallback = (userId: string): ChatSummary[] => {
  if (typeof window === 'undefined') return [];
  try {
    const key = localDmService.getUserChatsRef(userId);
    if (typeof key !== 'string') return [];
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    return Object.values(JSON.parse(raw) || {}) as ChatSummary[];
  } catch {
    return [];
  }
};

const getLocalMessagesFallback = (chatId: string): ChatMessage[] => {
  if (typeof window === 'undefined') return [];
  try {
    const key = localDmService.getMessagesRef(chatId);
    if (typeof key !== 'string') return [];
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    return JSON.parse(raw) as ChatMessage[];
  } catch {
    return [];
  }
};

export const postService = {
  createPost: async (
    userId: string,
    authorName: string,
    authorAvatar: string,
    email: string,
    content: string,
    image: string | null,
    options?: any
  ) => {
    const response = await apiPost<{ id: string }>('/api/infralith/community', {
      action: 'create_post',
      userId,
      authorName,
      authorAvatar,
      email,
      content,
      image,
      ...options,
    });
    if (response?.id) return response.id;
    return fallbackOrThrow('community.createPost', () =>
      localPostService.createPost(userId, authorName, authorAvatar, email, content, image, options)
    );
  },

  seedPosts: async (seedPosts: any[]) => {
    if (!allowLocalFallback) return [];
    return localPostService.seedPosts(seedPosts);
  },

  deletePost: async (postId: string) => {
    const response = await apiPost<{ success: boolean }>('/api/infralith/community', {
      action: 'delete_post',
      postId,
    });
    if (response?.success) return;
    return fallbackOrThrow('community.deletePost', () => localPostService.deletePost(postId));
  },

  getAllPosts: async () => {
    const response = await apiGet<{ posts: Post[] }>('/api/infralith/community');
    if (response?.posts) return response.posts;
    return fallbackOrThrow('community.getAllPosts', () => localPostService.getAllPosts());
  },

  getPostById: async (postId: string) => {
    const response = await apiGet<{ post: Post | null }>(
      `/api/infralith/community?postId=${encodeURIComponent(postId)}`
    );
    if (response && 'post' in response) return response.post;
    return fallbackOrThrow('community.getPostById', () => localPostService.getPostById(postId));
  },

  setReaction: async (postId: string, userId: string, reaction: ReactionType | null) => {
    const response = await apiPost<any>('/api/infralith/community', {
      action: 'set_reaction',
      postId,
      userId,
      reaction,
    });
    if (response) return response;
    return fallbackOrThrow('community.setReaction', () =>
      localPostService.setReaction(postId, userId, reaction)
    );
  },

  toggleLike: async (postId: string, userId: string) => {
    const response = await apiPost<any>('/api/infralith/community', {
      action: 'toggle_like',
      postId,
      userId,
    });
    if (response) return response;
    return fallbackOrThrow('community.toggleLike', () => localPostService.toggleLike(postId, userId));
  },

  toggleSave: async (postId: string, userId: string) => {
    const response = await apiPost<{ saved: boolean; saveCount: number }>('/api/infralith/community', {
      action: 'toggle_save',
      postId,
      userId,
    });
    if (response) return response;
    return fallbackOrThrow('community.toggleSave', () => localPostService.toggleSave(postId, userId));
  },

  createRepost: async (
    userId: string,
    authorName: string,
    authorAvatar: string,
    email: string,
    originalPostId: string,
    commentary = '',
    options?: any
  ) => {
    const response = await apiPost<{ id: string }>('/api/infralith/community', {
      action: 'create_repost',
      userId,
      authorName,
      authorAvatar,
      email,
      originalPostId,
      commentary,
      ...options,
    });
    if (response?.id) return response.id;
    return fallbackOrThrow('community.createRepost', () =>
      localPostService.createRepost(
        userId,
        authorName,
        authorAvatar,
        email,
        originalPostId,
        commentary,
        options
      )
    );
  },

  incrementShare: async (postId: string) => {
    const response = await apiPost<{ shares: number }>('/api/infralith/community', {
      action: 'increment_share',
      postId,
    });
    if (response && typeof response.shares === 'number') return response.shares;
    return fallbackOrThrow('community.incrementShare', () => localPostService.incrementShare(postId));
  },

  addComment: async (
    postId: string,
    userId: string,
    authorName: string,
    authorAvatar: string,
    text: string
  ) => {
    const response = await apiPost<{ id: string }>('/api/infralith/community', {
      action: 'add_comment',
      postId,
      userId,
      authorName,
      authorAvatar,
      text,
    });
    if (response?.id) return response.id;
    return fallbackOrThrow('community.addComment', () =>
      localPostService.addComment(postId, userId, authorName, authorAvatar, text)
    );
  },

  getComments: async (postId: string) => {
    const response = await apiGet<{ comments: Comment[] }>(
      `/api/infralith/community?resource=comments&postId=${encodeURIComponent(postId)}`
    );
    if (response?.comments) return response.comments;
    return fallbackOrThrow('community.getComments', () => localPostService.getComments(postId));
  },
};

export const dmService = {
  ...localDmService,

  getUserChats: async (userId: string): Promise<ChatSummary[]> => {
    const response = await apiGet<{ chats: ChatSummary[] }>('/api/infralith/messages?resource=chats');
    if (response?.chats) return response.chats;
    return fallbackOrThrow('messages.getUserChats', () => getLocalChatsFallback(userId));
  },

  getMessages: async (chatId: string): Promise<ChatMessage[]> => {
    const response = await apiGet<{ messages: ChatMessage[] }>(
      `/api/infralith/messages?resource=messages&chatId=${encodeURIComponent(chatId)}`
    );
    if (response?.messages) return response.messages;
    return fallbackOrThrow('messages.getMessages', () => getLocalMessagesFallback(chatId));
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
    const response = await apiPost<{ success: boolean }>('/api/infralith/messages', {
      action: 'send_message',
      currentUserId,
      otherUserId,
      otherUserName,
      otherUserAvatar,
      currentUserName,
      currentUserAvatar,
      text,
      imageUrl: imageUrl || null,
    });
    if (response?.success) return true;
    return fallbackOrThrow('messages.sendMessage', () =>
      localDmService.sendMessage(
        currentUserId,
        otherUserId,
        otherUserName,
        otherUserAvatar,
        currentUserName,
        currentUserAvatar,
        text,
        imageUrl
      )
    );
  },

  markChatRead: async (userId: string, chatId: string) => {
    const response = await apiPost<{ success: boolean }>('/api/infralith/messages', {
      action: 'mark_read',
      userId,
      chatId,
    });
    if (response?.success) return;
    return fallbackOrThrow('messages.markChatRead', () => localDmService.markChatRead(userId, chatId));
  },

  acceptChatRequest: async (userId: string, chatId: string) => {
    const response = await apiPost<{ success: boolean }>('/api/infralith/messages', {
      action: 'accept_chat',
      userId,
      chatId,
    });
    if (response?.success) return;
    return fallbackOrThrow('messages.acceptChatRequest', () =>
      localDmService.acceptChatRequest(userId, chatId)
    );
  },

  removeChat: async (userId: string, chatId: string) => {
    const response = await apiPost<{ success: boolean }>('/api/infralith/messages', {
      action: 'remove_chat',
      userId,
      chatId,
    });
    if (response?.success) return;
    return fallbackOrThrow('messages.removeChat', () => localDmService.removeChat(userId, chatId));
  },

  deleteMessage: async (chatId: string, messageId: string) => {
    const response = await apiPost<{ success: boolean }>('/api/infralith/messages', {
      action: 'delete_message',
      chatId,
      messageId,
    });
    if (response?.success) return;
    return fallbackOrThrow('messages.deleteMessage', () =>
      localDmService.deleteMessage(chatId, messageId)
    );
  },

  createGroup: async (
    creatorId: string,
    creatorName: string,
    creatorAvatar: string,
    groupName: string,
    participantIds: string[]
  ) => {
    const response = await apiPost<{ success: boolean; chatId: string }>('/api/infralith/messages', {
      action: 'create_group',
      creatorId,
      creatorName,
      creatorAvatar,
      groupName,
      participantIds,
    });
    if (response?.chatId) return response.chatId;
    return fallbackOrThrow('messages.createGroup', () =>
      localDmService.createGroup(creatorId, creatorName, creatorAvatar, groupName, participantIds)
    );
  },

  seedMockDMs: async (userId: string) => {
    if (process.env.NODE_ENV === 'production') return;
    const response = await apiPost<{ success: boolean }>('/api/infralith/messages', {
      action: 'seed_mock',
      userId,
    });
    if (response?.success) return;
    return fallbackOrThrow('messages.seedMockDMs', () => localDmService.seedMockDMs(userId));
  },
};
