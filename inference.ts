/**
 * x402 AI Inference Handler
 * 
 * Uses dynamic model registry - ALWAYS routes to cheapest provider automatically.
 * Pricing comes from provider APIs, not hardcoded values.
 * 
 * x402 Payment Flow:
 * 1. Client sends x-payment header with signed payment authorization
 * 2. Server verifies payment via Thirdweb facilitator
 * 3. After processing, server settles actual cost
 * 
 * Test Mode (x-session-active: true):
 * - Allows testing without real payments
 * - Client tracks budget locally
 * 
 * Supports multimodal tasks:
 * - text-generation (chat/completion)
 * - text-to-image (Stable Diffusion, FLUX, etc.)
 * - text-to-speech (TTS models)
 * - automatic-speech-recognition (Whisper, etc.)
 * - feature-extraction (embeddings)
 */
import type { Request, Response } from "express";
import { streamText, smoothStream, type CoreMessage } from "ai";

/**
 * Model Configuration
 *
 * Fetches model pricing and routing information.
 * Handles multi-provider routing (HuggingFace, ASI, OpenAI, etc.)
 *
 * Pricing is in wei per token.
 * Example: 100 wei/token on HF Router = 0.0000001 AVAX/token
 */
import {
  getLanguageModel,
  getModelInfo,
  getModelsBySource,
  getModelRegistry,
  calculateCost,
  calculateInferenceCost,
  getAvailableModels as getAvailableModelsList,
  DEFAULT_MODEL,
  type ModelInfo,
} from "./shared/models.js";
import { handleX402Payment, extractPaymentInfo } from "./lib/payment.js";
import { INFERENCE_PRICE_WEI } from "./shared/thirdweb.js";
import {
  generateImage as googleGenerateImage,
  generateVideo as googleGenerateVideo,
  generateAudio as googleGenerateAudio,
  generateSpeech as googleGenerateSpeech,
} from "./genai.js";

const HF_TOKEN = process.env.HUGGING_FACE_INFERENCE_TOKEN;

// =============================================================================
// Inference Endpoint
// =============================================================================

/**
 * x402 AI Inference endpoint
 *
 * Payment flow:
 * 1. Client sends x-session-user-address header with their wallet address
 * 2. Server verifies user has approved spending (via session creation)
 * 3. After processing, server pulls actual cost from user's allowance
 */
