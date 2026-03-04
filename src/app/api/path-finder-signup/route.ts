import { NextResponse } from 'next/server';

const ROLE_KEYWORDS: Record<string, string[]> = {
  'Structural Engineer': ['structural', 'seismic', 'reinforcement', 'mathematics', 'science', 'analytical'],
  'Project Manager': ['leadership', 'communication', 'planning', 'impact', 'stability', 'business'],
  'Civil Engineer': ['civil', 'infrastructure', 'construction', 'materials', 'site', 'design'],
  'DevOps Engineer': ['technology', 'automation', 'problem-solving', 'systems', 'cloud', 'pipeline'],
};

const DEFAULT_ROLES = ['Structural Engineer', 'Civil Engineer', 'Project Manager'];
const MAX_INPUT_CHARS = 12_000;

function normalizeText(input: unknown): string {
  if (Array.isArray(input)) {
    return input.map((item) => normalizeText(item)).join(' ');
  }
  if (typeof input === 'object' && input !== null) {
    return Object.values(input as Record<string, unknown>)
      .map((item) => normalizeText(item))
      .join(' ');
  }
  const value = String(input || '').toLowerCase();
  return value.length > MAX_INPUT_CHARS ? value.slice(0, MAX_INPUT_CHARS) : value;
}

export async function POST(req: Request) {
  let body: unknown = null;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ roles: DEFAULT_ROLES }, { status: 200 });
  }

  const candidate = (body && typeof body === 'object' && 'answers' in body)
    ? (body as { answers?: unknown }).answers
    : body;

  const haystack = normalizeText(candidate);
  if (!haystack) {
    return NextResponse.json({ roles: DEFAULT_ROLES }, { status: 200 });
  }

  const scored = Object.entries(ROLE_KEYWORDS)
    .map(([role, keywords]) => ({
      role,
      score: keywords.reduce((score, keyword) => score + (haystack.includes(keyword) ? 1 : 0), 0),
    }))
    .sort((a, b) => b.score - a.score);

  const roles = scored
    .filter((entry) => entry.score > 0)
    .map((entry) => entry.role)
    .slice(0, 3);

  return NextResponse.json({ roles: roles.length > 0 ? roles : DEFAULT_ROLES }, { status: 200 });
}
