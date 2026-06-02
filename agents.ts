import { createHash, randomUUID } from "node:crypto";
import { createPublicClient, http, parseAbi, type Address } from "viem";

import { normalizeConnectorBinding } from "./connectors.js";
import { getCompiledModels, getModelById } from "./inference/catalog/registry.js";

export type AgentModelRouteKind = "exact" | "bump" | "missing" | "invalid";
export type AgentFramework = "manowar" | "other";

export interface AgentModelRoute {
  kind: AgentModelRouteKind;
  from: string;
  to?: string;
  checked: string;
  reason?: string;
  source?: string;
  score?: number;
  candidates?: string[];
}

export interface AgentCard {
  schemaVersion: string;
  name: string;
  description: string;
  skills: string[];
  x402Support: boolean;
  image?: string;
  avatar?: string;
  dnaHash: string;
  walletAddress: string;
  walletTimestamp?: number;
  chain: number;
  model: string;
  creatorFee?: number;
  target?: string;
  route?: AgentModelRoute;
  framework?: AgentFramework;
  licensePrice: string;
  licenses: number;
  cloneable: boolean;
  knowledge?: string[];
  endpoint?: string;
  protocols: Array<{ name: string; version: string }>;
  plugins?: Array<{
    registryId: string;
    name: string;
    origin: string;
    tools?: Array<{
      name: string;
      description?: string;
      parameters?: Record<string, unknown>;
      inputSchema?: Record<string, unknown>;
    }>;
  }>;
  createdAt: string;
  creator?: string;
  cid?: string;
}

export interface WorkflowMetadata {
  schemaVersion: string;
  title: string;
  description: string;
  image?: string;
  dnaHash: string;
  walletAddress: string;
  walletTimestamp: number;
  agents: AgentCard[];
  edges?: Array<{
    source: number;
    target: number;
    label?: string;
  }>;
  coordinator?: {
    hasCoordinator: boolean;
    model: string;
  };
  pricing: {
    totalAgentPrice: string;
  };
  lease?: {
    enabled: boolean;
    durationDays: number;
    creatorPercent: number;
  };
  rfa?: {
    title: string;
    description: string;
    skills: string[];
    offerAmount: string;
  };
  creator: string;
  createdAt: string;
  cid?: string;
}

type BoundPlugin = {
  registryId: string;
  name?: string;
  origin?: string;
  tools?: Array<{
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
    inputSchema?: Record<string, unknown>;
  }>;
};

export type AgentSearchHit = Omit<Partial<AgentCard>, "plugins"> & {
  walletAddress: string;
  name: string;
  skills: string[];
  plugins: BoundPlugin[];
  score?: number;
};

const PINATA_API_URL = "https://api.pinata.cloud";
const VOYAGE_MODEL = "voyage-4-large";
const VOYAGE_RERANK_MODEL = "rerank-2.5";
const VECTOR_DIMENSIONS = 1024;
const VECTOR_VERSION = "creatorFee.ipfs.v1";
const FACTORY_ABI = parseAbi([
  "function totalAgents() view returns (uint256)",
  "function agentURI(uint256 agentId) view returns (string)",
  "event AgentRegistered(uint256 indexed agentId, address indexed owner, string agentURI)",
  "event AgentURIUpdated(uint256 indexed agentId, string agentURI)",
]);

type Card = AgentCard | WorkflowMetadata;

type Sync = {
  hash: string;
  at: number;
  agents: Map<string, AgentCard>;
  texts: Map<string, string>;
};

type Cache = {
  at: number;
  text: string;
};

type Stored = {
  agent: AgentCard;
  id: string;
  text: string;
};

type StoredAgentRow = {
  walletAddress?: string;
  card: string;
  text: string;
  cid?: string | null;
  creatorFee?: number | null;
  target?: string | null;
  route?: string | null;
};

type AgentVectorMetadata = Record<string, unknown>;

type AgentVectorMatch = {
  id?: string;
  score?: number;
  metadata?: AgentVectorMetadata;
};

type AgentCandidate = {
  id: string;
  agent: AgentSearchHit;
  text: string;
  score: number;
};

type RouteRow = {
  target?: string | null;
  reason?: string | null;
  source?: string | null;
  score?: number | null;
  candidates?: string | null;
  updated?: string | null;
};

type ModelHit = {
  modelId?: string;
  provider?: string;
  name?: string;
  score?: number;
};

type AgentStage = "card" | "validate" | "embed" | "publish" | "reconcile";

interface Catalog {
  name?: string;
  description?: string;
  tags?: string[];
  category?: string;
  status?: string;
  tools?: Array<{
    name?: string;
    description?: string;
    parameters?: Record<string, unknown>;
    inputSchema?: Record<string, unknown>;
  }>;
}

let synced: Sync | null = null;
let catalogs = new Map<string, Cache>();
let pluginTools = new Map<string, Cache & {
  tools: NonNullable<BoundPlugin["tools"]>;
}>();

function normalizeUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

function requireConfiguredEnv(name: "PINATA_JWT" | "MONGO_DB_API_KEY"): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function requirePinataGateway(): string {
  const value = process.env.PINATA_GATEWAY_URL;
  if (!value) {
    throw new Error("PINATA_GATEWAY_URL is required");
  }
  return value
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "");
}

function account(): string {
  const value = process.env.CF_ACCOUNT_ID || process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!value) {
    throw new Error("CF_ACCOUNT_ID is required for agent search");
  }
  return value;
}

function token(): string {
  const value = process.env.CF_GLOBAL_TOKEN
    || process.env.CF_API_TOKEN
    || process.env.CLOUDFLARE_API_TOKEN
    || process.env.CLOUDFLARE_API_KEY;
  if (!value) {
    throw new Error("Cloudflare API token is required for agent search");
  }
  return value;
}

function index(): string {
  return process.env.AGENTS_INDEX || "agents";
}

function routeIndex(): string | undefined {
  return process.env.CATALOG_ROUTES_INDEX || process.env.ROUTES_INDEX;
}

function database(): string {
  return process.env.AGENTS_D1_ID || "";
}

function base(): string {
  return normalizeUrl(process.env.EMBEDDING_API_BASE || "https://ai.mongodb.com/v1");
}

function connectors(): string {
  return normalizeUrl(process.env.CONNECTORS_URL || process.env.CONNECTOR_URL || "https://connectors.compose.market");
}

function models(): string {
  return normalizeUrl(process.env.MODELS_URL || "https://models.compose.market");
}

function factory(): Address | null {
  const value = process.env.AGENT_FACTORY_CONTRACT?.trim();
  if (!value) return null;
  if (!/^0x[a-fA-F0-9]{40}$/.test(value)) {
    throw new Error("AGENT_FACTORY_CONTRACT must be an EVM address");
  }
  return value as Address;
}

function factoryChain(): number {
  const raw = process.env.AGENT_FACTORY_CHAIN_ID || "43113";
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error("AGENT_FACTORY_CHAIN_ID must be a positive integer");
  }
  return value;
}

function factoryRpc(): string | null {
  const chainId = factoryChain();
  const explicit = process.env.AGENT_FACTORY_RPC?.trim();
  if (explicit) return explicit;
  if (chainId === 43114) return process.env.AVALANCHE_MAINNET_RPC?.trim() || null;
  if (chainId === 43113) return process.env.AVALANCHE_FUJI_RPC?.trim() || null;
  return null;
}

