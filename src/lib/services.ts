import { LS_KEYS } from './constants';
import { WorkflowResult } from '@/ai/flows/infralith/types';

export const normalizeEmail = (email: string) => (email || '').trim().toLowerCase();

export type UserProfileData = {
  uid: string;
  name: string;
  email: string;
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
  content: string;
  image?: string | null;
  timestamp: number;
  likes: Record<string, boolean>;
  likeCount: number;
  commentCount: number;
  shares: number;
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
};

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

// --- USER DB SERVICE ---
export const userDbService = {
  lookupRemoteUser: async (email: string): Promise<UserProfileData | null> => {
    if (typeof fetch === 'undefined') return null;
    try {
      const res = await fetch(`/api/user-lookup?email=${encodeURIComponent(normalizeEmail(email))}`, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
      });
      if (!res.ok) return null;
      const data = await res.json();
      if (!data) return null;
      return {
        uid: data.uid || data.id,
        name: data.name || data.fullName || '',
        email: normalizeEmail(data.email || email),
        avatar: data.avatar || data.image || null,
        role: data.role || data.title,
        profileCompleted: true,
      } as UserProfileData;
    } catch (error) {
      console.warn('Remote user lookup failed, falling back to local storage', error);
      return null;
    }
  },

  createUser: async (user: any) => {
    const users = getStorageItem('infralith_users') || {};
    users[user.id] = {
      uid: user.id,
      email: normalizeEmail(user.email),
      name: user.name,
      avatar: user.image,
      createdAt: new Date().toISOString(),
      profileCompleted: false,
    };
    setStorageItem('infralith_users', users);
  },

  getUser: async (uid: string): Promise<UserProfileData | null> => {
    const users = getStorageItem('infralith_users') || {};
    return users[uid] || null;
  },

  getAllUsers: async (): Promise<UserProfileData[]> => {
    const users = getStorageItem('infralith_users') || {};
    return Object.values(users);
  },

  getUserByEmail: async (email: string): Promise<UserProfileData | null> => {
    const target = normalizeEmail(email);
    // Try remote directory first (production) then fallback to local mock.
    const remote = await userDbService.lookupRemoteUser(target);
    if (remote) return remote;

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

  getInvitesSentBy: (senderUid: string): InviteRecord[] => {
    const invites: Record<string, InviteRecord> = getStorageItem('infralith_invites') || {};
    return Object.values(invites).filter((i) => i.senderUid === senderUid);
  },

  hasInvited: (senderUid: string, recipientEmail: string): boolean => {
    const invites: Record<string, InviteRecord> = getStorageItem('infralith_invites') || {};
    const normalizedEmail = normalizeEmail(recipientEmail);
    return Object.values(invites).some(
      (i) => i.senderUid === senderUid && normalizeEmail(i.recipientEmail) === normalizedEmail
    );
  },

  deleteInvite: (id: string) => {
    const invites: Record<string, InviteRecord> = getStorageItem('infralith_invites') || {};
    delete invites[id];
    setStorageItem('infralith_invites', invites);
  },
};

// --- AUTH SERVICE (Mocked for Enterprise context) ---
export const authService = {
  login: async (email: string, password: string) => {
    // Enterprise Auth now handled by Azure AD / NextAuth
    console.log("Mock login for:", email);
    return { uid: 'mock-uid', email };
  },

  signUp: async (data: Partial<SignUpData>) => {
    console.log("Mock signup for:", data.email);
    return { uid: 'mock-uid', email: data.email };
  },

  signInOrSignUpWithGoogle: async () => {
    return { user: { uid: 'mock-google-uid' }, isNewUser: false };
  },

  loginWithGoogle: async () => {
    return { user: { uid: 'mock-google-uid' }, isNewUser: false };
  },

  updateProfile: async (uid: string, data: Partial<UserProfileData>) => {
    await userDbService.updateUser(uid, data);
    return await userDbService.getUser(uid);
  },

  deleteAccount: async (uid: string) => {
    const users = getStorageItem('infralith_users') || {};
    delete users[uid];
    setStorageItem('infralith_users', users);
  },

  logout: async () => {
    if (typeof window !== 'undefined') {
      localStorage.removeItem(LS_KEYS.resume);
    }
  },

  cancelSignUpAndDeleteAuthUser: async () => {
    // Placeholder
  }
};

// --- CHAT HISTORY ---
export type Message = {
  role: 'user' | 'bot';
  text: string;
};

