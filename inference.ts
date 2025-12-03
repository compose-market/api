import type { Request, Response } from "express";
import { streamText, convertToModelMessages, smoothStream, type UIMessage } from "ai";
import { facilitator, verifyPayment, settlePayment, type PaymentArgs } from "thirdweb/x402";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { 
  serverClient, 
  serverWalletAddress, 
  paymentChain, 
  paymentAsset,
  PRICE_PER_TOKEN_WEI,
  MAX_TOKENS_PER_CALL,
} from "./lib/thirdweb";
import { 
  modelProvider, 
  calculateModelPrice, 
  type ModelID, 
  DEFAULT_MODEL, 
  MODEL_NAMES, 
  MODEL_PRICE_MULTIPLIERS,
  MODEL_PROVIDERS,
  isValidModelId,
  getAvailableModels,
  type ModelProviderType,
} from "./lib/models";

// =============================================================================
// HuggingFace Provider Setup
// =============================================================================

const HF_TOKEN = process.env.HUGGING_FACE_INFERENCE_TOKEN;

/**
 * Create HuggingFace inference provider for a specific model
 * Uses HuggingFace Router API (serverless, OpenAI-compatible)
 * Updated December 2025: Uses router.huggingface.co instead of api-inference
 */
function createHuggingFaceProvider(modelId: string) {
  if (!HF_TOKEN) {
    throw new Error("HUGGING_FACE_INFERENCE_TOKEN not configured");
  }
  
  // HuggingFace Router is OpenAI-compatible
  // Use the global /v1 endpoint, model is specified in the request body
  return createOpenAICompatible({
    name: "huggingface",
    apiKey: HF_TOKEN,
    baseURL: "https://router.huggingface.co/v1",
  });
}

/**
 * Check if a model ID is a HuggingFace model
 * HuggingFace models typically have format: "org/model-name"
 */
function isHuggingFaceModel(modelId: string): boolean {
  // Check if it's NOT in our built-in models
  // HuggingFace models have org/name format
  return !isValidModelId(modelId) && modelId.includes("/");
}

// =============================================================================
// x402 Payment Setup
// =============================================================================

// Create x402 facilitator for payment settlement
const twFacilitator = facilitator({
  client: serverClient,
  serverWalletAddress,
});

// =============================================================================
// Inference Endpoint
// =============================================================================

/**
 * x402 AI Inference endpoint
 * 
 * Supports two payment modes:
 * 
 * 1. Per-call x402 payment (default):
 *    - User sends signed payment data in x-payment header
 *    - Server verifies → does work → settles actual amount
 * 
 * 2. Session-based payment (when x-session-active: true):
 *    - User has pre-approved a session budget via ERC-4337 session key
 *    - Server verifies session → does work → settles via session key
 *    - No per-call wallet signatures needed
 * 
 * Model Routing:
 * - Built-in models (asi1-*, claude-*, gpt-*, gemini-*) → modelProvider
 * - HuggingFace models (org/name format) → HuggingFace Inference API
 */
