/**
 * ChainGPT chat client — api-side relay.
 *
 * Cloudflare Workers cannot reach api.chaingpt.org: it is itself a
 * Cloudflare zone, and Worker-originated requests arrive at its edge over
 * the internal backbone without a public client TLS handshake (TLS version
 * "none"), which its edge rejects with HTTP 400 "You need to use TLS
 * version 1.2 or higher." The api runs on GCP with a real TLS egress stack,
 * so the connectors Worker relays ChainGPT chat calls through here.
 *
 * All ChainGPT chat-family products share one endpoint (blob mode):
 *   POST https://api.chaingpt.org/chat/stream
 * The live API answers EITHER as plain text (HTTP 201) or as the documented
 * JSON blob {status, message, data:{bot}} — both are handled. First-party
 * credentials only: CHAIN_GPT_SECRET_KEY is an api secret (GCP), never a
 * user credential.
 */

const CHAINGPT_CHAT_URL = "https://api.chaingpt.org/chat/stream";
const CHAINGPT_TIMEOUT_MS = 50_000;

export const CHAINGPT_MODELS = new Set([
    "general_assistant",
    "smart_contract_auditor",
    "smart_contract_generator",
]);

export type ChainGptChatResult =
    | { ok: true; answer: string }
    | { ok: false; status?: number; error: string };

function parseJson(text: string): unknown {
    try {
        return JSON.parse(text);
    } catch {
        return undefined;
    }
}

function errorMessage(value: unknown): string | undefined {
    const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
    for (const key of ["message", "error"]) {
        const text = typeof record[key] === "string" ? (record[key] as string).trim() : "";
        if (text) return text;
    }
    return undefined;
}

export async function callChainGptChat(input: {
    model: string;
    question: string;
    timeoutMs?: number;
}): Promise<ChainGptChatResult> {
    const apiKey = process.env.CHAIN_GPT_SECRET_KEY?.trim();
    if (!apiKey) {
        return { ok: false, error: "CHAIN_GPT_SECRET_KEY is not configured on the api" };
    }
    if (!CHAINGPT_MODELS.has(input.model)) {
        return { ok: false, error: `unsupported model: ${input.model}` };
    }

    const response = await fetch(CHAINGPT_CHAT_URL, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            model: input.model,
            question: input.question,
            chatHistory: "off",
        }),
        signal: AbortSignal.timeout(input.timeoutMs ?? CHAINGPT_TIMEOUT_MS),
    });
    const body = await response.text().catch(() => "");
    const parsed = parseJson(body);

    if (response.status < 200 || response.status >= 300) {
        return {
            ok: false,
            status: response.status,
            error: errorMessage(parsed) || body.trim().slice(0, 500) || `chaingpt request failed (${response.status})`,
        };
    }

    if (parsed && typeof parsed === "object") {
        const blob = parsed as { status?: boolean; message?: string; data?: { bot?: string } };
        if (blob.status === false) {
            return { ok: false, error: blob.message || "chaingpt request failed" };
        }
        const answer = typeof blob.data?.bot === "string" ? blob.data.bot.trim() : "";
        if (answer) return { ok: true, answer };
    } else if (typeof parsed === "string" && parsed.trim()) {
        return { ok: true, answer: parsed.trim() };
    } else if (body.trim()) {
        // Observed live shape: HTTP 201 with a plain-text answer body.
        return { ok: true, answer: body.trim() };
    }

    return { ok: false, error: "chaingpt returned an empty answer" };
}
