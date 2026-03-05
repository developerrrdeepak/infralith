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

type ChatStatus = 'pending' | 'accepted';

type ChatMemberDoc = {
  id: string;
  pk: string;
  type: 'chatMember';
  chatId: string;
  userId: string;
  otherUserId: string;
  otherUserName: string;
  otherUserAvatar: string;
  lastMessage: string;
  timestamp: number;
  status: ChatStatus;
  isGroup?: boolean;
  participantIds?: string[];
  unreadCount?: number;
  createdAt: string;
  updatedAt: string;
};

type ChatMessageDoc = {
  id: string;
  pk: string;
  type: 'chatMessage';
  chatId: string;
  senderId: string;
  text: string;
  imageUrl?: string | null;
  timestamp: number;
  createdAt: string;
  updatedAt: string;
};

type ChatGroupDoc = {
  id: string;
  pk: string;
  type: 'chatGroup';
  chatId: string;
  name: string;
  participantIds: string[];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
};

const idWithPrefix = (prefix: string) =>
  `${prefix}_${Date.now()}_${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`;

const directChatId = (uid1: string, uid2: string) => [uid1, uid2].sort().join('_');
const userPk = (uid: string) => `user:${uid}`;
const chatPk = (chatId: string) => `chat:${chatId}`;
const memberDocId = (chatId: string, uid: string) => `chat_member:${chatId}:${uid}`;
const groupDocId = (chatId: string) => `chat_group:${chatId}`;

const actorFromSession = (session: any) => ({
  id: session?.user?.id || session?.user?.email || 'unknown-user',
  name: session?.user?.name || session?.user?.email || 'Team Member',
  avatar: session?.user?.image || '',
  role: session?.user?.role || 'Engineer',
});

const normalizeText = (value: unknown) => String(value || '').replace(/\r/g, '').trim();

async function readChatMember(chatId: string, uid: string): Promise<ChatMemberDoc | null> {
  return readCollabDoc<ChatMemberDoc>(memberDocId(chatId, uid), userPk(uid));
}

async function upsertChatMember(doc: ChatMemberDoc): Promise<ChatMemberDoc> {
  return upsertCollabDoc(doc);
}

async function hasChatAccess(chatId: string, uid: string): Promise<boolean> {
  const member = await readChatMember(chatId, uid);
  return !!member;
}

