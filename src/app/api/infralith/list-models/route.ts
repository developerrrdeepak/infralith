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
    } catch (error: any) {
        console.error("[Cosmos DB List API Error]:", error);
        return NextResponse.json({ error: "Failed to list models" }, { status: 500 });
    }
}
