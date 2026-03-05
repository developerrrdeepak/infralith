# Azure AI Search RAG Setup (Infralith)

## What this enables
1. Real retrieval over indexed project/code documents (no simulated vectors).
2. Hybrid grounding for report generation (`compliance`, `risk`, `cost`) with citation IDs like `[R1]`.
3. Search UI results sourced from Azure AI Search chunks.

## Required environment variables
Set in `.env`:

```env
AZURE_AI_SEARCH_ENDPOINT=https://<service>.search.windows.net
AZURE_AI_SEARCH_API_KEY=<admin-or-query-key>
AZURE_AI_SEARCH_INDEX_NAME=<primary-index>
AZURE_AI_SEARCH_SECONDARY_INDEX_NAME=<optional-secondary-index>
AZURE_AI_SEARCH_API_VERSION=2024-07-01
AZURE_AI_SEARCH_SEMANTIC_CONFIG=default
AZURE_AI_SEARCH_TITLE_FIELD=title
AZURE_AI_SEARCH_CONTENT_FIELD=content
AZURE_AI_SEARCH_SUMMARY_FIELD=summary
AZURE_AI_SEARCH_SOURCE_FIELD=source
AZURE_AI_SEARCH_COLLECTION_FIELD=collection
AZURE_AI_SEARCH_CREATED_AT_FIELD=createdAt
AZURE_AI_SEARCH_VECTOR_FIELD=<optional-vector-field>
AZURE_OPENAI_EMBEDDING_DEPLOYMENT=<optional-embedding-deployment>
```

## Recommended index schema
Each searchable chunk should include:
1. `id` (key)
2. `title`
3. `content`
4. `summary` (optional)
5. `source` (document URL/path)
6. `collection` (project/codebook/source family)
7. `createdAt` (ISO timestamp)
8. `<vector field>` (if using vector retrieval)

## Retrieval strategy implemented
1. Semantic query attempt (captions + answers).
2. Fallback to simple query when semantic config is unavailable.
3. Optional vector query if vector field + embedding deployment are configured.
4. Merge, dedupe, and rank chunks before LLM synthesis.

## References
- Azure AI Search vector + integrated vectorization:
  https://learn.microsoft.com/en-us/azure/search/vector-search-integrated-vectorization
- Azure AI Search vector store/RAG concepts:
  https://learn.microsoft.com/en-us/azure/search/vector-store
- Agentic retrieval (Azure AI Search):
  https://learn.microsoft.com/en-us/azure/search/search-get-started-agentic-retrieval
- RAG:
  https://arxiv.org/abs/2005.11401
- Self-RAG:
  https://arxiv.org/abs/2310.11511
