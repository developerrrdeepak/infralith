'use server';

import { generateAzureObject } from '@/ai/azure-ai';
import { z } from 'zod';
import { formatRagPromptContext, retrieveConstructionContext } from './rag-retrieval';

const synthSchema = z.object({
    answer: z.string().optional(),
    results: z.array(
        z.object({
            citationId: z.string(),
            title: z.string().optional(),
            summary: z.string().optional(),
            semanticMatchPercentage: z.union([z.number(), z.string()]).optional(),
            relevanceReason: z.string().optional(),
        })
    ).optional(),
});

const normalizeOptionalPct = (value: unknown): number | undefined => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return undefined;
    if (parsed <= 1) return Math.max(0, Math.min(100, Math.round(parsed * 100)));
    return Math.max(0, Math.min(100, Math.round(parsed)));
};

const isIsoDate = (value: unknown): boolean => {
    if (typeof value !== 'string' || !value.trim()) return false;
    return Number.isFinite(Date.parse(value));
};

/**
 * Real RAG search powered by Azure AI Search retrieval + LLM synthesis with citations.
 */
export async function searchCosmosDB(query: string) {
    try {
        const retrieved = await retrieveConstructionContext(query, { top: 8 });
        if (!retrieved.chunks.length) {
            console.warn('[Search Agent] no chunks retrieved', retrieved.diagnostics);
            return [];
        }

        const promptContext = await formatRagPromptContext(retrieved, 7600);
        const prompt = `
You are a construction-domain RAG synthesis agent.
Answer the query only using retrieved context and cite chunk ids.

QUERY:
${query}

RETRIEVED CONTEXT:
${promptContext}

Instructions:
- Keep each result grounded in one citationId from retrieved context.
- semanticMatchPercentage should be 0-100.
- Do not invent titles, dates, or sources not present in retrieved context.

Return strict JSON with:
{
  "answer": "optional concise overall answer",
  "results": [
    {
      "citationId": "R1",
      "title": "optional title",
      "summary": "grounded summary",
      "semanticMatchPercentage": 0-100,
      "relevanceReason": "why this is relevant"
    }
  ]
}
`;

        const synthesized = await generateAzureObject<z.infer<typeof synthSchema>>(prompt, synthSchema);
        const chunkByCitation = new Map(retrieved.chunks.map((chunk) => [chunk.citationId, chunk] as const));

        const stitched = (synthesized.results || [])
            .map((item) => {
                const chunk = chunkByCitation.get(item.citationId);
                if (!chunk) return null;
                const createdAt = isIsoDate(chunk.createdAt) ? chunk.createdAt : undefined;
                const semanticMatch =
                    normalizeOptionalPct(item.semanticMatchPercentage) ??
                    normalizeOptionalPct(chunk.rerankerScore ?? chunk.score ?? undefined);
                return {
                    id: chunk.chunkId,
                    title: item.title || chunk.title,
                    summary: item.summary || chunk.summary,
                    collection: chunk.collection || chunk.indexName,
                    createdAt,
                    source: chunk.source,
                    citationId: chunk.citationId,
                    semanticMatchPercentage: semanticMatch,
                    relevanceReason: item.relevanceReason || '',
                    score: chunk.rerankerScore ?? chunk.score ?? undefined,
                };
            })
            .filter((item): item is NonNullable<typeof item> => !!item);

        if (stitched.length > 0) return stitched;

        return retrieved.chunks.map((chunk, index) => ({
            id: chunk.chunkId,
            title: chunk.title,
            summary: chunk.summary,
            collection: chunk.collection || chunk.indexName,
            createdAt: isIsoDate(chunk.createdAt) ? chunk.createdAt : undefined,
            source: chunk.source,
            citationId: chunk.citationId,
            semanticMatchPercentage: normalizeOptionalPct(chunk.rerankerScore ?? chunk.score ?? undefined),
            relevanceReason: 'Retrieved via Azure AI Search hybrid ranking.',
            score: chunk.rerankerScore ?? chunk.score ?? undefined,
        }));
    } catch (error) {
        console.error('[Search Agent] RAG search failed:', error);
        return [];
    }
}
