import { CosmosClient, ItemDefinition, SqlQuerySpec } from '@azure/cosmos';
import { ClientSecretCredential, DefaultAzureCredential } from '@azure/identity';

const DATABASE_ID = process.env.AZURE_COSMOS_DATABASE_ID || 'InfralithDB';
const CONTAINER_ID = process.env.AZURE_COSMOS_COLLAB_CONTAINER_ID || 'CollabState';

let cosmosClient: CosmosClient | null = null;
type ConnectionConfig =
  | { kind: 'connection_string'; connectionString: string }
  | { kind: 'endpoint_key'; endpoint: string; key: string }
  | { kind: 'endpoint_aad'; endpoint: string; authMode: 'client_secret' | 'default_credential' };

const isMongoConnectionString = (value: string) => value.trim().toLowerCase().startsWith('mongodb://');
const isTenantAlias = (value: string) =>
  ['common', 'organizations', 'consumers', '{tenantid}'].includes(value.trim().toLowerCase());

const toBool = (value: string | undefined) => {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes';
};

const getConnectionConfig = (): ConnectionConfig | null => {
  const connectionString = process.env.AZURE_COSMOS_CONNECTION_STRING?.trim();
  const endpoint = process.env.COSMOS_ENDPOINT?.trim();
  const key = process.env.COSMOS_KEY?.trim();
  const tenantId = (process.env.AZURE_TENANT_ID || process.env.AZURE_AD_TENANT_ID || '').trim();
  const clientId = (process.env.AZURE_CLIENT_ID || process.env.AZURE_AD_CLIENT_ID || '').trim();
  const clientSecret = (process.env.AZURE_CLIENT_SECRET || process.env.AZURE_AD_CLIENT_SECRET || '').trim();
  const useAad = toBool(process.env.AZURE_COSMOS_USE_AAD);

  if (connectionString) {
    if (isMongoConnectionString(connectionString)) {
      throw new Error(
        'AZURE_COSMOS_CONNECTION_STRING is a MongoDB URI. This app needs Azure Cosmos SQL API config. Use COSMOS_ENDPOINT + COSMOS_KEY, or COSMOS_ENDPOINT + AZURE_CLIENT_ID/AZURE_CLIENT_SECRET/AZURE_TENANT_ID.'
      );
    }
    return { kind: 'connection_string', connectionString };
  }

  if (endpoint && key) {
    return { kind: 'endpoint_key', endpoint, key };
  }

  if (endpoint && tenantId && clientId && clientSecret) {
    if (isTenantAlias(tenantId)) {
      throw new Error(
        'AAD client-secret auth needs a concrete tenant GUID/domain. "common/organizations/consumers" are not valid for Cosmos service-principal auth.'
      );
    }
    return {
      kind: 'endpoint_aad',
      endpoint,
      authMode: 'client_secret',
    };
  }

  if (endpoint && useAad) {
    return {
      kind: 'endpoint_aad',
      endpoint,
      authMode: 'default_credential',
    };
  }

  return null;
};

const getClient = () => {
  if (cosmosClient) return cosmosClient;
  const config = getConnectionConfig();
  if (!config) {
    throw new Error(
      'Cosmos collab store is not configured. Use one: AZURE_COSMOS_CONNECTION_STRING (SQL API), COSMOS_ENDPOINT + COSMOS_KEY, or COSMOS_ENDPOINT + AAD credentials.'
    );
  }

  if (config.kind === 'connection_string') {
    cosmosClient = new CosmosClient(config.connectionString);
    return cosmosClient;
  }

  if (config.kind === 'endpoint_key') {
    cosmosClient = new CosmosClient({ endpoint: config.endpoint, key: config.key });
    return cosmosClient;
  }

  const aadCredentials =
    config.authMode === 'client_secret'
      ? new ClientSecretCredential(
          String(process.env.AZURE_TENANT_ID || process.env.AZURE_AD_TENANT_ID || ''),
          String(process.env.AZURE_CLIENT_ID || process.env.AZURE_AD_CLIENT_ID || ''),
          String(process.env.AZURE_CLIENT_SECRET || process.env.AZURE_AD_CLIENT_SECRET || '')
        )
      : new DefaultAzureCredential();

  cosmosClient = new CosmosClient({
    endpoint: config.endpoint,
    aadCredentials,
  });
  return cosmosClient;
};

export const isCollabStoreConfigured = () => {
  try {
    return !!getConnectionConfig();
  } catch {
    return false;
  }
};

const ensureCollabContainer = async () => {
  const client = getClient();
  const { database } = await client.databases.createIfNotExists({ id: DATABASE_ID });
  const { container } = await database.containers.createIfNotExists({
    id: CONTAINER_ID,
    partitionKey: { paths: ['/pk'] },
  });
  return container;
};

export type CollabDocBase = {
  id: string;
  pk: string;
  type: string;
  createdAt?: string;
  updatedAt?: string;
};

export async function upsertCollabDoc<T extends CollabDocBase>(doc: T): Promise<T> {
  const container = await ensureCollabContainer();
  const { resource } = await container.items.upsert(doc);
  return (resource as unknown as T) || doc;
}

export async function readCollabDoc<T extends ItemDefinition>(id: string, pk: string): Promise<T | null> {
  const container = await ensureCollabContainer();
  try {
    const { resource } = await container.item(id, pk).read<T>();
    return resource || null;
  } catch (error: any) {
    if (error?.code === 404 || error?.statusCode === 404) return null;
    throw error;
  }
}

export async function deleteCollabDoc(id: string, pk: string): Promise<void> {
  const container = await ensureCollabContainer();
  try {
    await container.item(id, pk).delete();
  } catch (error: any) {
    if (error?.code === 404 || error?.statusCode === 404) return;
    throw error;
  }
}

export async function queryCollabDocs<T extends ItemDefinition>(
  querySpec: SqlQuerySpec,
  options?: { partitionKey?: string; maxItemCount?: number }
): Promise<T[]> {
  const container = await ensureCollabContainer();
  const { resources } = await container.items
    .query<T>(querySpec, {
      partitionKey: options?.partitionKey,
      maxItemCount: options?.maxItemCount,
    })
    .fetchAll();
  return resources || [];
}
