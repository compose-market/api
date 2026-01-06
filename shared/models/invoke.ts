/**
 * Central Invocation Layer
 * 
 * Single source of truth for ALL provider invocations across ALL modalities.
 * Routes to correct provider based on modelCard.provider.
 * 
 * This module is the ONLY place where provider-specific functions are called.
 * All API handlers (openai/endpoints.ts) use this module.
 */

import { getModelById, getLanguageModel } from "./registry.js";
import type { ModelCard, ModelProvider } from "./types.js";

// Provider-specific imports
import {
    generateImage as googleGenerateImage,
    generateVideo as googleGenerateVideo,
    generateSpeech as googleGenerateSpeech,
} from "./providers/genai.js";

import {
    openaiGenerateImage,
    openaiGenerateVideo,
    openaiGenerateSpeech,
    openaiTranscribeAudio,
} from "./providers/openai.js";

import {
    executeHFInference,
    type HFInferenceInput,
} from "./providers/huggingface.js";

// AI SDK imports
import { streamText, generateText, embedMany } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { openai } from "@ai-sdk/openai";
import { anthropic } from "@ai-sdk/anthropic";
import { google } from "@ai-sdk/google";

// Google GenAI SDK for video generation
import { GoogleGenAI } from "@google/genai";


// =============================================================================
// Types
// =============================================================================

export interface ChatMessage {
    role: "system" | "user" | "assistant" | "tool";
    content: string;
}

export interface ChatOptions {
    stream?: boolean;
    maxTokens?: number;
    temperature?: number;
    onToken?: (token: string) => void;
    onComplete?: (result: { usage: TokenUsage }) => void;
}

export interface TokenUsage {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
}

export interface ChatResult {
    content: string;
    usage: TokenUsage;
    finishReason?: string;
}

export interface ImageOptions {
    size?: string;
    quality?: string;
    n?: number;
}

export interface ImageResult {
    buffer: Buffer;
    mimeType: string;
}

export interface VideoOptions {
    duration?: number;
    aspectRatio?: string;
    resolution?: string;
}

export interface VideoResult {
    buffer: Buffer;
    mimeType: string;
}

// Async video job types (for long-running video generation)
export interface VideoJobResult {
    jobId: string;  // Format: "provider:provider_job_id"
    status: "queued" | "processing";
}

export interface VideoJobStatus {
    jobId: string;
    status: "queued" | "processing" | "completed" | "failed";
    url?: string;      // Video URL when completed
    error?: string;    // Error message if failed
    progress?: number; // 0-100 if provider supports it
}

export interface TTSOptions {
    voice?: string;
    speed?: number;
    responseFormat?: string;
}

export interface ASROptions {
    language?: string;
    responseFormat?: string;
}

export interface ASRResult {
    text: string;
    language?: string;
    duration?: number;
}

export interface EmbeddingOptions {
    dimensions?: number;
}

export interface EmbeddingResult {
    embeddings: number[][];
    usage: { promptTokens: number; totalTokens: number };
}

// =============================================================================
// Helper: Get Provider from Model
// =============================================================================

function getProvider(modelId: string): { provider: ModelProvider; card: ModelCard | null } {
    const card = getModelById(modelId);
    if (card) {
        return { provider: card.provider, card };
    }

    // Throw error if model not in registry
    console.error(`[invoke] Model not found in registry: ${modelId}`);
    throw new Error(`Model not found: ${modelId}. Ensure model is in the compiled registry.`);
}

// =============================================================================
// Chat/Text Generation
// =============================================================================

/**
 * Invoke chat/text generation for any provider
 */
