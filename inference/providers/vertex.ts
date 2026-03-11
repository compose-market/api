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

const VERTEX_AI_API_KEY = process.env.VERTEX_AI_API_KEY;
const VERTEX_PROJECT_ID = process.env.VERTEX_PROJECT_ID;
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
    let hasYieldedContent = false;

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
                    const candidate = parsed.candidates?.[0];

                    // Check for content blocking
                    if (candidate?.finishReason === "SAFETY") {
                        console.error("[vertex] Content blocked by safety settings");
                        throw new Error("Content blocked by safety settings");
                    }

                    if (candidate?.finishReason === "RECITATION") {
                        console.error("[vertex] Content blocked by recitation policy");
                        throw new Error("Content blocked by recitation policy");
                    }

                    // Extract text from candidates
                    if (candidate?.content?.parts?.[0]?.text) {
                        hasYieldedContent = true;
                        yield candidate.content.parts[0].text;
                    }
                } catch (e) {
                    if (e instanceof Error && e.message.includes("blocked")) {
                        throw e;
                    }
                    // Log but don't throw for parse errors
                    console.warn("[vertex] Failed to parse SSE chunk:", line.slice(0, 100));
                }
            }
        }

        if (!hasYieldedContent) {
            console.error("[vertex] Stream completed but no content was generated");
            throw new Error("No content generated from Vertex AI");
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

    // Log full response for debugging
    console.log("[vertex] Response structure:", JSON.stringify(result, null, 2).slice(0, 1000));

    // Extract text from response
    const candidate = result.candidates?.[0];

    // Check for blocking first
    if (candidate?.finishReason === "SAFETY") {
        console.error("[vertex] Content blocked by safety settings");
        throw new Error("Content blocked by safety settings");
    }

    if (candidate?.finishReason === "RECITATION") {
        console.error("[vertex] Content blocked by recitation policy");
        throw new Error("Content blocked by recitation policy");
    }

    if (candidate?.finishReason === "OTHER") {
        console.error("[vertex] Generation stopped for other reasons");
        throw new Error("Generation stopped: " + (candidate.finishMessage || "Unknown reason"));
    }

    // Return text if available
    if (candidate?.content?.parts?.[0]?.text) {
        return candidate.content.parts[0].text;
    }

    // Log what we got instead
    console.error("[vertex] No text in response. Finish reason:", candidate?.finishReason);
    console.error("[vertex] Full candidate:", JSON.stringify(candidate, null, 2));

    throw new Error(`No content in Vertex AI response. Finish reason: ${candidate?.finishReason || "unknown"}`);
}

// =============================================================================
// Image Generation (Imagen 3)
// =============================================================================

export interface VertexImageResult {
    buffer: Buffer;
    mimeType: string;
}

export async function generateVertexImage(
    modelId: string,
    prompt: string,
    options?: { size?: string; n?: number }
): Promise<VertexImageResult> {
    if (!VERTEX_AI_API_KEY) {
        throw new Error("VERTEX_AI_API_KEY not configured");
    }

    // Parse size (e.g., "1024x1024" -> {width: 1024, height: 1024})
    const size = options?.size || "1024x1024";
    const [width, height] = size.split("x").map(Number);

    const url = `https://${VERTEX_LOCATION}-aiplatform.googleapis.com/v1/projects/${VERTEX_PROJECT_ID}/locations/${VERTEX_LOCATION}/publishers/google/models/${modelId}:predict`;

    const requestBody = {
        instances: [
            { prompt: prompt }
        ],
        parameters: {
            sampleCount: options?.n || 1,
            aspectRatio: width && height ? `${width}:${height}` : "1:1",
        }
    };

    console.log(`[vertex] Generating image with ${modelId}: "${prompt.slice(0, 50)}..."`);

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
        console.error(`[vertex] Image generation failed: ${response.status}`, errorText);
        throw new Error(`Vertex AI image generation failed: ${response.status} - ${errorText}`);
    }

    const data = await response.json();

    // Extract base64 image from predictions
    const prediction = data.predictions?.[0];
    if (!prediction) {
        throw new Error("No image data in Vertex AI response");
    }

    // Imagen returns base64 in bytesBase64Encoded field
    const base64Image = prediction.bytesBase64Encoded || prediction.base64Image || prediction.image;
    if (!base64Image) {
        console.error("[vertex] Response structure:", JSON.stringify(data).slice(0, 500));
        throw new Error("No base64 image data in response");
    }

    const buffer = Buffer.from(base64Image, "base64");
    return { buffer, mimeType: "image/png" };
}

