interface DesktopUpdaterRouteEvent {
  rawPath: string;
  requestContext: { http: { method: string } };
}

interface DesktopUpdaterRouteResult {
  statusCode: number;
  headers?: Record<string, string>;
  body: string;
  isBase64Encoded?: boolean;
}

interface DesktopUpdaterConfig {
  enabled: boolean;
  pubkey: string | null;
  manifestTemplate: string | null;
}

const DESKTOP_UPDATER_CONFIG_PATH = "/api/desktop/updates/config";
const DESKTOP_UPDATER_MANIFEST_PATH_REGEX = /^\/api\/desktop\/updates\/([^/]+)\/([^/]+)\/([^/]+)$/;

function json(
  statusCode: number,
  payload: unknown,
  corsHeaders: Record<string, string>,
): DesktopUpdaterRouteResult {
  return {
    statusCode,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  };
}

function getDesktopUpdaterConfig(): DesktopUpdaterConfig {
  const pubkey = process.env.DESKTOP_UPDATER_PUBLIC_KEY?.trim() || "";
  const manifestTemplate = (
    process.env.DESKTOP_UPDATER_MANIFEST_URL_TEMPLATE?.trim() ||
    process.env.DESKTOP_UPDATER_MANIFEST_URL?.trim() ||
    ""
  );

  return {
    enabled: Boolean(pubkey && manifestTemplate),
    pubkey: pubkey || null,
    manifestTemplate: manifestTemplate || null,
  };
}

function buildDesktopUpdaterManifestUrl(
  template: string,
  target: string,
  arch: string,
  currentVersion: string,
): string {
  return template
    .replace(/{{target}}/g, encodeURIComponent(target))
    .replace(/{{arch}}/g, encodeURIComponent(arch))
    .replace(/{{current_version}}/g, encodeURIComponent(currentVersion));
}

async function handleDesktopUpdaterConfig(
  corsHeaders: Record<string, string>,
): Promise<DesktopUpdaterRouteResult> {
  const config = getDesktopUpdaterConfig();
  return json(200, {
    enabled: config.enabled,
    pubkey: config.enabled ? config.pubkey : null,
  }, corsHeaders);
}

async function handleDesktopUpdaterManifest(
  path: string,
  corsHeaders: Record<string, string>,
): Promise<DesktopUpdaterRouteResult> {
  const config = getDesktopUpdaterConfig();
  if (!config.enabled || !config.manifestTemplate) {
    return json(404, { error: "Desktop updater is not configured" }, corsHeaders);
  }

  const match = path.match(DESKTOP_UPDATER_MANIFEST_PATH_REGEX);
  if (!match) {
    return json(400, { error: "Invalid desktop updater manifest path" }, corsHeaders);
  }

  const [, target, arch, currentVersion] = match;
  const manifestUrl = buildDesktopUpdaterManifestUrl(config.manifestTemplate, target, arch, currentVersion);

  try {
    const response = await fetch(manifestUrl, {
      headers: {
        Accept: "application/json",
        "User-Agent": "compose-desktop-updater-proxy/1.0",
      },
      signal: AbortSignal.timeout(10_000),
    });
    const body = await response.text();

    return {
      statusCode: response.status,
      headers: {
        ...corsHeaders,
        "Content-Type": response.headers.get("content-type") || "application/json",
        "Cache-Control": response.ok ? "public, max-age=60" : "no-store",
      },
      body,
    };
  } catch (error) {
    return json(502, {
      error: error instanceof Error ? error.message : "Failed to fetch desktop updater manifest",
    }, corsHeaders);
  }
}

export async function handleDesktopUpdaterRoute(
  event: DesktopUpdaterRouteEvent,
  corsHeaders: Record<string, string>,
): Promise<DesktopUpdaterRouteResult | null> {
  const path = event.rawPath;
  const method = event.requestContext.http.method.toUpperCase();

  if (method === "GET" && path === DESKTOP_UPDATER_CONFIG_PATH) {
    return handleDesktopUpdaterConfig(corsHeaders);
  }

  if (method === "GET" && DESKTOP_UPDATER_MANIFEST_PATH_REGEX.test(path)) {
    return handleDesktopUpdaterManifest(path, corsHeaders);
  }

  return null;
}