export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!isCollabStoreConfigured()) {
    return NextResponse.json({ error: 'Collab DB not configured' }, { status: 503 });
  }

  const actor = actorFromSession(session);
  const { searchParams } = new URL(req.url);
  const resource = String(searchParams.get('resource') || 'chats');

  try {
    if (resource === 'messages') {
      const chatId = String(searchParams.get('chatId') || '').trim();
      if (!chatId) return NextResponse.json({ error: 'chatId required' }, { status: 400 });
      if (!(await hasChatAccess(chatId, actor.id))) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
      }

      const messages = await queryCollabDocs<ChatMessageDoc>(
        {
          query: 'SELECT * FROM c WHERE c.pk = @pk AND c.type = @type ORDER BY c.timestamp ASC',
          parameters: [
            { name: '@pk', value: chatPk(chatId) },
            { name: '@type', value: 'chatMessage' },
          ],
        },
        { partitionKey: chatPk(chatId) }
      );

      return NextResponse.json({
        messages: messages.map((message) => ({
          id: message.id,
          senderId: message.senderId,
          text: message.text,
          imageUrl: message.imageUrl || null,
          timestamp: message.timestamp,
        })),
      });
    }

    const chats = await queryCollabDocs<ChatMemberDoc>(
      {
        query: 'SELECT * FROM c WHERE c.pk = @pk AND c.type = @type ORDER BY c.timestamp DESC',
        parameters: [
          { name: '@pk', value: userPk(actor.id) },
          { name: '@type', value: 'chatMember' },
        ],
      },
      { partitionKey: userPk(actor.id) }
    );

    return NextResponse.json({
      chats: chats.map((chat) => ({
        chatId: chat.chatId,
        otherUserId: chat.otherUserId,
        otherUserName: chat.otherUserName,
        otherUserAvatar: chat.otherUserAvatar,
        lastMessage: chat.lastMessage,
        timestamp: chat.timestamp,
        status: chat.status,
        isGroup: !!chat.isGroup,
        participantIds: chat.participantIds || [],
        unreadCount: chat.unreadCount || 0,
      })),
    });
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

  const actor = actorFromSession(session);
  const action = String(payload?.action || '').trim().toLowerCase();

  try {
    if (action === 'send_message') {
      const otherUserId = String(payload?.otherUserId || '').trim();
      const cleanText = normalizeText(payload?.text);
      const imageUrl = typeof payload?.imageUrl === 'string' ? payload.imageUrl : null;
      if (!otherUserId) {
        return NextResponse.json({ error: 'otherUserId required' }, { status: 400 });
      }
      if (!cleanText && !imageUrl) {
        return NextResponse.json({ error: 'Message cannot be empty' }, { status: 400 });
      }

      const isGroup = otherUserId.startsWith('group_');
      const chatId = isGroup ? otherUserId : directChatId(actor.id, otherUserId);
      const now = Date.now();
      const previewText = cleanText || 'Sent an attachment';

      if (isGroup) {
        const group = await readCollabDoc<ChatGroupDoc>(groupDocId(chatId), chatPk(chatId));
        const participants = Array.from(new Set([...(group?.participantIds || []), actor.id]));
        const groupName = group?.name || String(payload?.otherUserName || 'Team Group');

        await Promise.all(
          participants.map(async (uid) => {
            const existing = await readChatMember(chatId, uid);
            await upsertChatMember({
              id: memberDocId(chatId, uid),
              pk: userPk(uid),
              type: 'chatMember',
              chatId,
              userId: uid,
              otherUserId: chatId,
              otherUserName: groupName,
              otherUserAvatar: '',
              lastMessage: previewText,
              timestamp: now,
              status: 'accepted',
              isGroup: true,
              participantIds: participants,
              unreadCount: uid === actor.id ? 0 : (existing?.unreadCount || 0) + 1,
              createdAt: existing?.createdAt || new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            });
          })
        );
      } else {
        const senderExisting = await readChatMember(chatId, actor.id);
        await upsertChatMember({
          id: memberDocId(chatId, actor.id),
          pk: userPk(actor.id),
          type: 'chatMember',
          chatId,
          userId: actor.id,
          otherUserId,
          otherUserName: String(payload?.otherUserName || 'Team Member'),
          otherUserAvatar: String(payload?.otherUserAvatar || ''),
          lastMessage: previewText,
          timestamp: now,
          status: 'accepted',
          unreadCount: 0,
          createdAt: senderExisting?.createdAt || new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });

        const receiverExisting = await readChatMember(chatId, otherUserId);
        await upsertChatMember({
          id: memberDocId(chatId, otherUserId),
          pk: userPk(otherUserId),
          type: 'chatMember',
          chatId,
          userId: otherUserId,
          otherUserId: actor.id,
          otherUserName: String(payload?.currentUserName || actor.name),
          otherUserAvatar: String(payload?.currentUserAvatar || actor.avatar || ''),
          lastMessage: previewText,
          timestamp: now,
          status: receiverExisting?.status || 'pending',
          unreadCount: (receiverExisting?.unreadCount || 0) + 1,
          createdAt: receiverExisting?.createdAt || new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
      }

      const messageId = idWithPrefix('msg');
      await upsertCollabDoc<ChatMessageDoc>({
        id: messageId,
        pk: chatPk(chatId),
        type: 'chatMessage',
        chatId,
        senderId: actor.id,
        text: cleanText,
        imageUrl,
        timestamp: now,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      return NextResponse.json({ success: true, chatId, messageId });
    }

    if (action === 'mark_read') {
      const chatId = String(payload?.chatId || '').trim();
      if (!chatId) return NextResponse.json({ error: 'chatId required' }, { status: 400 });
      const member = await readChatMember(chatId, actor.id);
      if (!member) return NextResponse.json({ success: true });
      await upsertChatMember({
        ...member,
        unreadCount: 0,
        updatedAt: new Date().toISOString(),
      });
      return NextResponse.json({ success: true });
    }

    if (action === 'accept_chat') {
      const chatId = String(payload?.chatId || '').trim();
      if (!chatId) return NextResponse.json({ error: 'chatId required' }, { status: 400 });
      const member = await readChatMember(chatId, actor.id);
      if (!member) return NextResponse.json({ error: 'Chat not found' }, { status: 404 });
      await upsertChatMember({
        ...member,
        status: 'accepted',
        unreadCount: 0,
        updatedAt: new Date().toISOString(),
      });

      if (!member.isGroup && member.otherUserId) {
        const peer = await readChatMember(chatId, member.otherUserId);
        if (peer) {
          await upsertChatMember({
            ...peer,
            status: 'accepted',
            updatedAt: new Date().toISOString(),
          });
        }
      }
      return NextResponse.json({ success: true });
    }

    if (action === 'remove_chat') {
      const chatId = String(payload?.chatId || '').trim();
      if (!chatId) return NextResponse.json({ error: 'chatId required' }, { status: 400 });
      await deleteCollabDoc(memberDocId(chatId, actor.id), userPk(actor.id));
      return NextResponse.json({ success: true });
    }

    if (action === 'delete_message') {
      const chatId = String(payload?.chatId || '').trim();
      const messageId = String(payload?.messageId || '').trim();
      if (!chatId || !messageId) {
        return NextResponse.json({ error: 'chatId and messageId required' }, { status: 400 });
      }
      const message = await readCollabDoc<ChatMessageDoc>(messageId, chatPk(chatId));
      if (!message) return NextResponse.json({ success: true });
      const isAdmin = actor.role === 'Admin';
      if (message.senderId !== actor.id && !isAdmin) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
      }
      await deleteCollabDoc(messageId, chatPk(chatId));
      return NextResponse.json({ success: true });
    }

    if (action === 'create_group') {
      const groupName = normalizeText(payload?.groupName) || 'Project Group';
      const participantsInput = Array.isArray(payload?.participantIds)
        ? payload.participantIds.map((id: unknown) => String(id || '').trim()).filter(Boolean)
        : [];
      const participantIds = Array.from(new Set([actor.id, ...participantsInput]));
      const chatId = `group_${Date.now()}_${crypto.randomUUID().replace(/-/g, '').slice(0, 6)}`;

      const groupDoc: ChatGroupDoc = {
        id: groupDocId(chatId),
        pk: chatPk(chatId),
        type: 'chatGroup',
        chatId,
        name: groupName,
        participantIds,
        createdBy: actor.id,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await upsertCollabDoc(groupDoc);

      const now = Date.now();
      await Promise.all(
        participantIds.map(async (uid) => {
          const existing = await readChatMember(chatId, uid);
          await upsertChatMember({
            id: memberDocId(chatId, uid),
            pk: userPk(uid),
            type: 'chatMember',
            chatId,
            userId: uid,
            otherUserId: chatId,
            otherUserName: groupName,
            otherUserAvatar: '',
            lastMessage: 'Group created',
            timestamp: now,
            status: 'accepted',
            isGroup: true,
            participantIds,
            unreadCount: 0,
            createdAt: existing?.createdAt || new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          });
        })
      );

      await upsertCollabDoc<ChatMessageDoc>({
        id: idWithPrefix('msg'),
        pk: chatPk(chatId),
        type: 'chatMessage',
        chatId,
        senderId: 'system',
        text: `${actor.name} created group "${groupName}"`,
        imageUrl: null,
        timestamp: now,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      return NextResponse.json({ success: true, chatId });
    }

    if (action === 'seed_mock') {
      return NextResponse.json({ success: true });
    }

    return NextResponse.json({ error: 'Unsupported action' }, { status: 400 });
  } catch (error: any) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
