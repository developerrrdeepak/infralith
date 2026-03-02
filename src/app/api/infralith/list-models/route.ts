import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { NextResponse } from "next/server";
import { listUserBIMModels } from "@/lib/cosmos-service";

export async function GET() {
    const session = await getServerSession(authOptions);

    if (!session) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    try {
        const userId = session.user.email || "anonymous";
        const models = await listUserBIMModels(userId);
        return NextResponse.json(models);
    } catch (error: unknown) {
        console.error("[Cosmos DB List API Error]:", error);
        const message = error instanceof Error ? error.message : "Failed to list models";
        const status = message.startsWith("Cloud Cosmos DB") ? 503 : 500;
        return NextResponse.json({ error: message }, { status });
    }
}
