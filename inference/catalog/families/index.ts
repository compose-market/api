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
  { family: "alibaba", patterns: ["qwen*", "qwq*", "happyhorse", "happyhorse-*", "qvq*", "wan*", "cosyvoice", "paraformer", "fun-asr*", "gte*", "tongyi-*", "z-image-*"] },
  { family: "nvidia", patterns: ["nemotron-*", "nv-*", "nvidia/*"] },
  { family: "xai", patterns: ["grok-*"] },
  { family: "anthropic", patterns: ["claude-*"] },
  { family: "blackforestlabs", patterns: ["flux*", "kontext-*"] },
  { family: "zai", patterns: ["glm-*", "autoglm-*", "cogview*", "cogvideox"] },
  { family: "moonshot", patterns: ["kimi-*", "moonshot-*"] },
  { family: "deepseek", patterns: ["deepseek-*"] },
  { family: "minimax", patterns: ["minimax-*", "hailuo-*"] },
  { family: "tencent", patterns: ["hunyuan-*", "tencent/*", "hy3"] },
  { family: "baidu", patterns: ["ernie-*"] },
  { family: "microsoft", patterns: ["mai-*", "phi-*", "orca-*", "e5-*", "resnet-*", "intfloat/*", "microsoft/*", "wizardlm-*"] },
  { family: "aisingapore", patterns: ["aisingapore/sea-lion"] },
  { family: "google", patterns: ["gemma-*", "embeddinggemma*", "gemini-*", "imagen-*", "veo-*", "lyria-*", "deep-research-*", "nano-banana", "google/*", "codegemma*"] },
  { family: "meta", patterns: ["llama-*", "seamless", "m2m100", "bart-*", "detr-*", "meta-llama/*"] },
  { family: "mistral", patterns: ["mistral-*", "mixtral-*", "pixtral-*", "codestral-*", "magistral-*", "devstral-*", "ministral-*", "mistralai/*", "voxtral-*"] },
  { family: "cohere", patterns: ["command-*", "rerank-*", "embed-*", "cohere-rerank-*", "cohere-embed-*", "aya-*", "c4ai-*"] },
  { family: "openai", patterns: ["whisper-*", "gpt-*", "o1", "o3", "o4", "dall-e-*", "sora", "chat-*", "chatgpt-*", "omni-moderation-*", "tts-*", "text-embedding-*", "gpt-oss-*", "openai/*", "clip-*"] },
  { family: "elevenlabs", patterns: ["eleven-*", "music-*", "scribe-*"] },
  { family: "cartesia", patterns: ["sonic-*", "ink-*"] },
  { family: "roboflow", patterns: ["roboflow-*"] },
  { family: "baai", patterns: ["bge-*"] },
  { family: "stabilityai", patterns: ["stable-diffusion", "sdxl", "sd3", "stable-cascade", "stabilityai/*", "sd3.5*"] },
  { family: "lightricks", patterns: ["ltx-*"] },
  { family: "kuaishou", patterns: ["kolors"] },
  { family: "hidream", patterns: ["hidream"] },
  { family: "ideogram", patterns: ["ideogram"] },
  { family: "recraft", patterns: ["recraft"] },
  { family: "genmo", patterns: ["mochi"] },
  { family: "bytedance", patterns: ["seedream", "doubao", "bytedance/*", "seed-*"] },
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
  { family: "allenai", patterns: ["tulu-*", "olmo-*", "allenai/*", "olmocr-*", "olmocr"] },
  { family: "asicloud", patterns: ["asi1-*"] },
  { family: "leonardo", patterns: ["lucid-*", "phoenix-*"] },
  { family: "lykon", patterns: ["dreamshaper-*"] },
  { family: "pfnet", patterns: ["plamo-*"] },
  { family: "playht", patterns: ["playai", "playht"] },
  { family: "arcee", patterns: ["arcee-*"] },
  { family: "nousresearch", patterns: ["nous-*", "hermes-*"] },
  { family: "huggingface", patterns: ["smol*", "llava-*", "llava-hf", "distilbert-*", "sentence-transformers/*"] },
  { family: "moondream", patterns: ["moondream/*", "moondream*"] },
  { family: "daily", patterns: ["pipecat-ai", "smart-turn-*", "smart-turn", "pipecat"] },
  { family: "myshell", patterns: ["myshell-ai/melotts"] },
  { family: "bria", patterns: ["bria/*"] },
  { family: "prunaai", patterns: ["prunaai/*"] },
  { family: "sesame", patterns: ["sesame/*", "csm-*"] },
  { family: "shibing624", patterns: ["shibing624/*"] },
  { family: "sao10k", patterns: ["sao10k/*"] },
  { family: "xiaomi", patterns: ["xiaomimimo/*", "mimo-*"] },
  { family: "pixverse", patterns: ["pixverse/*"] },
  { family: "inworld", patterns: ["inworld-ai/*"] },
  { family: "stepfun", patterns: ["stepfun-ai/*", "step-*"] },
  { family: "resemble", patterns: ["resembleai/*", "chatterbox-*"] },
  { family: "hexgrad", patterns: ["hexgrad/*", "kokoro-*"] },
  { family: "boson", patterns: ["bosonai/*", "higgs-*"] },
  { family: "gryphe", patterns: ["gryphe/*"] },
  { family: "bigcode", patterns: ["bigcode/*", "bigcode-*"] },
  { family: "openchat", patterns: ["openchat/*", "openchat-*"] },
  { family: "canopylabs", patterns: ["canopylabs/*", "canopylabs-*"] },
  { family: "cognitivecomputations", patterns: ["cognitivecomputations/*", "cognitivecomputations-*", "dolphin-*"] },
  { family: "koboldai", patterns: ["koboldai/*", "koboldai-*"] },
  { family: "clarityai", patterns: ["clarityai/*", "clarityai-*"] },
  { family: "zyphra", patterns: ["zyphra/*", "zyphra-*", "zonos-*"] },
  { family: "deepinfra", patterns: ["deepinfra/*", "deepinfra-*"] },
  { family: "thinkingmachines", patterns: ["thinkingmachines/*", "inkling"] },
  { family: "acestep", patterns: ["acestep/*", "acestep-*"] },
  { family: "openbmb", patterns: ["openbmb/*", "openbmb-*", "minicpm-*"] },
  { family: "novasky", patterns: ["novasky-ai/*", "novasky/*", "sky-*"] },
  { family: "lizpreciatior", patterns: ["lizpreciatior/*", "lizpreciatior-*", "lzlv-*"] },
  { family: "run-diffusion", patterns: ["run-diffusion/*", "run-diffusion-*", "juggernaut-*"] },
  { family: "paddlepaddle", patterns: ["paddlepaddle/*", "paddlepaddle-*", "paddleocr-*"] },
  { family: "fastvideo", patterns: ["fastvideo/*", "fastvideo-*", "fastwan-*", "ltx2-*"] },
  { family: "austism", patterns: ["austism/*", "chronos-*"] },
  { family: "mattshumer", patterns: ["mattshumer/*", "reflection-*"] },
  { family: "deepreinforce-ai", patterns: ["deepreinforce-ai/*", "ornith-*"] },
  { family: "xpuct", patterns: ["xpuct/*", "deliberate"] },
  { family: "phind", patterns: ["phind/*", "phind-*"] },
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
