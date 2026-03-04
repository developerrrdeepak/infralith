import { z } from 'zod';
import { NextResponse } from 'next/server';

const NEWS_TIMEOUT_MS = 10_000;
const NEWS_REVALIDATE_SECONDS = 15 * 60;
const DEFAULT_IMAGE_URL = 'https://picsum.photos/400/250';

const articleSchema = z.object({
  title: z.string().trim().min(1).max(320),
  description: z.string().trim().max(2_000).nullable().optional(),
  url: z.string().url(),
  image: z.string().url().nullable().optional(),
});

const gnewsResponseSchema = z.object({
  articles: z.array(articleSchema),
});

type NewsArticle = z.infer<typeof articleSchema>;

const getHintToken = (title: string) => {
  const token = title.split(/\s+/).find(Boolean)?.toLowerCase() || 'news';
  return token.replace(/[^a-z0-9_-]/g, '') || 'news';
};

const mapArticle = (article: NewsArticle) => ({
  title: article.title,
  description: article.description || '',
  url: article.url,
  imageUrl: article.image || DEFAULT_IMAGE_URL,
  'data-ai-hint': getHintToken(article.title),
});

const readJsonSafe = async (response: Response) => {
  try {
    return await response.json();
  } catch {
    return null;
  }
};

export async function GET() {
  const apiKey = (process.env.GNEWS_API_KEY || '').trim();
  if (!apiKey) {
    return NextResponse.json({ error: 'News service not configured' }, { status: 503 });
  }

  const params = new URLSearchParams({
    q: '"career trends" OR "job market" OR "hiring" OR "employment"',
    lang: 'en',
    country: 'in',
    max: '15',
    token: apiKey,
  });

  const url = `https://gnews.io/api/v4/search?${params.toString()}`;
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), NEWS_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      signal: abortController.signal,
      next: { revalidate: NEWS_REVALIDATE_SECONDS },
    });

    if (!response.ok) {
      const details = await readJsonSafe(response);
      console.error('GNews API non-OK response', { status: response.status, details });
      return NextResponse.json({ error: 'Failed to fetch news' }, { status: 502 });
    }

    const payload = await readJsonSafe(response);
    const parsed = gnewsResponseSchema.safeParse(payload);
    if (!parsed.success) {
      console.error('GNews response validation failed', parsed.error.flatten());
      return NextResponse.json({ error: 'News provider returned invalid data' }, { status: 502 });
    }

    return NextResponse.json(parsed.data.articles.map(mapArticle));
  } catch (error) {
    const isTimeout = error instanceof Error && error.name === 'AbortError';
    if (isTimeout) {
      return NextResponse.json({ error: 'News request timed out' }, { status: 504 });
    }
    console.error('News API unexpected failure', error);
    return NextResponse.json({ error: 'An unexpected error occurred' }, { status: 500 });
  } finally {
    clearTimeout(timeout);
  }
}
