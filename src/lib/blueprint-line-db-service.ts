import type { BlueprintLineRecord } from "@/ai/flows/infralith/blueprint-line-database";
import { getBlueprintLineDatabase } from "@/ai/flows/infralith/blueprint-line-database";
import {
  isCollabStoreConfigured,
  readCollabDoc,
  upsertCollabDoc,
} from "@/lib/cosmos-collab-service";

const DOC_ID = "blueprint-line-db";
const DOC_PK = "config:blueprint-line-db";
const DOC_TYPE = "blueprintLineDatabase";
const DOC_VERSION = 1;

type LineDbActor = {
  id: string;
  name?: string;
  email?: string;
  role?: string;
};

export type BlueprintLineDbDoc = {
  id: string;
  pk: string;
  type: typeof DOC_TYPE;
  schemaVersion: number;
  records: BlueprintLineRecord[];
  createdAt: string;
  updatedAt: string;
  updatedBy?: LineDbActor;
};

export type BlueprintLineDbSnapshot = {
  records: BlueprintLineRecord[];
  source: "cosmos" | "default";
  writable: boolean;
  updatedAt: string;
  schemaVersion: number;
  updatedBy?: LineDbActor;
};

const nowIso = () => new Date().toISOString();

const cloneDefaultRecords = (): BlueprintLineRecord[] =>
  getBlueprintLineDatabase().map((record) => ({ ...record, aliases: [...(record.aliases || [])] }));

const sanitizeRecords = (records: BlueprintLineRecord[]): BlueprintLineRecord[] => {
  const seen = new Set<string>();
  const output: BlueprintLineRecord[] = [];

  for (const record of records) {
    const id = String(record?.id || "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    output.push({
      id,
      label: String(record?.label || "").trim() || id,
      category: record.category,
      cue: String(record?.cue || "").trim(),
      meaning: String(record?.meaning || "").trim(),
      caution: String(record?.caution || "").trim(),
      aliases: Array.isArray(record?.aliases)
        ? record.aliases.map((alias) => String(alias || "").trim()).filter(Boolean)
        : undefined,
      openingSignal: record.openingSignal,
      promptPriority: Number.isFinite(Number(record?.promptPriority))
        ? Math.max(1, Math.floor(Number(record.promptPriority)))
        : 999,
      wallGraphRole: record.wallGraphRole,
    });
  }

  return output.sort((a, b) => a.promptPriority - b.promptPriority || a.id.localeCompare(b.id));
};

const isSafeRecord = (record: BlueprintLineRecord): boolean => {
  if (!record?.id || !record?.label || !record?.cue || !record?.meaning || !record?.caution) return false;
  if (!["structural", "opening", "annotation", "reference", "circulation", "services", "site", "construction"].includes(record.category)) {
    return false;
  }
  if (!["candidate", "context", "exclude"].includes(record.wallGraphRole)) return false;
  if (record.openingSignal && !["door", "window", "generic"].includes(record.openingSignal)) return false;
  if (!Number.isFinite(record.promptPriority) || record.promptPriority < 1) return false;
  return true;
};

const isValidRecordSet = (records: BlueprintLineRecord[]): boolean => {
  if (!Array.isArray(records) || records.length === 0) return false;
  const ids = new Set<string>();
  for (const record of records) {
    if (!isSafeRecord(record)) return false;
    if (ids.has(record.id)) return false;
    ids.add(record.id);
  }
  return true;
};

const toSnapshot = (
  records: BlueprintLineRecord[],
  source: "cosmos" | "default",
  writable: boolean,
  updatedAt: string,
  schemaVersion: number,
  updatedBy?: LineDbActor
): BlueprintLineDbSnapshot => ({
  records,
  source,
  writable,
  updatedAt,
  schemaVersion,
  updatedBy,
});

export const isBlueprintLineDbConfigured = (): boolean => isCollabStoreConfigured();

export const readPersistedBlueprintLineDbDoc = async (): Promise<BlueprintLineDbDoc | null> => {
  if (!isCollabStoreConfigured()) return null;
  return readCollabDoc<BlueprintLineDbDoc>(DOC_ID, DOC_PK);
};

export const getBlueprintLineDbSnapshot = async (): Promise<BlueprintLineDbSnapshot> => {
  const fallbackRecords = cloneDefaultRecords();
  const fallbackUpdatedAt = nowIso();

  if (!isCollabStoreConfigured()) {
    return toSnapshot(fallbackRecords, "default", false, fallbackUpdatedAt, DOC_VERSION);
  }

  const persisted = await readPersistedBlueprintLineDbDoc();
  if (persisted && isValidRecordSet(persisted.records)) {
    return toSnapshot(
      sanitizeRecords(persisted.records),
      "cosmos",
      true,
      persisted.updatedAt || fallbackUpdatedAt,
      persisted.schemaVersion || DOC_VERSION,
      persisted.updatedBy
    );
  }

  const seeded = await saveBlueprintLineDbRecords(fallbackRecords, {
    id: "system",
    name: "System Seed",
    role: "Admin",
  });
  return seeded;
};

export const saveBlueprintLineDbRecords = async (
  records: BlueprintLineRecord[],
  actor: LineDbActor
): Promise<BlueprintLineDbSnapshot> => {
  if (!isCollabStoreConfigured()) {
    throw new Error("Cosmos collab store is not configured.");
  }
  const sanitized = sanitizeRecords(records);
  if (!isValidRecordSet(sanitized)) {
    throw new Error("Blueprint line DB payload is invalid.");
  }

  const existing = await readPersistedBlueprintLineDbDoc();
  const timestamp = nowIso();

  const doc: BlueprintLineDbDoc = {
    id: DOC_ID,
    pk: DOC_PK,
    type: DOC_TYPE,
    schemaVersion: DOC_VERSION,
    records: sanitized,
    createdAt: existing?.createdAt || timestamp,
    updatedAt: timestamp,
    updatedBy: actor,
  };

  const saved = await upsertCollabDoc(doc);
  return toSnapshot(
    sanitizeRecords(saved.records),
    "cosmos",
    true,
    saved.updatedAt || timestamp,
    saved.schemaVersion || DOC_VERSION,
    saved.updatedBy
  );
};
