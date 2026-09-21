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