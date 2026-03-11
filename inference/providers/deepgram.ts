const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;

if (!DEEPGRAM_API_KEY) {
    console.warn("[deepgram] DEEPGRAM_API_KEY not set — Deepgram speech disabled");
}

function requireDeepgramApiKey(): string {
    if (!DEEPGRAM_API_KEY) {
        throw new Error("DEEPGRAM_API_KEY not configured");
    }
    return DEEPGRAM_API_KEY;
}

function stripDeepgramPrefix(modelId: string): string {
    return modelId.replace(/^deepgram\//, "");
}

export interface DeepgramSpeechOptions {
    voice?: string;
    responseFormat?: string;
}

export async function transcribeDeepgramAudio(
    modelId: string,
    audioBuffer: Buffer,
    options: { language?: string } = {},
): Promise<{ text: string; metadata?: Record<string, unknown> }> {
    const url = new URL("https://api.deepgram.com/v1/listen");
    url.searchParams.set("model", stripDeepgramPrefix(modelId));
    url.searchParams.set("smart_format", "true");
    if (options.language) {
        url.searchParams.set("language", options.language);
    }

    const response = await fetch(url, {
        method: "POST",
        headers: {
            "Authorization": `Token ${requireDeepgramApiKey()}`,
            "Content-Type": "audio/wav",
        },
        body: new Blob([audioBuffer.buffer.slice(audioBuffer.byteOffset, audioBuffer.byteOffset + audioBuffer.byteLength) as ArrayBuffer], {
            type: "audio/wav",
        }),
    });

    if (!response.ok) {
        throw new Error(`Deepgram transcription failed: ${response.status} ${await response.text()}`);
    }

    const payload = await response.json() as {
        metadata?: Record<string, unknown>;
        results?: {
            channels?: Array<{
                alternatives?: Array<{
                    transcript?: string;
                }>;
            }>;
        };
    };

    const text = payload.results?.channels?.[0]?.alternatives?.[0]?.transcript || "";
    return { text, metadata: payload.metadata };
}

export async function generateDeepgramSpeech(
    modelId: string,
    text: string,
    options: DeepgramSpeechOptions = {},
): Promise<{ buffer: Buffer; mimeType: string }> {
    const format = (options.responseFormat || "mp3").toLowerCase();
    const url = new URL("https://api.deepgram.com/v1/speak");
    url.searchParams.set("model", stripDeepgramPrefix(modelId));

    switch (format) {
        case "wav":
            url.searchParams.set("container", "wav");
            url.searchParams.set("encoding", "linear16");
            break;
        case "pcm":
            url.searchParams.set("encoding", "linear16");
            break;
        case "opus":
            url.searchParams.set("encoding", "opus");
            url.searchParams.set("container", "ogg");
            break;
        case "aac":
            url.searchParams.set("encoding", "aac");
            url.searchParams.set("container", "aac");
            break;
        case "flac":
            url.searchParams.set("encoding", "flac");
            url.searchParams.set("container", "flac");
            break;
        default:
            url.searchParams.set("encoding", "mp3");
            url.searchParams.set("container", "mp3");
            break;
    }

    if (options.voice) {
        url.searchParams.set("voice", options.voice);
    }

    const response = await fetch(url, {
        method: "POST",
        headers: {
            "Authorization": `Token ${requireDeepgramApiKey()}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({ text }),
    });

    if (!response.ok) {
        throw new Error(`Deepgram speech failed: ${response.status} ${await response.text()}`);
    }

    return {
        buffer: Buffer.from(await response.arrayBuffer()),
        mimeType: response.headers.get("content-type") || "audio/mpeg",
    };
}
