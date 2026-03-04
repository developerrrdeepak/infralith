import { z } from 'zod';
import { getServerSession } from 'next-auth/next';
import { NextResponse } from 'next/server';
import { authOptions } from '@/lib/auth';

const approveRequestSchema = z.object({
  approved: z.boolean(),
  reason: z.string().trim().max(1_000).optional(),
}).passthrough();

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const userRole = session.user.role;
  const isSupervisor = userRole === 'Supervisor' || userRole === 'Admin';
  if (!isSupervisor) {
    return NextResponse.json({ error: 'Forbidden: Supervisor role required' }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const parsed = approveRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid approval payload' }, { status: 400 });
  }

  const { approved, reason } = parsed.data;
  console.log('Project decision submitted', {
    approved,
    actor: session.user.email || session.user.id,
    role: session.user.role,
    reason: reason || null,
  });

  return NextResponse.json({
    success: true,
    status: approved ? 'Approved' : 'Rejected',
    audit: {
      actionBy: session.user.name || session.user.email || session.user.id,
      role: session.user.role,
      reason: reason || null,
      timestamp: new Date().toISOString(),
    },
  });
}