export type ChatSession = {
  id: string;
  title: string;
  timestamp: number;
  messages: Message[];
};

export const chatHistoryService = {
  saveChatSession: async (userId: string, messages: Message[], existingId: string | null) => {
    const chats = getStorageItem(`chats_${userId}`) || {};
    let sessionId = existingId || `chat_${Date.now()}`;

    const generateTitle = (msgs: Message[]) => msgs.find(m => m.role === 'user')?.text.split(' ').slice(0, 5).join(' ') + '...' || 'New Chat';

    chats[sessionId] = {
      id: sessionId,
      title: existingId ? chats[sessionId]?.title : generateTitle(messages),
      timestamp: Date.now(),
      messages
    };

    setStorageItem(`chats_${userId}`, chats);
    return { sessionId };
  }
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
export const postService = {
  createPost: async (userId: string, authorName: string, authorAvatar: string, email: string, content: string, image: string | null) => {
    const posts = getStorageItem('infralith_posts') || [];
    const newPost = {
      id: `post_${Date.now()}`,
      authorId: userId,
      authorName,
      authorHandle: email.split('@')[0],
      authorAvatar: authorAvatar || '',
      content,
      image,
      timestamp: Date.now(),
      likeCount: 0,
      commentCount: 0,
      shares: 0,
      likes: {}
    };
    posts.unshift(newPost);
    setStorageItem('infralith_posts', posts);
    return newPost.id;
  },

  deletePost: async (postId: string) => {
    const posts = getStorageItem('infralith_posts') || [];
    const filtered = posts.filter((p: any) => p.id !== postId);
    setStorageItem('infralith_posts', filtered);
  },

  getAllPosts: async () => {
    return getStorageItem('infralith_posts') || [];
  },

  toggleLike: async (postId: string, userId: string) => {
    const posts = getStorageItem('infralith_posts') || [];
    const post = posts.find((p: any) => p.id === postId);
    if (post) {
      post.likes = post.likes || {};
      if (post.likes[userId]) {
        delete post.likes[userId];
        post.likeCount = Math.max(0, post.likeCount - 1);
      } else {
        post.likes[userId] = true;
        post.likeCount += 1;
      }
      setStorageItem('infralith_posts', posts);
    }
  },

  addComment: async (postId: string, userId: string, authorName: string, authorAvatar: string, text: string) => {
    const comments = getStorageItem(`comments_${postId}`) || [];
    const newComment = {
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
    const posts = getStorageItem('infralith_posts') || [];
    const post = posts.find((p: any) => p.id === postId);
    if (post) {
      post.commentCount += 1;
      setStorageItem('infralith_posts', posts);
    }
    return newComment.id;
  },

  getComments: async (postId: string) => {
    return getStorageItem(`comments_${postId}`) || [];
  }
};

// --- DM SERVICE ---
export const dmService = {
  getChatId: (uid1: string, uid2: string) => {
    return [uid1, uid2].sort().join('_');
  },

  sendMessage: async (currentUserId: string, otherUserId: string, otherUserName: string, otherUserAvatar: string, currentUserName: string, currentUserAvatar: string, text: string, imageUrl?: string | null) => {
    const isGroup = otherUserId.startsWith('group_');
    const chatId = isGroup ? otherUserId : dmService.getChatId(currentUserId, otherUserId);
    const messages = getStorageItem(`dm_messages_${chatId}`) || [];

    messages.push({
      id: `msg_${Date.now()}`,
      senderId: currentUserId,
      text,
      imageUrl,
      timestamp: Date.now()
    });
    setStorageItem(`dm_messages_${chatId}`, messages);

    // Update inboxes
    if (isGroup) {
      const inboxEntry = (getStorageItem(`inbox_${currentUserId}`) || {})[chatId];
      if (inboxEntry && inboxEntry.participantIds) {
        inboxEntry.participantIds.forEach((pid: string) => {
          const userInbox = getStorageItem(`inbox_${pid}`) || {};
          if (userInbox[chatId]) {
            userInbox[chatId].lastMessage = text;
            userInbox[chatId].timestamp = Date.now();
            setStorageItem(`inbox_${pid}`, userInbox);
          }
        });
      }
    } else {
      const updateInbox = (userId: string, otherId: string, otherName: string, otherAvatar: string, status: string) => {
        const inbox = getStorageItem(`inbox_${userId}`) || {};
        inbox[chatId] = {
          chatId,
          otherUserId: otherId,
          otherUserName: otherName,
          otherUserAvatar: otherAvatar,
          lastMessage: text,
          timestamp: Date.now(),
          status
        };
        setStorageItem(`inbox_${userId}`, inbox);
      };

      updateInbox(currentUserId, otherUserId, otherUserName, otherUserAvatar, 'accepted');
      const otherInbox = getStorageItem(`inbox_${otherUserId}`) || {};
      const existingStatus = otherInbox[chatId]?.status || 'pending';
      updateInbox(otherUserId, currentUserId, currentUserName, currentUserAvatar, existingStatus);
    }
  },

  deleteMessage: async (chatId: string, messageId: string) => {
    const messages = getStorageItem(`dm_messages_${chatId}`) || [];
    const filtered = messages.filter((m: any) => m.id !== messageId);
    setStorageItem(`dm_messages_${chatId}`, filtered);
  },

  getUserChatsRef: (userId: string) => {
    // This method returns the key for local storage inbox
    return `inbox_${userId}`;
  },

  getMessagesRef: (chatId: string) => {
    return `dm_messages_${chatId}`;
  },

  acceptChatRequest: async (userId: string, chatId: string) => {
    const inbox = getStorageItem(`inbox_${userId}`) || {};
    if (inbox[chatId]) {
      inbox[chatId].status = 'accepted';
      setStorageItem(`inbox_${userId}`, inbox);
    }
  },

  removeChat: async (userId: string, chatId: string) => {
    const inbox = getStorageItem(`inbox_${userId}`) || {};
    delete inbox[chatId];
    setStorageItem(`inbox_${userId}`, inbox);
  },

  createGroup: async (creatorId: string, creatorName: string, creatorAvatar: string, groupName: string, participantIds: string[]) => {
    const chatId = `group_${Date.now()}`;
    const allParticipantIds = [...new Set([creatorId, ...participantIds])];

    const updateInbox = (userId: string) => {
      const inbox = getStorageItem(`inbox_${userId}`) || {};
      inbox[chatId] = {
        chatId,
        otherUserId: chatId, // For groups, we use the chatId as the "otherId"
        otherUserName: groupName,
        otherUserAvatar: '', // Or a group icon
        isGroup: true,
        participantIds: allParticipantIds,
        lastMessage: 'Group created',
        timestamp: Date.now(),
        status: 'accepted'
      };
      setStorageItem(`inbox_${userId}`, inbox);
    };

    allParticipantIds.forEach(id => updateInbox(id));

    // Save initial system message
    const messages = [];
    messages.push({
      id: `msg_${Date.now()}`,
      senderId: 'system',
      text: `${creatorName} created group "${groupName}"`,
      timestamp: Date.now()
    });
    setStorageItem(`dm_messages_${chatId}`, messages);

    return chatId;
  },

  seedMockDMs: async (userId: string) => {
    const sarahId = 'sarah-chen-id';
    const marcusId = 'marcus-thorne-id';

    // Seed Users if they don't exist
    const users = getStorageItem('infralith_users') || {};
    if (!users[sarahId]) {
      users[sarahId] = { uid: sarahId, name: 'Dr. Sarah Chen', email: 'sarah@infralith.com', avatar: '', role: 'Engineer' };
    }
    if (!users[marcusId]) {
      users[marcusId] = { uid: marcusId, name: 'Marcus Thorne', email: 'marcus@infralith.com', avatar: '', role: 'Supervisor' };
    }
    setStorageItem('infralith_users', users);

    // Sarah's Message
    await dmService.sendMessage(
      sarahId, userId, 'Your Name', '', 'Dr. Sarah Chen', '',
      "Hey, did you check the seismic reinforcement on Section B-B? The Mumbai Phase 1 blueprint seems a bit thin there."
    );

    // Marcus's Message
    await dmService.sendMessage(
      marcusId, userId, 'Your Name', '', 'Marcus Thorne', '',
      "The regional audit is coming up on Tuesday. Please ensure all your compliance reports are synced to the Azure Foundry gateway."
    );
  }
};

// --- ADDITIONAL SERVICE MOCKS ---
export const resumeService = {
  saveText: (text: string) => localStorage.setItem('resume_text', text),
  getText: () => localStorage.getItem('resume_text') || '',
};

export const evaluationService = {
  getEvaluations: async (userId: string) => {
    return getStorageItem(`evaluations_${userId}`) || { skillAssessments: [], resumeReviews: [], mockInterviews: [] };
  }
};
