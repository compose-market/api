/**
 * HuggingFace Inference Executor
 *
 * Uses @huggingface/inference InferenceClient with provider="auto".
 */

const HF_TOKEN = process.env.HUGGING_FACE_INFERENCE_TOKEN;
const FAL_API_KEY = process.env.FAL_API_KEY;

if (!HF_TOKEN) {
  console.warn("[huggingface] HUGGING_FACE_INFERENCE_TOKEN not set - HF inference disabled");
}

if (!FAL_API_KEY) {
  console.warn("[huggingface] FAL_API_KEY not set - fal.ai fallback disabled");
}

// =============================================================================
// HuggingFace Inference Executor
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
  text?: string | string[];
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

function primaryTextInput(input: HFInferenceInput): string {
  if (typeof input.prompt === "string" && input.prompt.length > 0) {
    return input.prompt;
  }
  if (Array.isArray(input.text)) {
    return input.text.join("\n");
  }
  return input.text || "";
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
          inputs: primaryTextInput(input),
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

        const result = await client.imageTextToImage({
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

        const result = await client.imageTextToVideo({
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
          inputs: primaryTextInput(input),
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
        const inputs = Array.isArray(input.text)
          ? input.text
          : primaryTextInput(input);
        const result = await client.featureExtraction({
          provider,
          model: modelId,
          inputs,
        });
        return { type: "embedding", data: result as number[] | number[][] };
      }

      case "sentence-similarity": {
        const result = await client.sentenceSimilarity({
          model: modelId,
          inputs: {
            source_sentence: primaryTextInput(input),
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
          inputs: primaryTextInput(input),
          parameters: input.parameters as Record<string, unknown>,
        });
        return { type: "text", data: result.summary_text };
      }

      case "translation": {
        const result = await client.translation({
          model: modelId,
          inputs: primaryTextInput(input),
          parameters: input.parameters as Record<string, unknown>,
        });
        return { type: "text", data: result.translation_text };
      }

      case "text-classification": {
        const result = await client.textClassification({
          model: modelId,
          inputs: primaryTextInput(input),
        });
        return { type: "json", data: result };
      }

      case "token-classification": {
        const result = await client.tokenClassification({
          model: modelId,
          inputs: primaryTextInput(input),
        });
        return { type: "json", data: result };
      }

      case "question-answering": {
        const result = await client.questionAnswering({
          model: modelId,
          inputs: {
            question: input.prompt || "",
            context: primaryTextInput(input) || (input.parameters?.context as string) || "",
          },
        });
        return { type: "json", data: result };
      }

      case "fill-mask": {
        const result = await client.fillMask({
          model: modelId,
          inputs: primaryTextInput(input),
        });
        return { type: "json", data: result };
      }

      case "zero-shot-classification": {
        const result = await client.zeroShotClassification({
          model: modelId,
          inputs: primaryTextInput(input),
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
    const isFalRetryableTransportError = lowerMessage.includes("failed to fetch")
      && ["text-to-image", "image-to-image", "text-to-video", "image-to-video"].includes(task);

    console.log(`[huggingface] FAL_API_KEY available: ${!!FAL_API_KEY}, isFalPrepaidError: ${isFalPrepaidError}`);

    if ((isFalPrepaidError || isFalRetryableTransportError) && FAL_API_KEY) {
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
          case "image-to-image": {
            if (!input.image) throw new Error("image is required for image-to-image");
            const imageBuffer = Buffer.from(input.image, "base64");
            const imageBlob = new Blob([new Uint8Array(imageBuffer)], { type: "image/png" });
            const result = await falClient.imageTextToImage({
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
          case "image-to-video": {
            if (!input.image) throw new Error("image is required for image-to-video");
            const imageBuffer = Buffer.from(input.image, "base64");
            const imageBlob = new Blob([new Uint8Array(imageBuffer)], { type: "image/png" });
            const result = await falClient.imageTextToVideo({
              provider,
              model: modelId,
              inputs: imageBlob,
              parameters: {
                prompt: input.prompt || "",
                ...(input.parameters as Record<string, unknown>),
              },
            });
            const buffer = await blobToBuffer(result as unknown as Blob);
            return { type: "video", data: buffer, mimeType: "video/mp4" };
          }
          case "text-to-speech":
          case "text-to-audio": {
            const result = await falClient.textToSpeech({
              provider,
              model: modelId,
              inputs: primaryTextInput(input),
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
