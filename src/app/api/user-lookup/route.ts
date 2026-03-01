import { NextRequest, NextResponse } from 'next/server';

const normalizeEmail = (email: string) => (email || '').trim().toLowerCase();

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 10;
const rateStore = new Map<string, { count: number; windowStart: number }>();

const backendUrl = process.env.USER_LOOKUP_URL; // server-side only
const FETCH_TIMEOUT_MS = Number(process.env.USER_LOOKUP_TIMEOUT_MS || 5000);

async function rateLimit(ip: string): Promise<boolean> {
  const now = Date.now();
  const bucket = rateStore.get(ip);
  if (!bucket || now - bucket.windowStart > RATE_LIMIT_WINDOW_MS) {
    rateStore.set(ip, { count: 1, windowStart: now });
    return true;
  }
  if (bucket.count >= RATE_LIMIT_MAX) return false;
  bucket.count += 1;
  return true;
}

export async function GET(req: NextRequest) {
  const ip =
    (req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()) ||
    req.headers.get('x-real-ip') ||
    'unknown';
  if (!(await rateLimit(ip))) {
    return NextResponse.json({ error: 'Too many requests' }, { status: 429 });
  }

  const emailParam = req.nextUrl.searchParams.get('email') || '';
  const email = normalizeEmail(emailParam);
  if (!email || !email.includes('@')) {
    return NextResponse.json({ error: 'Invalid email' }, { status: 400 });
  }

  if (!backendUrl) {
    return NextResponse.json({ error: 'Lookup unavailable' }, { status: 503 });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(`${backendUrl}?email=${encodeURIComponent(email)}`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
      cache: 'no-store',
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (res.status === 404) {
      return NextResponse.json(null, { status: 200 });
    }
    if (!res.ok) {
      return NextResponse.json({ error: 'Lookup failed' }, { status: 502 });
    }

    const data = await res.json();
    const normalizedEmail = normalizeEmail(data.email || email);

    return NextResponse.json({
      uid: data.uid || data.id,
      name: data.name || data.fullName || '',
      email: normalizedEmail,
      avatar: data.avatar || data.image || null,
      role: data.role || data.title,
    });
  } catch (error: any) {
    clearTimeout(timeout);
    const code = error?.code || (error?.name === 'AbortError' ? 'ETIMEOUT' : 'EUNKNOWN');
    console.error('User lookup proxy error', { code, message: String(error) });

    // Surface a service-unavailable response so callers can gracefully fallback
    const status = code === 'ETIMEOUT' ? 504 : 503;
    return NextResponse.json({ error: 'Lookup unavailable', code }, { status });
  }
}
