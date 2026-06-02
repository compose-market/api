export type CanonicalConnectorOrigin = "mcp" | "onchain";

export interface ConnectorBindingInput {
  registryId?: string;
  origin?: string;
  slug?: string;
  id?: string;
}

export interface NormalizedConnectorBinding {
  origin: CanonicalConnectorOrigin;
  slug: string;
  registryId: `${CanonicalConnectorOrigin}:${string}`;
  original: string;
}

function canonicalOrigin(value: string | undefined, defaultOrigin: CanonicalConnectorOrigin): CanonicalConnectorOrigin {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return defaultOrigin;
  }
  if (normalized === "mcp" || normalized === "onchain") {
    return normalized;
  }
  throw new Error(`Unsupported connector origin "${value}". Use "mcp" or "onchain".`);
}

function splitPrefixed(value: string): { prefix?: CanonicalConnectorOrigin; slug: string } {
  let slug = value.trim();
  const forbidden = slug.match(/^(tools|goat)([:\-])(.+)$/i);
  if (forbidden) {
    throw new Error(`Unsupported connector registry prefix "${forbidden[1]}". Use "mcp" or "onchain".`);
  }
  const match = slug.match(/^(mcp|onchain)([:\-])(.+)$/i);
  if (!match) return { slug };
  return {
    prefix: match[1].toLowerCase() as CanonicalConnectorOrigin,
    slug: match[3].trim(),
  };
}

export function normalizeConnectorBinding(
  input: string | ConnectorBindingInput,
  options: { defaultOrigin?: CanonicalConnectorOrigin } = {},
): NormalizedConnectorBinding {
  const defaultOrigin = options.defaultOrigin ?? "mcp";
  const original = typeof input === "string" ? input : input.registryId || input.slug || input.id || "";
  const explicitOrigin = typeof input === "string" ? undefined : input.origin;
  const { prefix, slug } = splitPrefixed(original);
  const origin = canonicalOrigin(explicitOrigin || prefix, defaultOrigin);
  if (!slug) throw new Error("Connector registryId is required");
  return {
    origin,
    slug,
    registryId: `${origin}:${slug}`,
    original,
  };
}
