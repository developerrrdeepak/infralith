
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { NextResponse } from "next/server";

export async function POST(req: Request) {
    const session = await getServerSession(authOptions);

    if (!session) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const userRole = session.user.role;
    const isSupervisor = userRole === "Supervisor" || userRole === "Admin";

    if (!isSupervisor) {
        return NextResponse.json({ error: "Forbidden: Supervisor role required" }, { status: 403 });
    }

    try {
        const { approved } = await req.json();
        console.log(`Project ${approved ? 'Approval' : 'Rejection'} by ${session.user.name} (${session.user.email})`);

        // Log action to database for audit trail
        // db.audit.log({ action: approved ? 'APPROVE' : 'REJECT', userId: session.user.id, timestamp: Date.now() })

        return NextResponse.json({
            success: true,
            status: approved ? "Approved" : "Rejected",
            audit: {
                actionBy: session.user.name,
                role: session.user.role,
                timestamp: new Date().toISOString()
            }
        });
    } catch (error) {
        return NextResponse.json({ error: "Failed to process decision" }, { status: 500 });
    }
}
