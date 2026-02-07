import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import dotenv from "dotenv";

// =============================================================================
// Config
// =============================================================================

const ROOT = path.resolve(process.cwd(), "..");
const REGISTRY_PATH = path.join(ROOT, "services", "connector", "data", "mcpServers.json");

for (const envPath of [path.join(process.cwd(), ".env"), path.join(ROOT, ".env")]) {
  if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath, override: false, quiet: true });
  }
}

const OUTPUT_DIR = path.join(process.cwd(), "knowledge");
const MCP_INDEX_PATH = path.join(OUTPUT_DIR, "mcp-index.jsonl");
const MCP_TOOLS_PATH = path.join(OUTPUT_DIR, "mcp-tools.jsonl");
const MCP_VECTORS_PATH = path.join(OUTPUT_DIR, "mcp-vectors.jsonl");
const MCP_CLUSTERS_PATH = path.join(OUTPUT_DIR, "mcp-clusters.json");
const MCP_ERRORS_PATH = path.join(OUTPUT_DIR, "mcp-errors.jsonl");
const MCP_CHECKPOINT_PATH = path.join(OUTPUT_DIR, "mcp-checkpoint.json");
const MCP_SPAWNED_PATH = path.join(OUTPUT_DIR, "mcp-spawned.jsonl");

const CONNECTOR_URL = process.env.CONNECTOR_URL || "https://services.compose.market/connector";
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
const OPENAI_KEY = process.env.OPENAI_KEY || process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.MCP_INDEX_OPENAI_MODEL || "gpt-4o";

const CF_ACCOUNT_ID = process.env.CF_ACCOUNT_ID || "";
const CF_API_TOKEN = process.env.CF_API_TOKEN || "";
const CF_EMBEDDING_MODEL = process.env.CF_EMBEDDING_MODEL || "@cf/baai/bge-base-en-v1.5";

const RESET_OUTPUTS = process.env.MCP_INDEX_RESET !== "0";
const MAX_SERVERS = Math.max(0, Number(process.env.MCP_INDEX_MAX_SERVERS || "0"));
const REQUIRE_TOOLS = process.env.MCP_INDEX_REQUIRE_TOOLS !== "0";
const MIN_TOOL_COUNT = Math.max(0, Number(process.env.MCP_INDEX_MIN_TOOL_COUNT || "1"));

const STRICT_SPAWN = process.env.MCP_INDEX_STRICT_SPAWN !== "0";
const STRICT_DESCRIPTIONS = process.env.MCP_INDEX_STRICT_DESCRIPTIONS !== "0";
const ALLOW_EMPTY_EMBEDDINGS = process.env.MCP_INDEX_ALLOW_EMPTY_EMBEDDINGS === "1";

const SPAWN_CONCURRENCY = Math.max(1, Number(process.env.MCP_INDEX_SPAWN_CONCURRENCY || "16"));
const DESCRIBE_CONCURRENCY = Math.max(1, Number(process.env.MCP_INDEX_DESCRIBE_CONCURRENCY || "3"));
const EMBED_CONCURRENCY = Math.max(1, Number(process.env.MCP_INDEX_EMBED_CONCURRENCY || "12"));

const SPAWN_TIMEOUT_MS = Math.max(5_000, Number(process.env.MCP_INDEX_SPAWN_TIMEOUT_MS || "30000"));
const OPENAI_TIMEOUT_MS = Math.max(5_000, Number(process.env.MCP_INDEX_OPENAI_TIMEOUT_MS || "60000"));
const EMBED_TIMEOUT_MS = Math.max(5_000, Number(process.env.MCP_INDEX_EMBED_TIMEOUT_MS || "20000"));

const OPENAI_RETRIES = Math.max(0, Number(process.env.MCP_INDEX_OPENAI_RETRIES || "2"));
const TOOL_PROMPT_BATCH = Math.max(1, Number(process.env.MCP_INDEX_TOOL_PROMPT_BATCH || "30"));
const VECTOR_METADATA_MAX_TOOLS = Math.max(1, Number(process.env.MCP_INDEX_VECTOR_METADATA_MAX_TOOLS || "24"));

const EMBED_MAX_TOOLS = Math.max(1, Number(process.env.MCP_INDEX_EMBED_MAX_TOOLS || "30"));
const EMBED_MAX_CHARS = Math.max(512, Number(process.env.MCP_INDEX_EMBED_MAX_CHARS || "7000"));

const TAG_STOPWORDS = new Set([
  "mcp",
  "server",
  "model",
  "context",
  "protocol",
  "glama",
  "pulsemcp",
  "mcpso",
  "github",
  "git",
  "compose",
  "market",
  "official",
  "by",
  "hosting",
  "stdio",
  "hosting-stdio",
  "http",
  "https",
]);

