import type { ModelCard } from "../../types.js";
import type { Usage } from "../../core.js";
import {
  buildCapability,
  hasInput,
  hasOutput,
  hasSourceType,
  uniqueCapabilities,
} from "../source.js";
import { isRealtimeOnlyModel } from "./realtime.js";
import type { ModelOperationCapability, ModelSourceShape } from "./types.js";

// ---------------------------------------------------------------------------
// Modality classification — maps `source.sourceTypes` to canonical ops.
// ---------------------------------------------------------------------------

const TEXT_TYPE_OPERATIONS = new Map<string, string>([
  ["chat", "chat"],
  ["chat-completions", "chat"],
  ["text-to-text", "chat"],
  ["conversational", "chat"],
  // Most "text generation" / "text-generation" models in the catalog are
  // OpenAI / Anthropic / Google chat-completions models. Map them to the
  // canonical `chat` operation so integrators can find them under
  // `/v1/modalities/text/operations/chat/models`.
  ["text-generation", "chat"],
  ["reasoning", "chat"],
  ["responses", "responses"],
  ["completion", "completion"],
  ["completions", "completion"],
  ["search", "search"],
  ["deep-research", "deep-research"],
  ["question-answering", "question-answering"],
  ["summarization", "summarization"],
  ["translation", "translation"],
  ["moderation", "moderation"],
  ["text-classification", "classification"],
  ["token-classification", "classification"],
  ["zero-shot-classification", "classification"],
  ["classification", "classification"],
  ["speech", "chat"],
]);

const STT_TYPES = [
  "speech-to-text",
  "transcription",
  "automatic-speech-recognition",
] as const;

function textInputs(source: ModelSourceShape): string[] {
  const input = source.input.filter((value) => ["text", "image", "audio", "video"].includes(value));
  return input.length > 0 ? input : ["text"];
}

export function classifyTextModel(model: ModelCard, source: ModelSourceShape): ModelOperationCapability[] {
  const capabilities: ModelOperationCapability[] = [];
  if (isRealtimeOnlyModel(model, source)) {
    return capabilities;
  }

  const acceptsText = hasInput(source, "text") || source.input.length === 0;
  const emitsText = hasOutput(source, "text") || source.output.length === 0;

  if (acceptsText && emitsText) {
    for (const sourceType of source.sourceTypes) {
      const operation = TEXT_TYPE_OPERATIONS.get(sourceType);
      if (operation) {
        capabilities.push(
          buildCapability(model, source, "text", operation, true, {
            input: textInputs(source),
            output: ["text"],
          }),
        );
      }
    }
  }

  if (hasInput(source, "audio") && hasOutput(source, "text")) {
    if (hasSourceType(source, STT_TYPES) || !hasInput(source, "text")) {
      capabilities.push(buildCapability(model, source, "text", "speech-to-text", false, {
        input: hasInput(source, "text") ? ["audio", "text"] : ["audio"],
        output: ["text"],
      }));
    }
  }

  if (hasSourceType(source, ["image-text-to-text"])) {
    capabilities.push(buildCapability(model, source, "text", "vision-chat", true, {
      input: ["image", "text"],
      output: ["text"],
    }));
  }

  return uniqueCapabilities(capabilities);
}

// ===========================================================================
// Universal text-modality request shape
// ===========================================================================
//
// End users issue a SINGLE typed request — the resolver picks model + family
// + vendor invisibly. Universal params are flat at the top level. Native,
// family-specific knobs live in `native: { <family>: { ... } }` so users who
// know they want, say, Z.AI's `thinking: { clear_thinking: false }` or
// DeepSeek's `reasoning_effort: "max"` can pass them through with full type
// safety, while users who don't care can ignore them.
//
// Every native sub-shape below is sourced from the official upstream docs.
// NO aliases, NO renaming — keys preserve native lexicon.
// ===========================================================================

/**
 * A piece of content within a chat message. Models that don't accept a
 * given part type (e.g. video) ignore it. Family bridges decide how to
 * translate.
 */
