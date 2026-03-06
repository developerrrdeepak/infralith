import { z } from 'zod';
import { NextRequest, NextResponse } from 'next/server';

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 10;
const RATE_STORE_MAX = 2_000;
const DEFAULT_TIMEOUT_MS = 5_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 20_000;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DEFAULT_BACKOFF_MS = 60_000;
const TIMEOUT_LOG_THROTTLE_MS = 30_000;

const lookupPayloadSchema = z.object({
  uid: z.union([z.string(), z.number()]).optional(),
  id: z.union([z.string(), z.number()]).optional(),
  name: z.string().optional(),
  fullName: z.string().optional(),
  email: z.string().optional(),
  avatar: z.string().nullable().optional(),
  image: z.string().nullable().optional(),
  role: z.string().optional(),
  title: z.string().optional(),
}).passthrough();

const rateStore = new Map<string, { count: number; windowStart: number }>();
const backendUrl = (process.env.USER_LOOKUP_URL || '').trim();

const normalizeEmail = (email: string) => email.trim().toLowerCase();

const parseTimeoutMs = (value: string | undefined) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.floor(parsed)));
};

const FETCH_TIMEOUT_MS = parseTimeoutMs(process.env.USER_LOOKUP_TIMEOUT_MS);
const BACKOFF_MS = parseTimeoutMs(process.env.USER_LOOKUP_BACKOFF_MS || String(DEFAULT_BACKOFF_MS));
let backendBackoffUntil = 0;
let lastTimeoutLogAt = 0;

const pruneRateStore = (now: number) => {
  for (const [ip, bucket] of rateStore.entries()) {
    if (now - bucket.windowStart > RATE_LIMIT_WINDOW_MS) {
      rateStore.delete(ip);
    }
  }
  if (rateStore.size <= RATE_STORE_MAX) return;
  const overflow = rateStore.size - RATE_STORE_MAX;
  const oldest = [...rateStore.entries()]
    .sort((a, b) => a[1].windowStart - b[1].windowStart)
    .slice(0, overflow);
  for (const [ip] of oldest) {
    rateStore.delete(ip);
  }
};

const rateLimit = (ip: string) => {
  const now = Date.now();
  pruneRateStore(now);
  const bucket = rateStore.get(ip);
  if (!bucket || now - bucket.windowStart > RATE_LIMIT_WINDOW_MS) {
    rateStore.set(ip, { count: 1, windowStart: now });
    return true;
  }
  if (bucket.count >= RATE_LIMIT_MAX) return false;
  bucket.count += 1;
  return true;
};

const readJsonSafe = async (res: Response): Promise<unknown> => {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

export async function GET(req: NextRequest) {
  const now = Date.now();
  const ip =
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    req.headers.get('x-real-ip') ||
    'unknown';

  if (!rateLimit(ip)) {
    return NextResponse.json({ error: 'Too many requests' }, { status: 429 });
  }

  const emailParam = req.nextUrl.searchParams.get('email') || '';
  const email = normalizeEmail(emailParam);
  if (!EMAIL_REGEX.test(email)) {
    return NextResponse.json({ error: 'Invalid email' }, { status: 400 });
  }

  if (!backendUrl) {
    return NextResponse.json({ error: 'Lookup unavailable' }, { status: 503 });
  }
  if (now < backendBackoffUntil) {
    return NextResponse.json({ error: 'Lookup unavailable', code: 'EBACKOFF' }, { status: 503 });
  }

  let backend: URL;
  try {
    backend = new URL(backendUrl);
  } catch {
    return NextResponse.json({ error: 'Lookup unavailable' }, { status: 503 });
  }
  backend.searchParams.set('email', email);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(backend.toString(), {
      method: 'GET',
      headers: { Accept: 'application/json' },
      cache: 'no-store',
      signal: controller.signal,
    });

    if (res.status === 404) {
      return NextResponse.json(null, { status: 200 });
    }
    if (!res.ok) {
      if (res.status >= 500 || res.status === 429) {
        backendBackoffUntil = Date.now() + BACKOFF_MS;
      }
      const details = await readJsonSafe(res);
      console.error('User lookup backend failed', { status: res.status, details });
      return NextResponse.json({ error: 'Lookup failed' }, { status: 502 });
    }

    const payload = await readJsonSafe(res);
    const parsed = lookupPayloadSchema.safeParse(payload);
    if (!parsed.success) {
      console.error('User lookup payload invalid', parsed.error.flatten());
      return NextResponse.json({ error: 'Lookup failed' }, { status: 502 });
    }

    const data = parsed.data;
    const normalizedEmail = normalizeEmail(data.email || email);
    const uid = String(data.uid ?? data.id ?? '').trim();
    if (!uid) {
      return NextResponse.json({ error: 'Lookup failed' }, { status: 502 });
    }

    return NextResponse.json({
      uid,
      name: data.name || data.fullName || '',
      email: normalizedEmail,
      avatar: data.avatar || data.image || null,
      role: data.role || data.title || null,
    });
  } catch (error: unknown) {
    const isAbortError = error instanceof Error && error.name === 'AbortError';
    const status = isAbortError ? 504 : 503;
    const code = isAbortError ? 'ETIMEOUT' : 'ELOOKUP';
    backendBackoffUntil = Date.now() + BACKOFF_MS;
    const shouldLog = !isAbortError || Date.now() - lastTimeoutLogAt > TIMEOUT_LOG_THROTTLE_MS;
    if (shouldLog) {
      lastTimeoutLogAt = Date.now();
      console.error('User lookup proxy error', {
        code,
        message: error instanceof Error ? error.message : String(error),
      });
    }
    return NextResponse.json({ error: 'Lookup unavailable', code }, { status });
  } finally {
    clearTimeout(timeout);
  }
}