function factoryLimit(): number {
  const raw = Number.parseInt(process.env.AGENT_FACTORY_SCAN_LIMIT || "1000", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 1000;
}

function ttl(): number {
  const value = Number.parseInt(process.env.AGENTS_SYNC_TTL_MS || "300000", 10);
  return Number.isFinite(value) && value > 0 ? Math.max(30_000, value) : 300_000;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function id(walletAddress: string): string {
  return `agent:${walletAddress.toLowerCase()}`;
}

function score(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function num(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

function walletFromAgentVector(match: AgentVectorMatch): string | undefined {
  const wallet = maybeText(match.metadata?.walletAddress);
  if (wallet) return wallet.toLowerCase();
  const raw = maybeText(match.id);
  const parsed = raw?.match(/^agent:(0x[a-fA-F0-9]{40})$/)?.[1];
  return parsed?.toLowerCase();
}

function requireText(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`agent ${name} is required for search`);
  }
  return value.trim();
}

function maybeText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map(clean).filter(Boolean)
    : [];
}

function boundPlugins(value: unknown): BoundPlugin[] {
  return strings(value).map((registryId) => ({ registryId }));
}

function kind(value: unknown): AgentModelRouteKind | undefined {
  const raw = clean(value);
  return raw === "exact" || raw === "bump" || raw === "missing" || raw === "invalid"
    ? raw
    : undefined;
}

function frame(value: unknown): AgentFramework {
  return clean(value).toLowerCase() === "manowar" ? "manowar" : "other";
}

function legacyOrigin(value: string): "mcp" | "onchain" | null {
  const normalized = value.toLowerCase();
  if (normalized === "tools") return "mcp";
  if (normalized === "goat") return "onchain";
  return null;
}

function canonicalRegistryId(registryId: string, origin: string): { registryId: string; origin?: "mcp" | "onchain" } {
  const prefixed = registryId.match(/^(mcp|onchain|tools|goat)([:\-])(.+)$/i);
  if (prefixed) {
    const prefix = prefixed[1].toLowerCase();
    const canonicalOrigin = (legacyOrigin(prefix) ?? prefix) as "mcp" | "onchain";
    return {
      registryId: `${canonicalOrigin}:${prefixed[3].trim()}`,
      origin: canonicalOrigin,
    };
  }

  const sourceOrigin = legacyOrigin(origin) ?? (origin === "mcp" || origin === "onchain" ? origin : null);
  if (sourceOrigin) {
    return {
      registryId: `${sourceOrigin}:${registryId}`,
      origin: sourceOrigin,
    };
  }

  return { registryId };
}

function normalizePlugin(plugin: NonNullable<AgentCard["plugins"]>[number]): NonNullable<AgentCard["plugins"]>[number] {
  const source = canonicalRegistryId(clean(plugin.registryId), clean(plugin.origin).toLowerCase());
  const registryId = source.registryId;
  if (!/^(mcp|onchain):[^:\s]+$/i.test(registryId)) {
    throw new Error(`agent plugin registryId must be mcp:<slug> or onchain:<slug>: ${registryId || "missing"}`);
  }
  const sourceOrigin = source.origin ?? clean(plugin.origin).toLowerCase();
  const binding = normalizeConnectorBinding({ ...plugin, registryId, origin: sourceOrigin }, { defaultOrigin: "mcp" });
  const origin = sourceOrigin;
  if (origin && origin !== binding.origin) {
    throw new Error(`agent plugin origin mismatch for ${registryId}: ${plugin.origin}`);
  }
  return {
    ...plugin,
    registryId: binding.registryId,
    origin: binding.origin,
  };
}

function render(value: Catalog): string {
  return [
    value.name,
    value.description,
    ...(value.tags || []),
    value.category,
    value.status,
    ...(value.tools || []).flatMap((tool) => [tool.name, tool.description]),
  ].map(clean).filter(Boolean).join(" ");
}

function schema(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function normalizeTools(value: unknown): NonNullable<BoundPlugin["tools"]> {
  if (!Array.isArray(value)) return [];
  return value
    .map((tool): NonNullable<BoundPlugin["tools"]>[number] | null => {
      if (!tool || typeof tool !== "object" || Array.isArray(tool)) return null;
      const record = tool as Record<string, unknown>;
      const name = clean(record.name);
      if (!name) return null;
      const description = clean(record.description);
      const parameters = schema(record.parameters);
      const inputSchema = schema(record.inputSchema) || schema(record.input_schema);
      return {
        name,
        ...(description ? { description } : {}),
        ...(parameters ? { parameters } : {}),
        ...(inputSchema ? { inputSchema } : {}),
      };
    })
    .filter((tool): tool is NonNullable<BoundPlugin["tools"]>[number] => Boolean(tool));
}

async function pluginCard(origin: "mcp" | "onchain", slug: string): Promise<{
  text: string;
  tools: NonNullable<BoundPlugin["tools"]>;
}> {
  const key = `${origin}:${slug.toLowerCase()}`;
  const cached = pluginTools.get(key);
  if (cached && Date.now() - cached.at < ttl()) {
    return { text: cached.text, tools: cached.tools };
  }

  const path = origin === "mcp" ? "mcps" : "onchain";
  const response = await fetch(`${connectors()}/${path}/${encodeURIComponent(slug)}`, {
    signal: AbortSignal.timeout(8000),
  });
  if (response.status === 404) {
    pluginTools.set(key, { at: Date.now(), text: "", tools: [] });
    return { text: "", tools: [] };
  }
  if (!response.ok) {
    const message = await response.text().catch(() => "");
    throw new Error(`connector ${slug} metadata failed (${response.status}): ${message.slice(0, 300)}`);
  }

  const body = await response.json() as Catalog;
  const tools = normalizeTools(body.tools);
  const text = render(body);
  pluginTools.set(key, { at: Date.now(), text, tools });
  return { text, tools };
}

async function catalog(slug: string): Promise<string> {
  const key = `mcp:${slug.toLowerCase()}`;
  const cached = catalogs.get(key);
  if (cached && Date.now() - cached.at < ttl()) {
    return cached.text;
  }
  const { text } = await pluginCard("mcp", slug);
  catalogs.set(key, { at: Date.now(), text });
  return text;
}

async function enrich(agent: AgentCard): Promise<AgentCard> {
  const plugins = await Promise.all((agent.plugins || []).map(async (plugin) => {
    const normalized = normalizePlugin(plugin);
    if (normalized.tools?.length) {
      return normalized;
    }
    try {
      const binding = normalizeConnectorBinding(normalized, { defaultOrigin: "mcp" });
      const card = await pluginCard(binding.origin, binding.slug);
      return {
        ...normalized,
        ...(card.tools.length ? { tools: card.tools } : {}),
      };
    } catch (error) {
      console.warn("[agents] plugin tool metadata failed", {
        plugin: normalized.registryId,
        error: error instanceof Error ? error.message : String(error),
      });
      return normalized;
    }
  }));

  return {
    ...agent,
    plugins,
  };
}

async function tools(agent: AgentCard): Promise<string> {
  const parts = await Promise.all((agent.plugins || []).map(async (plugin) => {
    const binding = normalizeConnectorBinding(normalizePlugin(plugin), { defaultOrigin: "mcp" });
    const baseText = [plugin.registryId, plugin.name, plugin.origin].filter(Boolean).join(" ");
    if (binding.origin !== "mcp") {
      return baseText;
    }
    const description = await catalog(binding.slug);
    return [baseText, description].filter(Boolean).join(" ");
  }));
  return parts.filter(Boolean).join(", ");
}

async function cardText(agent: AgentCard): Promise<string> {
  const enriched = await enrich(agent);
  const plugins = (enriched.plugins || [])
    .map((plugin) => [plugin.registryId, plugin.name, plugin.origin].filter(Boolean).join(" "))
    .join(", ");
  return [
    `walletAddress: ${requireText(enriched.walletAddress, "walletAddress")}`,
    `name: ${requireText(enriched.name, "name")}`,
    `description: ${enriched.description || ""}`,
    `model: ${requireText(enriched.model, "model")}`,
    `creatorFee: ${enriched.creatorFee}`,
    ...(enriched.target && enriched.target !== enriched.model ? [`target: ${enriched.target}`] : []),
    ...(enriched.route ? [`route: ${enriched.route.kind}${enriched.route.to ? ` ${enriched.route.from} -> ${enriched.route.to}` : ` ${enriched.route.from}`}`] : []),
    `skills: ${strings(enriched.skills).join(", ")}`,
    `plugins: ${plugins}`,
    `connectors: ${await tools(enriched)}`,
  ].join("\n");
}

function normalizeAgentCard(card: AgentCard): AgentCard {
  const skills = strings(card.skills).map((skill) => canonicalRegistryId(skill, "").registryId);
  const creatorFee = num(card.creatorFee) ?? 1;
  return {
    ...card,
    framework: frame(card.framework),
    creatorFee,
    ...(Array.isArray(card.skills) ? { skills } : {}),
    protocols: Array.isArray(card.protocols) ? card.protocols : [],
    plugins: (card.plugins || []).map(normalizePlugin),
  };
}

function parseStoredAgent(card: string): AgentCard | null {
  try {
    return normalizeAgentCard(JSON.parse(card) as AgentCard);
  } catch {
    return null;
  }
}

function checkedAt(): string {
  return new Date().toISOString();
}

function route(
  kind: AgentModelRouteKind,
  from: string,
  to?: string,
  reason?: string,
  extra: Pick<AgentModelRoute, "source" | "score" | "candidates"> = {},
): AgentModelRoute {
  return {
    kind,
    from,
    ...(to ? { to } : {}),
    checked: checkedAt(),
    ...(reason ? { reason } : {}),
    ...(extra.source ? { source: extra.source } : {}),
    ...(typeof extra.score === "number" && Number.isFinite(extra.score) ? { score: extra.score } : {}),
    ...(extra.candidates?.length ? { candidates: extra.candidates } : {}),
  };
}

function parseRoute(value: unknown): AgentModelRoute | null {
  const raw = typeof value === "string" ? value : "";
  if (!raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<AgentModelRoute>;
    if (
      (parsed.kind === "exact" || parsed.kind === "bump" || parsed.kind === "missing" || parsed.kind === "invalid")
      && typeof parsed.from === "string"
      && typeof parsed.checked === "string"
    ) {
      return {
        kind: parsed.kind,
        from: parsed.from,
        ...(typeof parsed.to === "string" && parsed.to.trim() ? { to: parsed.to.trim() } : {}),
        checked: parsed.checked,
        ...(typeof parsed.reason === "string" && parsed.reason.trim() ? { reason: parsed.reason.trim() } : {}),
        ...(typeof parsed.source === "string" && parsed.source.trim() ? { source: parsed.source.trim() } : {}),
        ...(typeof parsed.score === "number" && Number.isFinite(parsed.score) ? { score: parsed.score } : {}),
        ...(Array.isArray(parsed.candidates)
          ? { candidates: parsed.candidates.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim()) }
          : {}),
      };
    }
  } catch {
    return null;
  }
  return null;
}

function parseStrings(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const out = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim());
    return out.length > 0 ? out : undefined;
  }
  if (typeof value !== "string" || !value.trim()) return undefined;
  try {
    return parseStrings(JSON.parse(value));
  } catch {
    return undefined;
  }
}