// =============================================================================
// Types
// =============================================================================

type McpServerRecord = {
  id: string;
  name?: string;
  namespace?: string;
  slug?: string;
  description?: string;
  attributes?: string[];
  repository?: { url?: string };
  tools?: ToolDefinition[];
  transport?: string;
  source?: string;
};

type RegistryFile = {
  sources: string[];
  updatedAt: string;
  count: number;
  servers: McpServerRecord[];
};

type ToolDefinition = {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
};

type ToolsResponse = {
  server?: string;
  toolCount?: number;
  tools?: ToolDefinition[];
};

type PreparedServer = {
  server: McpServerRecord;
  registryId: string;
  canonicalId: string;
};

type SpawnedRecord = {
  server: McpServerRecord;
  registryId: string;
  canonicalId: string;
  resolvedId: string;
  tools: ToolDefinition[];
  toolsSource: "runtime";
};

type EnrichedTool = {
  name: string;
  description: string;
  summary: string;
  params: string[];
  inputSchema: Record<string, unknown>;
  inputSchemaHash: string;
  evidence?: string;
};

type EnrichedRecord = SpawnedRecord & {
  mcpDescription: string;
  mcpSummary: string;
  capabilities: string[];
  tags: string[];
  toolDetails: EnrichedTool[];
};

type EmbeddedRecord = EnrichedRecord & {
  embedding: number[];
};

type ErrorRecord = {
  id: string;
  stage: "spawn" | "describe" | "embedding";
  error: string;
  detail?: Record<string, unknown>;
};

type OpenAiToolChunkResult = {
  tool_descriptions: Record<string, {
    description?: string;
    summary?: string;
    params?: string[];
    evidence?: string;
  }>;
};

type OpenAiMcpResult = {
  mcp_description?: string;
  mcp_summary?: string;
  capabilities?: string[];
};

type VectorRecord = {
  id: string;
  values: number[];
  metadata: Record<string, unknown>;
};

// =============================================================================
// Helpers
// =============================================================================

function ensureOutputDir(): void {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
}

function writeJson(filePath: string, payload: unknown): void {
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2));
}

function appendJsonl(stream: fs.WriteStream, payload: unknown): void {
  stream.write(`${JSON.stringify(payload)}\n`);
}

function clearOutputFiles(): void {
  fs.writeFileSync(MCP_INDEX_PATH, "");
  fs.writeFileSync(MCP_TOOLS_PATH, "");
  fs.writeFileSync(MCP_VECTORS_PATH, "");
  fs.writeFileSync(MCP_ERRORS_PATH, "");
  fs.writeFileSync(MCP_SPAWNED_PATH, "");
  if (fs.existsSync(MCP_CHECKPOINT_PATH)) {
    fs.unlinkSync(MCP_CHECKPOINT_PATH);
  }
}

