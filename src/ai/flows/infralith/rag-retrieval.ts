'use server';

import { azureRuntime } from '@/ai/config/azure-runtime';

export interface RagChunk {
    citationId: string;
    chunkId: string;
    indexName: string;
    title: string;
    summary: string;
    content: string;
    source: string;
    collection: string;
    createdAt?: string;
    score?: number;
    rerankerScore?: number;
}

export interface RagDiagnostics {
    configured: boolean;
    usedVectorQuery: boolean;
    indexesQueried: string[];
    warning?: string;
    errors: string[];
}

export interface RagRetrievedContext {
    query: string;
    chunks: RagChunk[];
    citationMap: Record<string, RagChunk>;
    diagnostics: RagDiagnostics;
}

const DEFAULT_TOP = 8;
const EMBEDDING_TIMEOUT_MS = 12_000;
const SEARCH_TIMEOUT_MS = 14_000;

const commonStringFields = ['title', 'name', 'heading', 'summary', 'content', 'text', 'body', 'source', 'url', 'path', 'collection', 'createdAt'];
const commonIdFields = ['id', 'key', 'chunkId', 'chunk_id', 'documentId', 'document_id'];

const asString = (value: unknown): string => String(value ?? '').replace(/\s+/g, ' ').trim();

const coalesceString = (...values: unknown[]): string => {
    for (const value of values) {
        const normalized = asString(value);
        if (normalized) return normalized;
    }
    return '';
};

const trimForPrompt = (value: string, maxChars: number): string => {
    if (value.length <= maxChars) return value;
    return `${value.slice(0, Math.max(0, maxChars - 3))}...`;
};

const parseJsonSafe = async (response: Response) => {
    const text = await response.text();
    try {
        return JSON.parse(text);
    } catch {
        throw new Error(`Invalid JSON response from Azure AI Search (${response.status}): ${text.slice(0, 360)}`);
    }
};

const withTimeout = async <T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> => {
    let timeout: ReturnType<typeof setTimeout> | null = null;
    try {
        return await Promise.race([
            promise,
            new Promise<T>((_, reject) => {
                timeout = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
            }),
        ]);
    } finally {
        if (timeout) clearTimeout(timeout);
    }
};

const normalizeOpenAiEndpoint = (endpoint: string): string => {
    const trimmed = endpoint.trim().replace(/\/+$/, '');
    if (!trimmed) return '';
    if (trimmed.endsWith('/openai')) return trimmed;
    if (trimmed.endsWith('/openai/v1')) return trimmed.replace(/\/v1$/i, '');
    return `${trimmed}/openai`;
};

const getEmbeddingVector = async (query: string): Promise<number[] | null> => {
    if (!azureRuntime.openAIEndpoint || !azureRuntime.openAIKey || !azureRuntime.embeddingDeploymentName) {
        return null;
    }

    const base = normalizeOpenAiEndpoint(azureRuntime.openAIEndpoint);
    if (!base) return null;

    const apiVersion = azureRuntime.openAIApiVersion || '2024-08-01-preview';
    const url = `${base}/deployments/${encodeURIComponent(azureRuntime.embeddingDeploymentName)}/embeddings?api-version=${encodeURIComponent(apiVersion)}`;

    const response = await withTimeout(fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'api-key': azureRuntime.openAIKey,
        },
        body: JSON.stringify({ input: query }),
    }), EMBEDDING_TIMEOUT_MS, 'Embedding generation');

    if (!response.ok) {
        const body = await response.text();
        throw new Error(`Embedding request failed (${response.status}): ${body.slice(0, 240)}`);
    }

    const payload = await parseJsonSafe(response);
    const vector = Array.isArray(payload?.data) && payload.data.length > 0 ? payload.data[0]?.embedding : null;
    return Array.isArray(vector) ? vector.map((v: unknown) => Number(v)).filter((n: number) => Number.isFinite(n)) : null;
};

type SearchRequestOptions = {
    indexName: string;
    query: string;
    top: number;
    embeddingVector?: number[] | null;
};

const extractCaptionText = (doc: Record<string, unknown>): string => {
    const captions = (doc as any)['@search.captions'];
    if (!Array.isArray(captions) || captions.length === 0) return '';
    const text = captions
        .map((entry: any) => asString(entry?.text || entry?.highlights))
        .filter(Boolean)
        .join(' ');
    return asString(text);
};

