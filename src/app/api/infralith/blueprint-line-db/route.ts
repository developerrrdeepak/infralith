import { z } from "zod";
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import type { BlueprintLineRecord } from "@/ai/flows/infralith/blueprint-line-database";
import {
  getBlueprintLineDbSnapshot,
  isBlueprintLineDbConfigured,
  saveBlueprintLineDbRecords,
} from "@/lib/blueprint-line-db-service";

const lineCategorySchema = z.enum([
  "structural",
  "opening",
  "annotation",
  "reference",
  "circulation",
  "services",
  "site",
  "construction",
]);
const lineOpeningSignalSchema = z.enum(["door", "window", "generic"]);
const wallGraphRoleSchema = z.enum(["candidate", "context", "exclude"]);

const lineRecordSchema = z.object({
  id: z.string().trim().min(2).max(120),
  label: z.string().trim().min(1).max(120),
  category: lineCategorySchema,
  cue: z.string().trim().min(2).max(260),
  meaning: z.string().trim().min(2).max(260),
  caution: z.string().trim().min(2).max(260),
  aliases: z.array(z.string().trim().min(1).max(80)).max(24).optional(),
  openingSignal: lineOpeningSignalSchema.optional(),
  promptPriority: z.number().int().min(1).max(9999),
  wallGraphRole: wallGraphRoleSchema,
});

const saveBodySchema = z.object({
  records: z.array(lineRecordSchema).min(1).max(400),
});

const isAdminUser = (session: { user?: { role?: string } } | null) =>
  !!session?.user && String(session.user.role || "").toLowerCase() === "admin";

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const snapshot = await getBlueprintLineDbSnapshot();
    return NextResponse.json({
      records: snapshot.records,
      source: snapshot.source,
      writable: snapshot.writable,
      configured: isBlueprintLineDbConfigured(),
      updatedAt: snapshot.updatedAt,
      schemaVersion: snapshot.schemaVersion,
      updatedBy: snapshot.updatedBy || null,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to load blueprint line DB";
    const status = message.includes("not configured") ? 503 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}

export async function PUT(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!isAdminUser(session)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (!isBlueprintLineDbConfigured()) {
    return NextResponse.json({ error: "Cosmos collab store is not configured." }, { status: 503 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = saveBodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid blueprint line DB payload" }, { status: 400 });
  }

  const ids = new Set<string>();
  for (const record of parsed.data.records) {
    if (ids.has(record.id)) {
      return NextResponse.json({ error: `Duplicate line id: ${record.id}` }, { status: 400 });
    }
    ids.add(record.id);
  }

  try {
    const normalizedRecords: BlueprintLineRecord[] = parsed.data.records.map((record) => ({
      ...record,
      aliases: Array.isArray(record.aliases)
        ? record.aliases.map((alias) => String(alias).trim()).filter(Boolean)
        : undefined,
    }));

    const snapshot = await saveBlueprintLineDbRecords(normalizedRecords, {
      id: String(session.user.id || session.user.email || "admin"),
      name: String(session.user.name || "Admin"),
      email: String(session.user.email || ""),
      role: String((session.user as any).role || "Admin"),
    });

    return NextResponse.json({
      success: true,
      records: snapshot.records,
      source: snapshot.source,
      updatedAt: snapshot.updatedAt,
      schemaVersion: snapshot.schemaVersion,
      updatedBy: snapshot.updatedBy || null,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to save blueprint line DB";
    const status = message.includes("not configured") ? 503 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
