import { CosmosClient } from "@azure/cosmos";
import { GeometricReconstruction } from "@/ai/flows/infralith/reconstruction-types";

const endpoint = process.env.COSMOS_ENDPOINT || "https://localhost:8081";
const key = process.env.COSMOS_KEY || "C2y6yDjf5/R+ob0N8A7Cgv30VRDJIWEHLM+4QDU5DE2nQ9nDuVTqobD4b8mGGyPMbIZnqyMsEcaGQy67XIw/Jw==";

// By default, if credentials are not provided in production, it will gracefully fallback to mocking or fail depending on setup.
// Using exact credentials for local emulator as fallback for dev.

const client = new CosmosClient({ endpoint, key });

const DATABASE_ID = "InfralithDB";
const CONTAINER_ID = "BIMModels";

export interface BIMDocument {
    id: string; // The partition key, usually blueprint/project ID
    userId: string;
    modelName: string;
    data: GeometricReconstruction;
    createdAt: string;
    updatedAt: string;
}

/**
 * Ensures the Cosmos DB Database and Container exist.
 */
async function ensureContainer() {
    try {
        const { database } = await client.databases.createIfNotExists({ id: DATABASE_ID });
        const { container } = await database.containers.createIfNotExists({
            id: CONTAINER_ID,
            partitionKey: { paths: ["/id"] }
        });
        return container;
    } catch (e) {
        console.error("Cosmos DB Connection Error:", e);
        throw e;
    }
}

/**
 * Saves or updates a BIM Model in Cosmos DB.
 */
export async function saveBIMModel(doc: BIMDocument): Promise<BIMDocument> {
    try {
        const container = await ensureContainer();
        const { resource } = await container.items.upsert(doc);
        return resource as unknown as BIMDocument;
    } catch (error) {
        console.error("Failed to save BIM model to Cosmos:", error);
        throw error;
    }
}

/**
 * Retrieves a specific BIM Model by its ID.
 */
export async function getBIMModel(id: string): Promise<BIMDocument | null> {
    try {
        const container = await ensureContainer();
        const { resource } = await container.item(id, id).read();
        return (resource as unknown as BIMDocument) || null;
    } catch (error) {
        console.error("Failed to read BIM model from Cosmos:", id, error);
        return null;
    }
}

/**
 * Lists all BIM Models for a specific user.
 */
export async function listUserBIMModels(userId: string): Promise<Pick<BIMDocument, 'id' | 'modelName' | 'createdAt' | 'updatedAt'>[]> {
    try {
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
    } catch (error) {
        console.error("Failed to list user BIM models from Cosmos:", error);
        return [];
    }
}
