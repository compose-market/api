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
import {
  MAX_TOKENS_PER_CALL,
} from "./lib/thirdweb";
import {
  getLanguageModel,
  getModelInfo,
  calculateInferenceCost,
  calculateCost,
  getModelRegistry,
  getAvailableModels as getAvailableModelsList,
  DEFAULT_MODEL,
  type ModelInfo,
} from "./lib/models";
import { handleX402Payment, extractPaymentInfo } from "./lib/payment";
import { INFERENCE_PRICE_WEI } from "./shared/thirdweb";

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
 * Uses HuggingFace InferenceClient with provider="auto" to automatically 
 * route to the best available provider (hf-inference, fal-ai, replicate, etc.)
 */
async function handleImageGeneration(modelId: string, prompt: string): Promise<Buffer> {
  if (!HF_TOKEN) throw new Error("HuggingFace token not configured");

  const { InferenceClient } = await import("@huggingface/inference");
  const client = new InferenceClient(HF_TOKEN);

  try {
    console.log(`[inference] Text-to-image: ${modelId} with provider=auto`);

    const result = await client.textToImage({
      provider: "auto",
      model: modelId,
      inputs: prompt,
    });

    // Handle different return types (Blob in browser, Buffer/ArrayBuffer in Node)
    // Cast to any to handle the union type properly
    const blob = result as unknown as Blob;
    if (typeof blob.arrayBuffer === "function") {
      const arrayBuffer = await blob.arrayBuffer();
      return Buffer.from(arrayBuffer);
    }
    // Fallback for other return types
    return Buffer.from(result as unknown as ArrayBuffer);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    // Provide better error messages
    if (message.includes("not found") || message.includes("404") || message.includes("Not Found")) {
      throw new Error(
        `Model "${modelId}" is not available for text-to-image inference. ` +
        `Try "black-forest-labs/FLUX.1-schnell" or "stabilityai/stable-diffusion-xl-base-1.0".`
      );
    }
    if (message.includes("loading") || message.includes("503")) {
      throw new Error(`Model "${modelId}" is loading. Please try again in 20-30 seconds.`);
    }

    throw new Error(`Image generation failed: ${message}`);
  }
}

/**
 * Image-to-Image inference (FLUX.2-dev, etc.)
 * Uses HuggingFace InferenceClient with provider="auto" to route to 
 * available providers like wavespeed, fal-ai, replicate, etc.
 */
async function handleImageToImage(modelId: string, inputImage: string, prompt: string): Promise<Buffer> {
  if (!HF_TOKEN) throw new Error("HuggingFace token not configured");

  const { InferenceClient } = await import("@huggingface/inference");
  const client = new InferenceClient(HF_TOKEN);

  try {
    console.log(`[inference] Image-to-image: ${modelId} with provider=auto`);

    // Convert base64 to Blob for the input image (HF client expects Blob)
    const imageBuffer = Buffer.from(inputImage, "base64");
    const imageBlob = new Blob([imageBuffer], { type: "image/png" });

    const result = await client.imageToImage({
      provider: "auto",
      model: modelId,
      inputs: imageBlob,
      parameters: { prompt },
    });

    // Handle different return types (Blob in browser, Buffer/ArrayBuffer in Node)
    // Cast to any to handle the union type properly
    const blob = result as unknown as Blob;
    if (typeof blob.arrayBuffer === "function") {
      const arrayBuffer = await blob.arrayBuffer();
      return Buffer.from(arrayBuffer);
    }
    // Fallback for other return types
    return Buffer.from(result as unknown as ArrayBuffer);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (message.includes("not found") || message.includes("404") || message.includes("Not Found")) {
      throw new Error(
        `Model "${modelId}" is not available for image-to-image inference. ` +
        `Try "black-forest-labs/FLUX.2-dev" with an input image.`
      );
    }
    if (message.includes("loading") || message.includes("503")) {
      throw new Error(`Model "${modelId}" is loading. Please try again in 20-30 seconds.`);
    }

    throw new Error(`Image-to-image failed: ${message}`);
  }
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
 */
async function handleASR(modelId: string, audioBuffer: Buffer): Promise<{ text: string }> {
  if (!HF_TOKEN) throw new Error("HuggingFace token not configured");

  const response = await fetch(`https://router.huggingface.co/hf-inference/models/${modelId}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${HF_TOKEN}`,
      "Content-Type": "audio/wav",
    },
    body: new Uint8Array(audioBuffer),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`ASR failed: ${error}`);
  }

  return response.json();
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
 * Unified multimodal inference endpoint
 * Routes to correct handler based on model task type
 */
export async function handleMultimodalInference(req: Request, res: Response) {
  try {
    const modelId = req.params.modelId || req.body.modelId || DEFAULT_MODEL;
    const modelInfo = await getModelInfo(modelId);
    let task = getTaskType(modelId, modelInfo);

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

        const imageBuffer = await handleImageGeneration(modelId, prompt);

        // Calculate cost
        const { totalCost, costUsdcWei } = await calculateInferenceCost(modelId, 500, 500);
        console.log(`[inference] Image cost: $${totalCost.toFixed(6)} (${costUsdcWei} wei)`);

        console.log(`[inference] Image: ${costUsdcWei} wei`);

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