export async function handleInference(req: Request, res: Response, paymentVerified = false) {
  try {
    // x402 Payment Verification - skip if already verified by caller
    if (!paymentVerified) {
      const { paymentData } = extractPaymentInfo(
        req.headers as Record<string, string | string[] | undefined>
      );

      const resourceUrl = `https://${req.get("host")}${req.originalUrl}`;
      const paymentResult = await handleX402Payment(
        paymentData,
        resourceUrl,
        "POST",
        INFERENCE_PRICE_WEI.toString(),
      );

      if (paymentResult.status !== 200) {
        Object.entries(paymentResult.responseHeaders).forEach(([key, value]) => {
          res.setHeader(key, value);
        });
        return res.status(paymentResult.status).json(paymentResult.responseBody);
      }
      console.log(`[inference] x402 payment verified`);
    } else {
      console.log(`[inference] x402 payment already verified by caller`);
    }

    // Parse request body
    const {
      messages,
      modelId = DEFAULT_MODEL,
      systemPrompt = "You are a helpful AI assistant.",
    }: {
      messages: CoreMessage[];
      modelId?: string;
      systemPrompt?: string;
    } = req.body;

    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: "messages array is required" });
    }

    // Get model info from dynamic registry
    const modelInfo = await getModelInfo(modelId);

    // Get the language model instance (automatically uses cheapest provider)
    const model = getLanguageModel(modelId, modelInfo?.source);
    const modelName = modelInfo?.name || modelId;
    const provider = modelInfo?.pricing?.provider || modelInfo?.source || "unknown";

    console.log(`[inference] Model: ${modelName}, Provider: ${provider} (cheapest)`);

    // Set up streaming headers
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    // Stream AI response
    const stream = streamText({
      model,
      system: systemPrompt,
      messages: messages as CoreMessage[],
      experimental_transform: [
        smoothStream({ chunking: "word" }),
      ],
      onFinish: async (event) => {
        // AI SDK uses these property names
        const usage = event.usage as { promptTokens?: number; completionTokens?: number } | undefined;
        const inputTokens = usage?.promptTokens || 0;
        const outputTokens = usage?.completionTokens || 0;
        const totalTokens = inputTokens + outputTokens;

        if (totalTokens === 0) {
          console.error("[inference] Token usage data not available");
          return;
        }

        // Calculate cost using dynamic pricing from registry
        const { costUsd, costUsdcWei, provider: pricingProvider } = await calculateCost(
          modelId,
          inputTokens,
          outputTokens
        );

        console.log(`[inference] Cost: $${costUsd.toFixed(6)} (${costUsdcWei} wei) via ${pricingProvider || provider}`);

        // Payment already settled via x402
        console.log(`[inference] Usage: ${costUsdcWei} wei for ${totalTokens} tokens`);
      },
    });

    // Stream response to client
    const response = stream.toTextStreamResponse();
    const reader = response.body?.getReader();

    if (!reader) {
      return res.status(500).json({ error: "Failed to create stream" });
    }

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        res.end();
        break;
      }
      res.write(value);
    }
  } catch (error) {
    console.error("[inference] Error:", error);
    if (!res.headersSent) {
      res.status(500).json({
        error: "Inference failed",
        message: error instanceof Error ? error.message : "Unknown error"
      });
    }
  }
}

// =============================================================================
// Models Endpoint - Returns dynamic registry data
// =============================================================================

