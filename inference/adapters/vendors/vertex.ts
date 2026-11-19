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

const VERTEX_AI_API_KEY = process.env.VERTEX_AI_API_KEY;
const VERTEX_PROJECT_ID = process.env.VERTEX_PROJECT_ID;
const VERTEX_LOCATION = process.env.VERTEX_LOCATION || "us-central1";

if (!VERTEX_AI_API_KEY) {
    console.warn("[vertex] VERTEX_AI_API_KEY not set");
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
    const size = options?.size;
    const [width, height] = size ? size.split("x").map(Number) : [undefined, undefined];

    const url = `https://${VERTEX_LOCATION}-aiplatform.googleapis.com/v1/projects/${VERTEX_PROJECT_ID}/locations/${VERTEX_LOCATION}/publishers/google/models/${modelId}:predict`;

    const requestBody = {
        instances: [
            { prompt: prompt }
        ],
        parameters: {
            ...(options?.n !== undefined ? { sampleCount: options.n } : {}),
            ...(width && height ? { aspectRatio: `${width}:${height}` } : {}),
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
