export interface FamilyCatalogEntry {
  family: string;
  modelCount: number;
}

export interface FamilyModel {
  modelId: string;
  family?: unknown;
}

export function normalizeFamily(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const family = value
    .trim()
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return family.length > 0 ? family : null;
}

const RULES: Array<{ family: string; patterns: string[] }> = [
  { family: "deepgram", patterns: ["deepgram/flux", "=flux", "nova-*", "aura-*"] },
  { family: "alibaba", patterns: ["qwen*", "qvq*", "wan*", "cosyvoice", "paraformer", "fun-asr*", "gte*", "tongyi-*", "z-image-*"] },
  { family: "happyhorse", patterns: ["happyhorse-*"] },
  { family: "nvidia", patterns: ["nemotron-*", "nv-*"] },
  { family: "xai", patterns: ["grok-*"] },
  { family: "anthropic", patterns: ["claude-*"] },
  { family: "blackforestlabs", patterns: ["flux*", "kontext-*"] },
  { family: "zai", patterns: ["glm-*", "autoglm-*", "cogview*", "cogvideox"] },
  { family: "moonshot", patterns: ["kimi-*", "moonshot-*"] },
  { family: "deepseek", patterns: ["deepseek-*"] },
  { family: "minimax", patterns: ["minimax-*", "hailuo-*"] },
  { family: "tencent", patterns: ["hunyuan-*"] },
  { family: "baidu", patterns: ["ernie-*"] },
  { family: "microsoft", patterns: ["mai-*", "phi-*", "orca-*", "e5-*", "resnet-*"] },
  { family: "aisingapore", patterns: ["aisingapore/sea-lion"] },
  { family: "google", patterns: ["gemma-*", "embeddinggemma*", "gemini-*", "imagen-*", "veo-*", "lyria-*", "deep-research-*", "nano-banana"] },
  { family: "meta", patterns: ["llama-*", "seamless", "m2m100", "bart-*", "detr-*"] },
  { family: "mistral", patterns: ["mistral-*", "mixtral-*", "pixtral-*", "codestral-*", "magistral-*", "devstral-*", "ministral-*"] },
  { family: "cohere", patterns: ["command-*", "rerank-*", "embed-*", "cohere-rerank-*", "cohere-embed-*", "aya-*", "c4ai-*"] },
  { family: "openai", patterns: ["whisper-*", "gpt-*", "o1", "o3", "o4", "dall-e-*", "sora", "chatgpt-*", "tts-*", "text-embedding-*", "gpt-oss-*"] },
  { family: "elevenlabs", patterns: ["eleven-*", "music-*", "scribe-*"] },
  { family: "cartesia", patterns: ["sonic-*"] },
  { family: "roboflow", patterns: ["roboflow-*"] },
  { family: "baai", patterns: ["bge-*"] },
  { family: "stabilityai", patterns: ["stable-diffusion", "sdxl", "sd3", "stable-cascade"] },
  { family: "lightricks", patterns: ["ltx-*"] },
  { family: "kuaishou", patterns: ["kolors"] },
  { family: "hidream", patterns: ["hidream"] },
  { family: "ideogram", patterns: ["ideogram"] },
  { family: "recraft", patterns: ["recraft"] },
  { family: "genmo", patterns: ["mochi"] },
  { family: "bytedance", patterns: ["seedream", "doubao"] },
  { family: "xiaohongshu", patterns: ["firered"] },
  { family: "meituan", patterns: ["longcat"] },
  { family: "ibm", patterns: ["granite-*", "ibm-granite"] },
  { family: "swissai", patterns: ["apertus"] },
  { family: "utter-project", patterns: ["eurollm"] },
  { family: "ai4bharat", patterns: ["ai4bharat"] },
  { family: "shanghai-ai-lab", patterns: ["internvl-*", "intern-*"] },
  { family: "01ai", patterns: ["yi-*"] },
  { family: "databricks", patterns: ["dbrx"] },
  { family: "tii", patterns: ["falcon-*"] },
  { family: "allenai", patterns: ["tulu-*", "olmo-*"] },
  { family: "asicloud", patterns: ["asi1-*"] },
  { family: "leonardo", patterns: ["lucid-*", "phoenix-*"] },
  { family: "llava-hf", patterns: ["llava-*"] },
  { family: "lykon", patterns: ["dreamshaper-*"] },
  { family: "pfnet", patterns: ["plamo-*"] },
  { family: "playht", patterns: ["playai", "playht"] },
  { family: "arcee", patterns: ["arcee-*"] },
  { family: "nousresearch", patterns: ["nous-*", "hermes-*"] },
  { family: "huggingface", patterns: ["smol*", "distilbert-*"] },
  { family: "pipecat", patterns: ["pipecat-ai"] },
  { family: "myshell", patterns: ["myshell-ai/melotts"] },
];

function token(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .trim()
    .toLowerCase()
    .replace(/^models\//, "")
    .replace(/^@cf\//, "")
    .replace(/^accounts\/[^/]+\/models\//, "")
    .replace(/_/g, "-")
    .replace(/[^a-z0-9./-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function tokens(modelId: string, name?: string | null): string[] {
  const roots = [token(modelId), token(name)].filter(Boolean);
  const out = new Set<string>();
  for (const root of roots) {
    out.add(root);
    const parts = root.split("/").filter(Boolean);
    const slug = parts[parts.length - 1] || root;
    out.add(slug);
    if (parts.length > 1) {
      out.add(`${parts[0]}/${slug}`);
    }
  }
  return [...out];
}

function match(candidate: string, pattern: string): boolean {
  const raw = pattern.trim();
  const exact = raw.startsWith("=");
  const dash = raw.endsWith("-*");
  const wild = !dash && raw.endsWith("*");
  const body = exact
    ? raw.slice(1)
    : dash
      ? raw.slice(0, -2)
      : wild
        ? raw.slice(0, -1)
        : raw;
  const normalized = token(body);
  if (!normalized) return false;
  if (exact) return candidate === normalized;
  if (normalized.includes("/") && !dash && !wild) {
    const [namespace, name] = normalized.split("/");
    const [candidateNamespace, candidateName = ""] = candidate.split("/");
    return candidateNamespace === namespace && candidateName.includes(name ?? "");
  }
  if (dash) {
    return candidate === normalized
      || candidate.startsWith(`${normalized}-`)
      || candidate.startsWith(`${normalized}/`);
  }
  if (wild) return candidate.startsWith(normalized);
  return candidate === normalized
    || candidate.startsWith(`${normalized}-`)
    || candidate.startsWith(`${normalized}/`);
}

export function aggregateCanonicalFamily(modelId: string, name?: string | null): string | undefined {
  const candidates = tokens(modelId, name);
  for (const rule of RULES) {
    for (const pattern of rule.patterns) {
      if (candidates.some((candidate) => match(candidate, pattern))) {
        return rule.family;
      }
    }
  }
  return undefined;
}

export function familyOf(model: Pick<FamilyModel, "family">): string | null {
  return normalizeFamily(model.family);
}

export function getFamilyCatalog(models: FamilyModel[] = []): FamilyCatalogEntry[] {
  const counts = new Map<string, Set<string>>();
  for (const model of models) {
    const family = familyOf(model);
    if (!family) continue;
    const ids = counts.get(family) ?? new Set<string>();
    ids.add(model.modelId);
    counts.set(family, ids);
  }

  return [...counts.entries()]
    .map(([family, ids]) => ({
      family,
      modelCount: ids.size,
    }))
    .sort((left, right) => left.family.localeCompare(right.family));
}
