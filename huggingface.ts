/**
 * HuggingFace Inference Models API
 * 
 * Fetches ONLY models with inference providers from HuggingFace.
 * Uses the Hub API with inference_provider=all filter.
 * 
 * Documentation: https://huggingface.co/docs/inference-providers/index
 * 
 * Key Points:
 * - The inference_provider=all filter ONLY returns models with inference providers
 * - Over 15,000+ models have inference providers on HuggingFace
 * - We fetch by task type (pipeline_tag) to get diverse model coverage
 * - No hardcoded model lists - everything is fetched dynamically
 */
import type { Request, Response } from "express";

const HF_TOKEN = process.env.HUGGING_FACE_INFERENCE_TOKEN;

if (!HF_TOKEN) {
  console.warn("[huggingface] HUGGING_FACE_INFERENCE_TOKEN not set - HF model discovery disabled");
}

// =============================================================================
// Types
// =============================================================================

export interface HFModel {
  id: string;
  name: string;
  task: string;
  downloads: number;
  likes: number;
  private: boolean;
  gated: boolean | "auto" | "manual";
  inferenceProviders?: string[];
}

export interface HFTask {
  id: string;
  name: string;
  description: string;
  modelCount?: number;
}

// =============================================================================
// Task Types - Fetched from HuggingFace Tasks API
// =============================================================================

// Cache for task types
let tasksCache: HFTask[] | null = null;
let tasksCacheTimestamp = 0;
const TASKS_CACHE_TTL = 60 * 60 * 1000; // 1 hour

/**
 * Fetch available task types from HuggingFace
 * These are the pipeline_tag values that can be used to filter models
 */
async function fetchAvailableTasks(): Promise<HFTask[]> {
  // Check cache
  if (tasksCache && Date.now() - tasksCacheTimestamp < TASKS_CACHE_TTL) {
    return tasksCache;
  }

  try {
    // HuggingFace Tasks API
    const response = await fetch("https://huggingface.co/api/tasks", {
      headers: HF_TOKEN ? { Authorization: `Bearer ${HF_TOKEN}` } : {},
    });

    if (!response.ok) {
      console.warn(`[huggingface] Tasks API returned ${response.status}, using fallback`);
      return getDefaultTasks();
    }

    const tasksData = await response.json() as Record<string, {
      id?: string;
      label?: string;
      description?: string;
    }>;

    // Convert to our format
    const tasks: HFTask[] = Object.entries(tasksData).map(([id, data]) => ({
      id,
      name: data.label || formatTaskName(id),
      description: data.description || "",
    }));

    tasksCache = tasks;
    tasksCacheTimestamp = Date.now();

    console.log(`[huggingface] Fetched ${tasks.length} task types`);
    return tasks;
  } catch (error) {
    console.error("[huggingface] Failed to fetch tasks:", error);
    return getDefaultTasks();
  }
}

/**
 * Default task types if API fails - based on HuggingFace documentation
 */
function getDefaultTasks(): HFTask[] {
  return [
    { id: "text-generation", name: "Text Generation", description: "Generate text based on a prompt" },
    { id: "text2text-generation", name: "Text-to-Text", description: "Transform text to text" },
    { id: "conversational", name: "Conversational", description: "Chat and dialogue systems" },
    { id: "text-to-image", name: "Text to Image", description: "Generate images from text" },
    { id: "image-to-image", name: "Image to Image", description: "Transform images" },
    { id: "text-to-speech", name: "Text to Speech", description: "Convert text to audio" },
    { id: "text-to-audio", name: "Text to Audio", description: "Generate audio from text" },
    { id: "automatic-speech-recognition", name: "Speech Recognition", description: "Transcribe audio to text" },
    { id: "text-to-video", name: "Text to Video", description: "Generate video from text" },
    { id: "image-to-video", name: "Image to Video", description: "Generate video from image" },
    { id: "feature-extraction", name: "Feature Extraction", description: "Extract embeddings" },
    { id: "sentence-similarity", name: "Sentence Similarity", description: "Measure text similarity" },
    { id: "text-classification", name: "Text Classification", description: "Classify text" },
    { id: "token-classification", name: "Token Classification", description: "NER and POS tagging" },
    { id: "question-answering", name: "Question Answering", description: "Answer questions" },
    { id: "summarization", name: "Summarization", description: "Summarize text" },
    { id: "translation", name: "Translation", description: "Translate between languages" },
    { id: "fill-mask", name: "Fill Mask", description: "Fill in masked words" },
    { id: "zero-shot-classification", name: "Zero-Shot Classification", description: "Classify without training" },
    { id: "image-classification", name: "Image Classification", description: "Classify images" },
    { id: "object-detection", name: "Object Detection", description: "Detect objects in images" },
    { id: "image-segmentation", name: "Image Segmentation", description: "Segment images" },
    { id: "depth-estimation", name: "Depth Estimation", description: "Estimate depth from images" },
  ];
}