export type TextContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string; detail?: "auto" | "low" | "high" } | string }
  | { type: "input_audio"; input_audio: { url: string; format?: string } | string }
  | { type: "video_url"; video_url: { url: string } | string }
  | { type: "file_url"; file_url: { url: string } | string }
  | { type: "tool-call"; toolCallId: string; toolName: string; input: unknown }
  | { type: "tool-result"; toolCallId: string; toolName: string; output: unknown };

export interface TextMessage {
  role: "system" | "user" | "assistant" | "tool" | "developer";
  content: string | TextContentPart[] | null;
  /** OpenAI / DeepSeek / Moonshot / etc. — assistant-message tool invocations. */
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
  name?: string;
  /** DeepSeek / Moonshot beta partial mode. */
  prefix?: boolean;
  /** DeepSeek beta CoT continuation. Requires `prefix: true`. */
  reasoning_content?: string;
  /** Provider-specific metadata that survives turn round-trips
   *  (e.g. Gemini `thoughtSignature`). */
  providerMetadata?: Record<string, Record<string, unknown>>;
}

/** Universal text-generation request. */
export interface TextRequest {
  /** Compose model id (resolver picks family + vendor). */
  model: string;

  /** Operation hint — chat | responses | completion | classify | summarize | translate | moderation | search | deep-research | rerank. */
  operation?: string;

  /** Conversation. */
  messages: TextMessage[];

  /** Top-level system prompt (Anthropic / Z.AI Vidu / Vertex separately
   *  surface this field; for OpenAI-shape it gets prepended as
   *  `role: "system"`). */
  system?: string;

  /** OpenAI Responses API multi-turn handle. */
  previous_response_id?: string;

  // -------------------------------------------------------------------------
  // Sampling
  // -------------------------------------------------------------------------
  temperature?: number;
  top_p?: number;
  top_k?: number;
  min_p?: number;
  presence_penalty?: number;
  frequency_penalty?: number;
  repetition_penalty?: number;
  seed?: number;
  /** Stop sequences (OpenAI: up to 4; Anthropic: any; DeepSeek/Moonshot: 16/5). */
  stop?: string | string[];
  logit_bias?: Record<string, number>;

  // -------------------------------------------------------------------------
  // Length
  // -------------------------------------------------------------------------
  max_tokens?: number;
  max_output_tokens?: number;
  max_completion_tokens?: number;

  // -------------------------------------------------------------------------
  // Output format
  // -------------------------------------------------------------------------
  response_format?:
    | { type: "text" }
    | { type: "json_object" }
    | { type: "json_schema"; json_schema: { name: string; schema: Record<string, unknown>; strict?: boolean } };

  // -------------------------------------------------------------------------
  // Tools
  // -------------------------------------------------------------------------
  tools?: Array<{
    type: "function" | "retrieval" | "web_search" | "computer" | "code_interpreter";
    function?: {
      name: string;
      description?: string;
      parameters?: Record<string, unknown>;
      strict?: boolean;
    };
    retrieval?: { knowledge_id: string; prompt_template?: string };
    web_search?: Record<string, unknown>;
    computer?: Record<string, unknown>;
    code_interpreter?: Record<string, unknown>;
  }>;
  tool_choice?:
    | "auto" | "none" | "required"
    | { type: "function"; function: { name: string } }
    | { type: "tool"; toolName: string };
  parallel_tool_calls?: boolean;

  // -------------------------------------------------------------------------
  // Reasoning / thinking — universal toggle and budget
  // -------------------------------------------------------------------------
  /** Universal reasoning toggle (mapped to native field per family). */
  thinking?: boolean | { type: "enabled" | "disabled" };
  reasoning_effort?: "minimal" | "low" | "medium" | "high" | "max" | "xhigh";

  // -------------------------------------------------------------------------
  // Logprobs
  // -------------------------------------------------------------------------
  logprobs?: boolean | number;
  top_logprobs?: number;

  // -------------------------------------------------------------------------
  // Streaming
  // -------------------------------------------------------------------------
  stream?: boolean;
  stream_options?: { include_usage?: boolean; exclude_aggregated_audio?: boolean };

  // -------------------------------------------------------------------------
  // Identity / safety / cache
  // -------------------------------------------------------------------------
  user?: string;
  user_id?: string;
  safety_identifier?: string;
  prompt_cache_key?: string;
  request_id?: string;

