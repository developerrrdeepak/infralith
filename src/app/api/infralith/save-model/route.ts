import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { NextResponse } from "next/server";
import { saveBIMModel, BIMDocument } from "@/lib/cosmos-service";
import crypto from "crypto";

export async function POST(req: Request) {
    const session = await getServerSession(authOptions);

    if (!session) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Usually restricted to authenticated users
    try {
        const body = await req.json();
        const { id, modelName, data } = body;

        if (!data) {
            return NextResponse.json({ error: "Missing BIM data" }, { status: 400 });
        }

        const modelId = id || crypto.randomUUID();

        const doc: BIMDocument = {
            id: modelId,
            userId: session.user.email || "anonymous",
            modelName: modelName || `BIM Model - ${new Date().toLocaleDateString()}`,
            data,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
        };

        const savedDoc = await saveBIMModel(doc);

        return NextResponse.json({
            success: true,
            message: "BIM model saved successfully",
            id: savedDoc.id,
        });
    } catch (error: any) {
        console.error("[Cosmos DB Save API Error]:", error);
        return NextResponse.json({ error: error.message || "Failed to save model" }, { status: 500 });
    }
}