function withProjection(agent: AgentCard, target: string | undefined, modelRoute: AgentModelRoute): AgentCard {
  const next: AgentCard = {
    ...agent,
    route: modelRoute,
  };
  if (target) {
    next.target = target;
  } else {
    delete next.target;
  }
  return next;
}

async function explicitRoute(model: string): Promise<RouteRow | null> {
  if (!(await ensure())) return null;
  const rows = await d1<RouteRow>(
    `SELECT target, reason, source, score, candidates, updated
     FROM routes
     WHERE model = ?1
     LIMIT 1`,
    [model],
  );
  return rows[0] || null;
}

async function rebind(agent: AgentCard): Promise<{ target?: string; reason: string; score?: number; candidates?: string[] }> {
  const target = new URL(`${models()}/rebind`);
  const response = await fetch(target, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: agent.model,
      limit: 8,
    }),
    signal: AbortSignal.timeout(8000),
  });
  const body = await response.json().catch(() => ({})) as {
    selected?: ModelHit | null;
    candidates?: ModelHit[];
    alternates?: ModelHit[];
    data?: ModelHit[];
    reason?: string;
    error?: { message?: string };
  };
  if (!response.ok) {
    const message = body.error?.message || `status ${response.status}`;
    return { reason: `model catalog rebind failed: ${message}` };
  }

  const rows = [
    ...(body.selected ? [body.selected] : []),
    ...(Array.isArray(body.candidates) ? body.candidates : []),
    ...(Array.isArray(body.alternates) ? body.alternates : []),
    ...(Array.isArray(body.data) ? body.data : []),
  ];
  const candidates = [...new Set(rows
    .map((item) => maybeText(item.modelId))
    .filter((item): item is string => Boolean(item)))];
  const selected = rows.find((item) => {
    const modelId = maybeText(item.modelId);
    return Boolean(modelId && getModelById(modelId));
  });
  const modelId = maybeText(selected?.modelId);
  if (!modelId) {
    return {
      reason: "model catalog selection returned no locally valid target",
      candidates,
    };
  }

  const resolved = getModelById(modelId);
  return {
    target: resolved?.modelId || modelId,
    reason: body.reason || `automatic deterministic catalog rebind from ${getCompiledModels().lastUpdated || "current catalog"}`,
    ...(typeof selected?.score === "number" && Number.isFinite(selected.score) ? { score: selected.score } : {}),
    candidates,
  };
}

async function persist(agent: AgentCard, projected: AgentCard): Promise<void> {
  if (!(await ensure())) return;
  await d1(
    `UPDATE agents
     SET target = ?2,
         route = ?3,
         updated = CURRENT_TIMESTAMP
     WHERE lower(walletAddress) = lower(?1)`,
    [
      agent.walletAddress,
      projected.target ?? null,
      projected.route ? JSON.stringify(projected.route) : null,
    ],
  );

  if (projected.route?.kind !== "bump" || !projected.route.to) return;
  await d1(
    `INSERT INTO routes (model, target, reason, source, score, candidates, updated)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, CURRENT_TIMESTAMP)
     ON CONFLICT(model) DO UPDATE SET
       target = excluded.target,
       reason = excluded.reason,
       source = excluded.source,
       score = excluded.score,
       candidates = excluded.candidates,
       updated = CURRENT_TIMESTAMP`,
    [
      projected.route.from,
      projected.route.to,
      projected.route.reason ?? "automatic catalog rebind",
      projected.route.source ?? "models.rebind",
      projected.route.score ?? null,
      projected.route.candidates ? JSON.stringify(projected.route.candidates) : null,
    ],
  );
}

