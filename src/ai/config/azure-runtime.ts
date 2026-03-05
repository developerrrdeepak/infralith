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
});
