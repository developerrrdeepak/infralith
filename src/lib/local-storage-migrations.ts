const SCHEMA_VERSION_KEY = 'infralith_schema_version';
const CURRENT_SCHEMA_VERSION = 3;

const isObjectRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

const parseJsonSafe = (raw: string | null): unknown => {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

const writeJson = (key: string, value: unknown) => {
  localStorage.setItem(key, JSON.stringify(value));
};

const toNonNegativeInt = (value: unknown, fallback = 0) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.floor(n));
};

const normalizeInboxRecord = (key: string) => {
  const raw = parseJsonSafe(localStorage.getItem(key));
  if (!isObjectRecord(raw)) {
    writeJson(key, {});
    return;
  }

  const normalized: Record<string, unknown> = {};
  Object.entries(raw).forEach(([chatId, entry]) => {
    if (!isObjectRecord(entry)) return;

    const normalizedChatId = String(entry.chatId || chatId || '').trim();
    if (!normalizedChatId) return;

    const participantIds = Array.isArray(entry.participantIds)
      ? entry.participantIds.map((id) => String(id || '').trim()).filter(Boolean)
      : undefined;
    const status = entry.status === 'pending' ? 'pending' : 'accepted';

    normalized[normalizedChatId] = {
      chatId: normalizedChatId,
      otherUserId: String(entry.otherUserId || '').trim(),
      otherUserName: String(entry.otherUserName || 'Team Member'),
      otherUserAvatar: String(entry.otherUserAvatar || ''),
      lastMessage: String(entry.lastMessage || ''),
      timestamp: toNonNegativeInt(entry.timestamp, Date.now()),
      status,
      isGroup: !!entry.isGroup,
      participantIds,
      unreadCount: toNonNegativeInt(entry.unreadCount, 0),
    };
  });

  writeJson(key, normalized);
};

const normalizeMessagesRecord = (key: string) => {
  const raw = parseJsonSafe(localStorage.getItem(key));
  if (!Array.isArray(raw)) {
    writeJson(key, []);
    return;
  }

  const base = Date.now();
  const normalized = raw
    .filter((entry) => isObjectRecord(entry))
    .map((entry, idx) => {
      const imageUrl = typeof entry.imageUrl === 'string' ? entry.imageUrl : null;
      const text = String(entry.text || '');
      const hasPayload = text.trim().length > 0 || !!imageUrl;
      if (!hasPayload) return null;

      return {
        id: String(entry.id || `${key}_${idx}`),
        senderId: String(entry.senderId || 'system'),
        text,
        imageUrl,
        timestamp: toNonNegativeInt(entry.timestamp, base + idx),
      };
    })
    .filter((entry): entry is NonNullable<typeof entry> => !!entry);

  writeJson(key, normalized);
};

const normalizeArrayCollection = (key: string) => {
  const raw = parseJsonSafe(localStorage.getItem(key));
  if (Array.isArray(raw)) return;
  if (isObjectRecord(raw)) {
    writeJson(key, Object.values(raw));
    return;
  }
  writeJson(key, []);
};

const normalizeObjectCollection = (key: string) => {
  const raw = parseJsonSafe(localStorage.getItem(key));
  if (isObjectRecord(raw)) return;
  writeJson(key, {});
};

const migrateLegacyKeyPrefixes = () => {
  const keyCount = localStorage.length;
  const keys = Array.from({ length: keyCount }, (_, index) => localStorage.key(index)).filter(
    (key): key is string => !!key
  );

  keys.forEach((key) => {
    if (key.startsWith('chats_')) {
      const suffix = key.slice('chats_'.length);
      const nextKey = `inbox_${suffix}`;
      if (nextKey && localStorage.getItem(nextKey) == null) {
        const value = localStorage.getItem(key);
        if (value != null) localStorage.setItem(nextKey, value);
      }
      localStorage.removeItem(key);
      return;
    }

    if (key.startsWith('messages_')) {
      const suffix = key.slice('messages_'.length);
      const nextKey = `dm_messages_${suffix}`;
      if (nextKey && localStorage.getItem(nextKey) == null) {
        const value = localStorage.getItem(key);
        if (value != null) localStorage.setItem(nextKey, value);
      }
      localStorage.removeItem(key);
    }
  });
};

const normalizeKnownStores = () => {
  const keyCount = localStorage.length;
  const keys = Array.from({ length: keyCount }, (_, index) => localStorage.key(index)).filter(
    (key): key is string => !!key
  );

  keys.forEach((key) => {
    if (key.startsWith('inbox_')) {
      normalizeInboxRecord(key);
      return;
    }
    if (key.startsWith('dm_messages_')) {
      normalizeMessagesRecord(key);
      return;
    }
    if (key.startsWith('comments_')) {
      normalizeArrayCollection(key);
      return;
    }
    if (
      key === 'infralith_posts' ||
      key.startsWith('chats_') ||
      key.startsWith('messages_')
    ) {
      normalizeArrayCollection(key);
      return;
    }
    if (key === 'infralith_users' || key === 'infralith_invites') {
      normalizeObjectCollection(key);
    }
  });
};

export const runLocalStorageMigrations = () => {
  if (typeof window === 'undefined') return;
  if (typeof localStorage === 'undefined') return;

  try {
    const currentVersion = toNonNegativeInt(localStorage.getItem(SCHEMA_VERSION_KEY), 0);
    if (currentVersion >= CURRENT_SCHEMA_VERSION) return;

    if (currentVersion < 1) {
      migrateLegacyKeyPrefixes();
    }

    if (currentVersion < 2) {
      normalizeKnownStores();
    }

    if (currentVersion < 3) {
      normalizeKnownStores();
    }

    localStorage.setItem(SCHEMA_VERSION_KEY, String(CURRENT_SCHEMA_VERSION));
  } catch (error) {
    console.error('Failed to run local storage migrations', error);
  }
};