async function projectAgent(agent: AgentCard, opts: { enrich?: boolean } = {}): Promise<AgentCard> {
  const complete = async (projected: AgentCard): Promise<AgentCard> => (
    opts.enrich === false ? projected : await enrich(projected)
  );
  const from = requireText(agent.model, "model");
  const exact = getModelById(from);
  if (exact) {
    const projected = withProjection(agent, exact.modelId, route("exact", from, undefined, undefined, { source: "catalog" }));
    await persist(agent, projected);
    return await complete(projected);
  }

  const row = await explicitRoute(from);
  const target = maybeText(row?.target);
  if (target && row?.source === "models.rebind") {
    const targetModel = getModelById(target);
    if (targetModel) {
      const candidates = parseStrings(row.candidates);
      const projected = withProjection(
        agent,
        targetModel.modelId,
        route("bump", from, targetModel.modelId, row?.reason || "cached automatic catalog rebind", {
          source: "models.rebind",
          ...(typeof row.score === "number" && Number.isFinite(row.score) ? { score: row.score } : {}),
          ...(Array.isArray(candidates) ? { candidates } : {}),
        }),
      );
      await persist(agent, projected);
      return await complete(projected);
    }
  }

  let selected: Awaited<ReturnType<typeof rebind>>;
  try {
    selected = await rebind(agent);
  } catch (error) {
    selected = {
      reason: `model catalog rebind failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const selectedTarget = maybeText(selected.target);
  if (!selectedTarget) {
    const projected = withProjection(
      agent,
      undefined,
      route("missing", from, undefined, selected.reason, { source: "models.rebind", candidates: selected.candidates }),
    );
    await persist(agent, projected);
    return await complete(projected);
  }

  const targetModel = getModelById(selectedTarget);
  if (!targetModel) {
    const projected = withProjection(
      agent,
      undefined,
      route("invalid", from, selectedTarget, "model catalog rebind target is not in the local catalog", {
        source: "models.rebind",
        score: selected.score,
        candidates: selected.candidates,
      }),
    );
    await persist(agent, projected);
    return await complete(projected);
  }

  const projected = withProjection(
    agent,
    targetModel.modelId,
    route("bump", from, targetModel.modelId, selected.reason, {
      source: "models.rebind",
      score: selected.score,
      candidates: selected.candidates,
    }),
  );
  await persist(agent, projected);
  return await complete(projected);
}

function validExactProjection(agent: AgentCard, target: string | undefined, modelRoute: AgentModelRoute): boolean {
  if (!modelRoute || modelRoute.from !== agent.model) return false;
  if (modelRoute.kind === "exact") {
    const exact = getModelById(agent.model);
    return Boolean(exact && target === exact.modelId);
  }
  return false;
}

async function projectStoredAgent(agent: AgentCard, row: Pick<StoredAgentRow, "target" | "route">): Promise<AgentCard> {
  const target = maybeText(row.target);
  const modelRoute = parseRoute(row.route);
  if (modelRoute && validExactProjection(agent, target, modelRoute)) {
    return await enrich(withProjection(agent, target, modelRoute!));
  }
  if (modelRoute?.kind === "bump" && modelRoute.from === agent.model && target && modelRoute.to === target && getModelById(target)) {
    const current = await explicitRoute(agent.model);
    const currentTarget = maybeText(current?.target);
    const currentModel = currentTarget ? getModelById(currentTarget) : null;
    const currentReason = current?.reason || undefined;
    if (current?.source === "models.rebind" && currentModel?.modelId === target && currentReason === modelRoute.reason) {
      return await enrich(withProjection(agent, target, modelRoute));
    }
  }
  return await projectAgent(agent);
}

async function fetchFromPinataGateway<T>(cid: string, pinataGateway: string): Promise<T | null> {
  const response = await fetch(`https://${pinataGateway}/ipfs/${cid}`, {
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) {
    return null;
  }
  return await response.json() as T;
}

function uriToUrl(uri: string, gateway: string): string | null {
  const value = uri.trim();
  if (!value) return null;
  if (/^https?:\/\//i.test(value)) return value;
  const cid = value.startsWith("ipfs://") ? value.slice("ipfs://".length) : value;
  if (/^(baf[a-z0-9]+|Qm[1-9A-HJ-NP-Za-km-z]+)(\/.*)?$/.test(cid)) {
    return `https://${gateway}/ipfs/${cid.replace(/^\/+/, "")}`;
  }
  return null;
}

function cursorBlock(value: string | undefined): bigint | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as { block?: unknown };
    if (typeof parsed.block === "string" && /^\d+$/.test(parsed.block)) {
      return BigInt(parsed.block);
    }
    if (typeof parsed.block === "number" && Number.isFinite(parsed.block) && parsed.block >= 0) {
      return BigInt(Math.floor(parsed.block));
    }
  } catch {
    if (/^\d+$/.test(value)) return BigInt(value);
  }
  return null;
}

async function readCursor(source: string): Promise<string | undefined> {
  if (!(await ensure())) return undefined;
  const rows = await d1<{ value: string }>(
    `SELECT value FROM cursor WHERE source = ?1 LIMIT 1`,
    [source],
  );
  return rows[0]?.value;
}

async function writeCursor(source: string, value: unknown): Promise<void> {
  if (!(await ensure())) return;
  await d1(
    `INSERT INTO cursor (source, value, updated)
     VALUES (?1, ?2, CURRENT_TIMESTAMP)
     ON CONFLICT(source) DO UPDATE SET
       value = excluded.value,
       updated = CURRENT_TIMESTAMP`,
    [source, typeof value === "string" ? value : JSON.stringify(value)],
  );
}

async function stamped(): Promise<boolean> {
  return (await readCursor("vectorize.creatorFee")) === VECTOR_VERSION;
}

async function stamp(): Promise<void> {
  await writeCursor("vectorize.creatorFee", VECTOR_VERSION);
}
async function fetchFactoryAgents(): Promise<AgentCard[]> {
  const contract = factory();
  if (!contract) return [];
  const rpc = factoryRpc();
  if (!rpc) {
    throw new Error(`RPC URL is required for AgentFactory chain ${factoryChain()}`);
  }
  const gateway = requirePinataGateway();
  const client = createPublicClient({ transport: http(rpc) });
  const [latest, total] = await Promise.all([
    client.getBlockNumber(),
    client.readContract({
      address: contract,
      abi: FACTORY_ABI,
      functionName: "totalAgents",
    }),
  ]);
  const cursor = cursorBlock(await readCursor("agentfactory"));
  const fromBlock = cursor === null || cursor >= latest ? null : cursor + 1n;
  let events = 0;
  if (fromBlock !== null) {
    const [registered, updated] = await Promise.all([
      client.getLogs({
        address: contract,
        event: FACTORY_ABI[2],
        fromBlock,
        toBlock: latest,
      }),
      client.getLogs({
        address: contract,
        event: FACTORY_ABI[3],
        fromBlock,
        toBlock: latest,
      }),
    ]);
    events = registered.length + updated.length;
  }
  const count = Number(total);
  if (!Number.isSafeInteger(count)) {
    throw new Error(`AgentFactory totalAgents is too large: ${total.toString()}`);
  }
  const limit = Math.min(count, factoryLimit());
  const cards: AgentCard[] = [];
  for (let agentId = 1; agentId <= limit; agentId += 1) {
    const uri = await client.readContract({
      address: contract,
      abi: FACTORY_ABI,
      functionName: "agentURI",
      args: [BigInt(agentId)],
    }).catch(() => "");
    const url = uriToUrl(String(uri), gateway);
    if (!url) continue;
    const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!response.ok) continue;
    const card = await response.json().catch(() => null) as AgentCard | null;
    if (card?.walletAddress) {
      try {
        cards.push(normalizeAgentCard({
          ...card,
          cid: String(uri).startsWith("ipfs://") ? String(uri).slice("ipfs://".length) : card.cid,
        }));
      } catch (error) {
        console.warn("[agents] skipped invalid AgentFactory card", error);
      }
    }
  }
  await writeCursor("agentfactory", {
    contract,
    chainId: factoryChain(),
    block: latest.toString(),
    total: total.toString(),
    events,
    indexed: cards.length,
  });
  await note("agentfactory_scan", contract, latest.toString(), {
    total: total.toString(),
    events,
    indexed: cards.length,
  });
  return cards;
}