export async function invokeChat(
    modelId: string,
    messages: ChatMessage[],
    options: ChatOptions = {}
): Promise<ChatResult | void> {
    console.log(`[invokeChat] Starting chat for modelId: "${modelId}"`);
    const modelInstance = getLanguageModel(modelId);
    console.log(`[invokeChat] Got model instance, modelId in instance: ${(modelInstance as any).modelId || "unknown"}`);

    const mappedMessages = messages.map(m => ({
        role: m.role as "system" | "user" | "assistant",
        content: m.content,
    }));

    if (options.stream) {
        console.log(`[invokeChat] Starting streaming mode`);
        console.log(`[invokeChat] Model instance config:`, JSON.stringify({
            modelId: (modelInstance as any).modelId,
            provider: (modelInstance as any).provider,
            config: (modelInstance as any).config ? {
                baseURL: (modelInstance as any).config.baseURL,
                name: (modelInstance as any).config.name,
            } : "N/A"
        }, null, 2));
        const result = streamText({
            model: modelInstance,
            messages: mappedMessages,
        });

        let chunkCount = 0;
        for await (const chunk of result.textStream) {
            chunkCount++;
            if (chunkCount <= 3) {
                console.log(`[invokeChat] Stream chunk ${chunkCount}: "${chunk.substring(0, 100)}"`);
            }
            if (options.onToken) options.onToken(chunk);
        }
        console.log(`[invokeChat] Streaming complete. Total chunks: ${chunkCount}`);

        const usage = await result.usage;
        if (options.onComplete) {
            options.onComplete({
                usage: {
                    promptTokens: (usage as any)?.promptTokens || 0,
                    completionTokens: (usage as any)?.completionTokens || 0,
                    totalTokens: (usage as any)?.totalTokens || 0,
                }
            });
        }
        return;
    }

    // Non-streaming mode
    const result = await generateText({
        model: modelInstance,
        messages: mappedMessages,
    });

    return {
        content: result.text,
        usage: {
            promptTokens: (result.usage as any)?.promptTokens || 0,
            completionTokens: (result.usage as any)?.completionTokens || 0,
            totalTokens: (result.usage as any)?.totalTokens || 0,
        },
        finishReason: result.finishReason,
    };
}

// =============================================================================
// Image Generation
// =============================================================================

/**
 * Invoke image generation for any provider
 */
export async function invokeImage(
    modelId: string,
    prompt: string,
    options: ImageOptions = {}
): Promise<ImageResult> {
    const { provider } = getProvider(modelId);

    switch (provider) {
        case "google":
            const googleBuffer = await googleGenerateImage(modelId, prompt, {
                numberOfImages: options.n,
            });
            return { buffer: googleBuffer, mimeType: "image/png" };

        case "openai":
            const openaiBuffer = await openaiGenerateImage(modelId, prompt, {
                size: options.size as any,
                quality: options.quality as any,
                n: options.n,
            });
            return { buffer: openaiBuffer, mimeType: "image/png" };

        case "aiml":
            // AIML uses OpenAI-compatible API for image generation
            const aimlApiKey = process.env.AI_ML_API_KEY;
            if (!aimlApiKey) {
                throw new Error("AI_ML_API_KEY not configured");
            }
            console.log(`[aiml] Generating image with ${modelId}: "${prompt.slice(0, 50)}..."`);

            const aimlResponse = await fetch("https://api.aimlapi.com/v1/images/generations", {
                method: "POST",
                headers: {
                    "Authorization": `Bearer ${aimlApiKey}`,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    model: modelId,
                    prompt,
                    n: options.n || 1,
                    size: options.size || "1024x1024",
                }),
            });

            if (!aimlResponse.ok) {
                const errorText = await aimlResponse.text();
                console.error(`[aiml] Image generation failed: ${aimlResponse.status}`, errorText);
                throw new Error(`AIML image generation failed: ${aimlResponse.status} - ${errorText}`);
            }

            const aimlData = await aimlResponse.json() as { data: Array<{ b64_json?: string; url?: string }> };
            if (!aimlData.data || aimlData.data.length === 0) {
                throw new Error("No image data returned from AIML");
            }

            const aimlImage = aimlData.data[0];
            if (aimlImage.b64_json) {
                return { buffer: Buffer.from(aimlImage.b64_json, "base64"), mimeType: "image/png" };
            } else if (aimlImage.url) {
                // Fetch the image from URL
                const imgResponse = await fetch(aimlImage.url);
                const imgBuffer = Buffer.from(await imgResponse.arrayBuffer());
                return { buffer: imgBuffer, mimeType: "image/png" };
            }
            throw new Error("AIML returned no image data");

        case "huggingface":
        default:
            const hfInput: HFInferenceInput = {
                modelId: modelId,
                task: "text-to-image",
                prompt,
            };
            const hfResult = await executeHFInference(hfInput);
            return { buffer: hfResult.data as Buffer, mimeType: "image/png" };
    }
}

