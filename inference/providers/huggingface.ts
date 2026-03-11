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
const FAL_API_KEY = process.env.FAL_API_KEY;

if (!HF_TOKEN) {
  console.warn("[huggingface] HUGGING_FACE_INFERENCE_TOKEN not set - HF model discovery disabled");
}

if (!FAL_API_KEY) {
  console.warn("[huggingface] FAL_API_KEY not set - fal.ai fallback disabled");
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
 * @param modelsPerTask - Models to fetch per task (default 200 - increased to capture more breadth)
 */
export async function fetchAllInferenceModels(
  tasksToFetch?: string[],
  modelsPerTask = 200
): Promise<HFModel[]> {
  if (!HF_TOKEN) {
    console.warn("[huggingface] No token - cannot fetch models");
    return [];
  }

  // Get task list
  const tasks = tasksToFetch || (await fetchAvailableTasks()).map(t => t.id);

  // Prioritize important tasks first and ensure we get enough of them
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
  const batchSize = 3; // Reduced concurrency slightly to be safe

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
      await new Promise(resolve => setTimeout(resolve, 200));
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

  const modelIdParam = req.params.modelId;
  const modelId = Array.isArray(modelIdParam) ? modelIdParam[0] : modelIdParam;

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
// HuggingFace Router API - Dynamic Per-Provider Pricing
// =============================================================================

/**
 * HuggingFace Router model with per-provider pricing
 * Source: router.huggingface.co/v1/models
 */
export interface HFRouterProvider {
  provider: string;
  status: string;
  context_length?: number;
  pricing?: {
    input: number;   // USD per million tokens
    output: number;  // USD per million tokens
  };
  supports_tools?: boolean;
  supports_structured_output?: boolean;
  is_model_author?: boolean;
}

export interface HFRouterModel {
  id: string;
  object: string;
  created: number;
  owned_by: string;
  architecture?: {
    input_modalities: string[];
    output_modalities: string[];
  };
  providers: HFRouterProvider[];
}

// Cache for router models
let routerModelsCache: HFRouterModel[] | null = null;
let routerModelsCacheTimestamp = 0;
const ROUTER_CACHE_TTL = 6 * 60 * 60 * 1000; // 6 hours

/**
 * Fetch models with pricing from HuggingFace Router API
 * This endpoint returns per-model per-provider pricing dynamically
 */
export async function fetchHFRouterModels(forceRefresh = false): Promise<HFRouterModel[]> {
  // Check cache
  if (!forceRefresh && routerModelsCache && Date.now() - routerModelsCacheTimestamp < ROUTER_CACHE_TTL) {
    return routerModelsCache;
  }

  try {
    const response = await fetch("https://router.huggingface.co/v1/models", {
      headers: HF_TOKEN ? { Authorization: `Bearer ${HF_TOKEN}` } : {},
    });

    if (!response.ok) {
      console.error(`[huggingface] Router API returned ${response.status}`);
      return routerModelsCache || [];
    }

    const data = await response.json() as { data: HFRouterModel[] };
    routerModelsCache = data.data;
    routerModelsCacheTimestamp = Date.now();

    console.log(`[huggingface] Fetched ${data.data.length} models with pricing from Router API`);
    return data.data;
  } catch (error) {
    console.error("[huggingface] Error fetching from Router API:", error);
    return routerModelsCache || [];
  }
}

/**
 * Get the cheapest provider for a model from Router API
 * Returns pricing and provider info for cost estimation
 */
export function getCheapestProvider(model: HFRouterModel): HFRouterProvider | null {
  const providersWithPricing = model.providers.filter(p => p.pricing && p.status === "live");
  if (providersWithPricing.length === 0) return null;

  // Sort by total cost (input + output) and return cheapest
  return providersWithPricing.sort((a, b) => {
    const costA = (a.pricing!.input + a.pricing!.output);
    const costB = (b.pricing!.input + b.pricing!.output);
    return costA - costB;
  })[0];
}

/**
 * Clear router models cache
 */
export function clearRouterCache(): void {
  routerModelsCache = null;
  routerModelsCacheTimestamp = 0;
}

// =============================================================================
// Unified HuggingFace Inference Executor
// Uses @huggingface/inference InferenceClient with provider="auto"
// =============================================================================

/**
 * Result type for HF inference - varies by task
 */
export interface HFInferenceResult {
  type: "image" | "video" | "audio" | "text" | "json" | "embedding";
  data: Buffer | string | number[] | number[][] | object;
  mimeType?: string;
}

/**
 * Input type for HF inference
 */
export interface HFInferenceInput {
  modelId: string;
  task: string;
  // Text inputs
  prompt?: string;
  text?: string;
  messages?: Array<{ role: string; content: string }>;
  systemPrompt?: string;
  // Media inputs (base64 encoded)
  image?: string;
  audio?: string;
  // Parameters
  parameters?: Record<string, unknown>;
  /** Specific HF Inference Provider (e.g., "fal-ai", "replicate", "together") */
  inferenceProvider?: string;
}

/**
 * Get a singleton InferenceClient instance
 */
let inferenceClient: InstanceType<typeof import("@huggingface/inference").InferenceClient> | null = null;

async function getInferenceClient() {
  if (!HF_TOKEN) throw new Error("HuggingFace token not configured (HUGGING_FACE_INFERENCE_TOKEN)");

  if (!inferenceClient) {
    const { InferenceClient } = await import("@huggingface/inference");
    inferenceClient = new InferenceClient(HF_TOKEN);
  }
  return inferenceClient;
}

/**
 * Execute HuggingFace inference for any task type
 * Routes to the correct InferenceClient method based on task
 * 
 * @param input - Inference input with modelId, task, and relevant data
 * @returns HFInferenceResult with type and data
 */
export async function executeHFInference(input: HFInferenceInput): Promise<HFInferenceResult> {
  const client = await getInferenceClient();
  const { modelId, task } = input;
  // Use specific provider if available, otherwise fall back to auto
  // Cast to any since HF SDK expects a union type but we store as string
  const provider = (input.inferenceProvider || "auto") as any;

  console.log(`[huggingface] Executing inference: ${modelId} (task: ${task}, provider: ${provider})`);



  try {
    switch (task) {
      // ===========================================
      // Text Generation Tasks
      // ===========================================
      case "text-generation":
      case "text2text-generation": {
        const result = await client.textGeneration({
          provider,
          model: modelId,
          inputs: input.prompt || input.text || "",
          parameters: input.parameters as Record<string, unknown>,
        });
        return { type: "text", data: result.generated_text };
      }

      case "conversational": {
        // Use chat completion for conversational models
        const result = await client.chatCompletion({
          provider,
          model: modelId,
          messages: input.messages || [{ role: "user", content: input.prompt || "" }],
          ...(input.parameters as Record<string, unknown>),
        });
        return {
          type: "text",
          data: result.choices?.[0]?.message?.content || ""
        };
      }

      // ===========================================
      // Image Generation Tasks
      // ===========================================
      case "text-to-image": {
        const result = await client.textToImage({
          provider,
          model: modelId,
          inputs: input.prompt || "",
          parameters: input.parameters as Record<string, unknown>,
        });
        const buffer = await blobToBuffer(result as unknown as Blob);
        return { type: "image", data: buffer, mimeType: "image/png" };
      }

      case "image-to-image": {
        if (!input.image) throw new Error("image is required for image-to-image");
        const imageBuffer = Buffer.from(input.image, "base64");
        const imageBlob = new Blob([new Uint8Array(imageBuffer)], { type: "image/png" });

        const result = await client.imageToImage({
          provider,
          model: modelId,
          inputs: imageBlob,
          parameters: {
            prompt: input.prompt || "",
            ...(input.parameters as Record<string, unknown>),
          },
        });
        const buffer = await blobToBuffer(result as unknown as Blob);
        return { type: "image", data: buffer, mimeType: "image/png" };
      }

      // ===========================================
      // Video Generation Tasks
      // ===========================================
      case "text-to-video": {
        const result = await client.textToVideo({
          provider,
          model: modelId,
          inputs: input.prompt || "",
          parameters: input.parameters as Record<string, unknown>,
        });
        // textToVideo returns a Blob with the video data
        const buffer = await blobToBuffer(result as unknown as Blob);
        return { type: "video", data: buffer, mimeType: "video/mp4" };
      }

      case "image-to-video": {
        if (!input.image) throw new Error("image is required for image-to-video");
        const imageBuffer = Buffer.from(input.image, "base64");
        const imageBlob = new Blob([new Uint8Array(imageBuffer)], { type: "image/png" });

        const result = await client.imageToVideo({
          provider,
          model: modelId,
          inputs: imageBlob,
          parameters: {
            prompt: input.prompt,
            ...(input.parameters as Record<string, unknown>),
          },
        });
        // imageToVideo returns a Blob with the video data
        const buffer = await blobToBuffer(result as unknown as Blob);
        return { type: "video", data: buffer, mimeType: "video/mp4" };
      }

      // ===========================================
      // Audio Tasks
      // ===========================================
      case "text-to-speech":
      case "text-to-audio": {
        const result = await client.textToSpeech({
          provider,
          model: modelId,
          inputs: input.text || input.prompt || "",
          parameters: input.parameters as Record<string, unknown>,
        });
        const buffer = await blobToBuffer(result as unknown as Blob);
        return { type: "audio", data: buffer, mimeType: "audio/wav" };
      }

      case "automatic-speech-recognition": {
        if (!input.audio) throw new Error("audio is required for ASR");
        const audioBuffer = Buffer.from(input.audio, "base64");
        const audioBlob = new Blob([new Uint8Array(audioBuffer)], { type: "audio/wav" });

        const result = await client.automaticSpeechRecognition({
          provider,
          model: modelId,
          inputs: audioBlob,
        });
        return { type: "json", data: { text: result.text } };
      }

      case "audio-classification": {
        if (!input.audio) throw new Error("audio is required for audio classification");
        const audioBuffer = Buffer.from(input.audio, "base64");
        const audioBlob = new Blob([new Uint8Array(audioBuffer)], { type: "audio/wav" });

        const result = await client.audioClassification({
          model: modelId,
          inputs: audioBlob,
        });
        return { type: "json", data: result };
      }

      // ===========================================
      // Embedding Tasks
      // ===========================================
      case "feature-extraction": {
        const result = await client.featureExtraction({
          model: modelId,
          inputs: input.text || input.prompt || "",
        });
        return { type: "embedding", data: result as number[] | number[][] };
      }

      case "sentence-similarity": {
        const result = await client.sentenceSimilarity({
          model: modelId,
          inputs: {
            source_sentence: input.text || input.prompt || "",
            sentences: (input.parameters?.sentences as string[]) || [],
          },
        });
        return { type: "json", data: result };
      }

      // ===========================================
      // NLP Tasks
      // ===========================================
      case "summarization": {
        const result = await client.summarization({
          model: modelId,
          inputs: input.text || input.prompt || "",
          parameters: input.parameters as Record<string, unknown>,
        });
        return { type: "text", data: result.summary_text };
      }

      case "translation": {
        const result = await client.translation({
          model: modelId,
          inputs: input.text || input.prompt || "",
          parameters: input.parameters as Record<string, unknown>,
        });
        return { type: "text", data: result.translation_text };
      }

      case "text-classification": {
        const result = await client.textClassification({
          model: modelId,
          inputs: input.text || input.prompt || "",
        });
        return { type: "json", data: result };
      }

      case "token-classification": {
        const result = await client.tokenClassification({
          model: modelId,
          inputs: input.text || input.prompt || "",
        });
        return { type: "json", data: result };
      }

      case "question-answering": {
        const result = await client.questionAnswering({
          model: modelId,
          inputs: {
            question: input.prompt || "",
            context: input.text || (input.parameters?.context as string) || "",
          },
        });
        return { type: "json", data: result };
      }

      case "fill-mask": {
        const result = await client.fillMask({
          model: modelId,
          inputs: input.text || input.prompt || "",
        });
        return { type: "json", data: result };
      }

      case "zero-shot-classification": {
        const result = await client.zeroShotClassification({
          model: modelId,
          inputs: input.text || input.prompt || "",
          parameters: {
            candidate_labels: (input.parameters?.candidate_labels as string[]) || [],
          },
        });
        return { type: "json", data: result };
      }

      // ===========================================
      // Vision Tasks
      // ===========================================
      case "image-classification": {
        if (!input.image) throw new Error("image is required for image classification");
        const imageBuffer = Buffer.from(input.image, "base64");
        const imageBlob = new Blob([new Uint8Array(imageBuffer)], { type: "image/png" });

        const result = await client.imageClassification({
          model: modelId,
          inputs: imageBlob,
        });
        return { type: "json", data: result };
      }

      case "object-detection": {
        if (!input.image) throw new Error("image is required for object detection");
        const imageBuffer = Buffer.from(input.image, "base64");
        const imageBlob = new Blob([new Uint8Array(imageBuffer)], { type: "image/png" });

        const result = await client.objectDetection({
          model: modelId,
          inputs: imageBlob,
        });
        return { type: "json", data: result };
      }

      case "image-segmentation": {
        if (!input.image) throw new Error("image is required for image segmentation");
        const imageBuffer = Buffer.from(input.image, "base64");
        const imageBlob = new Blob([new Uint8Array(imageBuffer)], { type: "image/png" });

        const result = await client.imageSegmentation({
          model: modelId,
          inputs: imageBlob,
        });
        return { type: "json", data: result };
      }

      case "image-to-text": {
        if (!input.image) throw new Error("image is required for image-to-text");
        const imageBuffer = Buffer.from(input.image, "base64");
        const imageBlob = new Blob([new Uint8Array(imageBuffer)], { type: "image/png" });

        const result = await client.imageToText({
          model: modelId,
          inputs: imageBlob,
        });
        return { type: "text", data: result.generated_text || "" };
      }

      // depth-estimation is not supported in the InferenceClient SDK
      // Users should use a different provider or the raw API for this task
      case "depth-estimation": {
        throw new Error(
          `Task "depth-estimation" is not supported via the HuggingFace InferenceClient. ` +
          `Please use the HuggingFace Spaces API directly for depth estimation models.`
        );
      }

      case "visual-question-answering": {
        if (!input.image) throw new Error("image is required for VQA");
        const imageBuffer = Buffer.from(input.image, "base64");
        const imageBlob = new Blob([new Uint8Array(imageBuffer)], { type: "image/png" });

        const result = await client.visualQuestionAnswering({
          model: modelId,
          inputs: {
            image: imageBlob,
            question: input.prompt || "",
          },
        });
        return { type: "json", data: result };
      }

      case "document-question-answering": {
        if (!input.image) throw new Error("document image is required for DQA");
        const imageBuffer = Buffer.from(input.image, "base64");
        const imageBlob = new Blob([new Uint8Array(imageBuffer)], { type: "image/png" });

        const result = await client.documentQuestionAnswering({
          model: modelId,
          inputs: {
            image: imageBlob,
            question: input.prompt || "",
          },
        });
        return { type: "json", data: result };
      }

      case "zero-shot-image-classification": {
        if (!input.image) throw new Error("image is required for zero-shot image classification");
        const imageBuffer = Buffer.from(input.image, "base64");
        const imageBlob = new Blob([new Uint8Array(imageBuffer)], { type: "image/png" });

        const result = await client.zeroShotImageClassification({
          model: modelId,
          inputs: { image: imageBlob },
          parameters: {
            candidate_labels: (input.parameters?.candidate_labels as string[]) || [],
          },
        });
        return { type: "json", data: result };
      }

      default:
        throw new Error(`Unsupported task type for HuggingFace inference: ${task}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const lowerMessage = message.toLowerCase();
    console.error(`[huggingface] Inference failed for ${modelId} (${task}):`, message);

    // Check for fal-ai prepaid credits error and retry with FAL_API_KEY if available
    const isFalPrepaidError = (
      lowerMessage.includes("pre-paid credits") ||
      lowerMessage.includes("prepaid credits") ||
      lowerMessage.includes("pre paid credits")
    ) && lowerMessage.includes("fal");

    console.log(`[huggingface] FAL_API_KEY available: ${!!FAL_API_KEY}, isFalPrepaidError: ${isFalPrepaidError}`);

    if (isFalPrepaidError && FAL_API_KEY) {
      console.log(`[huggingface] fal-ai requires prepaid credits, retrying with FAL_API_KEY directly...`);

      try {
        // Create a new InferenceClient with FAL_API_KEY for direct fal.ai access
        const { InferenceClient } = await import("@huggingface/inference");
        const falClient = new InferenceClient(FAL_API_KEY);
        const provider = "fal-ai" as any;

        // Retry the same operation with fal.ai direct auth
        switch (task) {
          case "text-to-image": {
            const result = await falClient.textToImage({
              provider,
              model: modelId,
              inputs: input.prompt || "",
              parameters: input.parameters as Record<string, unknown>,
            });
            const buffer = await blobToBuffer(result as unknown as Blob);
            return { type: "image", data: buffer, mimeType: "image/png" };
          }
          case "text-to-video": {
            const result = await falClient.textToVideo({
              provider,
              model: modelId,
              inputs: input.prompt || "",
              parameters: input.parameters as Record<string, unknown>,
            });
            const buffer = await blobToBuffer(result as unknown as Blob);
            return { type: "video", data: buffer, mimeType: "video/mp4" };
          }
          case "text-to-speech":
          case "text-to-audio": {
            const result = await falClient.textToSpeech({
              provider,
              model: modelId,
              inputs: input.text || input.prompt || "",
              parameters: input.parameters as Record<string, unknown>,
            });
            const buffer = await blobToBuffer(result as unknown as Blob);
            return { type: "audio", data: buffer, mimeType: "audio/wav" };
          }
          case "automatic-speech-recognition":
          case "speech-to-text": {
            if (!input.audio) throw new Error("audio is required for ASR");
            const audioBuffer = Buffer.from(input.audio, "base64");
            const audioBlob = new Blob([new Uint8Array(audioBuffer)], { type: "audio/wav" });
            const result = await falClient.automaticSpeechRecognition({
              provider,
              model: modelId,
              inputs: audioBlob,
            });
            return { type: "text", data: result.text };
          }
          default:
            // For unsupported tasks, fall through to original error
            console.log(`[huggingface] FAL_API_KEY fallback not supported for task: ${task}`);
        }
      } catch (falError) {
        console.error(`[huggingface] FAL_API_KEY fallback also failed:`, falError);
        // Fall through to original error handling
      }
    }

    // Provide helpful error messages
    if (message.includes("does not support") || message.includes("404") || message.includes("not found")) {
      throw new Error(
        `Model "${modelId}" is not available for ${task} inference via HuggingFace. ` +
        `This model may not have inference providers configured, or you may need to select a different model.`
      );
    }
    if (message.includes("loading") || message.includes("503")) {
      throw new Error(`Model "${modelId}" is loading. Please try again in 20-30 seconds.`);
    }
    if (lowerMessage.includes("rate limit") || lowerMessage.includes("429")) {
      throw new Error(`Rate limit exceeded for HuggingFace API. Please try again in a few seconds.`);
    }
    if (isFalPrepaidError) {
      throw new Error(
        `Provider fal-ai requires pre-paid credits. Either add credits to your HuggingFace account ` +
        `or set FAL_API_KEY in your environment for direct access.`
      );
    }

    throw error;
  }
}

/**
 * Helper to convert Blob to Buffer
 */
async function blobToBuffer(blob: Blob): Promise<Buffer> {
  if (typeof blob.arrayBuffer === "function") {
    const arrayBuffer = await blob.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }
  return Buffer.from(blob as unknown as ArrayBuffer);
}

/**
 * Clear inference client (useful for testing or token refresh)
 */
export function clearInferenceClient(): void {
  inferenceClient = null;
}

// =============================================================================
// Exports for use by other modules
// =============================================================================

export { fetchAvailableTasks, getDefaultTasks };