async function listPinRowsByType(type: "agent-card" | "workflow-metadata"): Promise<Array<{ ipfs_pin_hash: string }>> {
  const jwt = requireConfiguredEnv("PINATA_JWT");
  const query = encodeURIComponent(JSON.stringify({ type: { value: type, op: "eq" } }));
  const response = await fetch(
    `${PINATA_API_URL}/data/pinList?status=pinned&metadata[keyvalues]=${query}&pageLimit=1000`,
    {
      headers: { Authorization: `Bearer ${jwt}` },
      signal: AbortSignal.timeout(10000),
    },
  );

  if (!response.ok) {
    throw new Error(`Pinata list failed with status ${response.status}`);
  }

  const data = await response.json() as {
    rows: Array<{ ipfs_pin_hash: string }>;
  };
  return data.rows;
}

export async function listPinsByType(type: "agent-card" | "workflow-metadata"): Promise<Card[]> {
  const pinataGateway = requirePinataGateway();
  const rows = await listPinRowsByType(type);

  const items: Array<Card | null> = await Promise.all(
    rows.map(async (pin): Promise<Card | null> => {
      const content = await fetchFromPinataGateway<Card>(pin.ipfs_pin_hash, pinataGateway);
      return content ? { ...content, cid: pin.ipfs_pin_hash } : null;
    }),
  );

  return items.filter((value): value is Card => value !== null);
}

async function fetchAgents(): Promise<AgentCard[]> {
  const agents = await listPinsByType("agent-card") as AgentCard[];
  const byWallet = new Map<string, AgentCard>();
  for (const agent of agents) {
    try {
      const normalized = normalizeAgentCard(agent);
      byWallet.set(normalized.walletAddress.toLowerCase(), normalized);
    } catch (error) {
      console.warn("[agents] skipped invalid pinned card", error);
    }
  }
  try {
    for (const agent of await fetchFactoryAgents()) {
      byWallet.set(agent.walletAddress.toLowerCase(), agent);
    }
  } catch (error) {
    console.warn("[agents] AgentFactory scan failed", error);
  }
  return Array.from(byWallet.values());
}

export async function listAgents(): Promise<AgentCard[]> {
  let rows: AgentCard[] = [];
  try {
    rows = await stored();
    if (rows.length > 0 && await stamped()) {
      return rows;
    }
  } catch (error) {
    console.warn("[agents] cached catalog read failed; falling back to source scan", error);
  }

  const agents = await fetchAgents();
  try {
    await sync(agents);
    await stamp();
    const rows = await stored();
    if (rows.length > 0) {
      return rows;
    }
  } catch (error) {
    console.warn("[agents] catalog refresh failed; returning fetched cards", error);
    if (rows.length > 0) {
      return rows;
    }
  }
  return await Promise.all(agents.map(async (agent) => {
    try {
      return await projectAgent(agent);
    } catch {
      return agent;
    }
  }));
}

export async function listWorkflows(): Promise<WorkflowMetadata[]> {
  return await listPinsByType("workflow-metadata") as WorkflowMetadata[];
}

export async function findAgentByWallet(walletAddress: string): Promise<AgentCard | null> {
  const normalizedAddress = walletAddress.toLowerCase();
  const cached = synced?.agents.get(id(normalizedAddress));
  if (cached) return cached;

  const storedAgent = await storedByWallet(normalizedAddress);
  if (storedAgent) return storedAgent;

  const rows = await listPinRowsByType("agent-card");
  const pinataGateway = requirePinataGateway();
  for (const pin of rows) {
    const card = await fetchFromPinataGateway<AgentCard>(pin.ipfs_pin_hash, pinataGateway);
    if (card?.walletAddress?.toLowerCase() === normalizedAddress) {
      return await projectAgent(normalizeAgentCard({ ...card, cid: pin.ipfs_pin_hash }), { enrich: catalogEnabled() });
    }
  }

  return null;
}

export async function findWorkflowByWallet(walletAddress: string): Promise<WorkflowMetadata | null> {
  const workflows = await listWorkflows();
  const normalizedAddress = walletAddress.toLowerCase();
  return workflows.find((workflow) => workflow.walletAddress?.toLowerCase() === normalizedAddress) || null;
}

async function voyage(path: "embeddings" | "rerank", body: Record<string, unknown>): Promise<unknown> {
  const response = await fetch(`${base()}/${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: `Bearer ${requireConfiguredEnv("MONGO_DB_API_KEY")}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) {
    const message = await response.text().catch(() => "");
    throw new Error(`Voyage ${path} failed (${response.status}): ${message.slice(0, 300)}`);
  }
  return await response.json();
}

function vectors(value: unknown): number[][] {
  const rows = (value as { data?: Array<{ embedding?: unknown; index?: unknown }> })?.data ?? [];
  return rows
    .map((row, fallback) => ({
      index: typeof row.index === "number" ? row.index : fallback,
      embedding: Array.isArray(row.embedding) && row.embedding.every((item) => typeof item === "number" && Number.isFinite(item))
        ? row.embedding
        : null,
    }))
    .filter((row): row is { index: number; embedding: number[] } => Boolean(row.embedding))
    .sort((a, b) => a.index - b.index)
    .map((row) => row.embedding);
}

async function embed(input: string[], type: "document" | "query"): Promise<number[][]> {
  if (input.length === 0) return [];
  const parsed = await voyage("embeddings", {
    model: process.env.AGENT_EMBEDDING_MODEL || process.env.MEMORY_EMBEDDING_MODEL || VOYAGE_MODEL,
    input,
    input_type: type,
    output_dimension: VECTOR_DIMENSIONS,
  });
  const out = vectors(parsed);
  if (out.length !== input.length) {
    throw new Error(`agent embedding count mismatch: expected ${input.length}, got ${out.length}`);
  }
  return out;
}

async function rank(query: string, documents: Array<{ id: string; text: string; score?: number }>, topK: number): Promise<Array<{ id: string; score: number }>> {
  if (documents.length === 0) return [];
  const parsed = await voyage("rerank", {
    model: VOYAGE_RERANK_MODEL,
    query,
    documents: documents.map((item) => item.text),
    top_k: Math.max(1, Math.min(topK, documents.length)),
  }) as {
    data?: Array<{ index?: unknown; relevance_score?: unknown; score?: unknown }>;
    results?: Array<{ index?: unknown; relevance_score?: unknown; score?: unknown }>;
  };
  return (parsed.data ?? parsed.results ?? [])
    .map((row) => {
      const idx = typeof row.index === "number" ? row.index : -1;
      const doc = documents[idx];
      return doc ? {
        id: doc.id,
        score: score(row.relevance_score ?? row.score ?? doc.score),
      } : null;
    })
    .filter((item): item is { id: string; score: number } => Boolean(item))
    .sort((a, b) => b.score - a.score);
}