// =============================================================================
// Video Generation
// =============================================================================

/**
 * Invoke video generation for any provider
 */
export async function invokeVideo(
    modelId: string,
    prompt: string,
    options: VideoOptions = {}
): Promise<VideoResult> {
    const { provider } = getProvider(modelId);

    switch (provider) {
        case "google":
            const googleResult = await googleGenerateVideo(modelId, prompt, {
                duration: options.duration,
                aspectRatio: options.aspectRatio as any,
            });
            return { buffer: googleResult.videoBuffer, mimeType: googleResult.mimeType };

        case "openai":
            const openaiResult = await openaiGenerateVideo(modelId, prompt, {
                duration: options.duration,
                resolution: options.resolution as any,
                aspectRatio: options.aspectRatio as any,
            });
            return { buffer: openaiResult.videoBuffer, mimeType: openaiResult.mimeType };

        case "aiml":
            // AIML uses v2 API for video generation (ASYNC - returns job ID, then poll)
            const aimlVideoApiKey = process.env.AI_ML_API_KEY;
            if (!aimlVideoApiKey) {
                throw new Error("AI_ML_API_KEY not configured");
            }
            console.log(`[aiml] Generating video with ${modelId}: "${prompt.slice(0, 50)}..."`);

            const aimlVideoResponse = await fetch("https://api.aimlapi.com/v2/generate/video/kling/generation", {
                method: "POST",
                headers: {
                    "Authorization": `Bearer ${aimlVideoApiKey}`,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    model: modelId,
                    prompt,
                    aspect_ratio: options.aspectRatio || "16:9",
                    duration: options.duration?.toString() || "5",
                }),
            });

            if (!aimlVideoResponse.ok) {
                const errorText = await aimlVideoResponse.text();
                console.error(`[aiml] Video generation failed: ${aimlVideoResponse.status}`, errorText);
                throw new Error(`AIML video generation failed: ${aimlVideoResponse.status} - ${errorText}`);
            }

            const aimlVideoData = await aimlVideoResponse.json() as {
                id?: string;
                status?: string;
                data?: { video?: { url?: string } };
                video_url?: string;
                url?: string;
                video?: { url?: string };
            };
            console.log("[aiml] Video initial response:", JSON.stringify(aimlVideoData));

            // Check if this is an async response that needs polling
            if (aimlVideoData.id && aimlVideoData.status && !aimlVideoData.url && !aimlVideoData.video?.url && !aimlVideoData.video_url) {
                console.log(`[aiml] Async job started: ${aimlVideoData.id}, status: ${aimlVideoData.status}`);

                // Poll for completion (max 5 minutes)
                const jobId = aimlVideoData.id;
                const maxAttempts = 60; // 60 * 5s = 5 minutes
                let attempts = 0;

                while (attempts < maxAttempts) {
                    await new Promise(resolve => setTimeout(resolve, 5000)); // Wait 5 seconds
                    attempts++;

                    const pollResponse = await fetch(`https://api.aimlapi.com/v2/generate/video/kling/generation?generation_id=${jobId}`, {
                        method: "GET",
                        headers: {
                            "Authorization": `Bearer ${aimlVideoApiKey}`,
                        },
                    });

                    if (!pollResponse.ok) {
                        console.warn(`[aiml] Poll failed: ${pollResponse.status}`);
                        continue;
                    }

                    const pollData = await pollResponse.json() as {
                        status?: string;
                        video?: { url?: string };
                        video_url?: string;
                        url?: string;
                        error?: string;
                    };
                    console.log(`[aiml] Poll attempt ${attempts}: status=${pollData.status}`);

                    if (pollData.status === "completed" || pollData.status === "success") {
                        const finalUrl = pollData.video?.url || pollData.video_url || pollData.url;
                        if (finalUrl) {
                            console.log(`[aiml] Video ready: ${finalUrl}`);
                            const videoFetchResponse = await fetch(finalUrl);
                            const videoBuffer = Buffer.from(await videoFetchResponse.arrayBuffer());
                            return { buffer: videoBuffer, mimeType: "video/mp4" };
                        }
                    } else if (pollData.status === "failed" || pollData.error) {
                        throw new Error(`AIML video generation failed: ${pollData.error || "Unknown error"}`);
                    }
                    // Otherwise continue polling...
                }
                throw new Error("AIML video generation timed out after 5 minutes");
            }

            // Synchronous response - video URL directly available
            const videoUrl = aimlVideoData.video?.url || aimlVideoData.data?.video?.url || aimlVideoData.video_url || aimlVideoData.url;
            if (!videoUrl) {
                console.log("[aiml] Video response (no URL found):", JSON.stringify(aimlVideoData));
                throw new Error("AIML returned no video URL");
            }

            // Fetch the video from URL
            const videoResponse = await fetch(videoUrl);
            const videoBuffer = Buffer.from(await videoResponse.arrayBuffer());
            return { buffer: videoBuffer, mimeType: "video/mp4" };

        case "huggingface":
        default:
            const hfInput: HFInferenceInput = {
                modelId: modelId,
                task: "text-to-video",
                prompt,
            };
            const hfResult = await executeHFInference(hfInput);
            return { buffer: hfResult.data as Buffer, mimeType: "video/mp4" };
    }
}

