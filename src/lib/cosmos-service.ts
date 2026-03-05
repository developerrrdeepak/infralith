import { CosmosClient } from "@azure/cosmos";
import { ClientSecretCredential, DefaultAzureCredential } from "@azure/identity";
import { GeometricReconstruction } from "@/ai/flows/infralith/reconstruction-types";

const DATABASE_ID = process.env.AZURE_COSMOS_DATABASE_ID || "InfralithDB";
const CONTAINER_ID = process.env.AZURE_COSMOS_CONTAINER_ID || "BIMModels";
const PLACEHOLDER_MARKERS = [
    "replace_with_real_key",
    "replace_with_key",
    "your_key_here",
    "<key>",
    "changeme",
];

let client: CosmosClient | null = null;
let cosmosConfigCache: CosmosConfig | null = null;

export interface BIMDocument {
    id: string; // The partition key, usually blueprint/project ID
    userId: string;
    modelName: string;
    data: GeometricReconstruction;
    createdAt: string;
    updatedAt: string;
}

function hasLocalHost(value: string | undefined): boolean {
    if (!value) return false;
    const normalized = value.toLowerCase();
    return normalized.includes("localhost") || normalized.includes("127.0.0.1");
}

function hasPlaceholderValue(value: string | undefined): boolean {
    if (!value) return false;
    const normalized = value.toLowerCase();
    return PLACEHOLDER_MARKERS.some((marker) => normalized.includes(marker));
}

type CosmosConfig =
    | { mode: "connectionString"; connectionString: string }
    | { mode: "endpointKey"; endpoint: string; key: string }
    | { mode: "endpointAad"; endpoint: string; authMode: "clientSecret" | "defaultCredential" };

function isMongoConnectionString(value: string): boolean {
    return value.trim().toLowerCase().startsWith("mongodb://");
}

function isTenantAlias(value: string): boolean {
    return ["common", "organizations", "consumers", "{tenantid}"].includes(value.trim().toLowerCase());
}

function toBool(value: string | undefined): boolean {
    const normalized = String(value || "").trim().toLowerCase();
    return normalized === "1" || normalized === "true" || normalized === "yes";
}

function resolveCosmosConfig(): CosmosConfig {
    const connectionString = process.env.AZURE_COSMOS_CONNECTION_STRING?.trim();
    const endpoint = process.env.COSMOS_ENDPOINT?.trim();
    const key = process.env.COSMOS_KEY?.trim();
    const tenantId = (process.env.AZURE_TENANT_ID || process.env.AZURE_AD_TENANT_ID || "").trim();
    const clientId = (process.env.AZURE_CLIENT_ID || process.env.AZURE_AD_CLIENT_ID || "").trim();
    const clientSecret = (process.env.AZURE_CLIENT_SECRET || process.env.AZURE_AD_CLIENT_SECRET || "").trim();
    const useAad = toBool(process.env.AZURE_COSMOS_USE_AAD);

    if (connectionString) {
        if (isMongoConnectionString(connectionString)) {
            throw new Error(
                "AZURE_COSMOS_CONNECTION_STRING is a MongoDB URI. This service requires Cosmos SQL API config. Use COSMOS_ENDPOINT + COSMOS_KEY, or COSMOS_ENDPOINT + AZURE_CLIENT_ID/AZURE_CLIENT_SECRET/AZURE_TENANT_ID."
            );
        }
        return { mode: "connectionString", connectionString };
    }

    if (endpoint && key) {
        return { mode: "endpointKey", endpoint, key };
    }

    if (endpoint && tenantId && clientId && clientSecret) {
        if (isTenantAlias(tenantId)) {
            throw new Error(
                'AAD client-secret auth needs a concrete tenant GUID/domain. "common/organizations/consumers" are not valid for Cosmos service-principal auth.'
            );
        }
        return { mode: "endpointAad", endpoint, authMode: "clientSecret" };
    }

    if (endpoint && useAad) {
        return { mode: "endpointAad", endpoint, authMode: "defaultCredential" };
    }

    throw new Error(
        "Cloud Cosmos DB is not configured. Use AZURE_COSMOS_CONNECTION_STRING (SQL API), COSMOS_ENDPOINT + COSMOS_KEY, or COSMOS_ENDPOINT + AAD credentials."
    );
}