function sha256(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => JSON.stringify(k) + ":" + stableStringify(obj[k])).join(",")}}`;
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/--+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function cleanText(input: string): string {
  return String(input || "").replace(/\s+/g, " ").trim();
}

function decodeHtmlEntities(input: string): string {
  return input
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, "\"")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function cleanDescription(input: string): string {
  const decoded = decodeHtmlEntities(input || "");
  return cleanText(
    decoded
      .replace(/^mcp\s*server\s*[:\-]?\s*/i, "")
      .replace(/^mcp\s*[:\-]?\s*/i, "")
  );
}

function normalizeSchema(schema?: Record<string, unknown>): Record<string, unknown> {
  if (!schema) return {};
  const clone = JSON.parse(JSON.stringify(schema));
  const strip = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    const target = node as Record<string, unknown>;
    delete target.examples;
    delete target.example;
    delete target.default;
    delete target.title;
    delete target.$schema;
    for (const key of Object.keys(target)) {
      strip(target[key]);
    }
  };
  strip(clone);
  return clone;
}

function compactSchemaForPrompt(schema?: Record<string, unknown>): Record<string, unknown> {
  const normalized = normalizeSchema(schema);
  const root: Record<string, unknown> = {};
  const src = normalized as Record<string, unknown>;
  if (typeof src.type === "string") root.type = src.type;

  const required = Array.isArray(src.required) ? src.required.filter((v) => typeof v === "string") : [];
  if (required.length > 0) root.required = required;

  const properties = src.properties;
  if (properties && typeof properties === "object" && !Array.isArray(properties)) {
    const compactProps: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(properties as Record<string, unknown>)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const prop = value as Record<string, unknown>;
      compactProps[key] = {
        type: typeof prop.type === "string" ? prop.type : undefined,
        description: typeof prop.description === "string" ? cleanText(prop.description) : undefined,
      };
    }
    if (Object.keys(compactProps).length > 0) root.properties = compactProps;
  }

  return root;
}

function normalizeTool(tool: ToolDefinition): ToolDefinition | null {
  const name = cleanText(tool.name || "");
  if (!name) return null;
  const description = cleanDescription(tool.description || "");
  const inputSchema = tool.inputSchema && typeof tool.inputSchema === "object"
    ? tool.inputSchema
    : {};
  return {
    name,
    description: description || undefined,
    inputSchema,
  };
}

function extractToolParams(schema?: Record<string, unknown>): string[] {
  if (!schema || typeof schema !== "object") return [];
  const params = new Set<string>();
  const properties = (schema as { properties?: Record<string, unknown> })?.properties || {};
  for (const key of Object.keys(properties)) {
    params.add(key);
  }
  const required = (schema as { required?: unknown })?.required;
  if (Array.isArray(required)) {
    for (const key of required) {
      if (typeof key === "string" && key.trim()) params.add(key.trim());
    }
  }
  return Array.from(params).sort((a, b) => a.localeCompare(b));
}

function scoreToolQuality(tool: ToolDefinition): number {
  const params = extractToolParams(tool.inputSchema);
  const schemaKeys = Object.keys(tool.inputSchema || {}).length;
  return (tool.description?.length || 0) * 2 + params.length * 12 + schemaKeys;
}

function dedupeTools(tools: ToolDefinition[]): ToolDefinition[] {
  const byName = new Map<string, ToolDefinition>();
  for (const rawTool of tools) {
    const tool = normalizeTool(rawTool);
    if (!tool) continue;
    const key = tool.name.toLowerCase();
    const existing = byName.get(key);
    if (!existing || scoreToolQuality(tool) > scoreToolQuality(existing)) {
      byName.set(key, tool);
    }
  }
  return Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));
}

function buildToolSignature(tool: { name: string; description?: string; inputSchema?: Record<string, unknown> }): string {
  return sha256(stableStringify({
    name: tool.name,
    description: tool.description || "",
    schema: normalizeSchema(tool.inputSchema),
  }));
}

function buildToolsHash(tools: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>): string {
  const signatures = tools.map(buildToolSignature).sort();
  return sha256(stableStringify(signatures));
}

function tokenizeTagInput(input: string): string[] {
  return input.split(/[,|/\s]+/g).map((t) => slugify(t)).filter(Boolean);
}

function normalizeTags(candidates: string[]): string[] {
  const tags: string[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (!candidate) continue;
    for (const token of tokenizeTagInput(candidate)) {
      if (!token) continue;
      if (token.length < 2 && token !== "ai") continue;
      if (/^\d+$/.test(token)) continue;
      if (TAG_STOPWORDS.has(token)) continue;
      if (seen.has(token)) continue;
      seen.add(token);
      tags.push(token);
      if (tags.length >= 24) return tags;
    }
  }
  return tags;
}

function buildTagList(server: McpServerRecord, tools: ToolDefinition[]): string[] {
  const candidates = [
    ...(server.attributes || []),
    server.namespace || "",
    server.slug || "",
    server.source || "",
    server.name || "",
    cleanDescription(server.description || ""),
    ...tools.slice(0, 16).map((tool) => tool.name),
  ];
  return normalizeTags(candidates);
}

function buildCanonicalRegistryId(server: McpServerRecord): string {
  const preferred = [
    [server.namespace, server.slug].filter(Boolean).join("-"),
    server.slug || "",
    server.id || "",
    server.name || "",
  ].find((value) => Boolean(cleanText(value)));
  const slug = slugify(preferred || "");
  if (slug) return `mcp:${slug}`;
  return `mcp:${sha256(JSON.stringify(server)).slice(0, 12)}`;
}

function buildUniquenessKey(server: McpServerRecord): string {
  return [
    server.source || "",
    server.id || "",
    server.namespace || "",
    server.slug || "",
    server.name || "",
    server.repository?.url || "",
  ].join("|");
}

function buildPreparedServers(servers: McpServerRecord[]): PreparedServer[] {
  const used = new Set<string>();
  const prepared: PreparedServer[] = [];
  for (const server of servers) {
    const canonicalId = buildCanonicalRegistryId(server);
    let registryId = canonicalId;
    if (used.has(registryId)) {
      const suffix = sha256(buildUniquenessKey(server)).slice(0, 8);
      registryId = `${canonicalId}-${suffix}`;
      let i = 2;
      while (used.has(registryId)) {
        registryId = `${canonicalId}-${suffix}-${i}`;
        i += 1;
      }
    }
    used.add(registryId);
    prepared.push({ server, registryId, canonicalId });
  }
  return prepared;
}

function buildRuntimeCandidates(server: McpServerRecord, registryId: string): string[] {
  const canonicalSlug = registryId.replace(/^mcp:/, "");
  const rawCandidates = [
    server.id || "",
    [server.namespace, server.slug].filter(Boolean).join("/"),
    [server.source, server.id].filter(Boolean).join(":"),
    server.slug || "",
    canonicalSlug,
    registryId,
  ];
  const seen = new Set<string>();
  const candidates: string[] = [];
  for (const raw of rawCandidates) {
    const cleaned = cleanText(raw);
    if (!cleaned || seen.has(cleaned)) continue;
    seen.add(cleaned);
    candidates.push(cleaned);
  }
  return candidates;
}

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

function parseJsonObject(content: string): Record<string, unknown> {
  const trimmed = content.trim();
  try {
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("model-output-not-json");
    return JSON.parse(match[0]) as Record<string, unknown>;
  }
}

function buildEmbeddingText(record: EnrichedRecord): string {
  const lines = [
    `MCP Server: ${cleanText(record.server.name || record.registryId)}`,
    `Description: ${cleanText(record.mcpDescription)}`,
    `Summary: ${cleanText(record.mcpSummary)}`,
    record.capabilities.length > 0 ? `Capabilities: ${record.capabilities.join(", ")}` : "",
    record.tags.length > 0 ? `Tags: ${record.tags.join(", ")}` : "",
    "Tools:",
    ...record.toolDetails
      .slice(0, EMBED_MAX_TOOLS)
      .map((tool) => `- ${tool.name}: ${cleanText(tool.summary)} Params: ${tool.params.join(", ") || "none"}`),
  ].filter(Boolean);
  return lines.join("\n").slice(0, EMBED_MAX_CHARS);
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<{ data: T; status: number }> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} for ${url}${text ? ` - ${text}` : ""}`);
  }
  return { data: await res.json() as T, status: res.status };
}