// =============================================================================
// Text-to-Speech
// =============================================================================

/**
 * Invoke TTS for any provider
 */
export async function invokeTTS(
    modelId: string,
    text: string,
    options: TTSOptions = {}
): Promise<Buffer> {
    const { provider } = getProvider(modelId);

    switch (provider) {
        case "google":
            return googleGenerateSpeech(modelId, text, {
                voice: options.voice,
            });

        case "openai":
            return openaiGenerateSpeech(modelId, text, {
                voice: options.voice as any,
                speed: options.speed,
                responseFormat: options.responseFormat as any,
            });

        case "huggingface":
        default:
            const hfInput: HFInferenceInput = {
                modelId: modelId,
                task: "text-to-speech",
                prompt: text,
            };
            const hfResult = await executeHFInference(hfInput);
            return hfResult.data as Buffer;
    }
}

// =============================================================================
// Speech-to-Text (ASR)
// =============================================================================

/**
 * Invoke ASR/transcription for any provider
 */
export async function invokeASR(
    modelId: string,
    audio: Buffer,
    options: ASROptions = {}
): Promise<ASRResult> {
    const { provider } = getProvider(modelId);

    switch (provider) {
        case "google":
            // Google doesn't have a direct transcribeAudio export - use HF fallback
            // or implement via Google Cloud Speech API if needed
            console.warn("[invoke] Google ASR not implemented, falling back to OpenAI");
        // Fallthrough to OpenAI

        case "openai":
            const openaiResult = await openaiTranscribeAudio(modelId, audio, {
                language: options.language,
                responseFormat: options.responseFormat as any,
            });
            return { text: openaiResult.text };

        case "huggingface":
        default:
            const hfInput: HFInferenceInput = {
                modelId: modelId,
                task: "automatic-speech-recognition",
                audio: audio.toString("base64"),
            };
            const hfASRResult = await executeHFInference(hfInput);
            // HFInferenceResult doesn't have text, check result type
            if (hfASRResult.type === "text" && typeof hfASRResult.data === "string") {
                return { text: hfASRResult.data };
            }
            return { text: "" };
    }
}

// =============================================================================
// Embeddings
// =============================================================================

/**
 * Invoke embeddings for any provider
 */
