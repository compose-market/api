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
import { streamText, smoothStream, type ModelMessage } from "ai";

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
} from "./models.js";
import { handleX402Payment, extractPaymentInfo } from "../../lib/payment.js";
import { INFERENCE_PRICE_WEI } from "../thirdweb.js";
import {
  generateImage as googleGenerateImage,
  generateVideo as googleGenerateVideo,
  generateSpeech as googleGenerateSpeech,
  generateWithSearchGrounding as googleSearchGrounding,
  generateWithCodeExecution as googleCodeExecution,
} from "./providers/genai.js";
import {
  executeHFInference,
  type HFInferenceResult,
} from "./providers/huggingface.js";

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
      messages: ModelMessage[];
      modelId?: string;
      systemPrompt?: string;
    } = req.body;

    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: "messages array is required" });
    }

    // Get model info from dynamic registry
    const modelInfo = await getModelInfo(modelId);

    // Get the language model instance (routes to correct provider via registry)
    const model = getLanguageModel(modelId, modelInfo?.provider);
    const modelName = modelInfo?.name || modelId;
    const provider = modelInfo?.provider || "unknown";

    console.log(`[inference] Model: ${modelName}, Provider: ${provider}`);

    // Set up streaming headers
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    // Stream AI response
    const stream = streamText({
      model,
      system: systemPrompt,
      messages: messages as ModelMessage[],
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
    const models = availableModels.map((m) => ({
      id: m.modelId,
      name: m.name,
      provider: m.provider,
      ownedBy: m.ownedBy,
      task: m.taskType || "text-generation",
      available: m.available,
      contextLength: m.contextWindow,
      capabilities: m.capabilities,
      inputModalities: m.inputModalities,
      outputModalities: m.outputModalities,
      // Pricing for x402 (USD per million tokens)
      pricing: m.pricing ? {
        input: m.pricing.input,
        output: m.pricing.output,
      } : null,
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
  if (modelInfo?.taskType) return modelInfo.taskType;

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
 * Unified multimodal inference endpoint
 * Routes to correct handler based on model task type and source
 * 
 * Routing logic:
 * - Google models -> genai.ts handlers
 * - HuggingFace/other models -> unified executeHFInference
 */
export async function handleMultimodalInference(req: Request, res: Response) {
  try {
    const taskParam = req.query.task || req.body.task;
    const requestedTask = typeof taskParam === "string" ? taskParam : undefined;

    // Model ID from path or body
    const modelIdFromPath = req.params?.modelId;
    const modelId = (typeof modelIdFromPath === "string" ? modelIdFromPath : undefined) || req.body.modelId || DEFAULT_MODEL;

    const modelInfo = await getModelInfo(modelId);
    let task = requestedTask || modelInfo?.taskType || getTaskType(modelId, modelInfo);

    // Auto-detect image-to-image if image is provided with text-to-image or text-generation
    if (req.body.image && (task === "text-to-image" || task === "text-generation")) {
      console.log(`[inference] Request has image body, upgrading task ${task} -> image-to-image`);
      task = "image-to-image";
    }

    // Auto-detect image-to-video if image is provided with text-to-video
    if (req.body.image && task === "text-to-video") {
      console.log(`[inference] Request has image body, upgrading task ${task} -> image-to-video`);
      task = "image-to-video";
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
    console.log(`[inference] Multimodal x402 payment verified, task: ${task}, provider: ${modelInfo?.provider || "unknown"}`);

    // Determine if this is a Google model
    const isGoogleModel = modelInfo?.provider === "google";

    // =========================================================================
    // Google-specific routing (special API)
    // =========================================================================
    if (isGoogleModel) {
      switch (task) {
        case "text-to-image": {
          const { prompt } = req.body;
          if (!prompt) return res.status(400).json({ error: "prompt is required" });

          const imageBuffer = await googleGenerateImage(modelId, prompt);
          const { totalCost, costUsdcWei } = await calculateInferenceCost(modelId, 500, 500);
          console.log(`[inference] Google image cost: $${totalCost.toFixed(6)} (${costUsdcWei} wei)`);

          res.setHeader("Content-Type", "image/png");
          res.setHeader("X-Cost-USDC", totalCost.toFixed(6));
          return res.send(imageBuffer);
        }

        case "text-to-video": {
          const { prompt, duration, aspectRatio } = req.body;
          if (!prompt) return res.status(400).json({ error: "prompt is required for video generation" });

          const result = await googleGenerateVideo(modelId, prompt, {
            duration: duration as number | undefined,
            aspectRatio: aspectRatio as "16:9" | "9:16" | undefined,
          });

          const estimatedTokens = Math.ceil(prompt.length / 4);
          const { totalCost, costUsdcWei } = await calculateInferenceCost(modelId, estimatedTokens * 10, 0);
          console.log(`[inference] Google video cost: $${totalCost.toFixed(6)} (${costUsdcWei} wei)`);

          // Return video buffer directly
          res.setHeader("Content-Type", result.mimeType);
          res.setHeader("X-Cost-USDC", totalCost.toFixed(6));
          return res.send(result.videoBuffer);
        }

        case "text-to-audio": {
          // Lyria RealTime requires WebSocket - not supported in Lambda
          // Redirect to socket server endpoint
          return res.status(501).json({
            error: "Lyria RealTime requires WebSocket connection",
            message: "Music generation via Lyria is available at wss://services.compose.market/socket",
            socketEndpoint: "wss://services.compose.market/socket",
            hint: "Connect via WebSocket and send { type: 'lyria', prompt: '...' }",
          });
        }

        case "text-to-speech": {
          const { text } = req.body;
          if (!text) return res.status(400).json({ error: "text is required" });

          const audioBuffer = await googleGenerateSpeech(modelId, text);
          const estimatedTokens = Math.ceil(text.length / 4);
          const { totalCost, costUsdcWei } = await calculateInferenceCost(modelId, estimatedTokens, 0);
          console.log(`[inference] Google TTS cost: $${totalCost.toFixed(6)} (${costUsdcWei} wei)`);

          res.setHeader("Content-Type", "audio/wav");
          res.setHeader("X-Cost-USDC", totalCost.toFixed(6));
          return res.send(audioBuffer);
        }

        default:
          // Fall through to text-generation via handleInference
          return handleInference(req, res, true);
      }
    }

    // =========================================================================
    // Non-HuggingFace text-generation models (ASI, OpenRouter, OpenAI, etc.)
    // Route to handleInference which uses getLanguageModel for proper provider
    // =========================================================================
    const textGenerationProviders = ["asi-one", "asi-cloud", "openrouter", "openai", "anthropic", "aiml"];
    if (task === "text-generation" && modelInfo?.provider && textGenerationProviders.includes(modelInfo.provider)) {
      console.log(`[inference] Routing ${modelId} (provider: ${modelInfo.provider}) to handleInference`);
      return handleInference(req, res, true);
    }

    // =========================================================================
    // HuggingFace unified inference (all other models)
    // Uses the unified executeHFInference with automatic provider routing
    // =========================================================================

    // Build HF inference input from request
    const hfInput = {
      modelId,
      task,
      prompt: req.body.prompt,
      text: req.body.text || req.body.prompt,
      messages: req.body.messages,
      systemPrompt: req.body.systemPrompt,
      image: req.body.image,
      audio: req.body.audio,
      parameters: {
        ...req.body.parameters,
        // Include common parameters at top level
        sentences: req.body.sentences || req.body.texts,
        candidate_labels: req.body.candidate_labels || req.body.labels,
        context: req.body.context,
      },
    };

    // Validate required inputs for specific tasks
    const mediaInputTasks = [
      "image-to-image", "image-to-video", "image-classification",
      "object-detection", "image-segmentation", "image-to-text",
      "depth-estimation", "visual-question-answering",
      "document-question-answering", "zero-shot-image-classification"
    ];
    const audioInputTasks = ["automatic-speech-recognition", "audio-classification"];

    if (mediaInputTasks.includes(task) && !hfInput.image) {
      return res.status(400).json({ error: "image is required (base64)" });
    }
    if (audioInputTasks.includes(task) && !hfInput.audio) {
      return res.status(400).json({ error: "audio is required (base64)" });
    }
    if (["text-to-image", "text-to-video", "text-to-speech", "text-to-audio"].includes(task) && !hfInput.prompt && !hfInput.text) {
      return res.status(400).json({ error: "prompt or text is required" });
    }

    // Execute HF inference
    const result = await executeHFInference(hfInput);

    // Calculate cost based on task type
    let inputEstimate = 500;
    let outputEstimate = 500;
    if (hfInput.prompt) inputEstimate = Math.ceil(hfInput.prompt.length / 4);
    if (hfInput.text) inputEstimate = Math.ceil(hfInput.text.length / 4);
    if (hfInput.image) inputEstimate = 1000; // Images are more expensive
    if (hfInput.audio) inputEstimate = Math.ceil((hfInput.audio.length * 0.75) / 16000);

    const { totalCost, costUsdcWei } = await calculateInferenceCost(modelId, inputEstimate, outputEstimate);
    console.log(`[inference] HF ${task} cost: $${totalCost.toFixed(6)} (${costUsdcWei} wei)`);
    res.setHeader("X-Cost-USDC", totalCost.toFixed(6));

    // Return response based on result type
    switch (result.type) {
      case "image":
        res.setHeader("Content-Type", result.mimeType || "image/png");
        return res.send(result.data);

      case "video":
        res.setHeader("Content-Type", result.mimeType || "video/mp4");
        return res.send(result.data);

      case "audio":
        res.setHeader("Content-Type", result.mimeType || "audio/wav");
        return res.send(result.data);

      case "text":
        res.setHeader("Content-Type", "text/plain");
        return res.send(result.data);

      case "embedding":
        return res.json({
          embeddings: result.data,
          dimensions: Array.isArray((result.data as number[][])[0])
            ? (result.data as number[][])[0].length
            : (result.data as number[]).length
        });

      case "json":
      default:
        return res.json(result.data);
    }
  } catch (error) {
    console.error("[inference] Multimodal error:", error);
    res.status(500).json({
      error: "Inference failed",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
}