async function cloud<T>(path: string, init: RequestInit): Promise<T> {
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account()}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token()}`,
      ...(init.headers || {}),
    },
    signal: init.signal ?? AbortSignal.timeout(8000),
  });
  const raw = await response.text();
  let parsed: unknown;
  try {
    parsed = raw ? JSON.parse(raw) : {};
  } catch {
    parsed = { raw };
  }
  if (!response.ok || (parsed && typeof parsed === "object" && (parsed as { success?: boolean }).success === false)) {
    const errors = parsed && typeof parsed === "object" && Array.isArray((parsed as { errors?: unknown }).errors)
      ? JSON.stringify((parsed as { errors: unknown }).errors)
      : raw;
    throw new Error(`Cloudflare Vectorize failed (${response.status}): ${errors.slice(0, 300)}`);
  }
  return ((parsed as { result?: unknown })?.result ?? parsed) as T;
}

function catalogEnabled(): boolean {
  return Boolean(database() && (process.env.CF_ACCOUNT_ID || process.env.CLOUDFLARE_ACCOUNT_ID) && (
    process.env.CF_GLOBAL_TOKEN
    || process.env.CF_API_TOKEN
    || process.env.CLOUDFLARE_API_TOKEN
    || process.env.CLOUDFLARE_API_KEY
  ));
}

let ready = false;

async function d1<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  if (!catalogEnabled()) return [];
  const result = await cloud<Array<{ results?: T[] }>>(`/d1/database/${database()}/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sql, params }),
  });
  return result.flatMap((item) => item.results ?? []);
}

async function hasColumn(table: string, name: string): Promise<boolean> {
  const rows = await d1<{ name?: string }>(`PRAGMA table_info(${table})`);
  return rows.some((row) => row.name === name);
}