const extractBestField = (doc: Record<string, unknown>, preferredField: string, fallbacks: string[]): string => {
    const preferred = preferredField ? asString(doc[preferredField]) : '';
    if (preferred) return preferred;
    for (const field of fallbacks) {
        const value = asString(doc[field]);
        if (value) return value;
    }
    for (const key of Object.keys(doc)) {
        if (!commonStringFields.includes(key)) continue;
        const value = asString(doc[key]);
        if (value) return value;
    }
    return '';
};

const mapSearchDocumentToChunk = (doc: Record<string, unknown>, indexName: string, position: number): Omit<RagChunk, 'citationId'> => {
    const id = coalesceString(...commonIdFields.map((field) => doc[field]), `${indexName}-${position + 1}`);
    const title = extractBestField(doc, azureRuntime.aiSearchTitleField, ['title', 'name', 'heading']);
    const summaryRaw = extractBestField(doc, azureRuntime.aiSearchSummaryField, ['summary', 'abstract', 'snippet']);
    const contentRaw = extractBestField(doc, azureRuntime.aiSearchContentField, ['content', 'text', 'body', 'chunk']);
    const caption = extractCaptionText(doc);

    const content = coalesceString(contentRaw, summaryRaw, caption);
    const summary = coalesceString(summaryRaw, caption, trimForPrompt(content, 360));
    const source = extractBestField(doc, azureRuntime.aiSearchSourceField, ['source', 'url', 'path', 'documentUrl', 'fileName']) || `index:${indexName}`;
    const collection = extractBestField(doc, azureRuntime.aiSearchCollectionField, ['collection', 'category', 'project']) || indexName;
    const createdAt = extractBestField(doc, azureRuntime.aiSearchCreatedAtField, ['createdAt', 'timestamp', 'updatedAt']) || undefined;
    const scoreCandidate = Number((doc as any)['@search.score']);
    const rerankerCandidate = Number((doc as any)['@search.rerankerScore']);

    return {
        chunkId: `${indexName}:${id}`,
        indexName,
        title: title || `Document ${position + 1}`,
        summary: trimForPrompt(summary || content, 420),
        content: trimForPrompt(content, 1800),
        source,
        collection,
        createdAt,
        score: Number.isFinite(scoreCandidate) ? scoreCandidate : undefined,
        rerankerScore: Number.isFinite(rerankerCandidate) ? rerankerCandidate : undefined,
    };
};

const searchIndex = async ({ indexName, query, top, embeddingVector }: SearchRequestOptions): Promise<Omit<RagChunk, 'citationId'>[]> => {
    if (!azureRuntime.aiSearchEndpoint || !azureRuntime.aiSearchKey) return [];

    const endpoint = azureRuntime.aiSearchEndpoint.replace(/\/+$/, '');
    const url = `${endpoint}/indexes/${encodeURIComponent(indexName)}/docs/search?api-version=${encodeURIComponent(azureRuntime.aiSearchApiVersion)}`;
    const commonPayload: Record<string, unknown> = {
        search: query,
        top,
    };

    if (Array.isArray(embeddingVector) && embeddingVector.length > 0 && azureRuntime.aiSearchVectorField) {
        commonPayload.vectorQueries = [
            {
                kind: 'vector',
                vector: embeddingVector,
                fields: azureRuntime.aiSearchVectorField,
                kNearestNeighborsCount: Math.max(top, 8),
            },
        ];
    }

    const headers = {
        'Content-Type': 'application/json',
        'api-key': azureRuntime.aiSearchKey,
    };

    const semanticPayload = {
        ...commonPayload,
        queryType: 'semantic',
        semanticConfiguration: azureRuntime.aiSearchSemanticConfig || undefined,
        queryLanguage: 'en-us',
        captions: 'extractive|highlight-false',
        answers: 'extractive|count-3',
    };

    const semanticResponse = await withTimeout(fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(semanticPayload),
    }), SEARCH_TIMEOUT_MS, `Search semantic ${indexName}`);

    let payload: any;
    if (semanticResponse.ok) {
        payload = await parseJsonSafe(semanticResponse);
    } else {
        const fallbackResponse = await withTimeout(fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(commonPayload),
        }), SEARCH_TIMEOUT_MS, `Search fallback ${indexName}`);
        if (!fallbackResponse.ok) {
            const fallbackBody = await fallbackResponse.text();
            throw new Error(`Azure AI Search failed for index "${indexName}" (${fallbackResponse.status}): ${fallbackBody.slice(0, 300)}`);
        }
        payload = await parseJsonSafe(fallbackResponse);
    }

    const docs = Array.isArray(payload?.value) ? payload.value : [];
    return docs.map((doc: Record<string, unknown>, idx: number) => mapSearchDocumentToChunk(doc, indexName, idx));
};

