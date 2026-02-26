'use server';

import { generateAzureObject } from '@/ai/azure-ai';
import { WorkflowResult, DevOpsInsight } from './types';
import { Octokit } from "octokit";

// Initialize the modern GitHub Client. If the token is missing, it stays null.
const github = process.env.GITHUB_TOKEN
    ? new Octokit({ auth: process.env.GITHUB_TOKEN })
    : null;

// Pull repo details from environment variables, with safe fallbacks.
const REPO_OWNER = process.env.GITHUB_OWNER || "simulation-owner";
const REPO_NAME = process.env.GITHUB_REPO || "simulation-repo";

/**
 * Agentic DevOps Agent
 * This agent monitors the evaluation workflow and generates automated maintenance
 * tasks or infrastructure-as-code updates in a GitHub repository.
 */
export async function runDevOpsAgent(data: WorkflowResult): Promise<DevOpsInsight> {

    // --- Step 1: REASONING ---
    // The AI acts as a Site Reliability Engineer to analyze the data and decide if action is needed.
    const prompt = `
        As an expert AI Site Reliability Engineer (SRE), review the following structural analysis telemetry:
        
        Project: ${data.projectScope}
        Risk Index: ${data.riskReport?.riskIndex ?? 0}
        Compliance Status: ${data.complianceReport?.overallStatus}
        Critical Conflicts Found: ${data.conflicts?.filter((c: any) => c.riskCategory === 'Critical').length ?? 0}
        
        DECISION MATRIX:
        - A GitHub issue is MANDATORY if the Risk Index is > 70 OR the Compliance Status is "Fail".
        - This is a P0 (highest priority) blocker.

        Based on this matrix, generate a JSON object with your decision.
        
        SCHEMA:
        {
          "ticketRequired": boolean,
          "ticketTitle": "A short, descriptive title for the GitHub issue.",
          "ticketBody": "A detailed markdown-formatted summary explaining the failure. Reference the specific risk index and compliance violations."
        }
    `;

    const analysis = await generateAzureObject<{
        ticketRequired: boolean;
        ticketTitle: string;
        ticketBody: string;
    }>(prompt);

    // --- Step 2: SAFETY GATE & ACTION ---
    // This is a hard-coded check. Even if the AI makes a mistake, this code ensures
    // a ticket is ONLY created for genuinely high-risk situations.
    const isActionRequired = (data.riskReport?.riskIndex || 0) > 70 || data.complianceReport?.overallStatus === 'Fail';
    let ticketUrl = "";

    if (analysis.ticketRequired && isActionRequired) {
        if (github) {
            try {
                // The AI uses its "Tool" to make a real-world change.
                const response = await github.request("POST /repos/{owner}/{repo}/issues", {
                    owner: REPO_OWNER,
                    repo: REPO_NAME,
                    title: `[AI-BLOCKER] ${analysis.ticketTitle}`,
                    body: `${analysis.ticketBody}\n\n---\n**Telemetry Snapshot:**\n- **Project:** ${data.projectScope}\n- **Risk Index:** ${data.riskReport?.riskIndex}\n- **Compliance:** ${data.complianceReport?.overallStatus}\n- **Trace ID:** ${data.id}`,
                    labels: ['critical-risk', 'ai-generated', 'structural-failure'],
                    headers: { 'X-GitHub-Api-Version': '2022-11-28' }
                });
                ticketUrl = response.data.html_url;
                console.log(`[DevOps Agent] Successfully created GitHub issue: ${ticketUrl}`);
            } catch (error) {
                console.error("[DevOps Agent] GitHub API Error:", error);
                ticketUrl = "ERROR_CREATING_TICKET";
            }
        } else {
            // Fallback Simulation Mode
            console.warn("[DevOps Agent] GITHUB_TOKEN not found. Running in Simulation Mode.");
            ticketUrl = `https://github.com/${REPO_OWNER}/${REPO_NAME}/issues/simulated-${Math.floor(Math.random() * 100)}`;
        }
    }

    // --- Step 3: RETURN INSIGHT ---
    // Send the results back to the main workflow.
    return {
        agentId: 'DevOps-Automator-v5',
        status: isActionRequired ? 'Issue' : 'Optimized',
        message: isActionRequired ? `Action Required: Engineering blocker ticket created.` : 'Pipeline healthy, no critical blockers.',
        actionRequired: isActionRequired,
        ticketUrl: isActionRequired ? ticketUrl : undefined,
    } as DevOpsInsight;
}