async function addColumn(table: string, name: string, definition: string): Promise<void> {
  if (await hasColumn(table, name)) return;
  await d1(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
}

async function ensure(): Promise<boolean> {
  if (!catalogEnabled()) return false;
  if (ready) return true;
  const statements = [
    `CREATE TABLE IF NOT EXISTS agents (
       walletAddress TEXT PRIMARY KEY,
       card          TEXT NOT NULL,
       text          TEXT NOT NULL,
       hash          TEXT NOT NULL,
       name          TEXT,
       model         TEXT,
       cid           TEXT,
       state         TEXT NOT NULL CHECK (state IN ('queued', 'indexed', 'stale', 'failed')),
       batch         TEXT NOT NULL,
       updated       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
     )`,
    `CREATE TABLE IF NOT EXISTS routes (
       model   TEXT PRIMARY KEY,
       target  TEXT NOT NULL,
       reason  TEXT,
       updated TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
     )`,
    `CREATE TABLE IF NOT EXISTS states (
       walletAddress TEXT PRIMARY KEY,
       hash          TEXT NOT NULL,
       state         TEXT NOT NULL CHECK (state IN ('queued', 'indexed', 'stale', 'failed')),
       attempts      INTEGER NOT NULL DEFAULT 0,
       batch         TEXT NOT NULL,
       next          TEXT,
       error         TEXT,
       updated       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
     )`,
    `CREATE INDEX IF NOT EXISTS idx_states_state ON states(state, next, updated)`,
    `CREATE TABLE IF NOT EXISTS attempts (
       id            TEXT PRIMARY KEY,
       walletAddress TEXT NOT NULL,
       batch         TEXT NOT NULL,
       stage         TEXT NOT NULL,
       state         TEXT NOT NULL CHECK (state IN ('started', 'succeeded', 'failed')),
       error         TEXT,
       created       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
     )`,
    `CREATE INDEX IF NOT EXISTS idx_attempts_wallet ON attempts(walletAddress, created)`,
    `CREATE INDEX IF NOT EXISTS idx_attempts_batch ON attempts(batch, created)`,
    `CREATE TABLE IF NOT EXISTS cursor (
       source  TEXT PRIMARY KEY,
       value   TEXT NOT NULL,
       updated TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
     )`,
    `CREATE TABLE IF NOT EXISTS audit (
       id      TEXT PRIMARY KEY,
       action  TEXT NOT NULL,
       target  TEXT NOT NULL,
       batch   TEXT,
       data    TEXT NOT NULL DEFAULT '{}',
       created TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE INDEX IF NOT EXISTS idx_audit_action ON audit(action, created)`,
  ];
  for (const sql of statements) {
    await d1(sql);
  }
  await addColumn("agents", "target", "TEXT");
  await addColumn("agents", "route", "TEXT");
  await addColumn("agents", "creatorFee", "REAL");
  await addColumn("routes", "source", "TEXT");
  await addColumn("routes", "score", "REAL");
  await addColumn("routes", "candidates", "TEXT");
  await repair();
  await d1(`CREATE INDEX IF NOT EXISTS idx_agents_state ON agents(state, updated)`);
  await d1(`CREATE INDEX IF NOT EXISTS idx_agents_model ON agents(model, state)`);
  await d1(`CREATE INDEX IF NOT EXISTS idx_agents_target ON agents(target, state)`);
  await d1(`CREATE INDEX IF NOT EXISTS idx_routes_target ON routes(target)`);
  ready = true;
  return true;
}

async function repair(): Promise<void> {
  const rows = await d1<StoredAgentRow>(
    `SELECT walletAddress, card, creatorFee
     FROM agents
     WHERE creatorFee IS NULL
        OR json_type(card, '$.creatorFee') IS NULL`,
  );
  for (const row of rows) {
    const agent = parseStoredAgent(row.card);
    if (!agent) continue;
    await d1(
      `UPDATE agents
       SET card = ?2,
           creatorFee = ?3,
           updated = CURRENT_TIMESTAMP
       WHERE lower(walletAddress) = lower(?1)`,
      [row.walletAddress || agent.walletAddress, JSON.stringify(agent), agent.creatorFee],
    );
  }
}

async function note(action: string, target: string, batch: string | null, data: unknown = {}): Promise<void> {
  if (!(await ensure())) return;
  await d1(
    `INSERT INTO audit (id, action, target, batch, data, created)
     VALUES (?1, ?2, ?3, ?4, ?5, CURRENT_TIMESTAMP)`,
    [randomUUID(), action, target, batch, JSON.stringify(data ?? {})],
  );
}

async function step(agents: AgentCard[], batch: string, stage: AgentStage, state: "started" | "succeeded" | "failed", error?: unknown): Promise<void> {
  if (!(await ensure())) return;
  const message = error instanceof Error ? error.message : error ? String(error) : null;
  for (const agent of agents) {
    await d1(
      `INSERT INTO attempts (id, walletAddress, batch, stage, state, error, created)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, CURRENT_TIMESTAMP)`,
      [randomUUID(), agent.walletAddress.toLowerCase(), batch, stage, state, message?.slice(0, 1000) ?? null],
    );
  }
}

async function fail(agents: AgentCard[], batch: string, stage: AgentStage, error: unknown): Promise<void> {
  if (!(await ensure())) return;
  const message = error instanceof Error ? error.message : String(error);
  await step(agents, batch, stage, "failed", message);
  for (const agent of agents) {
    const wallet = agent.walletAddress.toLowerCase();
    await d1(
      `UPDATE states
       SET state = 'failed',
           attempts = attempts + 1,
           next = datetime('now', '+' || MIN(attempts + 1, 60) || ' minutes'),
           error = ?2,
           updated = CURRENT_TIMESTAMP
       WHERE walletAddress = ?1`,
      [wallet, message.slice(0, 1000)],
    );
  }
}

async function start(documents: Array<{ agent: AgentCard; id: string; text: string }>, batch: string): Promise<void> {
  if (!(await ensure())) return;
  await step(documents.map((doc) => doc.agent), batch, "card", "succeeded");
  await step(documents.map((doc) => doc.agent), batch, "validate", "succeeded");
  for (const doc of documents) {
    const agent = doc.agent;
    const wallet = agent.walletAddress.toLowerCase();
    const textHash = hash(doc.text);
    await d1(
      `INSERT INTO states (walletAddress, hash, state, attempts, batch, next, error, updated)
       VALUES (?1, ?2, 'queued', 0, ?3, NULL, NULL, CURRENT_TIMESTAMP)
       ON CONFLICT(walletAddress) DO UPDATE SET
         hash = excluded.hash,
         state = 'queued',
         batch = excluded.batch,
         next = NULL,
         error = NULL,
         updated = CURRENT_TIMESTAMP`,
      [wallet, textHash, batch],
    );
    await d1(
      `INSERT INTO agents (walletAddress, card, text, hash, name, model, target, route, cid, creatorFee, state, batch, updated)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'queued', ?11, CURRENT_TIMESTAMP)
       ON CONFLICT(walletAddress) DO UPDATE SET
         card = excluded.card,
         text = excluded.text,
         hash = excluded.hash,
         name = excluded.name,
         model = excluded.model,
         target = excluded.target,
         route = excluded.route,
         cid = excluded.cid,
         creatorFee = excluded.creatorFee,
         state = 'queued',
         batch = excluded.batch,
         updated = CURRENT_TIMESTAMP`,
      [
        wallet,
        JSON.stringify(agent),
        doc.text,
        textHash,
        agent.name,
        agent.model,
        agent.target ?? null,
        agent.route ? JSON.stringify(agent.route) : null,
        agent.cid ?? null,
        agent.creatorFee,
        batch,
      ],
    );
  }
}

async function publish(documents: Array<{ agent: AgentCard; id: string; text: string }>, batch: string): Promise<void> {
  if (!(await ensure())) return;
  await step(documents.map((doc) => doc.agent), batch, "publish", "succeeded");
  for (const doc of documents) {
    const wallet = doc.agent.walletAddress.toLowerCase();
    await d1(
      `UPDATE agents
       SET state = 'indexed',
           batch = ?2,
           updated = CURRENT_TIMESTAMP
       WHERE walletAddress = ?1`,
      [wallet, batch],
    );
    await d1(
      `UPDATE states
       SET state = 'indexed',
           next = NULL,
           error = NULL,
           updated = CURRENT_TIMESTAMP
       WHERE walletAddress = ?1`,
      [wallet],
    );
  }
  const wallets = documents.map((doc) => doc.agent.walletAddress.toLowerCase());
  if (wallets.length > 0) {
    const marks = wallets.map((_, index) => `?${index + 2}`).join(", ");
    await d1(
      `UPDATE agents
       SET state = 'stale',
           batch = ?1,
           updated = CURRENT_TIMESTAMP
       WHERE walletAddress NOT IN (${marks})`,
      [batch, ...wallets],
    );
    await d1(
      `UPDATE states
       SET state = 'stale',
           batch = ?1,
           updated = CURRENT_TIMESTAMP
       WHERE walletAddress NOT IN (${marks})`,
      [batch, ...wallets],
    );
  }
  await d1(
    `INSERT INTO cursor (source, value, updated)
     VALUES ('pinata', ?1, CURRENT_TIMESTAMP)
     ON CONFLICT(source) DO UPDATE SET
       value = excluded.value,
       updated = CURRENT_TIMESTAMP`,
    [batch],
  );
  await note("publish", "agents", batch, { count: documents.length });
}

async function stored(): Promise<AgentCard[]> {
  return (await cached()).map((row) => row.agent);
}

async function cached(): Promise<Stored[]> {
  if (!(await ensure())) return [];
  const rows = await d1<StoredAgentRow>(
    `SELECT card, text, creatorFee, target, route
     FROM agents
     WHERE state = 'indexed'
     ORDER BY lower(name) ASC`,
  );
  const projected = await Promise.all(rows.map(async (row): Promise<Stored | null> => {
      const agent = parseStoredAgent(row.card);
      if (!agent) return null;
      return { agent: await projectStoredAgent(agent, row), id: id(agent.walletAddress), text: row.text };
    }));
  return projected.filter((row): row is Stored => Boolean(row));
}

async function storedByWallet(walletAddress: string): Promise<AgentCard | null> {
  if (!catalogEnabled()) return null;
  const read = async (): Promise<AgentCard | null> => {
    const rows = await d1<StoredAgentRow>(
      `SELECT card, text, creatorFee, target, route
       FROM agents
       WHERE lower(walletAddress) = lower(?1)
         AND state = 'indexed'
       LIMIT 1`,
      [walletAddress],
    );
    const row = rows[0];
    const agent = row?.card ? parseStoredAgent(row.card) : null;
    return agent && row ? await projectStoredAgent(agent, row) : null;
  };

  try {
    const direct = await read();
    if (direct) return direct;
  } catch (error) {
    console.warn("[agents] fast exact D1 lookup failed", error);
  }

  try {
    if (!(await ensure())) return null;
    return await read();
  } catch (error) {
    console.warn("[agents] exact D1 lookup failed", error);
    return null;
  }
}

async function docs(agents: AgentCard[]): Promise<Array<{ agent: AgentCard; id: string; text: string }>> {
  return await Promise.all(agents.map(async (source) => {
    const agent = await projectAgent(source);
    return {
      agent,
      id: id(agent.walletAddress),
      text: await cardText(agent),
    };
  }));
}

function labelNorm(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function routeId(ref: string, label: string): string {
  const baseId = `agents:${ref}:${labelNorm(label)}`;
  return baseId.length <= 64 ? baseId : `agents:${hash(baseId).slice(0, 32)}`;
}

function routeEvidence(doc: { agent: AgentCard; text: string }): string {
  return [
    doc.agent.name,
    doc.agent.description || "",
    doc.agent.skills?.length ? `skills ${doc.agent.skills.slice(0, 8).join(", ")}` : "",
    doc.agent.target || doc.agent.model ? `model ${doc.agent.target || doc.agent.model}` : "",
    doc.text,
  ].filter(Boolean).join("; ").replace(/\s+/g, " ").slice(0, 500);
}

function routeVectors(doc: { agent: AgentCard; id: string; text: string }, vector: number[] | undefined): Array<Record<string, unknown>> {
  if (!vector) throw new Error(`missing route vector for ${doc.id}`);
  const ref = doc.agent.walletAddress.toLowerCase();
  const labels = [...new Set([
    doc.agent.name,
    doc.agent.walletAddress,
  ].map((label) => label?.trim()).filter((label): label is string => Boolean(label)))];
  const evidence = routeEvidence(doc);
  return labels.map((label) => ({
    id: routeId(ref, label),
    values: vector,
    metadata: {
      domain: "agents",
      ref,
      label,
      labelNorm: labelNorm(label),
      evidence,
      version: hash(doc.text).slice(0, 32),
      updated: new Date().toISOString(),
    },
  }));
}

async function sync(agents: AgentCard[]): Promise<Sync> {
  const documents = await docs(agents);
  if (documents.length === 0) {
    const empty = { hash: hash("[]"), at: Date.now(), agents: new Map<string, AgentCard>(), texts: new Map<string, string>() };
    synced = empty;
    return empty;
  }
  const digest = hash(JSON.stringify(documents.map((doc) => ({
    walletAddress: doc.agent.walletAddress.toLowerCase(),
    creatorFee: doc.agent.creatorFee,
    text: doc.text,
  }))));
  if (synced && synced.hash === digest && Date.now() - synced.at < ttl()) {
    return synced;
  }

  const byId = new Map(documents.map((doc) => [doc.id, doc.agent] as const));
  const texts = new Map(documents.map((doc) => [doc.id, doc.text] as const));
  await start(documents, digest);
  let embedded: number[][] = [];
  try {
    await step(agents, digest, "embed", "started");
    embedded = await embed(documents.map((doc) => doc.text), "document");
    await step(agents, digest, "embed", "succeeded");
  } catch (error) {
    await fail(agents, digest, "embed", error);
    throw error;
  }

  const body = documents.map((doc, idx) => JSON.stringify({
    id: doc.id,
    values: embedded[idx],
    metadata: {
      walletAddress: doc.agent.walletAddress,
      name: doc.agent.name,
      description: doc.agent.description || "",
      model: doc.agent.model || "",
      target: doc.agent.target || "",
      route: doc.agent.route?.kind || "",
      skills: strings(doc.agent.skills),
      plugins: (doc.agent.plugins || []).map((plugin) => plugin.registryId),
      creatorFee: doc.agent.creatorFee,
      evidence: doc.text.slice(0, 1000),
      hash: hash(doc.text).slice(0, 32),
    },
  })).join("\n") + "\n";
  const routeTarget = routeIndex();
  const routes = routeTarget
    ? documents.flatMap((doc, idx) => routeVectors(doc, embedded[idx]))
      .map((item) => JSON.stringify(item))
      .join("\n") + "\n"
    : "";

  try {
    await step(agents, digest, "publish", "started");
    await cloud(`/vectorize/v2/indexes/${index()}/upsert`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-ndjson",
      },
      body,
    });
    if (routeTarget && routes.trim()) {
      await cloud(`/vectorize/v2/indexes/${routeTarget}/upsert`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-ndjson",
        },
        body: routes,
      });
    }
    await publish(documents, digest);
  } catch (error) {
    await fail(agents, digest, "publish", error);
    throw error;
  }
  synced = { hash: digest, at: Date.now(), agents: byId, texts };
  return synced;
}