  // -------------------------------------------------------------------------
  // Native — family-specific extensions (all optional, all type-safe)
  // -------------------------------------------------------------------------
  native?: TextRequestNative;

  /** Last-resort free-form passthrough; bypassed when native is set. */
  customParams?: Record<string, unknown>;
}

/**
 * Family-keyed native extensions. End users opt into specific knobs per
 * family without the resolver caring. Bridges read only the slot they own
 * and ignore the rest.
 */
export interface TextRequestNative {
  openai?: OpenAINativeText;
  anthropic?: AnthropicNativeText;
  google?: GoogleNativeText;
  xai?: XaiNativeText;
  zai?: ZaiNativeText;
  deepseek?: DeepSeekNativeText;
  moonshot?: MoonshotNativeText;
  minimax?: MinimaxNativeText;
  alibaba?: AlibabaNativeText;
  cohere?: CohereNativeText;
  mistral?: MistralNativeText;
  tencent?: TencentNativeText;
  baidu?: BaiduNativeText;
  bytedance?: BytedanceNativeText;
  nvidia?: NvidiaNativeText;
  meta?: MetaNativeText;
  microsoft?: MicrosoftNativeText;
  ibm?: IbmNativeText;
}

// ---------------------------------------------------------------------------
// OpenAI (gpt-*, o1, o3, o4, gpt-oss, chatgpt-*)
// ---------------------------------------------------------------------------

export interface OpenAINativeText {
  /** Responses API: tools that retain state across turns. */
  store?: boolean;
  /** Responses API: persist server-side. */
  metadata?: Record<string, string>;
  /** Reasoning models (o1/o3/o4/gpt-5): effort + summary level. */
  reasoning?: {
    effort?: "minimal" | "low" | "medium" | "high";
    summary?: "auto" | "concise" | "detailed" | null;
  };
  /** Server-side modality output channels (Responses). */
  modalities?: Array<"text" | "audio">;
  /** When `modalities` includes "audio". */
  audio?: { voice?: string; format?: "wav" | "mp3" | "flac" | "opus" | "pcm16" };
  /** Web search built-in tool params (Responses). */
  web_search_options?: { search_context_size?: "low" | "medium" | "high"; user_location?: { type: "approximate"; approximate: { country?: string; city?: string; region?: string; timezone?: string } } };
  /** Service tier override. */
  service_tier?: "auto" | "default" | "flex" | "priority";
  /** Verbosity (gpt-5 family). */
  verbosity?: "low" | "medium" | "high";
  /** Predicted output for speculative decoding. */
  prediction?: { type: "content"; content: string | Array<{ type: "text"; text: string }> };
}

// ---------------------------------------------------------------------------
// Anthropic (claude-*)
// ---------------------------------------------------------------------------

export interface AnthropicNativeText {
  /** Extended thinking. */
  thinking?: { type: "enabled"; budget_tokens: number } | { type: "disabled" };
  /** Beta header opt-ins; vendor selects beta route accordingly. */
  betas?: string[];
  /** Prompt-cache breakpoints — applied at the message/content-part level
   *  via the bridge. Toggles cache_control: { type: "ephemeral", ttl }. */
  cache_control?: { ttl?: "5m" | "1h" };
  /** Server-side tool: web_search. */
  web_search?: { max_uses?: number; allowed_domains?: string[]; blocked_domains?: string[]; user_location?: { type: "approximate"; city?: string; region?: string; country?: string; timezone?: string } };
  /** Server-side tool: web_fetch. */
  web_fetch?: { max_uses?: number; allowed_domains?: string[]; blocked_domains?: string[]; max_content_tokens?: number };
  /** Server-side tool: code_execution. */
  code_execution?: { type: "code_execution_20250825" | "code_execution_20260120" };
  /** Computer-use tool config. */
  computer_use?: { type: "computer_20250124"; display_width_px: number; display_height_px: number; display_number?: number };
  /** Citations enable / disable. */
  citations?: { enabled: boolean };
  /** Force tool parallelism. */
  disable_parallel_tool_use?: boolean;
  /** Container reuse for code execution. */
  container?: string;
}

