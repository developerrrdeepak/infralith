import { z } from 'zod';
import { getServerSession } from 'next-auth/next';
import { NextResponse } from 'next/server';
import { authOptions } from '@/lib/auth';

const uploadRequestSchema = z.object({
  fileName: z.string().trim().min(1).max(256).optional(),
  fileType: z.string().trim().max(128).optional(),
  bytes: z.number().int().positive().max(100 * 1024 * 1024).optional(),
}).passthrough();

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

  const parsed = uploadRequestSchema.safeParse(payload);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid upload payload' }, { status: 400 });
  }

  console.log('Blueprint upload request accepted', {
    actor: session.user.email || session.user.id,
    role: session.user.role,
    fileName: parsed.data.fileName || null,
    fileType: parsed.data.fileType || null,
    bytes: parsed.data.bytes || null,
  });

  return NextResponse.json({
    success: true,
    message: 'Blueprint upload processed',
    timestamp: new Date().toISOString(),
    user: session.user.name || session.user.email || session.user.id,
  });
}