export async function invokeEmbedding(
    modelId: string,
    input: string | string[],
    options: EmbeddingOptions = {}
): Promise<EmbeddingResult> {
    const { provider } = getProvider(modelId);
    const inputs = Array.isArray(input) ? input : [input];

    let embeddingModel;
    switch (provider) {
        case "google":
            embeddingModel = google.textEmbeddingModel(modelId);
            break;
        case "openai":
        default:
            embeddingModel = openai.embedding(modelId);
            break;
    }

    const result = await embedMany({
        model: embeddingModel,
        values: inputs,
    });

    return {
        embeddings: result.embeddings,
        usage: {
            promptTokens: (result.usage as any)?.tokens || inputs.join("").length / 4,
            totalTokens: (result.usage as any)?.tokens || inputs.join("").length / 4,
        },
    };
}

// =============================================================================
// Async Video Generation (for long-running jobs)
// =============================================================================

/**
 * Submit a video generation job and return immediately with job ID
 * Use checkVideoJobStatus to poll for completion
 */
export async function submitVideoJob(
    modelId: string,
    prompt: string,
    options: VideoOptions = {}
): Promise<VideoJobResult> {
    const { provider } = getProvider(modelId);

    switch (provider) {
        case "aiml": {
            const apiKey = process.env.AI_ML_API_KEY;
            if (!apiKey) {
                throw new Error("AI_ML_API_KEY not configured");
            }

            console.log(`[aiml] Submitting video job for ${modelId}: "${prompt.slice(0, 50)}..."`);

            const response = await fetch("https://api.aimlapi.com/v2/generate/video/kling/generation", {
                method: "POST",
                headers: {
                    "Authorization": `Bearer ${apiKey}`,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    model: modelId,
                    prompt,
                    aspect_ratio: options.aspectRatio || "16:9",
                    duration: options.duration?.toString() || "5",
                }),
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`AIML video submission failed: ${response.status} - ${errorText}`);
            }

            const data = await response.json() as { id?: string; status?: string };
            if (!data.id) {
                throw new Error("AIML returned no job ID");
            }

            console.log(`[aiml] Job submitted: ${data.id}, status: ${data.status}`);
            return {
                jobId: `aiml:${data.id}`,
                status: data.status === "queued" ? "queued" : "processing",
            };
        }

        case "openai": {
            // OpenAI Sora API: POST /videos
            const apiKey = process.env.OPENAI_API_KEY;
            if (!apiKey) {
                throw new Error("OPENAI_API_KEY not configured");
            }

            console.log(`[openai] Submitting video job for ${modelId}: "${prompt.slice(0, 50)}..."`);

            // Map aspectRatio to valid size
            let size = "1280x720"; // default 16:9 landscape
            if (options.aspectRatio === "9:16") size = "720x1280";
            else if (options.aspectRatio === "1:1") size = "1024x1792"; // No 1:1, use tall portrait

            const response = await fetch("https://api.openai.com/v1/videos", {
                method: "POST",
                headers: {
                    "Authorization": `Bearer ${apiKey}`,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    model: modelId.includes("sora") ? modelId : "sora-2",
                    prompt,
                    size,
                    seconds: String(options.duration && options.duration >= 8 ? (options.duration >= 12 ? 12 : 8) : 4),
                }),
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`OpenAI video submission failed: ${response.status} - ${errorText}`);
            }

            const data = await response.json() as { id?: string; status?: string };
            if (!data.id) {
                throw new Error("OpenAI returned no job ID");
            }

            console.log(`[openai] Job submitted: ${data.id}, status: ${data.status}`);
            return {
                jobId: `openai:${data.id}`,
                status: data.status === "queued" ? "queued" : "processing",
            };
        }

        case "google": {
            // Google Veo API using @google/genai SDK
            const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
            if (!apiKey) {
                throw new Error("GOOGLE_GENERATIVE_AI_API_KEY not configured");
            }

            console.log(`[google] Submitting video job for ${modelId}: "${prompt.slice(0, 50)}..."`);

            const client = new GoogleGenAI({ apiKey });

            // Use veo-3.1-generate-preview or the specified model
            const veoModel = modelId.includes("veo") ? modelId.replace("models/", "") : "veo-3.1-generate-preview";

            // Start the video generation operation
            const operation = await client.models.generateVideos({
                model: veoModel,
                prompt,
                config: {
                    ...(options.aspectRatio && { aspectRatio: options.aspectRatio as "16:9" | "9:16" }),
                    ...(options.duration && { durationSeconds: options.duration }),
                },
            });

            // The operation.name is the unique identifier for polling
            const operationName = (operation as unknown as { name?: string }).name;
            if (!operationName) {
                throw new Error("Google returned no operation name");
            }

            console.log(`[google] Operation submitted: ${operationName}`);
            return {
                jobId: `google:${operationName}`,
                status: "processing",
            };
        }

        case "huggingface": {
            // HuggingFace Inference API for video models
            const apiKey = process.env.HUGGING_FACE_INFERENCE_TOKEN || process.env.HF_TOKEN;
            if (!apiKey) {
                throw new Error("HUGGING_FACE_INFERENCE_TOKEN not configured");
            }

            console.log(`[huggingface] Submitting video job for ${modelId}: "${prompt.slice(0, 50)}..."`);

            // HuggingFace uses the Inference API with async mode
            const response = await fetch(`https://api-inference.huggingface.co/models/${modelId}`, {
                method: "POST",
                headers: {
                    "Authorization": `Bearer ${apiKey}`,
                    "Content-Type": "application/json",
                    "X-Wait-For-Model": "false", // Don't wait, return immediately
                },
                body: JSON.stringify({
                    inputs: prompt,
                    parameters: {
                        num_frames: (options.duration || 5) * 8, // ~8 fps estimate
                    },
                }),
            });

            // HuggingFace returns 503 with estimated_time when model is loading
            if (response.status === 503) {
                const data = await response.json() as { estimated_time?: number };
                // Return as queued with the model ID as job ID
                return {
                    jobId: `huggingface:${modelId}:${Date.now()}`,
                    status: "queued",
                };
            }

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`HuggingFace video submission failed: ${response.status} - ${errorText}`);
            }

            // If successful, it might return the video directly (sync) or a job ID
            const contentType = response.headers.get("content-type") || "";
            if (contentType.includes("video")) {
                // Sync response - video returned directly
                // We still return a "job" but mark it as needing immediate processing
                const buffer = Buffer.from(await response.arrayBuffer());
                const base64 = buffer.toString("base64");
                return {
                    jobId: `huggingface:sync:${base64.slice(0, 100)}`, // Store partial data
                    status: "processing", // Will be handled specially
                };
            }

            // Async response
            const data = await response.json() as { id?: string };
            return {
                jobId: `huggingface:${modelId}:${data.id || Date.now()}`,
                status: "processing",
            };
        }

        case "openrouter": {
            // OpenRouter routes to various video models
            const apiKey = process.env.OPEN_ROUTER_API_KEY;
            if (!apiKey) {
                throw new Error("OPEN_ROUTER_API_KEY not configured");
            }

            console.log(`[openrouter] Submitting video job for ${modelId}: "${prompt.slice(0, 50)}..."`);

            // OpenRouter uses a similar API to OpenAI
            const response = await fetch("https://openrouter.ai/api/v1/videos", {
                method: "POST",
                headers: {
                    "Authorization": `Bearer ${apiKey}`,
                    "Content-Type": "application/json",
                    "HTTP-Referer": "https://compose.market",
                },
                body: JSON.stringify({
                    model: modelId,
                    prompt,
                    duration: options.duration || 5,
                }),
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`OpenRouter video submission failed: ${response.status} - ${errorText}`);
            }

            const data = await response.json() as { id?: string; status?: string };
            if (!data.id) {
                throw new Error("OpenRouter returned no job ID");
            }

            return {
                jobId: `openrouter:${data.id}`,
                status: data.status === "queued" ? "queued" : "processing",
            };
        }

        default:
            throw new Error(`Provider ${provider} does not support async video generation`);
    }
}