export async function handleInference(req: Request, res: Response) {
  try {
    // Extract payment headers
    const paymentData = req.headers["x-payment"] as string | undefined;
    const sessionActive = req.headers["x-session-active"] === "true";
    const sessionBudgetRemaining = parseInt(req.headers["x-session-budget-remaining"] as string || "0", 10);
    
    // Build payment args for verification
    const resourceUrl = `${req.protocol}://${req.get("host")}${req.originalUrl}`;
    const paymentArgs: PaymentArgs = {
      facilitator: twFacilitator,
      method: "POST",
      network: paymentChain,
      scheme: "upto", // Pay up to max, settle for actual amount
      price: {
        amount: (PRICE_PER_TOKEN_WEI * MAX_TOKENS_PER_CALL).toString(),
        asset: paymentAsset,
      },
      resourceUrl,
      paymentData,
    };

    // Verify payment based on mode
    if (sessionActive) {
      // Session mode: check budget remaining
      if (sessionBudgetRemaining <= 0) {
        return res.status(402).json({ 
          error: "session_budget_exceeded",
          message: "Session budget exhausted. Please top up or create a new session.",
        });
      }
      // Session has pre-approved budget, skip per-call verification
      // The session key allows treasury to pull payments
      console.log(`Session payment: ${sessionBudgetRemaining} wei remaining`);
    } else {
      // Per-call mode: verify x402 payment signature
      if (!paymentData) {
        return res.status(402).json({
          error: "payment_required",
          message: "x-payment header required for inference",
        });
      }
      
      const verifyResult = await verifyPayment(paymentArgs);
      
      if (verifyResult.status !== 200) {
        return res.status(verifyResult.status).json(verifyResult.responseBody);
      }
    }

    // Parse request body
    const { 
      messages, 
      modelId = DEFAULT_MODEL,
      systemPrompt = "You are a helpful AI assistant.",
    }: {
      messages: UIMessage[];
      modelId?: string; // Can be ModelID or HuggingFace model ID
      systemPrompt?: string;
    } = req.body;

    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: "messages array is required" });
    }

    // Determine which provider to use
    let model;
    let priceMultiplier = 1.0;
    let modelName = modelId;
    
    if (isHuggingFaceModel(modelId)) {
      // HuggingFace model (org/name format)
      if (!HF_TOKEN) {
        return res.status(503).json({
          error: "huggingface_not_configured",
          message: "HuggingFace inference is not available. HUGGING_FACE_INFERENCE_TOKEN not set.",
        });
      }
      
      const hfProvider = createHuggingFaceProvider(modelId);
      model = hfProvider("tgi"); // HuggingFace TGI endpoint
      priceMultiplier = 1.0; // Base pricing for HF models
      modelName = modelId;
      console.log(`[inference] Using HuggingFace model: ${modelId}`);
    } else if (isValidModelId(modelId)) {
      // Built-in model
      model = modelProvider.languageModel(modelId as ModelID);
      priceMultiplier = MODEL_PRICE_MULTIPLIERS[modelId as ModelID] || 1.0;
      modelName = MODEL_NAMES[modelId as ModelID] || modelId;
      
      // Log which API key is being used
      const provider = MODEL_PROVIDERS[modelId as ModelID];
      console.log(`[inference] Using built-in model: ${modelName} (provider: ${provider})`);
    } else {
      // Unknown model
      return res.status(400).json({
        error: "invalid_model",
        message: `Unknown model ID: ${modelId}. Use a built-in model or HuggingFace model (org/name format).`,
        availableModels: Object.keys(MODEL_NAMES),
      });
    }

    // Set up streaming headers
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    // Stream AI response
    const stream = streamText({
      model,
      system: systemPrompt,
      messages: convertToModelMessages(messages),
      experimental_transform: [
        smoothStream({ chunking: "word" }),
      ],
      onFinish: async (event) => {
        const totalTokens = event.totalUsage?.totalTokens || 0;
        
        if (totalTokens === 0) {
          console.error("Token usage data not available");
          return;
        }

        // Calculate final price based on actual tokens and model multiplier
        const finalPrice = Math.ceil(PRICE_PER_TOKEN_WEI * priceMultiplier * totalTokens);

        // Settle payment based on mode
        if (sessionActive) {
          // Session mode: payment is pulled via pre-approved session key
          // The client tracks usage locally and the session key allows treasury to collect
          console.log(`Session settlement: ${finalPrice} wei for ${totalTokens} tokens (model: ${modelName})`);
          // Note: Actual token transfer happens via the session key's pre-approval
          // The client-side recordUsage() tracks this against the session budget
        } else {
          // Per-call mode: settle via x402
          try {
            const result = await settlePayment({
              ...paymentArgs,
              price: {
                amount: finalPrice.toString(),
                asset: paymentAsset,
              },
            });
            console.log(`x402 payment settled: ${JSON.stringify(result)}`);
          } catch (error) {
            console.error("Payment settlement failed:", error);
          }
        }
      },
    });

    // Stream response to client
    const response = stream.toTextStreamResponse();

    // Pipe the stream to express response
    const reader = response.body?.getReader();
    if (!reader) {
      return res.status(500).json({ error: "Failed to create stream" });
    }

    const pump = async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          res.end();
          break;
        }
        res.write(value);
      }
    };

    await pump();
  } catch (error) {
    console.error("Inference error:", error);
    if (!res.headersSent) {
      res.status(500).json({ 
        error: "Inference failed", 
        message: error instanceof Error ? error.message : "Unknown error" 
      });
    }
  }
}

// =============================================================================
// Models Endpoint
// =============================================================================

/**
 * Get available models endpoint
 * Returns all built-in models with their pricing and availability
 */
export function handleGetModels(_req: Request, res: Response) {
  const availableModelIds = getAvailableModels();
  
  const models = Object.entries(MODEL_NAMES).map(([id, name]) => ({
    id,
    name,
    priceMultiplier: MODEL_PRICE_MULTIPLIERS[id as ModelID] || 1.0,
    provider: MODEL_PROVIDERS[id as ModelID],
    available: availableModelIds.includes(id as ModelID),
  }));

  res.json({ 
    models,
    basePricePerToken: PRICE_PER_TOKEN_WEI,
    maxTokensPerCall: MAX_TOKENS_PER_CALL,
    paymentChain: paymentChain.name,
    paymentToken: "USDC",
    // Provider availability
    providers: {
      openai: !!process.env.OPENAI_API_KEY,
      anthropic: !!process.env.ANTHROPIC_API_KEY,
      google: !!process.env.GOOGLE_GENERATIVE_AI_API_KEY,
      "asi-one": !!process.env.ASI_ONE_API_KEY,
      "asi-cloud": !!process.env.ASI_INFERENCE_API_KEY,
      huggingface: !!process.env.HUGGING_FACE_INFERENCE_TOKEN,
    },
  });
}
