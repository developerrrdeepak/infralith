import { CosmosClient } from "@azure/cosmos";

const connectionString = process.env.AZURE_COSMOS_CONNECTION_STRING;
const databaseId = process.env.AZURE_COSMOS_DATABASE_ID || "infralith";
const containerId = process.env.AZURE_COSMOS_CONTAINER_ID || "intelligence_reports";

let cosmosClient: CosmosClient | null = null;

if (connectionString && !connectionString.includes("REPLACE_WITH_REAL_KEY") && !connectionString.includes("localhost")) {
    cosmosClient = new CosmosClient(connectionString);
}

/**
 * Enforces cloud-only Cosmos usage.
 */
function requireCloudCosmosClient(): CosmosClient {
    if (!cosmosClient) {
        throw new Error("Cloud Cosmos DB is required. Set AZURE_COSMOS_CONNECTION_STRING to a non-local endpoint.");
    }
    return cosmosClient;
}

/**
 * Unified persistence layer (cloud Cosmos only)
 */
export async function saveDocumentToCosmos(collectionName: string, document: any) {
    const newDoc = {
        id: `doc_${Date.now()}_${Math.random().toString(36).substring(7)}`,
        collection: collectionName,
        createdAt: new Date().toISOString(),
        ...document
    };

    try {
        const client = requireCloudCosmosClient();
        const { database } = await client.databases.createIfNotExists({ id: databaseId });
        const { container } = await database.containers.createIfNotExists({ id: containerId });
        await container.items.create(newDoc);
        return newDoc;
    } catch (err) {
        console.error("[Azure Cosmos DB] Write failed:", err);
        throw err;
    }
}

/**
 * Unified retrieval layer (cloud Cosmos only)
 */
export async function getDocumentsFromCosmos(collectionName: string) {
    try {
        const client = requireCloudCosmosClient();
        const { database } = await client.databases.createIfNotExists({ id: databaseId });
        const { container } = await database.containers.createIfNotExists({ id: containerId });

        const querySpec = {
            query: "SELECT * FROM c WHERE c.collection = @collection",
            parameters: [{ name: "@collection", value: collectionName }]
        };

        const { resources } = await container.items.query(querySpec).fetchAll();
        return resources;
    } catch (err) {
        console.error("[Azure Cosmos DB] Query failed:", err);
        throw err;
    }
}
