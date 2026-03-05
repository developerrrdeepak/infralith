type NullableString = string | undefined | null;

const pickFirst = (values: NullableString[], fallback = ""): string => {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return fallback;
};

const toBoolean = (value: NullableString, fallback: boolean): boolean => {
  if (typeof value !== "string") return fallback;
  const normalized = value.trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  return fallback;
};

export const azureRuntime = {
  openAIKey: pickFirst([process.env.AZURE_OPENAI_KEY, process.env.AZURE_OPENAI_API_KEY]),
  openAIEndpoint: pickFirst([process.env.AZURE_OPENAI_ENDPOINT]),
  openAIApiVersion: pickFirst([process.env.AZURE_OPENAI_API_VERSION], "2024-08-01-preview"),
  resourceName: pickFirst([process.env.AZURE_OPENAI_RESOURCE_NAME]),
  routerDeploymentName: pickFirst(
    [process.env.AZURE_OPENAI_DEPLOYMENT_NAME, process.env.AZURE_OPENAI_DEPLOYMENT],
    "model-router"
  ),
  topDeploymentName: pickFirst(
    [process.env.AZURE_OPENAI_TOP_DEPLOYMENT, process.env.AZURE_OPENAI_TOP_MODEL_DEPLOYMENT],
    "gpt-5"
  ),
  preferTopModel: toBoolean(process.env.AZURE_OPENAI_PREFER_TOP_MODEL, true),
  docIntelEndpoint: pickFirst([
    process.env.AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT,
    process.env.AZURE_FORM_RECOGNIZER_ENDPOINT,
    process.env.DOCUMENT_INTELLIGENCE_ENDPOINT,
  ]),
  docIntelKey: pickFirst([
    process.env.AZURE_DOCUMENT_INTELLIGENCE_KEY,
    process.env.AZURE_FORM_RECOGNIZER_KEY,
    process.env.DOCUMENT_INTELLIGENCE_KEY,
  ]),
  aiSearchEndpoint: pickFirst([process.env.AZURE_AI_SEARCH_ENDPOINT, process.env.AZURE_SEARCH_ENDPOINT]),
  aiSearchKey: pickFirst([process.env.AZURE_AI_SEARCH_API_KEY, process.env.AZURE_SEARCH_API_KEY]),
  aiSearchApiVersion: pickFirst([process.env.AZURE_AI_SEARCH_API_VERSION], "2024-07-01"),
  aiSearchIndexName: pickFirst([process.env.AZURE_AI_SEARCH_INDEX_NAME, process.env.AZURE_SEARCH_INDEX_NAME]),
  aiSearchSecondaryIndexName: pickFirst([process.env.AZURE_AI_SEARCH_SECONDARY_INDEX_NAME]),
  aiSearchSemanticConfig: pickFirst([process.env.AZURE_AI_SEARCH_SEMANTIC_CONFIG], "default"),
  aiSearchTitleField: pickFirst([process.env.AZURE_AI_SEARCH_TITLE_FIELD], "title"),
  aiSearchContentField: pickFirst([process.env.AZURE_AI_SEARCH_CONTENT_FIELD], "content"),
  aiSearchSummaryField: pickFirst([process.env.AZURE_AI_SEARCH_SUMMARY_FIELD], "summary"),
  aiSearchSourceField: pickFirst([process.env.AZURE_AI_SEARCH_SOURCE_FIELD], "source"),
  aiSearchCollectionField: pickFirst([process.env.AZURE_AI_SEARCH_COLLECTION_FIELD], "collection"),
  aiSearchCreatedAtField: pickFirst([process.env.AZURE_AI_SEARCH_CREATED_AT_FIELD], "createdAt"),
  aiSearchVectorField: pickFirst([process.env.AZURE_AI_SEARCH_VECTOR_FIELD]),
  embeddingDeploymentName: pickFirst([
    process.env.AZURE_OPENAI_EMBEDDING_DEPLOYMENT,
    process.env.AZURE_OPENAI_EMBEDDINGS_DEPLOYMENT_NAME,
  ]),
};

export const getDeploymentOrder = (): string[] => {
  const ordered = azureRuntime.preferTopModel
    ? [azureRuntime.topDeploymentName, azureRuntime.routerDeploymentName]
    : [azureRuntime.routerDeploymentName];

  return Array.from(new Set(ordered.filter(Boolean)));
};

export const getSanitizedAiRuntimeSummary = () => ({
  openAIConfigured: !!azureRuntime.openAIKey,
  endpointConfigured: !!azureRuntime.openAIEndpoint,
  apiVersion: azureRuntime.openAIApiVersion,
  deploymentRouter: azureRuntime.routerDeploymentName,
  deploymentTop: azureRuntime.topDeploymentName,
  preferTopModel: azureRuntime.preferTopModel,
  docIntelConfigured: !!azureRuntime.docIntelEndpoint && !!azureRuntime.docIntelKey,
  aiSearchConfigured: !!azureRuntime.aiSearchEndpoint && !!azureRuntime.aiSearchKey && !!azureRuntime.aiSearchIndexName,
  aiSearchIndex: azureRuntime.aiSearchIndexName || null,
  aiSearchSecondaryIndex: azureRuntime.aiSearchSecondaryIndexName || null,
  embeddingDeployment: azureRuntime.embeddingDeploymentName || null,
});
