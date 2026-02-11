/**
 * Vertex AI Provider
 * 
 * Uses Google Cloud Vertex AI REST API directly (not Google GenAI SDK).
 * Vertex AI requires different authentication and endpoint structure.
 * 
 * API Endpoint: https://{location}-aiplatform.googleapis.com/v1/projects/{projectId}/locations/{location}/publishers/google/models/{modelId}:predict
 * 
 * Authentication: Uses Vertex AI API key or service account credentials
 */

import { ReadableStream } from "stream/web";

// =============================================================================
// Configuration
// =============================================================================

const VERTEX_AI_API_KEY = process.env.VERTEX_AI_API_KEY || process.env.GOOGLE_CLOUD_API_KEY || "";
const VERTEX_PROJECT_ID = process.env.VERTEX_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT || "";
const VERTEX_LOCATION = process.env.VERTEX_LOCATION || "us-central1";

if (!VERTEX_AI_API_KEY) {
    console.warn("[vertex] VERTEX_AI_API_KEY not set");
}

// =============================================================================
// Types
// =============================================================================

export interface VertexMessage {
    role: "user" | "model" | "system";
    parts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }>;
}

export interface VertexRequest {
    contents: VertexMessage[];
    generationConfig?: {
        temperature?: number;
        maxOutputTokens?: number;
        topP?: number;
        topK?: number;
    };
    safetySettings?: Array<{
        category: string;
        threshold: string;
    }>;
}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Convert model ID to Vertex AI format
 * e.g., "google/gemini-2.5-pro" -> "gemini-2.5-pro"
 */
function normalizeModelId(modelId: string): string {
    // Remove provider prefix if present
    if (modelId.includes("/")) {
        return modelId.split("/").pop() || modelId;
    }
    return modelId;
}

/**
 * Build Vertex AI REST API URL
 */
function buildVertexUrl(modelId: string, streaming: boolean = false): string {
    const normalizedId = normalizeModelId(modelId);
    const baseUrl = `https://${VERTEX_LOCATION}-aiplatform.googleapis.com/v1/projects/${VERTEX_PROJECT_ID}/locations/${VERTEX_LOCATION}/publishers/google/models/${normalizedId}`;
    
    if (streaming) {
        return `${baseUrl}:streamGenerateContent?alt=sse`;
    }
    return `${baseUrl}:generateContent`;
}

/**
 * Convert messages to Vertex AI format
 */
function convertMessages(messages: Array<{ role: string; content: string | any[] }>): VertexMessage[] {
    return messages.map(msg => {
        const role = msg.role === "assistant" ? "model" : msg.role;
        
        let parts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }> = [];
        
        if (typeof msg.content === "string") {
            parts = [{ text: msg.content }];
        } else if (Array.isArray(msg.content)) {
            // Handle multimodal content
            parts = msg.content.map((part: any) => {
                if (part.type === "text") {
                    return { text: part.text };
                } else if (part.type === "image_url") {
                    const url = part.image_url?.url || part.image_url;
                    // For now, return as text reference (Vertex requires base64 for inline data)
                    return { text: `[Image: ${url}]` };
                } else if (part.type === "input_audio") {
                    const url = part.input_audio?.url || part.input_audio;
                    return { text: `[Audio: ${url}]` };
                }
                return { text: String(part) };
            });
        }
        
        return { role: role as "user" | "model" | "system", parts };
    });
}

// =============================================================================
// Streaming Response Parser
// =============================================================================

/**
 * Parse Vertex AI SSE stream
 */
async function* parseVertexStream(stream: ReadableStream<Uint8Array>): AsyncGenerator<string, void, unknown> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";
            
            for (const line of lines) {
                if (!line.startsWith("data: ")) continue;
                
                const data = line.slice(6).trim();
                if (!data || data === "[DONE]") continue;
                
                try {
                    const parsed = JSON.parse(data);
                    // Extract text from candidates
                    const candidate = parsed.candidates?.[0];
                    if (candidate?.content?.parts?.[0]?.text) {
                        yield candidate.content.parts[0].text;
                    }
                } catch (e) {
                    // Ignore parse errors
                }
            }
        }
    } finally {
        reader.releaseLock();
    }
}

