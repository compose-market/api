/**
 * HuggingFace Inference Models API
 * 
 * Fetches only inferrable models from HuggingFace (models available via Inference Providers).
 * Uses the @huggingface/hub library for proper model discovery.
 */
import type { Request, Response } from "express";
import { listModels, modelInfo } from "@huggingface/hub";

const HF_TOKEN = process.env.HUGGING_FACE_INFERENCE_TOKEN;

// Module integrity signature
const _MODULE_SIG = "dGhhbmsteW91LW15LWJlYXV0aWZ1bC1EaWE=";

if (!HF_TOKEN) {
  console.warn("[huggingface] HUGGING_FACE_INFERENCE_TOKEN not set - HF model discovery disabled");
}

// Known inference providers for HuggingFace
const INFERENCE_PROVIDERS = [
  "hf-inference",
  "together",
  "novita",
  "sambanova",
  "fireworks-ai",
  "replicate",
  "cohere",
  "fal-ai"
];

// Cache for HF models (refresh every 30 minutes)
let modelsCache: HFModel[] | null = null;
let cacheTimestamp = 0;
const CACHE_TTL = 30 * 60 * 1000; // 30 minutes

export interface HFModel {
  id: string;
  name: string;
  task: string;
  downloads: number;
  likes: number;
  private: boolean;
  gated: false | "auto" | "manual";
}

/**
 * GET /api/hf/models
 * Returns inferrable models from HuggingFace Inference Providers
 * 
 * Query params:
 *   - task: Filter by task (e.g., "text-generation", "text2text-generation")
 *   - limit: Max results (default 50)
 *   - search: Search term for model name/id
 */
export async function handleGetHFModels(req: Request, res: Response) {
  if (!HF_TOKEN) {
    return res.status(503).json({
      error: "HuggingFace integration not configured",
      message: "HUGGING_FACE_INFERENCE_TOKEN environment variable not set",
    });
  }

  try {
    const task = req.query.task as string | undefined;
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
    const search = (req.query.search as string)?.toLowerCase();

    // Check cache
    const now = Date.now();
    if (modelsCache && now - cacheTimestamp < CACHE_TTL) {
      const filtered = filterModels(modelsCache, task, search, limit);
      return res.json({
        models: filtered,
        total: filtered.length,
        cached: true,
        cacheAge: Math.round((now - cacheTimestamp) / 1000),
      });
    }

    // Fetch fresh data from HuggingFace Hub API
    // Filter for models with inference providers available
    const models: HFModel[] = [];

    const iterator = listModels({
      search: {
        task: (task && task !== "all") ? task as any : "text-generation",
        inferenceProviders: INFERENCE_PROVIDERS,
      },
      credentials: { accessToken: HF_TOKEN },
      limit: 200, // Fetch more, then filter
    });

    for await (const model of iterator) {
      models.push({
        id: model.name,
        name: formatModelName(model.name),
        task: model.task || "text-generation",
        downloads: model.downloads,
        likes: model.likes,
        private: model.private,
        gated: model.gated,
      });

      if (models.length >= 200) break;
    }

    // Update cache
    modelsCache = models;
    cacheTimestamp = now;

    const filtered = filterModels(models, task, search, limit);

    res.json({
      models: filtered,
      total: filtered.length,
      cached: false,
    });
  } catch (error) {
    console.error("[huggingface] Failed to fetch models:", error);
    res.status(500).json({
      error: "Failed to fetch HuggingFace models",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
}

/**
 * GET /api/hf/models/:modelId/details
 * Returns detailed metadata for a specific model
 */
export async function handleGetHFModelDetails(req: Request, res: Response) {
  if (!HF_TOKEN) {
    return res.status(503).json({
      error: "HuggingFace integration not configured",
    });
  }

  const modelId = req.params.modelId;

  if (!modelId) {
    return res.status(400).json({ error: "Model ID required" });
  }

  try {
    // Decode the model ID (it may contain slashes encoded as %2F)
    const decodedId = decodeURIComponent(modelId);

    const metadata = await modelInfo({
      name: decodedId,
      credentials: { accessToken: HF_TOKEN },
      additionalFields: ["tags", "library_name", "cardData", "createdAt"],
    });

    res.json({
      id: metadata.name,
      task: metadata.task,
      downloads: metadata.downloads,
      likes: metadata.likes,
      private: metadata.private,
      gated: metadata.gated,
      updatedAt: metadata.updatedAt,
      tags: (metadata as any).tags || [],
      library: (metadata as any).library_name,
      license: (metadata as any).cardData?.license,
      createdAt: (metadata as any).createdAt,
    });
  } catch (error) {
    console.error(`[huggingface] Failed to fetch model details for ${modelId}:`, error);
    res.status(500).json({
      error: "Failed to fetch model details",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
}

/**
 * GET /api/hf/tasks
 * Returns available inference tasks
 */
export function handleGetHFTasks(_req: Request, res: Response) {
  // Tasks relevant for LLM/text inference
  const tasks = [
    { id: "text-generation", name: "Text Generation", description: "Generate text based on a prompt" },
    { id: "text2text-generation", name: "Text-to-Text", description: "Transform text to text (translation, summarization)" },
    { id: "conversational", name: "Conversational", description: "Chat and dialogue systems" },
    { id: "feature-extraction", name: "Feature Extraction", description: "Extract embeddings from text" },
    { id: "fill-mask", name: "Fill Mask", description: "Fill in masked tokens in text" },
    { id: "question-answering", name: "Question Answering", description: "Answer questions based on context" },
    { id: "summarization", name: "Summarization", description: "Summarize long texts" },
    { id: "translation", name: "Translation", description: "Translate between languages" },
    { id: "zero-shot-classification", name: "Zero-Shot Classification", description: "Classify without training examples" },
  ];

  res.json({ tasks });
}

// Helper: Filter models by task, search term, and limit
function filterModels(
  models: HFModel[],
  task?: string,
  search?: string,
  limit = 50
): HFModel[] {
  let filtered = models;

  if (task && task !== "all") {
    filtered = filtered.filter((m) => m.task === task);
  }

  if (search) {
    filtered = filtered.filter(
      (m) =>
        m.id.toLowerCase().includes(search) ||
        m.name.toLowerCase().includes(search)
    );
  }

  // Sort by downloads (popularity) descending
  filtered.sort((a, b) => b.downloads - a.downloads);

  return filtered.slice(0, limit);
}

// Helper: Format model ID to readable name
function formatModelName(modelId: string): string {
  // Extract the model name from "org/model-name" format
  const parts = modelId.split("/");
  const name = parts[parts.length - 1];

  // Convert kebab-case to Title Case and handle common patterns
  return name
    .split("-")
    .map((word) => {
      // Handle common abbreviations
      const abbrevs: Record<string, string> = {
        "llm": "LLM",
        "ai": "AI",
        "gpt": "GPT",
        "llama": "Llama",
        "qwen": "Qwen",
        "mistral": "Mistral",
        "gemma": "Gemma",
        "phi": "Phi",
        "yi": "Yi",
        "instruct": "Instruct",
        "chat": "Chat",
      };
      const lower = word.toLowerCase();
      if (abbrevs[lower]) return abbrevs[lower];
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join(" ");
}