export async function handleGetModels(_req: Request, res: Response) {
  try {
    const registry = await getModelRegistry();
    const availableModels = await getAvailableModelsList();

    // Format for API response
    const models = availableModels.map((m: ModelInfo) => ({
      id: m.id,
      name: m.name,
      source: m.source,
      ownedBy: m.ownedBy,
      task: m.task || "text-generation",
      available: m.available,
      contextLength: m.contextLength,
      architecture: m.architecture,
      // Cheapest provider is automatically selected
      pricing: m.pricing ? {
        provider: m.pricing.provider,
        inputPerMillion: m.pricing.input,
        outputPerMillion: m.pricing.output,
      } : null,
      // All providers (for reference only - cheapest is auto-selected)
      allProviders: m.providers.map((p) => ({
        provider: p.provider,
        status: p.status,
        pricing: p.pricing,
      })),
    }));

    res.json({
      models,
      total: models.length,
      sources: registry.sources,
      lastUpdated: registry.lastUpdated,
      note: "Cheapest provider is always automatically selected",
      paymentChain: "avalanche-fuji",
      paymentToken: "USDC",
    });
  } catch (error) {
    console.error("[models] Error fetching registry:", error);
    res.status(500).json({
      error: "Failed to fetch models",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
}

// =============================================================================
// Multimodal Inference - HuggingFace Inference API
// =============================================================================

/**
 * Determine task type from model info or ID
 */
function getTaskType(modelId: string, modelInfo?: ModelInfo | null): string {
  if (modelInfo?.task) return modelInfo.task;

  const lowerId = modelId.toLowerCase();
  if (lowerId.includes("flux") || lowerId.includes("stable-diffusion") || lowerId.includes("sdxl")) {
    return "text-to-image";
  }
  if (lowerId.includes("whisper")) {
    return "automatic-speech-recognition";
  }
  if (lowerId.includes("tts") || lowerId.includes("bark") || lowerId.includes("speecht5")) {
    return "text-to-speech";
  }
  if (lowerId.includes("embed") || lowerId.includes("e5") || lowerId.includes("bge") || lowerId.includes("minilm") || lowerId.includes("sentence-transformer")) {
    return "feature-extraction";
  }
  return "text-generation";
}

/**
 * Text-to-Image inference (FLUX, Stable Diffusion, etc.)
 * Uses HuggingFace InferenceClient with provider fallback strategy:
 * 1. Try hf-inference (free HuggingFace inference)
 * 2. Try wavespeed (usually free)
 * 3. Try replicate (usually free)
 * 4. Try auto as last resort
 * 
 * Avoids fal-ai which requires PRO subscription
 */
async function handleImageGeneration(modelId: string, prompt: string): Promise<Buffer> {
  if (!HF_TOKEN) throw new Error("HuggingFace token not configured");

  const { InferenceClient } = await import("@huggingface/inference");
  const client = new InferenceClient(HF_TOKEN);

  // Providers to try in order (hf-inference first, avoid fal-ai which needs PRO)
  const providersToTry = ["hf-inference", "wavespeed", "replicate", "novita"] as const;

  let lastError: Error | null = null;

  for (const provider of providersToTry) {
    try {
      console.log(`[inference] Text-to-image: ${modelId} with provider=${provider}`);

      const result = await client.textToImage({
        provider,
        model: modelId,
        inputs: prompt,
      });

      // Handle different return types (Blob in browser, Buffer/ArrayBuffer in Node)
      const blob = result as unknown as Blob;
      if (typeof blob.arrayBuffer === "function") {
        const arrayBuffer = await blob.arrayBuffer();
        return Buffer.from(arrayBuffer);
      }
      return Buffer.from(result as unknown as ArrayBuffer);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(`[inference] Provider ${provider} failed: ${message}`);
      lastError = error instanceof Error ? error : new Error(message);

      // If it's a PRO requirement error or provider doesn't support model, try next
      if (message.includes("PRO") || message.includes("not supported") ||
        message.includes("not available") || message.includes("404")) {
        continue;
      }

      // For loading errors, don't retry different providers
      if (message.includes("loading") || message.includes("503")) {
        throw new Error(`Model "${modelId}" is loading. Please try again in 20-30 seconds.`);
      }
    }
  }

  // All providers failed
  const errorMessage = lastError?.message || "Unknown error";
  if (errorMessage.includes("not found") || errorMessage.includes("404")) {
    throw new Error(
      `Model "${modelId}" is not available for text-to-image inference. ` +
      `Try "black-forest-labs/FLUX.1-schnell" or "stabilityai/stable-diffusion-xl-base-1.0".`
    );
  }

  throw new Error(`Image generation failed: ${errorMessage}`);
}

/**
 * Image-to-Image inference (FLUX.2-dev, etc.)
 * Uses HuggingFace InferenceClient with provider fallback strategy:
 * 1. Try wavespeed (supports FLUX.2-dev, usually free)
 * 2. Try hf-inference (free HuggingFace inference)
 * 3. Try replicate (usually free)
 * 4. Try novita
 * 
 * Avoids fal-ai which requires PRO subscription
 */
async function handleImageToImage(modelId: string, inputImage: string, prompt: string): Promise<Buffer> {
  if (!HF_TOKEN) throw new Error("HuggingFace token not configured");

  const { InferenceClient } = await import("@huggingface/inference");
  const client = new InferenceClient(HF_TOKEN);

  // Convert base64 to Blob for the input image (HF client expects Blob)
  const imageBuffer = Buffer.from(inputImage, "base64");
  const imageBlob = new Blob([new Uint8Array(imageBuffer)], { type: "image/png" });

  // Providers to try in order (wavespeed first for FLUX.2-dev, avoid fal-ai which needs PRO)
  const providersToTry = ["wavespeed", "hf-inference", "replicate", "novita"] as const;

  let lastError: Error | null = null;

  for (const provider of providersToTry) {
    try {
      console.log(`[inference] Image-to-image: ${modelId} with provider=${provider}`);

      const result = await client.imageToImage({
        provider,
        model: modelId,
        inputs: imageBlob,
        parameters: { prompt },
      });

      // Handle different return types (Blob in browser, Buffer/ArrayBuffer in Node)
      const blob = result as unknown as Blob;
      if (typeof blob.arrayBuffer === "function") {
        const arrayBuffer = await blob.arrayBuffer();
        return Buffer.from(arrayBuffer);
      }
      return Buffer.from(result as unknown as ArrayBuffer);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(`[inference] Provider ${provider} failed: ${message}`);
      lastError = error instanceof Error ? error : new Error(message);

      // If it's a PRO requirement error or provider doesn't support model, try next
      if (message.includes("PRO") || message.includes("not supported") ||
        message.includes("not available") || message.includes("404") ||
        message.includes("Upgrade")) {
        continue;
      }

      // For loading errors, don't retry different providers
      if (message.includes("loading") || message.includes("503")) {
        throw new Error(`Model "${modelId}" is loading. Please try again in 20-30 seconds.`);
      }
    }
  }

  // All providers failed
  const errorMessage = lastError?.message || "Unknown error";
  if (errorMessage.includes("not found") || errorMessage.includes("404")) {
    throw new Error(
      `Model "${modelId}" is not available for image-to-image inference. ` +
      `Try "black-forest-labs/FLUX.2-dev" with an input image.`
    );
  }

  throw new Error(`Image-to-image failed: ${errorMessage}`);
}

/**
 * Text-to-Speech inference
 * Uses HuggingFace Router API for TTS models
 */
async function handleTTS(modelId: string, text: string): Promise<Buffer> {
  if (!HF_TOKEN) throw new Error("HuggingFace token not configured");

  const response = await fetch(`https://router.huggingface.co/hf-inference/models/${modelId}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${HF_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ inputs: text }),
  });

  if (!response.ok) {
    const error = await response.text();
    if (error === "Not Found" || response.status === 404) {
      throw new Error(`TTS model "${modelId}" is not available for inference. Try "facebook/mms-tts-eng" or "microsoft/speecht5_tts".`);
    }
    if (error.includes("loading") || response.status === 503) {
      throw new Error(`TTS model "${modelId}" is loading. Please try again in 20-30 seconds.`);
    }
    throw new Error(`TTS failed: ${error}`);
  }

  return Buffer.from(await response.arrayBuffer());
}

/**
 * Automatic Speech Recognition (Whisper, etc.)
 * Uses HuggingFace InferenceClient with provider="auto" for automatic provider routing
 * See: https://huggingface.co/docs/inference-providers/guides/building-first-app
 */
async function handleASR(modelId: string, audioBuffer: Buffer): Promise<{ text: string }> {
  if (!HF_TOKEN) throw new Error("HuggingFace token not configured");

  try {
    const { InferenceClient } = await import("@huggingface/inference");
    const client = new InferenceClient(HF_TOKEN);

    console.log(`[inference] ASR: ${modelId} with provider=auto`);

    // Use provider="auto" to automatically route to the best available provider
    // Convert Buffer to Blob for the HF client (use Uint8Array to avoid type issues)
    const audioBlob = new Blob([new Uint8Array(audioBuffer)], { type: "audio/wav" });
    const result = await client.automaticSpeechRecognition({
      provider: "auto",
      model: modelId,
      inputs: audioBlob,
    });

    return { text: result.text };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (message.includes("not found") || message.includes("404")) {
      throw new Error(
        `ASR model "${modelId}" is not available for inference. ` +
        `Try "openai/whisper-large-v3" or "openai/whisper-small".`
      );
    }
    if (message.includes("loading") || message.includes("503")) {
      throw new Error(`ASR model "${modelId}" is loading. Please try again in 20-30 seconds.`);
    }

    throw new Error(`ASR failed: ${message}`);
  }
}

/**
 * Feature extraction (embeddings) and sentence similarity
 * Uses HuggingFace Router API for embedding models
 *
 * For sentence-similarity models (sentence-transformers), use:
 *   { source_sentence: "text", sentences: ["text1", "text2"] }
 * For feature-extraction models, use:
 *   { inputs: "text" or ["text1", "text2"] }
 */
async function handleEmbeddings(
  modelId: string,
  text: string | string[],
  task: string = "feature-extraction"
): Promise<number[] | number[][]> {
  if (!HF_TOKEN) throw new Error("HuggingFace token not configured");

  // Prepare body based on task type
  let body: object;
  if (task === "sentence-similarity") {
    // Sentence-similarity needs source_sentence + sentences format
    const texts = Array.isArray(text) ? text : [text];
    body = {
      inputs: {
        source_sentence: texts[0],
        sentences: texts.length > 1 ? texts.slice(1) : texts
      }
    };
  } else {
    // Regular feature-extraction uses inputs directly
    body = { inputs: text };
  }

  const response = await fetch(`https://router.huggingface.co/hf-inference/models/${modelId}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${HF_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const error = await response.text();
    if (error === "Not Found" || response.status === 404) {
      throw new Error(`Embedding model "${modelId}" is not available for inference. Try "sentence-transformers/all-MiniLM-L6-v2".`);
    }
    if (error.includes("loading") || response.status === 503) {
      throw new Error(`Embedding model "${modelId}" is loading. Please try again in 20-30 seconds.`);
    }
    throw new Error(`Embedding failed: ${error}`);
  }

  return response.json();
}

/**
 * Text-to-Video generation (Google Veo)
 * Uses Google's Generative Language API for video generation
 * 
 * Note: Veo models (veo-3.0-generate-preview, etc.) use a long-running operation pattern.
 * This handler initiates the generation and waits for completion.
 */
async function handleVideoGeneration(modelId: string, prompt: string, options?: {
  duration?: number;  // Duration in seconds (default: 5)
  aspectRatio?: string;  // e.g., "16:9", "9:16", "1:1"
}): Promise<{ videoUrl: string; operationId?: string }> {
  const GOOGLE_API_KEY = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  if (!GOOGLE_API_KEY) throw new Error("Google API key not configured");

  // Clean model ID (remove "models/" prefix if present)
  const cleanModelId = modelId.replace("models/", "");

  console.log(`[inference] Text-to-video: ${cleanModelId}`);

  // Google Veo uses the generateContent endpoint with video output
  // The actual endpoint may vary based on the model version
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${cleanModelId}:generateContent?key=${GOOGLE_API_KEY}`;

  const requestBody = {
    contents: [{
      parts: [{ text: prompt }]
    }],
    generationConfig: {
      responseModalities: ["VIDEO"],
      ...(options?.duration && { videoDuration: options.duration }),
      ...(options?.aspectRatio && { aspectRatio: options.aspectRatio }),
    }
  };

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const errorText = await response.text();

      // Check for model availability errors
      if (response.status === 404 || errorText.includes("not found")) {
        throw new Error(
          `Video model "${cleanModelId}" is not available. ` +
          `Veo models may require Vertex AI access. Try "veo-3.0-generate-preview" if available.`
        );
      }
      if (response.status === 400 && errorText.includes("not supported")) {
        throw new Error(
          `Model "${cleanModelId}" does not support video generation. ` +
          `Please select a Veo model for video generation.`
        );
      }
      throw new Error(`Video generation failed: ${errorText}`);
    }

    const data = await response.json() as {
      candidates?: Array<{
        content?: {
          parts?: Array<{
            fileData?: { fileUri: string; mimeType: string };
            text?: string;
          }>;
        };
      }>;
      error?: { message: string };
    };

    if (data.error) {
      throw new Error(`Video generation error: ${data.error.message}`);
    }

    // Extract video URL from response
    const videoPart = data.candidates?.[0]?.content?.parts?.find(p => p.fileData);
    if (!videoPart?.fileData?.fileUri) {
      throw new Error("No video generated in response");
    }

    return { videoUrl: videoPart.fileData.fileUri };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    // Provide helpful error messages
    if (message.includes("PERMISSION_DENIED") || message.includes("403")) {
      throw new Error(
        `Access denied to video model "${cleanModelId}". ` +
        `Veo models may require additional API access or Vertex AI.`
      );
    }

    throw error;
  }
}

/**
 * Text-to-Audio/Music generation (Google Lyria)
 * Uses Google's API for audio/music generation
 * 
 * Lyria 2 generates high-fidelity instrumental music from text prompts.
 */
async function handleAudioGeneration(modelId: string, prompt: string, options?: {
  duration?: number;  // Duration in seconds
  negativePrompt?: string;  // What to avoid in the generation
}): Promise<Buffer> {
  const GOOGLE_API_KEY = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  if (!GOOGLE_API_KEY) throw new Error("Google API key not configured");

  // Clean model ID
  const cleanModelId = modelId.replace("models/", "");

  console.log(`[inference] Text-to-audio: ${cleanModelId}`);

  // Google Lyria uses similar pattern to other generative models
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${cleanModelId}:generateContent?key=${GOOGLE_API_KEY}`;

  const requestBody = {
    contents: [{
      parts: [{ text: prompt }]
    }],
    generationConfig: {
      responseModalities: ["AUDIO"],
      ...(options?.duration && { audioDuration: options.duration }),
    },
    ...(options?.negativePrompt && {
      safetySettings: [{
        category: "HARM_CATEGORY_DANGEROUS_CONTENT",
        threshold: "BLOCK_NONE"
      }]
    })
  };

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const errorText = await response.text();

      if (response.status === 404 || errorText.includes("not found")) {
        throw new Error(
          `Audio model "${cleanModelId}" is not available. ` +
          `Lyria models may require Vertex AI access. Try "lyria-2.0-generate" if available.`
        );
      }
      if (response.status === 400 && errorText.includes("not supported")) {
        throw new Error(
          `Model "${cleanModelId}" does not support audio generation. ` +
          `Please select a Lyria model for music generation.`
        );
      }
      throw new Error(`Audio generation failed: ${errorText}`);
    }

    const data = await response.json() as {
      candidates?: Array<{
        content?: {
          parts?: Array<{
            inlineData?: { data: string; mimeType: string };
            fileData?: { fileUri: string; mimeType: string };
          }>;
        };
      }>;
      error?: { message: string };
    };

    if (data.error) {
      throw new Error(`Audio generation error: ${data.error.message}`);
    }

    // Extract audio from response
    const audioPart = data.candidates?.[0]?.content?.parts?.find(
      p => p.inlineData || p.fileData
    );

    if (audioPart?.inlineData?.data) {
      // Audio returned as base64 inline data
      return Buffer.from(audioPart.inlineData.data, "base64");
    }

    if (audioPart?.fileData?.fileUri) {
      // Audio returned as file URL - fetch it
      const audioResponse = await fetch(audioPart.fileData.fileUri);
      if (!audioResponse.ok) {
        throw new Error("Failed to download generated audio");
      }
      const arrayBuffer = await audioResponse.arrayBuffer();
      return Buffer.from(arrayBuffer);
    }

    throw new Error("No audio generated in response");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (message.includes("PERMISSION_DENIED") || message.includes("403")) {
      throw new Error(
        `Access denied to audio model "${cleanModelId}". ` +
        `Lyria models may require additional API access or Vertex AI.`
      );
    }

    throw error;
  }
}

/**
 * Unified multimodal inference endpoint
 * Routes to correct handler based on model task type
 */
export async function handleMultimodalInference(req: Request, res: Response) {
  try {
    const taskParam = req.query.task || req.body.task;
    const requestedTask = typeof taskParam === "string" ? taskParam : undefined;

    // Model ID from path or body
    const modelIdFromPath = req.params?.modelId;
    const modelId = (typeof modelIdFromPath === "string" ? modelIdFromPath : undefined) || req.body.modelId || DEFAULT_MODEL;

    const modelInfo = await getModelInfo(modelId);
    let task = requestedTask || getTaskType(modelId, modelInfo);

    // Auto-detect image-to-image if image is provided in body
    if (req.body.image && (task === "text-to-image" || task === "text-generation")) {
      console.log(`[inference] Request has image body, upgrading task ${task} -> image-to-image`);
      task = "image-to-image";
    }

    // x402 Payment Verification - ALWAYS required, no session bypass
    const { paymentData } = extractPaymentInfo(
      req.headers as Record<string, string | string[] | undefined>
    );

    const resourceUrl = `https://${req.get("host")}${req.originalUrl}`;
    const paymentResult = await handleX402Payment(
      paymentData,
      resourceUrl,
      "POST",
      INFERENCE_PRICE_WEI.toString(),
    );

    if (paymentResult.status !== 200) {
      Object.entries(paymentResult.responseHeaders).forEach(([key, value]) => {
        res.setHeader(key, value);
      });
      return res.status(paymentResult.status).json(paymentResult.responseBody);
    }
    console.log(`[inference] Multimodal x402 payment verified, task: ${task}`);

    // Route based on task
    switch (task) {
      case "image-to-image": {
        // Requires input image + prompt
        const { image, prompt } = req.body;
        if (!image) return res.status(400).json({ error: "image is required (base64)" });
        if (!prompt) return res.status(400).json({ error: "prompt is required for image-to-image" });

        const imageBuffer = await handleImageToImage(modelId, image, prompt);

        const { totalCost, costUsdcWei } = await calculateInferenceCost(modelId, 500, 500);
        console.log(`[inference] Image-to-image cost: $${totalCost.toFixed(6)} (${costUsdcWei} wei)`);

        res.setHeader("Content-Type", "image/png");
        res.setHeader("X-Cost-USDC", totalCost.toFixed(6));
        return res.send(imageBuffer);
      }

      case "text-to-image": {
        const { prompt } = req.body;
        if (!prompt) return res.status(400).json({ error: "prompt is required" });

        // Route based on model source: Google models use genai.ts, others use HuggingFace
        let imageBuffer: Buffer;
        const isGoogleModel = modelInfo?.source === "google" ||
          modelId.startsWith("gemini") ||
          modelId.startsWith("imagen") ||
          modelId.includes("-image");

        if (isGoogleModel) {
          imageBuffer = await googleGenerateImage(modelId, prompt);
        } else {
          imageBuffer = await handleImageGeneration(modelId, prompt);
        }

        // Calculate cost
        const { totalCost, costUsdcWei } = await calculateInferenceCost(modelId, 500, 500);
        console.log(`[inference] Image cost: $${totalCost.toFixed(6)} (${costUsdcWei} wei)`);

        res.setHeader("Content-Type", "image/png");
        res.setHeader("X-Cost-USDC", totalCost.toFixed(6));
        return res.send(imageBuffer);
      }

      case "text-to-speech": {
        const { text } = req.body;
        if (!text) return res.status(400).json({ error: "text is required" });

        const audioBuffer = await handleTTS(modelId, text);

        // Calculate cost
        const estimatedTokens = Math.ceil(text.length / 4);
        const { totalCost, costUsdcWei } = await calculateInferenceCost(modelId, estimatedTokens, 0);
        console.log(`[inference] TTS cost: $${totalCost.toFixed(6)} (${costUsdcWei} wei)`);

        console.log(`[inference] TTS: ${costUsdcWei} wei`);

        res.setHeader("Content-Type", "audio/wav");
        res.setHeader("X-Cost-USDC", totalCost.toFixed(6));
        return res.send(audioBuffer);
      }

      case "text-to-video": {
        // Google Veo video generation (via genai.ts)
        const { prompt, duration, aspectRatio } = req.body;
        if (!prompt) return res.status(400).json({ error: "prompt is required for video generation" });

        const result = await googleGenerateVideo(modelId, prompt, {
          duration: duration as number | undefined,
          aspectRatio: aspectRatio as string | undefined,
        });

        // Calculate cost (video generation is more expensive)
        const estimatedTokens = Math.ceil(prompt.length / 4);
        const { totalCost, costUsdcWei } = await calculateInferenceCost(modelId, estimatedTokens * 10, 0);
        console.log(`[inference] Video generation cost: $${totalCost.toFixed(6)} (${costUsdcWei} wei)`);

        res.setHeader("X-Cost-USDC", totalCost.toFixed(6));
        return res.json({
          videoUrl: result.videoUrl,
          mimeType: result.mimeType,
          message: "Video generated successfully",
        });
      }

      case "text-to-audio": {
        // Google Lyria music/audio generation (via genai.ts)
        const { prompt, duration, negativePrompt } = req.body;
        if (!prompt) return res.status(400).json({ error: "prompt is required for audio generation" });

        const audioBuffer = await googleGenerateAudio(modelId, prompt, {
          duration: duration as number | undefined,
          negativePrompt: negativePrompt as string | undefined,
        });

        // Calculate cost
        const estimatedTokens = Math.ceil(prompt.length / 4);
        const { totalCost, costUsdcWei } = await calculateInferenceCost(modelId, estimatedTokens * 5, 0);
        console.log(`[inference] Audio generation cost: $${totalCost.toFixed(6)} (${costUsdcWei} wei)`);

        res.setHeader("Content-Type", "audio/wav");
        res.setHeader("X-Cost-USDC", totalCost.toFixed(6));
        return res.send(audioBuffer);
      }

      case "automatic-speech-recognition": {
        // Expect audio in request body as base64 or raw buffer
        let audioBuffer: Buffer;
        if (req.body.audio) {
          audioBuffer = Buffer.from(req.body.audio, "base64");
        } else if (Buffer.isBuffer(req.body)) {
          audioBuffer = req.body;
        } else {
          return res.status(400).json({ error: "audio data is required (base64 or raw)" });
        }

        const result = await handleASR(modelId, audioBuffer);

        // Calculate cost
        const estimatedTokens = Math.ceil(audioBuffer.length / 16000);
        const { totalCost, costUsdcWei } = await calculateInferenceCost(modelId, estimatedTokens, 50);
        console.log(`[inference] ASR cost: $${totalCost.toFixed(6)} (${costUsdcWei} wei)`);

        console.log(`[inference] ASR: ${costUsdcWei} wei`);

        res.setHeader("X-Cost-USDC", totalCost.toFixed(6));
        return res.json(result);
      }

      case "sentence-similarity":
      case "feature-extraction": {
        const { text, texts } = req.body;
        const input = texts || text;
        if (!input) return res.status(400).json({ error: "text or texts is required" });

        const embeddings = await handleEmbeddings(modelId, input, task);

        // Calculate cost
        const inputLength = Array.isArray(input) ? input.join(" ").length : input.length;
        const estimatedTokens = Math.ceil(inputLength / 4);
        const { totalCost, costUsdcWei } = await calculateInferenceCost(modelId, estimatedTokens, 0);
        console.log(`[inference] Embedding cost: $${totalCost.toFixed(6)} (${costUsdcWei} wei)`);

        console.log(`[inference] Embedding: ${costUsdcWei} wei`);

        res.setHeader("X-Cost-USDC", totalCost.toFixed(6));
        return res.json({ embeddings, dimensions: Array.isArray(embeddings[0]) ? embeddings[0].length : embeddings.length });
      }

      default:
        // Fall back to text-generation (handleInference)
        // Pass paymentVerified=true since we already verified payment above
        return handleInference(req, res, true);
    }
  } catch (error) {
    console.error("[inference] Multimodal error:", error);
    res.status(500).json({
      error: "Inference failed",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
}
