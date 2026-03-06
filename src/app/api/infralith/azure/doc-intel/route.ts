import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getServerSession } from 'next-auth/next';
import { authOptions } from '@/lib/auth';
import { probeDocumentIntelligence } from '@/ai/azure-ai';
import { getSanitizedAiRuntimeSummary } from '@/ai/config/azure-runtime';

const probePayloadSchema = z.object({
  sampleDocumentUrl: z.string().url().max(1024).optional(),
  timeoutMs: z.number().int().min(5000).max(60000).optional(),
});

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const runtime = getSanitizedAiRuntimeSummary();
  const probe = await probeDocumentIntelligence();

  return NextResponse.json({
    success: true,
    runtime,
    docIntel: probe,
    guidance: {
      envVars: [
        'AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT',
        'AZURE_DOCUMENT_INTELLIGENCE_KEY',
      ],
      aliasesSupported: [
        'AZURE_FORM_RECOGNIZER_ENDPOINT',
        'AZURE_FORM_RECOGNIZER_KEY',
      ],
    },
  });
}

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let payload: unknown = {};
  try {
    payload = await req.json();
  } catch {
    payload = {};
  }

  const parsed = probePayloadSchema.safeParse(payload);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid probe payload', details: parsed.error.flatten() }, { status: 400 });
  }

  const probe = await probeDocumentIntelligence({
    sampleDocumentUrl: parsed.data.sampleDocumentUrl,
    timeoutMs: parsed.data.timeoutMs,
  });

  return NextResponse.json({
    success: probe.probeSucceeded || !probe.probePerformed,
    docIntel: probe,
  }, { status: probe.probeSucceeded || !probe.probePerformed ? 200 : 502 });
}