const mergeAndRankChunks = (chunks: Omit<RagChunk, 'citationId'>[], limit: number): RagChunk[] => {
    const dedup = new Map<string, Omit<RagChunk, 'citationId'>>();
    for (const chunk of chunks) {
        const key = `${chunk.chunkId}|${chunk.source}|${chunk.content}`;
        if (!dedup.has(key)) dedup.set(key, chunk);
    }
    const ranked = [...dedup.values()].sort((a, b) => {
        const aRank = Number.isFinite(a.rerankerScore || NaN) ? (a.rerankerScore as number) : (a.score || 0);
        const bRank = Number.isFinite(b.rerankerScore || NaN) ? (b.rerankerScore as number) : (b.score || 0);
        return bRank - aRank;
    }).slice(0, Math.max(1, limit));

    return ranked.map((chunk, idx) => ({
        ...chunk,
        citationId: `R${idx + 1}`,
    }));
};

export const formatRagPromptContext = (
    context: RagRetrievedContext,
    maxChars = 7_500
): string => {
    if (!Array.isArray(context?.chunks) || context.chunks.length === 0) {
        return 'No retrieved external context was available.';
    }

    const lines: string[] = [];
    let chars = 0;

    for (const chunk of context.chunks) {
        const block = [
            `[${chunk.citationId}] title=${chunk.title}`,
            `source=${chunk.source}`,
            `collection=${chunk.collection}`,
            `summary=${chunk.summary}`,
            `content=${chunk.content}`,
        ].join('\n');
        const nextSize = chars + block.length + 2;
        if (nextSize > maxChars) break;
        lines.push(block);
        chars = nextSize;
    }

    return lines.join('\n\n');
};

export const retrieveConstructionContext = async (
    query: string,
    options?: { top?: number }
): Promise<RagRetrievedContext> => {
    const cleanQuery = asString(query);
    const top = Math.max(1, Math.min(20, Number(options?.top ?? DEFAULT_TOP)));
    const indexes = Array.from(new Set([azureRuntime.aiSearchIndexName, azureRuntime.aiSearchSecondaryIndexName].filter(Boolean)));
    const configured = !!azureRuntime.aiSearchEndpoint && !!azureRuntime.aiSearchKey && indexes.length > 0;

    const diagnostics: RagDiagnostics = {
        configured,
        usedVectorQuery: false,
        indexesQueried: indexes,
        errors: [],
    };

    if (!configured || !cleanQuery) {
        return {
            query: cleanQuery,
            chunks: [],
            citationMap: {},
            diagnostics: {
                ...diagnostics,
                warning: !cleanQuery
                    ? 'Query is empty.'
                    : 'Azure AI Search is not configured. Set endpoint/key/index env vars.',
            },
        };
    }

    let embeddingVector: number[] | null = null;
    if (azureRuntime.aiSearchVectorField) {
        try {
            embeddingVector = await getEmbeddingVector(cleanQuery);
            diagnostics.usedVectorQuery = Array.isArray(embeddingVector) && embeddingVector.length > 0;
        } catch (error) {
            diagnostics.errors.push(`Embedding unavailable: ${asString((error as any)?.message || error)}`);
        }
    }

    const rawChunks: Omit<RagChunk, 'citationId'>[] = [];
    await Promise.all(indexes.map(async (indexName) => {
        try {
            const chunks = await searchIndex({ indexName, query: cleanQuery, top, embeddingVector });
            rawChunks.push(...chunks);
        } catch (error) {
            diagnostics.errors.push(asString((error as any)?.message || error));
        }
    }));

    const chunks = mergeAndRankChunks(rawChunks, top);
    const citationMap: Record<string, RagChunk> = {};
    for (const chunk of chunks) citationMap[chunk.citationId] = chunk;

    if (chunks.length === 0 && diagnostics.errors.length === 0) {
        diagnostics.warning = 'No relevant chunks were retrieved from configured indexes.';
    }

    return {
        query: cleanQuery,
        chunks,
        citationMap,
        diagnostics,
    };
};
