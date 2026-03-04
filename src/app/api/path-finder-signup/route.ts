import { NextResponse } from 'next/server';

const ROLE_KEYWORDS: Record<string, string[]> = {
  'Structural Engineer': ['structural', 'seismic', 'reinforcement', 'mathematics', 'science', 'analytical'],
  'Project Manager': ['leadership', 'communication', 'planning', 'impact', 'stability', 'business'],
  'Civil Engineer': ['civil', 'infrastructure', 'construction', 'materials', 'site', 'design'],
  'DevOps Engineer': ['technology', 'automation', 'problem-solving', 'systems', 'cloud', 'pipeline'],
};

function normalizeText(input: unknown): string {
  if (Array.isArray(input)) {
    return input.map((item) => normalizeText(item)).join(' ');
  }
  if (typeof input === 'object' && input !== null) {
    return Object.values(input).map((item) => normalizeText(item)).join(' ');
  }
  return String(input || '').toLowerCase();
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const answers = body?.answers ?? body ?? {};
    const haystack = normalizeText(answers);

    const rankedRoles = Object.entries(ROLE_KEYWORDS)
      .map(([role, keywords]) => ({
        role,
        score: keywords.reduce((score, keyword) => score + (haystack.includes(keyword) ? 1 : 0), 0),
      }))
      .sort((a, b) => b.score - a.score)
      .map((item) => item.role);

    const fallback = ['Structural Engineer', 'Civil Engineer', 'Project Manager'];
    const roles = rankedRoles.slice(0, 3);

    return NextResponse.json({ roles: roles.length > 0 ? roles : fallback });
  } catch (error) {
    return NextResponse.json(
      { roles: ['Structural Engineer', 'Civil Engineer', 'Project Manager'] },
      { status: 200 }
    );
  }
}