function assertCloudCosmosConfig(config: CosmosConfig): void {
    if (config.mode === "connectionString") {
        if (hasLocalHost(config.connectionString)) {
            throw new Error("Cloud Cosmos DB required: AZURE_COSMOS_CONNECTION_STRING points to localhost.");
        }
        if (hasPlaceholderValue(config.connectionString)) {
            throw new Error(
                "Cloud Cosmos DB required: AZURE_COSMOS_CONNECTION_STRING uses a placeholder key. Replace it with a real Cosmos key."
            );
        }
        return;
    }

    if (hasLocalHost(config.endpoint)) {
        throw new Error("Cloud Cosmos DB required: COSMOS_ENDPOINT points to localhost.");
    }
    if (config.mode === "endpointKey" && hasPlaceholderValue(config.key)) {
        throw new Error("Cloud Cosmos DB required: COSMOS_KEY uses a placeholder value.");
    }
}

function getValidatedCosmosConfig(): CosmosConfig {
    if (cosmosConfigCache) return cosmosConfigCache;
    const config = resolveCosmosConfig();
    assertCloudCosmosConfig(config);
    cosmosConfigCache = config;
    return config;
}

function getCosmosClient(): CosmosClient {
    if (client) return client;
    const cosmosConfig = getValidatedCosmosConfig();

    if (cosmosConfig.mode === "connectionString") {
        client = new CosmosClient(cosmosConfig.connectionString);
        return client;
    }

    if (cosmosConfig.mode === "endpointKey") {
        client = new CosmosClient({ endpoint: cosmosConfig.endpoint, key: cosmosConfig.key });
        return client;
    }

    const aadCredentials =
        cosmosConfig.authMode === "clientSecret"
            ? new ClientSecretCredential(
                String(process.env.AZURE_TENANT_ID || process.env.AZURE_AD_TENANT_ID || ""),
                String(process.env.AZURE_CLIENT_ID || process.env.AZURE_AD_CLIENT_ID || ""),
                String(process.env.AZURE_CLIENT_SECRET || process.env.AZURE_AD_CLIENT_SECRET || "")
            )
            : new DefaultAzureCredential();

    client = new CosmosClient({
        endpoint: cosmosConfig.endpoint,
        aadCredentials,
    });
    return client;
}

function isNotFoundError(error: unknown): boolean {
    if (!error || typeof error !== "object") return false;
    const maybeCode = (error as { code?: number | string }).code;
    const maybeStatus = (error as { statusCode?: number }).statusCode;
    return maybeCode === 404 || maybeCode === "404" || maybeStatus === 404;
}

/**
 * Ensures the Cosmos DB Database and Container exist.
 */
async function ensureContainer() {
    const cosmosClient = getCosmosClient();
    try {
        const { database } = await cosmosClient.databases.createIfNotExists({ id: DATABASE_ID });
        const { container } = await database.containers.createIfNotExists({
            id: CONTAINER_ID,
            partitionKey: { paths: ["/id"] }
        });
        return container;
    } catch (e: unknown) {
        const details = e instanceof Error ? e.message : String(e);
        throw new Error(`Cosmos DB connection failed: ${details}`);
    }
}

/**
 * Saves or updates a BIM Model in Cosmos DB.
 */
export async function saveBIMModel(doc: BIMDocument): Promise<BIMDocument> {
    const container = await ensureContainer();
    const { resource } = await container.items.upsert(doc);
    return resource as unknown as BIMDocument;
}

/**
 * Retrieves a specific BIM Model by its ID.
 */
export async function getBIMModel(id: string): Promise<BIMDocument | null> {
    const container = await ensureContainer();
    try {
        const { resource } = await container.item(id, id).read<BIMDocument>();
        return resource || null;
    } catch (error: unknown) {
        if (isNotFoundError(error)) return null;
        throw error;
    }
}

/**
 * Lists all BIM Models for a specific user.
 */
export async function listUserBIMModels(userId: string): Promise<Pick<BIMDocument, 'id' | 'modelName' | 'createdAt' | 'updatedAt'>[]> {
    const container = await ensureContainer();
    const querySpec = {
        query: "SELECT c.id, c.modelName, c.createdAt, c.updatedAt FROM c WHERE c.userId = @userId ORDER BY c.updatedAt DESC",
        parameters: [
            {
                name: "@userId",
                value: userId
            }
        ]
    };
    const { resources } = await container.items.query(querySpec).fetchAll();
    return resources;
}