// =============================================================================
// Video Generation (Veo)
// =============================================================================

export interface VertexVideoResult {
    buffer: Buffer;
    mimeType: string;
}

export async function generateVertexVideo(
    modelId: string,
    prompt: string,
    options?: { duration?: number; aspectRatio?: string }
): Promise<VertexVideoResult> {
    if (!VERTEX_AI_API_KEY) {
        throw new Error("VERTEX_AI_API_KEY not configured");
    }

    const url = `https://${VERTEX_LOCATION}-aiplatform.googleapis.com/v1/projects/${VERTEX_PROJECT_ID}/locations/${VERTEX_LOCATION}/publishers/google/models/${modelId}:predictLongRunning`;

    // Veo uses aspect ratio, not exact dimensions
    const aspectRatio = options?.aspectRatio || "16:9";
    const duration = options?.duration || 8; // Default 8 seconds

    const requestBody = {
        instances: [
            { prompt: prompt }
        ],
        parameters: {
            aspectRatio: aspectRatio,
            durationSeconds: duration,
        }
    };

    console.log(`[vertex] Starting video generation with ${modelId}: "${prompt.slice(0, 50)}..."`);

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
        console.error(`[vertex] Video generation failed: ${response.status}`, errorText);
        throw new Error(`Vertex AI video generation failed: ${response.status} - ${errorText}`);
    }

    const data = await response.json();

    // Long running operation - get operation ID
    const operationName = data.name;
    if (!operationName) {
        throw new Error("No operation ID in response");
    }

    console.log(`[vertex] Video job started: ${operationName}`);

    // Poll for completion
    const maxAttempts = 60; // 5 minutes (5s intervals)
    const pollUrl = `https://${VERTEX_LOCATION}-aiplatform.googleapis.com/v1/${operationName}`;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 5000)); // Wait 5 seconds

        const pollResponse = await fetch(pollUrl, {
            headers: { "Authorization": `Bearer ${VERTEX_AI_API_KEY}` },
        });

        if (!pollResponse.ok) {
            console.warn(`[vertex] Poll failed: ${pollResponse.status}`);
            continue;
        }

        const pollData = await pollResponse.json();

        if (pollData.done) {
            if (pollData.error) {
                throw new Error(`Video generation failed: ${pollData.error.message}`);
            }

            // Extract video from response
            const videoBase64 = pollData.response?.predictions?.[0]?.bytesBase64Encoded;
            if (!videoBase64) {
                throw new Error("No video data in completed operation");
            }

            console.log(`[vertex] Video generation complete`);
            const buffer = Buffer.from(videoBase64, "base64");
            return { buffer, mimeType: "video/mp4" };
        }

        console.log(`[vertex] Polling... attempt ${attempt + 1}/${maxAttempts}`);
    }

    throw new Error("Video generation timed out after 5 minutes");
}

// =============================================================================
// Text-to-Speech
// =============================================================================

export interface VertexSpeechResult {
    buffer: Buffer;
    mimeType: string;
}