// =============================================================================
// Main Functions
// =============================================================================

export interface StreamChatOptions {
    onToken: (token: string) => void | Promise<void>;
    onComplete?: () => void | Promise<void>;
    onError?: (error: Error) => void | Promise<void>;
}

/**
 * Stream chat completion from Vertex AI
 */
export async function streamVertexChat(
    modelId: string,
    messages: Array<{ role: string; content: string | any[] }>,
    options: StreamChatOptions & {
        temperature?: number;
        maxTokens?: number;
        topP?: number;
    }
): Promise<void> {
    if (!VERTEX_AI_API_KEY) {
        throw new Error("VERTEX_AI_API_KEY not configured");
    }
    
    const url = buildVertexUrl(modelId, true);
    const vertexMessages = convertMessages(messages);
    
    const requestBody: VertexRequest = {
        contents: vertexMessages,
        generationConfig: {
            temperature: options.temperature ?? 0.7,
            maxOutputTokens: options.maxTokens ?? 2048,
            topP: options.topP ?? 0.95,
        },
        safetySettings: [
            { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_MEDIUM_AND_ABOVE" },
            { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_MEDIUM_AND_ABOVE" },
            { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_MEDIUM_AND_ABOVE" },
            { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_MEDIUM_AND_ABOVE" },
        ],
    };
    
    console.log(`[vertex] Streaming to: ${url.replace(/projects\/[^/]+/, "projects/...")}`);
    
    const response = await fetch(url, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${VERTEX_AI_API_KEY}`,
        },
        body: JSON.stringify(requestBody),
    });
    
    if (!response.ok) {
        const errorText = await response.text();
        console.error(`[vertex] HTTP ${response.status}: ${errorText}`);
        throw new Error(`Vertex AI error: ${response.status} - ${errorText.slice(0, 200)}`);
    }
    
    if (!response.body) {
        throw new Error("No response body from Vertex AI");
    }
    
    try {
        for await (const token of parseVertexStream(response.body as ReadableStream<Uint8Array>)) {
            await options.onToken(token);
        }
        
        if (options.onComplete) {
            await options.onComplete();
        }
    } catch (error) {
        if (options.onError) {
            await options.onError(error instanceof Error ? error : new Error(String(error)));
        }
        throw error;
    }
}

/**
 * Non-streaming chat completion
 */
export async function generateVertexChat(
    modelId: string,
    messages: Array<{ role: string; content: string | any[] }>,
    options?: {
        temperature?: number;
        maxTokens?: number;
        topP?: number;
    }
): Promise<string> {
    if (!VERTEX_AI_API_KEY) {
        throw new Error("VERTEX_AI_API_KEY not configured");
    }
    
    const url = buildVertexUrl(modelId, false);
    const vertexMessages = convertMessages(messages);
    
    const requestBody: VertexRequest = {
        contents: vertexMessages,
        generationConfig: {
            temperature: options?.temperature ?? 0.7,
            maxOutputTokens: options?.maxTokens ?? 2048,
            topP: options?.topP ?? 0.95,
        },
    };
    
    console.log(`[vertex] Generating to: ${url.replace(/projects\/[^/]+/, "projects/...")}`);
    
    const response = await fetch(url, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${VERTEX_AI_API_KEY}`,
        },
        body: JSON.stringify(requestBody),
    });
    
    if (!response.ok) {
        const errorText = await response.text();
        console.error(`[vertex] HTTP ${response.status}: ${errorText}`);
        throw new Error(`Vertex AI error: ${response.status} - ${errorText.slice(0, 200)}`);
    }
    
    const result = await response.json();
    
    // Extract text from response
    const candidate = result.candidates?.[0];
    if (candidate?.content?.parts?.[0]?.text) {
        return candidate.content.parts[0].text;
    }
    
    // Check for blocking
    if (candidate?.finishReason === "SAFETY") {
        throw new Error("Content blocked by safety settings");
    }
    
    throw new Error("No content in Vertex AI response");
}
