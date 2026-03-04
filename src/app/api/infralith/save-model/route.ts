import crypto from 'crypto';
import { z } from 'zod';
import { getServerSession } from 'next-auth/next';
import { NextResponse } from 'next/server';
import { authOptions } from '@/lib/auth';
import { saveBIMModel, BIMDocument } from '@/lib/cosmos-service';

const MAX_MODEL_BYTES_DEFAULT = 8 * 1024 * 1024;
const MIN_MODEL_BYTES = 256 * 1024;
const MAX_MODEL_BYTES = 25 * 1024 * 1024;

const saveModelBodySchema = z.object({
  id: z.string().trim().min(3).max(128).regex(/^[a-zA-Z0-9._:-]+$/).optional(),
  modelName: z.string().trim().min(1).max(160).optional(),
  data: z.unknown(),
});

const parseMaxModelBytes = () => {
  const raw = Number(process.env.INFRALITH_MAX_MODEL_BYTES || MAX_MODEL_BYTES_DEFAULT);
  if (!Number.isFinite(raw)) return MAX_MODEL_BYTES_DEFAULT;
  return Math.max(MIN_MODEL_BYTES, Math.min(MAX_MODEL_BYTES, Math.floor(raw)));
};

const maxModelBytes = parseMaxModelBytes();

const getSafeModelName = (name?: string) => {
  if (name && name.trim()) return name.trim();
  return `BIM Model - ${new Date().toISOString().slice(0, 10)}`;
};

const estimatePayloadBytes = (data: unknown): number => {
  const serialized = JSON.stringify(data);
  return Buffer.byteLength(serialized, 'utf8');
};

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const parsed = saveModelBodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid model payload' }, { status: 400 });
  }

  const { id, modelName, data } = parsed.data;
  if (!data || typeof data !== 'object') {
    return NextResponse.json({ error: 'Missing or invalid BIM data' }, { status: 400 });
  }

  let estimatedBytes = 0;
  try {
    estimatedBytes = estimatePayloadBytes(data);
  } catch {
    return NextResponse.json({ error: 'Model payload must be JSON-serializable' }, { status: 400 });
  }

  if (estimatedBytes > maxModelBytes) {
    return NextResponse.json(
      { error: `Model payload is too large. Limit is ${maxModelBytes} bytes.` },
      { status: 413 }
    );
  }

  const timestamp = new Date().toISOString();
  const modelId = id || crypto.randomUUID();
  const userId = session.user.email || session.user.id || 'anonymous';

  const doc: BIMDocument = {
    id: modelId,
    userId,
    modelName: getSafeModelName(modelName),
    data: data as BIMDocument['data'],
    createdAt: timestamp,
    updatedAt: timestamp,
  };

  try {
    const savedDoc = await saveBIMModel(doc);
    return NextResponse.json({
      success: true,
      message: 'BIM model saved successfully',
      id: savedDoc.id,
      updatedAt: savedDoc.updatedAt,
    });
  } catch (error: unknown) {
    console.error('[Cosmos DB Save API Error]', error);
    const message = error instanceof Error ? error.message : 'Failed to save model';
    const status = message.startsWith('Cloud Cosmos DB') ? 503 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