async function snapshot(): Promise<Sync | null> {
  if (synced && synced.agents.size > 0 && Date.now() - synced.at < ttl()) {
    return synced;
  }
  const documents = await cached();
  if (documents.length === 0) {
    return null;
  }
  const digest = hash(JSON.stringify(documents.map((doc) => ({
    walletAddress: doc.agent.walletAddress.toLowerCase(),
    creatorFee: doc.agent.creatorFee,
    text: doc.text,
  }))));
  const state = {
    hash: digest,
    at: Date.now(),
    agents: new Map(documents.map((doc) => [doc.id, doc.agent] as const)),
    texts: new Map(documents.map((doc) => [doc.id, doc.text] as const)),
  };
  synced = state;
  return state;
}

function agentSearchText(agent: AgentSearchHit): string {
  return [
    agent.name,
    agent.walletAddress,
    agent.description || "",
    agent.target || agent.model || "",
    ...(agent.skills || []),
    ...(agent.plugins || []).map((plugin) => plugin.registryId),
  ].filter(Boolean).join("; ").replace(/\s+/g, " ").slice(0, 1000);
}

function hit(agent: AgentCard): AgentSearchHit {
  return {
    walletAddress: agent.walletAddress,
    name: agent.name,
    description: agent.description || "",
    skills: strings(agent.skills),
    plugins: agent.plugins || [],
    ...(typeof agent.creatorFee === "number" ? { creatorFee: agent.creatorFee } : {}),
    ...(agent.model ? { model: agent.model } : {}),
    ...(agent.target ? { target: agent.target } : {}),
    ...(agent.route ? { route: agent.route } : {}),
  };
}

function candidate(match: AgentVectorMatch): AgentCandidate | null {
  const walletAddress = walletFromAgentVector(match);
  if (!walletAddress) return null;
  const metadata = match.metadata || {};
  const name = maybeText(metadata.name) || walletAddress;
  const model = maybeText(metadata.model);
  const target = maybeText(metadata.target);
  const routeKind = kind(metadata.route);
  const creatorFee = num(metadata.creatorFee);
  const agent: AgentSearchHit = {
    walletAddress,
    name,
    description: maybeText(metadata.description) || "",
    skills: strings(metadata.skills),
    plugins: boundPlugins(metadata.plugins),
    ...(typeof creatorFee === "number" ? { creatorFee } : {}),
    ...(model ? { model } : {}),
    ...(target ? { target } : {}),
    ...(routeKind ? { route: { kind: routeKind, from: model || target || "", checked: new Date().toISOString() } } : {}),
  };
  return {
    id: maybeText(match.id) || id(walletAddress),
    agent,
    text: maybeText(metadata.evidence) || maybeText(metadata.text) || agentSearchText(agent),
    score: score(match.score),
  };
}

function runnable(agent: AgentCard, row: Pick<StoredAgentRow, "target" | "route">): AgentCard | null {
  const target = maybeText(row.target);
  const modelRoute = parseRoute(row.route);
  if (modelRoute && validExactProjection(agent, target, modelRoute)) {
    return withProjection(agent, target, modelRoute);
  }
  if (modelRoute?.kind === "bump" && modelRoute.from === agent.model && target && modelRoute.to === target && getModelById(target)) {
    return withProjection(agent, target, modelRoute);
  }
  if (!modelRoute) {
    const exact = getModelById(agent.model);
    if (exact) {
      return withProjection(agent, exact.modelId, route("exact", agent.model, undefined, undefined, { source: "catalog" }));
    }
  }
  return null;
}

async function hydrate(candidates: AgentCandidate[]): Promise<AgentCandidate[]> {
  const byWallet = new Map<string, AgentCandidate>();
  for (const candidate of candidates) {
    const wallet = candidate.agent.walletAddress.toLowerCase();
    const current = byWallet.get(wallet);
    if (!current || candidate.score > current.score) {
      byWallet.set(wallet, candidate);
    }
  }
  const wallets = [...byWallet.keys()];
  if (wallets.length === 0 || !(await ensure())) return [];
  const marks = wallets.map((_, index) => `?${index + 1}`).join(", ");
  const rows = await d1<StoredAgentRow>(
    `SELECT walletAddress, card, text, creatorFee, target, route
     FROM agents
     WHERE state = 'indexed'
       AND lower(walletAddress) IN (${marks})`,
    wallets,
  );
  const out: AgentCandidate[] = [];
  for (const row of rows) {
    const agent = parseStoredAgent(row.card);
    if (!agent) continue;
    const projected = runnable(agent, row);
    if (!projected) continue;
    const wallet = projected.walletAddress.toLowerCase();
    const source = byWallet.get(wallet);
    if (!source) continue;
    out.push({
      id: id(wallet),
      agent: hit(projected),
      text: row.text || agentSearchText(hit(projected)),
      score: source.score,
    });
  }
  return out.sort((a, b) => b.score - a.score);
}

export async function searchAgents(query: string, limit = 8): Promise<AgentSearchHit[]> {
  const q = query.trim();
  if (!q) return [];
  if (!(await stamped())) {
    await listAgents().catch((error) => {
      console.warn("[agents] search catalog refresh failed", error);
    });
  }
  const topK = Math.max(1, Math.min(50, limit));
  const [queryVector] = await embed([q], "query");
  if (!queryVector) {
    throw new Error("agent query embedding returned empty vector");
  }
  const result = await cloud<{
    matches?: AgentVectorMatch[];
  }>(`/vectorize/v2/indexes/${index()}/query`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      vector: queryVector,
      topK: Math.min(Math.max(topK * 6, 16), 50),
      returnMetadata: "all",
    }),
  });
  const candidates = (result.matches ?? [])
    .map(candidate)
    .filter((item): item is AgentCandidate => Boolean(item));
  const hydrated = await hydrate(candidates);
  const byId = new Map(hydrated.map((item) => [item.id, item.agent] as const));
  const ranked = await rank(q, hydrated.map((item) => ({
    id: item.id,
    text: item.text,
    score: item.score,
  })), topK);
  return ranked.map((item) => {
    const agent = byId.get(item.id);
    if (!agent) {
      throw new Error(`agent search candidate missing for ${item.id}`);
    }
    return {
      ...agent,
      score: item.score,
    };
  });
}

export const test = {
  reset() {
    synced = null;
    catalogs = new Map();
    pluginTools = new Map();
    ready = false;
  },
};