export async function generateVertexSpeech(
    modelId: string,
    text: string,
    options?: { voice?: string; language?: string }
): Promise<VertexSpeechResult> {
    if (!VERTEX_AI_API_KEY) {
        throw new Error("VERTEX_AI_API_KEY not configured");
    }

    // Chirp is the TTS model on Vertex
    const url = `https://${VERTEX_LOCATION}-aiplatform.googleapis.com/v1/projects/${VERTEX_PROJECT_ID}/locations/${VERTEX_LOCATION}/publishers/google/models/${modelId}:predict`;

    const requestBody = {
        instances: [
            { text: text }
        ],
        parameters: {
            languageCode: options?.language || "en-US",
            voiceName: options?.voice || "en-US-Standard-A",
        }
    };

    console.log(`[vertex] Generating speech with ${modelId}: "${text.slice(0, 50)}..."`);

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
        console.error(`[vertex] TTS failed: ${response.status}`, errorText);
        throw new Error(`Vertex AI TTS failed: ${response.status} - ${errorText}`);
    }

    const data = await response.json();

    const prediction = data.predictions?.[0];
    if (!prediction?.audioContent) {
        throw new Error("No audio data in Vertex AI response");
    }

    const buffer = Buffer.from(prediction.audioContent, "base64");
    return { buffer, mimeType: "audio/mp3" };
}

// =============================================================================
// Speech-to-Text (ASR)
// =============================================================================

export interface VertexTranscriptionResult {
    text: string;
    confidence?: number;
}

export async function transcribeVertexAudio(
    modelId: string,
    audio: Buffer,
    options?: { language?: string }
): Promise<VertexTranscriptionResult> {
    if (!VERTEX_AI_API_KEY) {
        throw new Error("VERTEX_AI_API_KEY not configured");
    }

    // Chirp ASR model
    const url = `https://${VERTEX_LOCATION}-aiplatform.googleapis.com/v1/projects/${VERTEX_PROJECT_ID}/locations/${VERTEX_LOCATION}/publishers/google/models/${modelId}:predict`;

    const base64Audio = audio.toString("base64");

    const requestBody = {
        instances: [
            { content: base64Audio }
        ],
        parameters: {
            languageCode: options?.language || "en-US",
        }
    };

    console.log(`[vertex] Transcribing audio with ${modelId}`);

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
        console.error(`[vertex] ASR failed: ${response.status}`, errorText);
        throw new Error(`Vertex AI ASR failed: ${response.status} - ${errorText}`);
    }

    const data = await response.json();

    const prediction = data.predictions?.[0];
    if (!prediction?.alternatives?.[0]?.transcript) {
        throw new Error("No transcription in Vertex AI response");
    }

    return {
        text: prediction.alternatives[0].transcript,
        confidence: prediction.alternatives[0].confidence,
    };
}

// =============================================================================
// Embeddings
// =============================================================================

export interface VertexEmbeddingResult {
    embeddings: number[][];
}

export async function generateVertexEmbeddings(
    modelId: string,
    inputs: string[]
): Promise<VertexEmbeddingResult> {
    if (!VERTEX_AI_API_KEY) {
        throw new Error("VERTEX_AI_API_KEY not configured");
    }

    // Text embedding models (textembedding-gecko, etc.)
    const url = `https://${VERTEX_LOCATION}-aiplatform.googleapis.com/v1/projects/${VERTEX_PROJECT_ID}/locations/${VERTEX_LOCATION}/publishers/google/models/${modelId}:predict`;

    const requestBody = {
        instances: inputs.map(text => ({ content: text })),
    };

    console.log(`[vertex] Generating embeddings for ${inputs.length} inputs with ${modelId}`);

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
        console.error(`[vertex] Embeddings failed: ${response.status}`, errorText);
        throw new Error(`Vertex AI embeddings failed: ${response.status} - ${errorText}`);
    }

    const data = await response.json();

    if (!data.predictions || !Array.isArray(data.predictions)) {
        throw new Error("Invalid embedding response from Vertex AI");
    }

    const embeddings = data.predictions.map((pred: any) => {
        // Different embedding models return different field names
        return pred.embeddings?.values || pred.embedding?.values || pred.values || [];
    });

    return { embeddings };
}
