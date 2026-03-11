const CARTESIA_API_KEY = process.env.CARTESIA_API_KEY;
const CARTESIA_DEFAULT_VOICE_ID = process.env.CARTESIA_DEFAULT_VOICE_ID;
const CARTESIA_API_VERSION = process.env.CARTESIA_API_VERSION || "2024-06-10";

if (!CARTESIA_API_KEY) {
    console.warn("[cartesia] CARTESIA_API_KEY not set — Cartesia speech disabled");
}

function requireCartesiaApiKey(): string {
    if (!CARTESIA_API_KEY) {
        throw new Error("CARTESIA_API_KEY not configured");
    }
    return CARTESIA_API_KEY;
}

export interface CartesiaSpeechOptions {
    voiceId?: string;
    responseFormat?: string;
    speed?: number;
}

export async function generateCartesiaSpeech(
    modelId: string,
    text: string,
    options: CartesiaSpeechOptions = {},
): Promise<{ buffer: Buffer; mimeType: string }> {
    const voiceId = options.voiceId || CARTESIA_DEFAULT_VOICE_ID;
    if (!voiceId) {
        throw new Error("Cartesia voice ID is required");
    }

    const outputFormat = mapCartesiaOutput(options.responseFormat);
    const response = await fetch("https://api.cartesia.ai/tts/bytes", {
        method: "POST",
        headers: {
            "X-API-Key": requireCartesiaApiKey(),
            "Cartesia-Version": CARTESIA_API_VERSION,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            model_id: modelId,
            transcript: text,
            voice: {
                mode: "id",
                id: voiceId,
            },
            output_format: outputFormat,
            language: "en",
            speed: options.speed ?? 1,
        }),
    });

    if (!response.ok) {
        throw new Error(`Cartesia speech failed: ${response.status} ${await response.text()}`);
    }

    return {
        buffer: Buffer.from(await response.arrayBuffer()),
        mimeType: response.headers.get("content-type") || outputFormatToMimeType(outputFormat.container),
    };
}

function mapCartesiaOutput(format?: string): { container: string; encoding: string; sample_rate: number } {
    switch ((format || "mp3").toLowerCase()) {
        case "wav":
            return { container: "wav", encoding: "pcm_s16le", sample_rate: 44100 };
        case "pcm":
            return { container: "raw", encoding: "pcm_s16le", sample_rate: 24000 };
        case "opus":
            return { container: "ogg", encoding: "opus", sample_rate: 48000 };
        default:
            return { container: "mp3", encoding: "mp3", sample_rate: 44100 };
    }
}

function outputFormatToMimeType(container: string): string {
    switch (container) {
        case "wav":
            return "audio/wav";
        case "ogg":
            return "audio/ogg";
        case "raw":
            return "audio/pcm";
        default:
            return "audio/mpeg";
    }
}