// ---------------------------------------------------------------------------
// Google (gemini-*, gemma-*, imagen-*, veo-*, lyria-*, nano-banana)
// ---------------------------------------------------------------------------

export interface GoogleNativeText {
  /** Gemini thinking. */
  thinkingConfig?: { thinkingBudget?: number; includeThoughts?: boolean };
  /** Gemini safety thresholds. */
  safetySettings?: Array<{ category: string; threshold: string }>;
  /** System instruction (top-level — `system` flat field also supported). */
  systemInstruction?: { parts: Array<{ text: string }> };
  /** Built-in tools. */
  tools?: Array<
    | { google_search: Record<string, never> }
    | { google_search_retrieval: { dynamic_retrieval_config?: { mode: "MODE_DYNAMIC"; dynamic_threshold: number } } }
    | { code_execution: Record<string, never> }
    | { url_context: Record<string, never> }
    | { google_maps: Record<string, never> }
  >;
  /** Generation config. */
  generationConfig?: {
    responseMimeType?: "text/plain" | "application/json" | "text/x.enum";
    responseSchema?: Record<string, unknown>;
    responseModalities?: Array<"TEXT" | "IMAGE" | "AUDIO">;
    candidateCount?: number;
    speechConfig?: { voiceConfig?: { prebuiltVoiceConfig?: { voiceName: string } }; languageCode?: string };
    routingConfig?: { autoMode?: { modelRoutingPreference: "PRIORITIZE_QUALITY" | "BALANCED" | "PRIORITIZE_COST" } };
    mediaResolution?: "MEDIA_RESOLUTION_LOW" | "MEDIA_RESOLUTION_MEDIUM" | "MEDIA_RESOLUTION_HIGH";
  };
  /** Cached content reference. */
  cachedContent?: string;
  /** Labels for billing tracking. */
  labels?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// xAI (grok-*)
// ---------------------------------------------------------------------------

export interface XaiNativeText {
  /** Live web/X search. */
  search_parameters?: {
    mode?: "off" | "auto" | "on";
    sources?: Array<
      | { type: "web"; country?: string; excluded_websites?: string[]; allowed_websites?: string[]; safe_search?: boolean }
      | { type: "x"; x_handles?: string[]; included_x_handles?: string[]; excluded_x_handles?: string[]; post_favorite_count?: number; post_view_count?: number }
      | { type: "news"; country?: string; excluded_websites?: string[]; safe_search?: boolean }
      | { type: "rss"; links: string[] }
    >;
    from_date?: string;
    to_date?: string;
    return_citations?: boolean;
    max_search_results?: number;
  };
  /** Reasoning effort (grok-3-mini and below — NOT grok-4). */
  reasoning_effort?: "low" | "high";
  /** Deferred chat completion mode. */
  deferred?: boolean;
  /** Request id (for deferred polling). */
  request_id?: string;
}

// ---------------------------------------------------------------------------
// Z.AI / Zhipu (glm-*, autoglm-*, cogview*, cogvideox)
// ---------------------------------------------------------------------------

export interface ZaiNativeText {
  /** Thinking mode toggle + multi-turn preservation. */
  thinking?: { type?: "enabled" | "disabled"; clear_thinking?: boolean };
  /** Stream tool-call deltas (GLM-4.6+). */
  tool_stream?: boolean;
  /** Sampling toggle (when false, temperature/top_p have no effect). */
  do_sample?: boolean;
  /** Built-in retrieval tool. */
  retrieval?: { knowledge_id: string; prompt_template?: string };
  /** Built-in web-search tool. */
  web_search?: {
    enable?: boolean;
    search_engine?: "search_pro_jina";
    search_query?: string;
    count?: number;
    search_domain_filter?: string;
    search_recency_filter?: "oneDay" | "oneWeek" | "oneMonth" | "oneYear" | "noLimit";
    content_size?: "medium" | "high";
    result_sequence?: "before" | "after";
    search_result?: boolean;
    require_search?: boolean;
    search_prompt?: string;
  };
}

// ---------------------------------------------------------------------------
// DeepSeek (deepseek-v4-flash, deepseek-v4-pro, R-series)
// ---------------------------------------------------------------------------

export interface DeepSeekNativeText {
  thinking?: { type: "enabled" | "disabled" };
  /** Default "high"; "max" is for complex agentic workflows. */
  reasoning_effort?: "high" | "max";
  /** Per-token logprobs (separate channel for content + reasoning). */
  logprobs?: boolean;
  top_logprobs?: number;
  /** User id for KVCache isolation. */
  user_id?: string;
  /** FIM-only fields. */
  fim?: { suffix?: string; echo?: boolean };
}

// ---------------------------------------------------------------------------
// Moonshot (kimi-*, moonshot-v1-*)
// ---------------------------------------------------------------------------

export interface MoonshotNativeText {
  /** kimi-k2.6 thinking + preserved-thinking. */
  thinking?: { type: "enabled" | "disabled"; keep?: "all" | null };
  /** Cache key for prompt KV reuse. */
  prompt_cache_key?: string;
  safety_identifier?: string;
  /** Partial mode — set on the LAST assistant message. */
  partial?: boolean;
  /** MFJS-strict mode for json_schema. */
  strict_schema?: boolean;
}

// ---------------------------------------------------------------------------
// MiniMax (m2.7, m2.5, M2-her, ABAB-chat-pro)
// ---------------------------------------------------------------------------

export interface MinimaxNativeText {
  /** Plugin tools (web search, code interpreter, etc.). */
  plugin?: Array<{ name: string; arguments?: Record<string, unknown> }>;
  /** Bot setting — character / role-play config. */
  bot_setting?: Array<{ bot_name: string; content: string }>;
  /** Reply constraints. */
  reply_constraints?: { sender_type: "BOT"; sender_name: string };
  /** Sample messages for in-context demonstration. */
  sample_messages?: Array<{ sender_type: "USER" | "BOT"; sender_name?: string; text: string }>;
  /** Mask the assistant prefix in the response. */
  mask_sensitive_info?: boolean;
}

// ---------------------------------------------------------------------------
// Alibaba DashScope (qwen-*, wan-*, qwen-vl-*, qwen-audio-*)
// ---------------------------------------------------------------------------

export interface AlibabaNativeText {
  /** Qwen3 thinking toggle. */
  enable_thinking?: boolean;
  /** Thinking budget tokens. */
  thinking_budget?: number;
  /** Search-and-grounding flags. */
  enable_search?: boolean;
  search_options?: {
    forced_search?: boolean;
    enable_source?: boolean;
    enable_citation?: boolean;
    citation_format?: "[<number>]" | "[ref_<number>]";
    search_strategy?: "standard" | "pro";
  };
  /** Web search MCP (Qwen-Plus). */
  enable_web_search?: boolean;
  /** Translation options for qwen-mt-*. */
  translation_options?: { source_lang?: string; target_lang: string; terms?: Array<{ source: string; target: string }>; tm_list?: Array<{ source: string; target: string }>; domains?: string };
  /** Increment streaming output (deltas only, not aggregated). */
  incremental_output?: boolean;
  /** Custom result format ("message" or "text"). */
  result_format?: "message" | "text";
}

// ---------------------------------------------------------------------------
// Cohere (command-*, aya-*, c4ai-*, embed-*, rerank-*)
// ---------------------------------------------------------------------------

export interface CohereNativeText {
  /** Conversation id for multi-turn. */
  conversation_id?: string;
  /** Documents for grounded generation (RAG). */
  documents?: Array<{ id?: string; data: Record<string, string>; title?: string; snippet?: string; url?: string }>;
  /** Connectors for built-in retrieval (e.g. `web-search`). */
  connectors?: Array<{ id: string; user_access_token?: string; continue_on_failure?: boolean; options?: Record<string, unknown> }>;
  /** Citation quality / mode. */
  citation_options?: { mode: "fast" | "accurate" | "off" };
  /** Prompt truncation strategy. */
  prompt_truncation?: "off" | "auto" | "auto_preserve_order";
  /** Safety mode. */
  safety_mode?: "contextual" | "strict" | "off";
  /** Force JSON. */
  raw_prompting?: boolean;
}

// ---------------------------------------------------------------------------
// Mistral (mistral-*, mixtral-*, pixtral-*, codestral-*, magistral-*, ...)
// ---------------------------------------------------------------------------

export interface MistralNativeText {
  /** Random seed for reproducibility (Mistral aliases `random_seed`). */
  random_seed?: number;
  /** Force safe-prompt prepending. */
  safe_prompt?: boolean;
  /** Document(s) for grounded generation. */
  document?: Array<{ type: "image_url" | "document_url"; image_url?: string; document_url?: string }>;
  /** Magistral series: prediction (speculative decoding). */
  prediction?: { type: "content"; content: string };
  /** Tool-result presentation. */
  tool_choice?: "auto" | "any" | "none" | { type: "function"; function: { name: string } };
}

// ---------------------------------------------------------------------------
// Tencent Hunyuan (hunyuan-*)
// ---------------------------------------------------------------------------

export interface TencentNativeText {
  /** Search/enhancement toggle. */
  enable_enhancement?: boolean;
  /** Force search even when low-confidence. */
  force_search_enhancement?: boolean;
  /** Speed-mode search (faster TTFT). */
  enable_speed_search?: boolean;
  /** Multi-media response (images / video URLs). */
  enable_multimedia?: boolean;
  /** Knowledge-grounded search options. */
  web_search_options?: { from_date?: string; to_date?: string; max_search_results?: number; search_strategy?: "standard" | "pro"; user_location?: string };
  /** Add source citations. */
  citation?: boolean;
  /** Append search-info object to the response. */
  search_info?: boolean;
  /** Recommended follow-up questions. */
  enable_recommended_questions?: boolean;
  /** Hunyuan thinking toggle (a13b only). */
  enable_thinking?: boolean;
  /** Stream-output safety review mode. */
  stream_moderation?: boolean;
  /** Topic constraint. */
  topic_choice?: string;
}

// ---------------------------------------------------------------------------
// Baidu ERNIE (ernie-*)
// ---------------------------------------------------------------------------

export interface BaiduNativeText {
  /** ERNIE web-search built-in. */
  web_search?: { enable?: boolean; enable_citation?: boolean; enable_trace?: boolean };
  /** Toggle thinking. */
  enable_thinking?: boolean;
  /** Penalty score (Baidu ranges differ from OpenAI). */
  penalty_score?: number;
  /** Disable safety filter (whitelisted accounts). */
  disable_search?: boolean;
  /** Trace user identity. */
  user_id?: string;
  /** System prompt (Baidu prefers `system` field). */
  system?: string;
  /** Output streaming markers. */
  enable_corner_markers?: boolean;
}

// ---------------------------------------------------------------------------
// ByteDance Doubao / Volcano Ark (doubao-*, seed-*)
// ---------------------------------------------------------------------------

export interface BytedanceNativeText {
  /** Doubao thinking. */
  thinking?: { type: "enabled" | "disabled" | "auto" };
  /** Vision-detail. */
  vision_detail?: "auto" | "low" | "high";
  /** Enable web-search via Ark plugin. */
  bot_id?: string;
  /** Endpoint metadata for the Ark dispatcher. */
  endpoint_id?: string;
  /** Force JSON output. */
  format?: "json" | "text";
}

// ---------------------------------------------------------------------------
// NVIDIA NIM (nemotron-*, nv-*) — universal NIM extensions
// ---------------------------------------------------------------------------

export interface NvidiaNativeText {
  /** Nemotron classifier guardrail levels. */
  guardrails?: { content_safety?: boolean; topic_control?: boolean; jailbreak_detect?: boolean };
  /** Function-calling mode. */
  nvext?: {
    top_k?: number;
    top_p?: number;
    seed?: number;
    repetition_penalty?: number;
    /** Detokenizer skip. */
    skip_special_tokens?: boolean;
    /** Stop tokens (token ids). */
    stop_token_ids?: number[];
  };
}

// ---------------------------------------------------------------------------
// Meta (llama-*) — Llama-Stack-style native fields
// ---------------------------------------------------------------------------

export interface MetaNativeText {
  /** Built-in tools (Llama 3.x): `brave_search`, `wolfram_alpha`,
   *  `code_interpreter`, `photogen`. */
  built_in_tools?: Array<"brave_search" | "wolfram_alpha" | "code_interpreter" | "photogen">;
  /** Llama-Guard category filters. */
  guard_categories?: string[];
  /** Llama Stack chat-template kwargs (e.g. ipython turns). */
  chat_template_kwargs?: { tools_in_user_message?: boolean; add_generation_prompt?: boolean; date_string?: string };
}

// ---------------------------------------------------------------------------
// Microsoft (phi-*, orca-*, mai-*, e5-*)
// ---------------------------------------------------------------------------

export interface MicrosoftNativeText {
  /** Phi-4 thinking. */
  reasoning_effort?: "low" | "medium" | "high";
  /** Azure-style content filter override. */
  content_filter_severity?: "safe" | "low" | "medium" | "high";
}

// ---------------------------------------------------------------------------
// IBM Granite (granite-*)
// ---------------------------------------------------------------------------

export interface IbmNativeText {
  /** Granite-Guardian classifier label hint. */
  guardian_intent?: "harm" | "social_bias" | "jailbreak" | "violence" | "sexual_content" | "unethical_behavior";
  /** Granite reasoning toggle. */
  thinking?: boolean;
  /** Granite RAG document grounding. */
  documents?: Array<{ doc_id: string; text: string; title?: string }>;
  /** Style profile (chat / RAG / instruct). */
  style?: "chat" | "rag" | "instruct";
}

// ===========================================================================
// Universal text-modality response shape
// ===========================================================================

export interface TextResponse {
  /** Concatenated text — empty when only tool calls. */
  text: string;
  /** Reasoning / thinking content (Anthropic, Z.AI, DeepSeek, Moonshot,
   *  Alibaba qwen3, ByteDance, IBM, etc.). */
  reasoningContent?: string;
  /** Stop reason — normalized to a stable string union. */
  finishReason?:
    | "stop"
    | "length"
    | "content_filter"
    | "tool_calls"
    | "abort"
    | "error"
    | "other";
  /** Tool calls emitted by the assistant. */
  toolCalls?: Array<{ id: string; name: string; arguments: string; providerMetadata?: Record<string, unknown> }>;
  /** Citations / web-search grounding (xAI, Z.AI, Tencent, Alibaba, Cohere,
   *  Anthropic web_search, Google url_context). */
  citations?: TextCitation[];
  /** Structured search results when an integrated tool returned them. */
  searchResults?: Array<Record<string, unknown>>;
  /** Logprobs (DeepSeek / OpenAI). */
  logprobs?: { content?: TextLogprob[]; reasoning_content?: TextLogprob[] };
  /** Token usage and per-modality breakdown. */
  usage?: Usage;
  /** Model id the wire reported (may differ from request when routing). */
  model?: string;
  /** Server fingerprint (OpenAI). */
  systemFingerprint?: string;
  /** Native passthrough — every family's raw response is preserved here so
   *  consumers that need an exotic field (Anthropic `stop_sequence`,
   *  Tencent `Replaces`, Alibaba `output.search_info`) can read it. */
  raw: unknown;
}

export interface TextCitation {
  /** Inline marker the model used (e.g. "[1]", "ref_3"). */
  marker?: string;
  title?: string;
  url?: string;
  snippet?: string;
  /** Document index when grounded against a document set. */
  documentIndex?: number;
  /** Per-citation provider metadata. */
  providerMetadata?: Record<string, unknown>;
}

export interface TextLogprob {
  token: string;
  logprob: number;
  bytes: number[] | null;
  top_logprobs: Array<{ token: string; logprob: number; bytes: number[] | null }>;
}

// ===========================================================================
// Universal text-modality streaming events
// ===========================================================================

export type TextStreamEvent =
  | { type: "text-delta"; text: string }
  | { type: "reasoning-delta"; text: string }
  | { type: "tool-call"; id: string; name: string; arguments: string; providerMetadata?: Record<string, unknown> }
  | { type: "tool-call-delta"; index: number; id?: string; name?: string; argumentsDelta?: string }
  | { type: "citation"; citation: TextCitation }
  | { type: "warning"; warning: { code: string; message: string } }
  | { type: "error"; error: { code: string; message: string; details?: Record<string, unknown> } }
  | { type: "done"; finishReason?: TextResponse["finishReason"]; usage?: Usage };
