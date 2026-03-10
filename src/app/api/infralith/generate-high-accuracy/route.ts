import { NextRequest, NextResponse } from 'next/server';
import { generateHighAccuracy3DModel } from '@/ai/flows/infralith/high-accuracy-generator';

export const maxDuration = 300;

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { blueprintBase64, targetAccuracy = 0.95 } = body;

    if (!blueprintBase64) {
      return NextResponse.json(
        { error: 'Blueprint image is required' },
        { status: 400 }
      );
    }

    const accuracy = Math.max(0.85, Math.min(0.99, targetAccuracy));

    console.log(`🎯 Generating 3D model with ${(accuracy * 100).toFixed(0)}% target accuracy...`);

    const result = await generateHighAccuracy3DModel(blueprintBase64, accuracy);

    return NextResponse.json({
      success: true,
      model: result.model,
      validation: {
        passed: result.validation.passed,
        accuracy: result.validation.accuracy,
        issueCount: result.validation.issues.length,
        criticalIssues: result.validation.issues.filter(i => i.severity === 'critical').length,
        suggestions: result.validation.suggestions,
      },
      metadata: result.metadata,
    });
  } catch (error) {
    console.error('Error generating 3D model:', error);
    return NextResponse.json(
      {
        error: 'Failed to generate 3D model',
        details: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    );
  }
}