async function mapLimit<T>(items: T[], limit: number, fn: (item: T, idx: number) => Promise<void>): Promise<void> {
  const workerCount = Math.max(1, Math.min(limit, items.length || 1));
  let idx = 0;
  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      const current = idx;
      idx += 1;
      if (current >= items.length) break;
      await fn(items[current], current);
    }
  });
  await Promise.all(workers);
}

async function endStream(stream: fs.WriteStream): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    stream.once("error", reject);
    stream.end(() => resolve());
  });
}

async function fetchRuntimeTools(server: McpServerRecord, registryId: string): Promise<{ tools: ToolDefinition[]; resolvedId: string; error?: string }> {
  const candidates = buildRuntimeCandidates(server, registryId);
  let lastError: Error | null = null;
  for (const candidate of candidates) {
    try {
      const url = `${CONNECTOR_URL}/mcp/servers/${encodeURIComponent(candidate)}/tools`;
      const { data } = await fetchJson<ToolsResponse>(url, {
        signal: AbortSignal.timeout(SPAWN_TIMEOUT_MS),
      });
      const tools = dedupeTools(data.tools || []);
      if (tools.length > 0) {
        return {
          tools,
          resolvedId: candidate,
        };
      }
    } catch (err) {
      lastError = err as Error;
    }
  }
  return {
    tools: [],
    resolvedId: registryId,
    error: lastError?.message || "runtime-tools-not-found",
  };
}

async function openAiJson(systemPrompt: string, userPrompt: string, maxTokens = 2000): Promise<Record<string, unknown>> {
  if (!OPENAI_KEY) {
    throw new Error("OPENAI_KEY or OPENAI_API_KEY is required for phase 2 descriptions");
  }

  let lastErr: Error | null = null;
  for (let attempt = 0; attempt <= OPENAI_RETRIES; attempt += 1) {
    try {
      const response = await fetch(`${OPENAI_BASE_URL}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${OPENAI_KEY}`,
        },
        signal: AbortSignal.timeout(OPENAI_TIMEOUT_MS),
        body: JSON.stringify({
          model: OPENAI_MODEL,
          temperature: 0,
          max_tokens: maxTokens,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
        }),
      });

      if (!response.ok) {
        const errBody = await response.text().catch(() => "");
        throw new Error(`OpenAI ${response.status}${errBody ? ` - ${errBody.slice(0, 250)}` : ""}`);
      }

      const payload = await response.json();
      const content = String(payload?.choices?.[0]?.message?.content || "").trim();
      if (!content) throw new Error("OpenAI empty response content");
      return parseJsonObject(content);
    } catch (err) {
      lastErr = err as Error;
    }
  }

  throw lastErr || new Error("openai-call-failed");
}

