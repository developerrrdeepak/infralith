import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { NextResponse } from "next/server";
import { getBIMModel } from "@/lib/cosmos-service";

export async function GET(req: Request) {
    const session = await getServerSession(authOptions);

    if (!session) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { searchParams } = new URL(req.url);
    const id = searchParams.get("id");

    if (!id) {
        return NextResponse.json({ error: "Missing model ID" }, { status: 400 });
    }

    try {
        const model = await getBIMModel(id);
        if (!model) {
            return NextResponse.json({ error: "Model not found" }, { status: 404 });
        }

        // Security check: ensure the model belongs to the user
        const userId = session.user.email || session.user.id || "anonymous";
        if (model.userId !== userId) {
            return NextResponse.json({ error: "Forbidden" }, { status: 403 });
        }

        return NextResponse.json(model);
    } catch (error: unknown) {
        console.error("[Cosmos DB Load API Error]:", error);
        const message = error instanceof Error ? error.message : "Failed to load model";
        const status = message.startsWith("Cloud Cosmos DB") ? 503 : 500;
        return NextResponse.json({ error: message }, { status });
    }
}