/**
 * Check the status of a video generation job
 * Returns completed status with URL when done
 */
export async function checkVideoJobStatus(jobId: string): Promise<VideoJobStatus> {
    const [provider, ...idParts] = jobId.split(":");
    const providerJobId = idParts.join(":"); // Handle job IDs that might contain colons

    switch (provider) {
        case "aiml": {
            const apiKey = process.env.AI_ML_API_KEY;
            if (!apiKey) {
                throw new Error("AI_ML_API_KEY not configured");
            }

            const response = await fetch(`https://api.aimlapi.com/v2/generate/video/kling/generation?generation_id=${providerJobId}`, {
                method: "GET",
                headers: {
                    "Authorization": `Bearer ${apiKey}`,
                },
            });

            if (!response.ok) {
                const errorText = await response.text();
                console.error(`[aiml] Status check failed: ${response.status}`, errorText);
                return { jobId, status: "failed", error: `Status check failed: ${response.status}` };
            }

            const data = await response.json() as {
                status?: string;
                video?: { url?: string };
                video_url?: string;
                url?: string;
                error?: string;
                progress?: number;
            };

            console.log(`[aiml] Job ${providerJobId} status: ${data.status}`);

            if (data.status === "completed" || data.status === "success") {
                const videoUrl = data.video?.url || data.video_url || data.url;
                if (videoUrl) {
                    return { jobId, status: "completed", url: videoUrl };
                }
            }

            if (data.status === "failed" || data.error) {
                return { jobId, status: "failed", error: data.error || "Unknown error" };
            }

            return {
                jobId,
                status: data.status === "queued" ? "queued" : "processing",
                progress: data.progress,
            };
        }

        case "openai": {
            const apiKey = process.env.OPENAI_API_KEY;
            if (!apiKey) {
                throw new Error("OPENAI_API_KEY not configured");
            }

            // GET /videos/{video_id}
            const response = await fetch(`https://api.openai.com/v1/videos/${providerJobId}`, {
                method: "GET",
                headers: {
                    "Authorization": `Bearer ${apiKey}`,
                },
            });

            if (!response.ok) {
                const errorText = await response.text();
                console.error(`[openai] Status check failed: ${response.status}`, errorText);
                return { jobId, status: "failed", error: `Status check failed: ${response.status}` };
            }

            const data = await response.json() as {
                status?: string;
                error?: { message?: string };
            };

            console.log(`[openai] Job ${providerJobId} status: ${data.status}`);

            if (data.status === "completed") {
                // Fetch the actual video content with auth
                const contentUrl = `https://api.openai.com/v1/videos/${providerJobId}/content`;
                const videoResponse = await fetch(contentUrl, {
                    method: "GET",
                    headers: {
                        "Authorization": `Bearer ${apiKey}`,
                    },
                });

                if (!videoResponse.ok) {
                    console.error(`[openai] Failed to fetch video content: ${videoResponse.status}`);
                    return { jobId, status: "failed", error: `Failed to fetch video: ${videoResponse.status}` };
                }

                // Upload to Pinata so frontend can access without auth
                const videoBuffer = Buffer.from(await videoResponse.arrayBuffer());
                const pinataJwt = process.env.PINATA_JWT;

                if (pinataJwt) {
                    try {
                        const FormData = (await import("form-data")).default;
                        const formData = new FormData();
                        formData.append("file", videoBuffer, {
                            filename: `video-${providerJobId}.mp4`,
                            contentType: "video/mp4",
                        });

                        const pinataResponse = await fetch("https://api.pinata.cloud/pinning/pinFileToIPFS", {
                            method: "POST",
                            headers: {
                                "Authorization": `Bearer ${pinataJwt}`,
                                ...formData.getHeaders(),
                            },
                            body: formData as any,
                        });

                        if (pinataResponse.ok) {
                            const pinataData = await pinataResponse.json() as { IpfsHash: string };
                            const pinataUrl = `https://compose.mypinata.cloud/ipfs/${pinataData.IpfsHash}`;
                            console.log(`[openai] Video uploaded to Pinata: ${pinataUrl}`);
                            return { jobId, status: "completed", url: pinataUrl };
                        }
                    } catch (pinataError) {
                        console.error(`[openai] Pinata upload failed:`, pinataError);
                    }
                }

                // Fallback: return base64 data URL (not ideal but works)
                const base64 = videoBuffer.toString("base64");
                return { jobId, status: "completed", url: `data:video/mp4;base64,${base64}` };
            }

            if (data.status === "failed") {
                return { jobId, status: "failed", error: data.error?.message || "Video generation failed" };
            }

            return {
                jobId,
                status: data.status === "queued" ? "queued" : "processing",
            };
        }

        case "google": {
            const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
            if (!apiKey) {
                throw new Error("GOOGLE_GENERATIVE_AI_API_KEY not configured");
            }

            const client = new GoogleGenAI({ apiKey });

            try {
                // Create a minimal operation object to pass to getVideosOperation
                // The SDK expects the operation object, but we only have the name
                const operationObj = { name: providerJobId } as Parameters<typeof client.operations.getVideosOperation>[0]["operation"];

                const operation = await client.operations.getVideosOperation({
                    operation: operationObj,
                });

                console.log(`[google] Operation ${providerJobId} done: ${operation.done}`);

                if (operation.done) {
                    if (operation.error) {
                        const errMsg = (operation.error as { message?: string }).message || JSON.stringify(operation.error);
                        return {
                            jobId,
                            status: "failed",
                            error: errMsg || "Video generation failed"
                        };
                    }

                    // Extract video from response
                    const generatedVideo = operation.response?.generatedVideos?.[0];
                    if (generatedVideo?.video?.uri) {
                        return { jobId, status: "completed", url: generatedVideo.video.uri };
                    }
                    return { jobId, status: "failed", error: "No video URI in response" };
                }

                return { jobId, status: "processing" };
            } catch (err) {
                console.error(`[google] Status check failed:`, err);
                return {
                    jobId,
                    status: "failed",
                    error: err instanceof Error ? err.message : "Unknown error"
                };
            }
        }

        case "huggingface": {
            // HuggingFace doesn't have a standard polling API
            // For sync responses stored in jobId, extract and return
            if (providerJobId.startsWith("sync:")) {
                // This was a sync response - mark as completed
                return { jobId, status: "completed" };
            }

            const apiKey = process.env.HUGGING_FACE_INFERENCE_TOKEN || process.env.HF_TOKEN;
            if (!apiKey) {
                throw new Error("HUGGING_FACE_INFERENCE_TOKEN not configured");
            }

            // Parse modelId from jobId: huggingface:{modelId}:{timestamp}
            const [modelId] = providerJobId.split(":");

            // Re-query the model - HuggingFace will return the result if ready
            const response = await fetch(`https://api-inference.huggingface.co/models/${modelId}`, {
                method: "POST",
                headers: {
                    "Authorization": `Bearer ${apiKey}`,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    inputs: "status check", // Minimal input for status
                }),
            });

            if (response.status === 503) {
                // Still loading
                return { jobId, status: "queued" };
            }

            if (!response.ok) {
                return { jobId, status: "failed", error: `HuggingFace error: ${response.status}` };
            }

            // Model is ready - but we'd need the original prompt to generate
            // For now, return as completed (user should retry generation)
            return { jobId, status: "completed" };
        }

        case "openrouter": {
            const apiKey = process.env.OPEN_ROUTER_API_KEY;
            if (!apiKey) {
                throw new Error("OPEN_ROUTER_API_KEY not configured");
            }

            const response = await fetch(`https://openrouter.ai/api/v1/videos/${providerJobId}`, {
                method: "GET",
                headers: {
                    "Authorization": `Bearer ${apiKey}`,
                },
            });

            if (!response.ok) {
                const errorText = await response.text();
                console.error(`[openrouter] Status check failed: ${response.status}`, errorText);
                return { jobId, status: "failed", error: `Status check failed: ${response.status}` };
            }

            const data = await response.json() as {
                status?: string;
                url?: string;
                video_url?: string;
                error?: string;
            };

            if (data.status === "completed" || data.status === "success") {
                const videoUrl = data.url || data.video_url;
                if (videoUrl) {
                    return { jobId, status: "completed", url: videoUrl };
                }
            }

            if (data.status === "failed" || data.error) {
                return { jobId, status: "failed", error: data.error || "Video generation failed" };
            }

            return {
                jobId,
                status: data.status === "queued" ? "queued" : "processing",
            };
        }

        default:
            return { jobId, status: "failed", error: `Unknown provider: ${provider}` };
    }
}