function formatTaskName(taskId: string): string {
  return taskId
    .split("-")
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

// =============================================================================
// Model Fetching - ONLY models with inference providers
// =============================================================================

// Cache for models
let modelsCache: Map<string, HFModel[]> = new Map();
let modelsCacheTimestamp: Map<string, number> = new Map();
const MODELS_CACHE_TTL = 30 * 60 * 1000; // 30 minutes

/**
 * Fetch models for a specific task type
 * ONLY returns models with inference providers (inference_provider=all filter)
 * 
 * @param task - The pipeline_tag to filter by (e.g., "text-to-image")
 * @param limit - Maximum models to fetch (default 100)
 */
export async function fetchModelsByTask(task: string, limit = 100): Promise<HFModel[]> {
  if (!HF_TOKEN) return [];

  // Check cache
  const cacheKey = `${task}:${limit}`;
  const cachedModels = modelsCache.get(cacheKey);
  const cacheTime = modelsCacheTimestamp.get(cacheKey) || 0;

  if (cachedModels && Date.now() - cacheTime < MODELS_CACHE_TTL) {
    return cachedModels;
  }

  try {
    // Use inference_provider=all to ONLY get models with inference providers
    const url = new URL("https://huggingface.co/api/models");
    url.searchParams.set("inference_provider", "all");
    url.searchParams.set("pipeline_tag", task);
    url.searchParams.set("sort", "downloads");
    url.searchParams.set("direction", "-1");
    url.searchParams.set("limit", limit.toString());

    const response = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${HF_TOKEN}`,
        "User-Agent": "compose-market/1.0",
      },
    });

    if (!response.ok) {
      console.error(`[huggingface] API error for task ${task}: ${response.status}`);
      return [];
    }

    const rawModels = await response.json() as Array<{
      id: string;
      modelId?: string;
      pipeline_tag?: string;
      downloads?: number;
      likes?: number;
      private?: boolean;
      gated?: false | "auto" | "manual";
      inference?: string;
      tags?: string[];
    }>;

    const models: HFModel[] = rawModels.map(m => ({
      id: m.id || m.modelId || "",
      name: formatModelName(m.id || m.modelId || ""),
      task: m.pipeline_tag || task,
      downloads: m.downloads || 0,
      likes: m.likes || 0,
      private: m.private || false,
      gated: m.gated || false,
    })).filter(m => m.id); // Filter out empty IDs

    // Update cache
    modelsCache.set(cacheKey, models);
    modelsCacheTimestamp.set(cacheKey, Date.now());

    console.log(`[huggingface] Fetched ${models.length} models for task: ${task}`);
    return models;
  } catch (error) {
    console.error(`[huggingface] Failed to fetch models for task ${task}:`, error);
    return [];
  }
}

/**
 * Fetch ALL models with inference providers across all task types
 * This is the main function used by the models registry
 * 
 * @param tasksToFetch - Optional list of specific tasks to fetch. If not provided, fetches all.
 * @param modelsPerTask - Models to fetch per task (default 100)
 */
export async function fetchAllInferenceModels(
  tasksToFetch?: string[],
  modelsPerTask = 100
): Promise<HFModel[]> {
  if (!HF_TOKEN) {
    console.warn("[huggingface] No token - cannot fetch models");
    return [];
  }

  // Get task list
  const tasks = tasksToFetch || (await fetchAvailableTasks()).map(t => t.id);

  // Prioritize important tasks first
  const priorityTasks = [
    "text-generation",
    "text-to-image",
    "image-to-image",
    "text-to-speech",
    "automatic-speech-recognition",
    "text-to-video",
    "text-to-audio",
    "feature-extraction",
    "conversational",
  ];

  const orderedTasks = [
    ...priorityTasks.filter(t => tasks.includes(t)),
    ...tasks.filter(t => !priorityTasks.includes(t)),
  ];

  console.log(`[huggingface] Fetching models for ${orderedTasks.length} task types...`);

  // Fetch in batches to avoid rate limiting
  const allModels: HFModel[] = [];
  const seenIds = new Set<string>();
  const batchSize = 5;

  for (let i = 0; i < orderedTasks.length; i += batchSize) {
    const batch = orderedTasks.slice(i, i + batchSize);

    const batchResults = await Promise.all(
      batch.map(task => fetchModelsByTask(task, modelsPerTask))
    );

    for (const models of batchResults) {
      for (const model of models) {
        if (!seenIds.has(model.id)) {
          seenIds.add(model.id);
          allModels.push(model);
        }
      }
    }

    // Small delay between batches to avoid rate limiting
    if (i + batchSize < orderedTasks.length) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  console.log(`[huggingface] Total: ${allModels.length} unique models with inference providers`);
  return allModels;
}

/**
 * Get count of models with inference providers
 * Useful for displaying stats
 */
export async function getInferenceModelCount(): Promise<number> {
  if (!HF_TOKEN) return 0;

  try {
    // Quick count query
    const response = await fetch(
      "https://huggingface.co/api/models?inference_provider=all&limit=1",
      {
        headers: {
          Authorization: `Bearer ${HF_TOKEN}`,
        },
      }
    );

    // Get count from response headers if available
    const totalCount = response.headers.get("x-total-count");
    if (totalCount) {
      return parseInt(totalCount, 10);
    }

    // Fallback: just return a known approximate count
    return 15000;
  } catch {
    return 15000; // Approximate count
  }
}

// =============================================================================
// Helper Functions
// =============================================================================

function formatModelName(modelId: string): string {
  const parts = modelId.split("/");
  const name = parts[parts.length - 1];

  return name
    .split("-")
    .map(word => {
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
        "flux": "FLUX",
        "sdxl": "SDXL",
        "whisper": "Whisper",
        "tts": "TTS",
        "instruct": "Instruct",
        "chat": "Chat",
      };
      const lower = word.toLowerCase();
      if (abbrevs[lower]) return abbrevs[lower];
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join(" ");
}

// =============================================================================
// Express Route Handlers
// =============================================================================

/**
 * GET /api/hf/models
 * Returns models with inference providers from HuggingFace
 * 
 * Query params:
 *   - task: Filter by task (e.g., "text-generation", "text-to-image")
 *   - limit: Max results per task (default 50)
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

    let models: HFModel[];

    if (task && task !== "all") {
      // Fetch specific task
      models = await fetchModelsByTask(task, limit);
    } else {
      // Fetch all tasks
      models = await fetchAllInferenceModels(undefined, Math.ceil(limit / 10));
    }

    // Apply search filter
    if (search) {
      models = models.filter(m =>
        m.id.toLowerCase().includes(search) ||
        m.name.toLowerCase().includes(search)
      );
    }

    // Sort by downloads
    models.sort((a, b) => b.downloads - a.downloads);

    // Apply limit
    models = models.slice(0, limit);

    res.json({
      models,
      total: models.length,
      cached: modelsCache.size > 0,
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
    const decodedId = decodeURIComponent(modelId);

    const response = await fetch(`https://huggingface.co/api/models/${decodedId}`, {
      headers: {
        Authorization: `Bearer ${HF_TOKEN}`,
      },
    });

    if (!response.ok) {
      throw new Error(`Model not found: ${response.status}`);
    }

    const metadata = await response.json() as {
      id: string;
      pipeline_tag?: string;
      downloads?: number;
      likes?: number;
      private?: boolean;
      gated?: false | "auto" | "manual";
      lastModified?: string;
      tags?: string[];
      library_name?: string;
      cardData?: { license?: string };
      createdAt?: string;
      inference?: string;
    };

    res.json({
      id: metadata.id,
      task: metadata.pipeline_tag,
      downloads: metadata.downloads,
      likes: metadata.likes,
      private: metadata.private,
      gated: metadata.gated,
      updatedAt: metadata.lastModified,
      tags: metadata.tags || [],
      library: metadata.library_name,
      license: metadata.cardData?.license,
      createdAt: metadata.createdAt,
      hasInference: metadata.inference === "warm" || metadata.inference === "cold",
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
 * Returns available inference task types from HuggingFace
 */
export async function handleGetHFTasks(_req: Request, res: Response) {
  try {
    const tasks = await fetchAvailableTasks();
    res.json({ tasks });
  } catch (error) {
    console.error("[huggingface] Failed to fetch tasks:", error);
    res.status(500).json({
      error: "Failed to fetch tasks",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
}

// =============================================================================
// Exports for use by other modules
// =============================================================================

export { fetchAvailableTasks, getDefaultTasks };
