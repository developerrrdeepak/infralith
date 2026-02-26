'use server';

import { AzureOpenAI } from "openai";

const azureEndpoint = process.env.AZURE_OPENAI_ENDPOINT || "";
const azureKey = process.env.AZURE_OPENAI_KEY || "";
const deploymentName = process.env.AZURE_OPENAI_DEPLOYMENT_NAME || process.env.AZURE_OPENAI_DEPLOYMENT || "gpt-4o";

export async function chatWithInfralith(messages: { role: string, content: string }[], newPrompt: string, documentName?: string, documentContent?: string) {
    if (!azureEndpoint || !azureKey) {
        console.warn("Azure OpenAI keys not configured. Responding with mock chat.");
        return "I am the Infralith Construction Intelligence AI (Simulation Mode). I can assist you with understanding structural parameters, compliance codes (IS-456), and project telemetry insights from the Azure Digital Twins platform.";
    }

    try {
        const client = new AzureOpenAI({
            endpoint: azureEndpoint,
            apiKey: azureKey,
            apiVersion: "2024-12-01-preview",
            deployment: deploymentName,
        });

        const systemMessage = "You are the Infralith Construction Intelligence AI. You are an expert civil engineer and project supervisor. Respond clearly, professionally, and provide actionable insights about structural engineering, building codes, and risk mitigation.";

        let finalPrompt = newPrompt;
        if (documentName && documentContent) {
            finalPrompt = `[User has uploaded a document: ${documentName}]\n[Document Intelligence Extraction: ${documentContent.substring(0, 2000)}...]\n\nUser Question: ${newPrompt}`;
        }

        const formattedMessages = [
            { role: "system", content: systemMessage },
            ...messages.map(m => ({ role: m.role === 'infralith' ? 'assistant' : 'user', content: m.content })),
            { role: "user", content: finalPrompt }
        ];

        const response = await client.chat.completions.create({
            model: deploymentName,
            messages: formattedMessages as any,
        });

        return response.choices[0].message?.content || "No response generated.";
    } catch (e) {
        console.error("Chat Error:", e);
        return "Error: Infralith AI is currently unable to reach Azure Cognitive Services. Please try again later or check your network routing.";
    }
}
