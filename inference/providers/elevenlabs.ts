const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_DEFAULT_VOICE_ID = process.env.ELEVENLABS_DEFAULT_VOICE_ID;

if (!ELEVENLABS_API_KEY) {
    console.warn("[elevenlabs] ELEVENLABS_API_KEY not set — ElevenLabs speech disabled");
}

function requireElevenLabsApiKey(): string {
    if (!ELEVENLABS_API_KEY) {
        throw new Error("ELEVENLABS_API_KEY not configured");
    }
    return ELEVENLABS_API_KEY;
}

export interface ElevenLabsSpeechOptions {
    voiceId?: string;
    responseFormat?: string;
    speed?: number;
}

export async function generateElevenLabsSpeech(
    modelId: string,
    text: string,
    options: ElevenLabsSpeechOptions = {},
): Promise<{ buffer: Buffer; mimeType: string }> {
    const voiceId = options.voiceId || ELEVENLABS_DEFAULT_VOICE_ID;
    if (!voiceId) {
        throw new Error("ElevenLabs voice ID is required");
    }

    const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}`, {
        method: "POST",
        headers: {
            "xi-api-key": requireElevenLabsApiKey(),
            "Content-Type": "application/json",
            "Accept": "audio/mpeg",
        },
        body: JSON.stringify({
            text,
            model_id: modelId,
            output_format: mapElevenLabsFormat(options.responseFormat),
            voice_settings: {
                stability: 0.35,
                similarity_boost: 0.7,
                style: 0.35,
                speed: options.speed ?? 1,
                use_speaker_boost: true,
            },
        }),
    });

    if (!response.ok) {
        throw new Error(`ElevenLabs speech failed: ${response.status} ${await response.text()}`);
    }

    return {
        buffer: Buffer.from(await response.arrayBuffer()),
        mimeType: response.headers.get("content-type") || "audio/mpeg",
    };
}

function mapElevenLabsFormat(format?: string): string {
    switch ((format || "mp3").toLowerCase()) {
        case "wav":
            return "pcm_44100";
        case "pcm":
            return "pcm_44100";
        case "aac":
            return "mp3_44100_128";
        case "opus":
            return "ogg_44100_128";
        default:
            return "mp3_44100_128";
    }
}