async function describeToolChunkWithOpenAi(server: McpServerRecord, chunk: ToolDefinition[]): Promise<OpenAiToolChunkResult> {
  const inputTools = chunk.map((tool) => ({
    name: tool.name,
    description: cleanDescription(tool.description || ""),
    params: extractToolParams(tool.inputSchema),
    schema: compactSchemaForPrompt(tool.inputSchema),
  }));

  const systemPrompt =
    "You are a strict MCP tool cataloger. Use only the provided runtime metadata. Do not invent functionality.";
  const userPrompt = [
    "Write tool descriptions grounded only in tool names, provided descriptions, and schemas.",
    "If metadata is insufficient, use 'Unknown from runtime metadata'.",
    "Return strict JSON:",
    "{",
    '  "tool_descriptions": {',
    '    "toolName": {',
    '      "description": "1 sentence",',
    '      "summary": "short action phrase",',
    '      "params": ["paramName", ...],',
    '      "evidence": "brief note"',
    "    }",
    "  }",
    "}",
    "",
    `SERVER_NAME: ${server.name || server.id || "unknown"}`,
    `SERVER_DESCRIPTION: ${cleanDescription(server.description || "") || "none"}`,
    `TOOLS_JSON: ${JSON.stringify(inputTools)}`,
  ].join("\n");

  const parsed = await openAiJson(systemPrompt, userPrompt, 2500);
  return {
    tool_descriptions: (parsed.tool_descriptions as OpenAiToolChunkResult["tool_descriptions"]) || {},
  };
}

async function describeMcpWithOpenAi(server: McpServerRecord, tools: EnrichedTool[]): Promise<OpenAiMcpResult> {
  const compactTools = tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    summary: tool.summary,
    params: tool.params,
  }));

  const systemPrompt =
    "You are a strict MCP cataloger. Use only supplied tool metadata and server metadata. No guessing.";
  const userPrompt = [
    "Write MCP-level metadata from runtime tool data.",
    "Return strict JSON:",
    "{",
    '  "mcp_description": "2-4 sentences grounded in metadata",',
    '  "mcp_summary": "1 sentence summary",',
    '  "capabilities": ["short capability", ...]',
    "}",
    "If uncertain, write 'Unknown from runtime metadata'.",
    "",
    `SERVER_NAME: ${server.name || server.id || "unknown"}`,
    `SERVER_DESCRIPTION: ${cleanDescription(server.description || "") || "none"}`,
    `TOOLS_JSON: ${JSON.stringify(compactTools.slice(0, 160))}`,
  ].join("\n");

  const parsed = await openAiJson(systemPrompt, userPrompt, 1600);
  return {
    mcp_description: typeof parsed.mcp_description === "string" ? parsed.mcp_description : undefined,
    mcp_summary: typeof parsed.mcp_summary === "string" ? parsed.mcp_summary : undefined,
    capabilities: Array.isArray(parsed.capabilities)
      ? parsed.capabilities.filter((v): v is string => typeof v === "string").map((v) => cleanText(v)).filter(Boolean)
      : [],
  };
}

async function embedText(text: string): Promise<number[] | null> {
  if (!CF_ACCOUNT_ID || !CF_API_TOKEN) return null;

  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/ai/v1/embeddings`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${CF_API_TOKEN}`,
    },
    signal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
    body: JSON.stringify({
      model: CF_EMBEDDING_MODEL,
      input: text,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Cloudflare embeddings failed: ${res.status}${body ? ` - ${body.slice(0, 250)}` : ""}`);
  }

  const data = await res.json();
  const embedding = data?.data?.[0]?.embedding;
  return Array.isArray(embedding) ? embedding : null;
}

function finalizeToolDescription(tool: ToolDefinition, modelPayload?: {
  description?: string;
  summary?: string;
  params?: string[];
  evidence?: string;
}): EnrichedTool {
  const baseParams = extractToolParams(tool.inputSchema);
  const modelParams = Array.isArray(modelPayload?.params)
    ? modelPayload?.params.filter((v): v is string => typeof v === "string").map((v) => cleanText(v)).filter(Boolean)
    : [];

  const mergedParams = Array.from(new Set([...baseParams, ...modelParams])).sort((a, b) => a.localeCompare(b));
  const fallback = "Unknown from runtime metadata.";
  const modelDescription = cleanText(modelPayload?.description || "");
  const modelSummary = cleanText(modelPayload?.summary || "");

  const description = modelDescription
    || cleanDescription(tool.description || "")
    || fallback;
  const summary = modelSummary
    || modelDescription
    || cleanDescription(tool.description || "")
    || fallback;

  return {
    name: tool.name,
    description,
    summary,
    params: mergedParams,
    inputSchema: tool.inputSchema || {},
    inputSchemaHash: buildToolSignature(tool),
    evidence: cleanText(modelPayload?.evidence || ""),
  };
}

// =============================================================================
// Pipeline Phases
// =============================================================================

async function phaseSpawn(prepared: PreparedServer[], errors: ErrorRecord[]): Promise<SpawnedRecord[]> {
  const spawned: SpawnedRecord[] = [];
  console.log(`[mcp-indexer] phase 1/3 spawn start (${prepared.length} MCPs)`);

  await mapLimit(prepared, SPAWN_CONCURRENCY, async ({ server, registryId, canonicalId }, idx) => {
    const { tools, resolvedId, error } = await fetchRuntimeTools(server, registryId);

    if (tools.length < MIN_TOOL_COUNT || (REQUIRE_TOOLS && tools.length === 0)) {
      errors.push({
        id: registryId,
        stage: "spawn",
        error: error || `spawned-with-insufficient-tools (${tools.length})`,
        detail: {
          sourceId: server.id,
          resolvedId,
        },
      });
      return;
    }

    spawned.push({
      server,
      registryId,
      canonicalId,
      resolvedId,
      tools,
      toolsSource: "runtime",
    });

    if (idx % 300 === 0) {
      console.log(`[mcp-indexer] phase 1 progress ${idx + 1}/${prepared.length}`);
    }
  });

  console.log(`[mcp-indexer] phase 1 complete spawned=${spawned.length} failed=${errors.filter((e) => e.stage === "spawn").length}`);
  return spawned;
}

async function phaseDescribe(spawned: SpawnedRecord[], errors: ErrorRecord[]): Promise<EnrichedRecord[]> {
  console.log(`[mcp-indexer] phase 2/3 describe start (${spawned.length} MCPs via ${OPENAI_MODEL})`);

  if (!OPENAI_KEY) {
    throw new Error("OPENAI_KEY or OPENAI_API_KEY is required for phase 2 descriptions");
  }

  const enriched: EnrichedRecord[] = [];

  await mapLimit(spawned, DESCRIBE_CONCURRENCY, async (record, idx) => {
    try {
      const toolChunkResults: OpenAiToolChunkResult[] = [];
      const chunks = chunkArray(record.tools, TOOL_PROMPT_BATCH);
      for (const chunk of chunks) {
        const chunkResult = await describeToolChunkWithOpenAi(record.server, chunk);
        toolChunkResults.push(chunkResult);
      }

      const mergedToolMap = new Map<string, OpenAiToolChunkResult["tool_descriptions"][string]>();
      for (const result of toolChunkResults) {
        for (const [name, payload] of Object.entries(result.tool_descriptions || {})) {
          const key = cleanText(name);
          if (!key) continue;
          mergedToolMap.set(key, payload || {});
        }
      }

      const toolDetails = record.tools.map((tool) =>
        finalizeToolDescription(tool, mergedToolMap.get(tool.name))
      );

      const mcpModel = await describeMcpWithOpenAi(record.server, toolDetails);
      const mcpDescription = cleanText(mcpModel.mcp_description || cleanDescription(record.server.description || "") || "Unknown from runtime metadata.");
      const mcpSummary = cleanText(mcpModel.mcp_summary || mcpDescription);
      const capabilities = Array.isArray(mcpModel.capabilities) && mcpModel.capabilities.length > 0
        ? mcpModel.capabilities
        : toolDetails.slice(0, 16).map((tool) => tool.name);

      enriched.push({
        ...record,
        mcpDescription,
        mcpSummary,
        capabilities,
        tags: buildTagList(record.server, record.tools),
        toolDetails,
      });

      if (idx % 200 === 0) {
        console.log(`[mcp-indexer] phase 2 progress ${idx + 1}/${spawned.length}`);
      }
    } catch (err) {
      if (!STRICT_DESCRIPTIONS) {
        const toolDetails = record.tools.map((tool) =>
          finalizeToolDescription(tool, undefined)
        );
        enriched.push({
          ...record,
          mcpDescription: cleanDescription(record.server.description || "") || "Unknown from runtime metadata.",
          mcpSummary: cleanDescription(record.server.description || "") || "Unknown from runtime metadata.",
          capabilities: toolDetails.slice(0, 16).map((tool) => tool.name),
          tags: buildTagList(record.server, record.tools),
          toolDetails,
        });
      }
      errors.push({
        id: record.registryId,
        stage: "describe",
        error: err instanceof Error ? err.message : String(err),
        detail: {
          sourceId: record.server.id,
          resolvedId: record.resolvedId,
        },
      });
    }
  });

  console.log(`[mcp-indexer] phase 2 complete described=${enriched.length} failed=${errors.filter((e) => e.stage === "describe").length}`);
  return enriched;
}

async function phaseEmbed(enriched: EnrichedRecord[], errors: ErrorRecord[]): Promise<EmbeddedRecord[]> {
  console.log(`[mcp-indexer] phase 3/3 embeddings start (${enriched.length} MCPs)`);

  const embedded: EmbeddedRecord[] = [];
  const embeddingsConfigured = Boolean(CF_ACCOUNT_ID && CF_API_TOKEN);
  if (!embeddingsConfigured && !ALLOW_EMPTY_EMBEDDINGS) {
    throw new Error("CF_ACCOUNT_ID and CF_API_TOKEN are required for embeddings. Set MCP_INDEX_ALLOW_EMPTY_EMBEDDINGS=1 only for metadata-only dry runs.");
  }

  await mapLimit(enriched, EMBED_CONCURRENCY, async (record, idx) => {
    try {
      const text = buildEmbeddingText(record);
      const values = embeddingsConfigured ? await embedText(text) : [];
      if ((!values || values.length === 0) && !ALLOW_EMPTY_EMBEDDINGS) {
        throw new Error("embedding-missing");
      }

      embedded.push({
        ...record,
        embedding: values || [],
      });

      if (idx % 400 === 0) {
        console.log(`[mcp-indexer] phase 3 progress ${idx + 1}/${enriched.length}`);
      }
    } catch (err) {
      if (ALLOW_EMPTY_EMBEDDINGS) {
        embedded.push({
          ...record,
          embedding: [],
        });
      }
      errors.push({
        id: record.registryId,
        stage: "embedding",
        error: err instanceof Error ? err.message : String(err),
        detail: {
          sourceId: record.server.id,
          resolvedId: record.resolvedId,
        },
      });
    }
  });

  console.log(`[mcp-indexer] phase 3 complete embedded=${embedded.length} failed=${errors.filter((e) => e.stage === "embedding").length}`);
  return embedded;
}

// =============================================================================
// Output Writer
// =============================================================================

async function writeOutputs(spawned: SpawnedRecord[], embedded: EmbeddedRecord[], errors: ErrorRecord[]): Promise<void> {
  const spawnedStream = fs.createWriteStream(MCP_SPAWNED_PATH, { flags: "a" });
  const indexStream = fs.createWriteStream(MCP_INDEX_PATH, { flags: "a" });
  const toolsStream = fs.createWriteStream(MCP_TOOLS_PATH, { flags: "a" });
  const vectorStream = fs.createWriteStream(MCP_VECTORS_PATH, { flags: "a" });
  const errorStream = fs.createWriteStream(MCP_ERRORS_PATH, { flags: "a" });

  for (const record of spawned) {
    appendJsonl(spawnedStream, {
      id: record.registryId,
      canonicalId: record.canonicalId,
      sourceId: record.server.id,
      resolvedId: record.resolvedId,
      toolCount: record.tools.length,
    });
  }

  const clusters = new Map<string, { canonical: string; members: string[] }>();
  for (const record of embedded) {
    const toolsHash = buildToolsHash(record.toolDetails);
    if (!clusters.has(toolsHash)) {
      clusters.set(toolsHash, { canonical: record.registryId, members: [record.registryId] });
    } else {
      clusters.get(toolsHash)!.members.push(record.registryId);
    }

    const mcpRecord = {
      id: record.registryId,
      canonicalId: record.canonicalId,
      sourceId: record.server.id,
      namespace: record.server.namespace || null,
      slug: record.server.slug || null,
      name: cleanText(record.server.name || record.server.id || record.registryId),
      provider: record.server.source || "unknown",
      category: null,
      task: null,
      tags: record.tags.join(","),
      cost: null,
      latency: null,
      description: record.mcpDescription,
      repository: record.server.repository?.url || null,
      transport: record.server.transport || null,
      registryId: record.registryId,
      resolvedId: record.resolvedId,
      toolsSource: record.toolsSource,
      toolsError: null,
      toolsHash,
      toolCount: record.toolDetails.length,
      summary: record.mcpSummary,
      capabilities: record.capabilities,
      descriptionModel: OPENAI_MODEL,
      embeddingModel: record.embedding.length > 0 ? CF_EMBEDDING_MODEL : null,
    };
    appendJsonl(indexStream, mcpRecord);

    for (const tool of record.toolDetails) {
      appendJsonl(toolsStream, {
        mcpId: record.registryId,
        tool: {
          name: tool.name,
          description: tool.description,
          summary: tool.summary,
          params: tool.params,
          inputSchema: tool.inputSchema,
          inputSchemaHash: tool.inputSchemaHash,
          evidence: tool.evidence || "",
        },
      });
    }

    const vectorRecord: VectorRecord = {
      id: record.registryId,
      values: record.embedding,
      metadata: {
        name: mcpRecord.name,
        description: mcpRecord.description,
        canonical_id: mcpRecord.canonicalId,
        source_id: mcpRecord.sourceId,
        namespace: mcpRecord.namespace,
        slug: mcpRecord.slug,
        type: "mcp",
        provider: mcpRecord.provider,
        transport: mcpRecord.transport,
        resolved_id: mcpRecord.resolvedId,
        task: mcpRecord.task,
        category: mcpRecord.category,
        tags: mcpRecord.tags,
        cost: mcpRecord.cost,
        latency: mcpRecord.latency,
        tool_count: mcpRecord.toolCount,
        tool_names: record.toolDetails.slice(0, VECTOR_METADATA_MAX_TOOLS).map((t) => t.name).join(","),
        capabilities: mcpRecord.capabilities.join(","),
        tools_hash: toolsHash,
        tools_source: record.toolsSource,
        summary: mcpRecord.summary,
        tool_summaries: record.toolDetails
          .slice(0, VECTOR_METADATA_MAX_TOOLS)
          .map((t) => `${t.name}: ${t.summary}`)
          .join(" | ")
          .slice(0, 3500),
        repository: mcpRecord.repository,
        description_model: OPENAI_MODEL,
        embedding_model: record.embedding.length > 0 ? CF_EMBEDDING_MODEL : null,
      },
    };
    appendJsonl(vectorStream, vectorRecord);
  }

  for (const err of errors) {
    appendJsonl(errorStream, err);
  }

  await Promise.all([
    endStream(spawnedStream),
    endStream(indexStream),
    endStream(toolsStream),
    endStream(vectorStream),
    endStream(errorStream),
  ]);

  const clusterPayload = Array.from(clusters.entries()).map(([hash, info]) => ({
    tools_hash: hash,
    canonical: info.canonical,
    members: info.members,
  }));
  writeJson(MCP_CLUSTERS_PATH, clusterPayload);
  writeJson(MCP_CHECKPOINT_PATH, {
    processedIds: embedded.map((r) => r.registryId),
    updatedAt: new Date().toISOString(),
    pipeline: {
      strictSpawn: STRICT_SPAWN,
      strictDescriptions: STRICT_DESCRIPTIONS,
      allowEmptyEmbeddings: ALLOW_EMPTY_EMBEDDINGS,
      openaiModel: OPENAI_MODEL,
      embeddingModel: CF_EMBEDDING_MODEL,
    },
  });
}

// =============================================================================
// Main
// =============================================================================

async function main(): Promise<void> {
  ensureOutputDir();
  if (RESET_OUTPUTS) {
    clearOutputFiles();
  }

  const registry = readJson<RegistryFile>(REGISTRY_PATH);
  let prepared = buildPreparedServers(registry.servers);
  if (MAX_SERVERS > 0) prepared = prepared.slice(0, MAX_SERVERS);

  const errors: ErrorRecord[] = [];
  const spawned = await phaseSpawn(prepared, errors);
  const spawnErrors = errors.filter((e) => e.stage === "spawn").length;
  if (STRICT_SPAWN && spawnErrors > 0) {
    await writeOutputs(spawned, [], errors);
    throw new Error(`phase 1 spawn failed for ${spawnErrors} MCPs with STRICT_SPAWN=1`);
  }

  const enriched = await phaseDescribe(spawned, errors);
  const describeErrors = errors.filter((e) => e.stage === "describe").length;
  if (STRICT_DESCRIPTIONS && describeErrors > 0) {
    await writeOutputs(spawned, [], errors);
    throw new Error(`phase 2 description failed for ${describeErrors} MCPs with STRICT_DESCRIPTIONS=1`);
  }

  const embedded = await phaseEmbed(enriched, errors);
  const embeddingErrors = errors.filter((e) => e.stage === "embedding").length;
  if (!ALLOW_EMPTY_EMBEDDINGS && embeddingErrors > 0) {
    await writeOutputs(spawned, embedded, errors);
    throw new Error(`phase 3 embedding failed for ${embeddingErrors} MCPs`);
  }

  await writeOutputs(spawned, embedded, errors);

  console.log(
    `[mcp-indexer] done. total=${prepared.length} spawned=${spawned.length} described=${enriched.length} embedded=${embedded.length} errors=${errors.length}`
  );
}

main().catch((err) => {
  console.error("[mcp-indexer] failed:", err);
  process.exit(1);
});
