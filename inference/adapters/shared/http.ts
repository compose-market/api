/**
 * Minimal HTTP wrappers used by vendor / family modules.
 *
 * No retries, no fancy timeout logic — those concerns live in
 * `policy.ts` (request-level) and the gateway lifecycle.
 */

export interface HttpFetchInit {
    method?: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
    headers?: Record<string, string>;
    body?: BodyInit | null;
    signal?: AbortSignal;
}

export class HttpError extends Error {
    statusCode: number;
    statusText: string;
    url: string;
    body: string;
    responseBody: string;
    code?: string;
    retryAfter?: string;

    constructor(label: string, url: string, response: Response, body: string) {
        super(`${label} HTTP ${response.status} ${response.statusText} @ ${url}: ${body}`);
        this.name = "HttpError";
        this.statusCode = response.status;
        this.statusText = response.statusText;
        this.url = url;
        this.body = body;
        this.responseBody = body;
        this.retryAfter = response.headers.get("retry-after") || undefined;
        try {
            const root = JSON.parse(body) as Record<string, unknown>;
            const nested = root.error && typeof root.error === "object" && !Array.isArray(root.error)
                ? root.error as Record<string, unknown>
                : root;
            const code = nested.code ?? nested.type;
            if (typeof code === "string" && code.length > 0) this.code = code;
        } catch {
            // Preserve non-JSON provider errors as bounded text.
        }
    }
}

/**
 * Reads a response body as text, truncated to the first 1000 chars.
 * Falls back to the status text when the body cannot be read.
 */
export async function readErrorBody(response: Response): Promise<string> {
    try {
        return (await response.text()).slice(0, 1000);
    } catch {
        return response.statusText;
    }
}

/**
 * Throws a labeled `Error` carrying status, statusText, response
 * snippet and the URL. Use after a `!response.ok` check.
 */
export async function throwHttpError(label: string, url: string, response: Response): Promise<never> {
    const body = await readErrorBody(response);
    throw new HttpError(label, url, response, body);
}

/**
 * `fetch` + JSON parse + ok-check. Throws via `throwHttpError` on
 * non-2xx.
 */
export async function fetchJson(url: string, init: HttpFetchInit = {}): Promise<unknown> {
    const response = await fetch(url, init as RequestInit);
    if (!response.ok) await throwHttpError("fetchJson", url, response);
    if (response.status === 204) return null;
    const text = await response.text();
    if (!text) return null;
    try {
        return JSON.parse(text);
    } catch {
        throw new Error(`fetchJson invalid JSON @ ${url}: ${text.slice(0, 200)}`);
    }
}

/**
 * `fetchJson` POST with an `application/json` body.
 */
export async function postJson(
    url: string,
    body: unknown,
    headers: Record<string, string> = {},
    signal?: AbortSignal,
): Promise<unknown> {
    return fetchJson(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify(body),
        signal,
    });
}

/**
 * `fetchJson` GET.
 */
export async function getJson(
    url: string,
    headers: Record<string, string> = {},
    signal?: AbortSignal,
): Promise<unknown> {
    return fetchJson(url, { method: "GET", headers, signal });
}

const MAX_FETCH_BUFFER_BYTES = 50 * 1024 * 1024;
const MAX_FETCH_REDIRECTS = 5;

function isPrivateOrLoopbackIPv4(octets: [number, number, number, number]): boolean {
    const [a, b] = octets;
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    return false;
}

function parseIPv4(value: string): [number, number, number, number] | null {
    const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value);
    if (!match) return null;
    const octets = [Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4])];
    if (octets.some((n) => n < 0 || n > 255)) return null;
    return octets as [number, number, number, number];
}

function parseIPv6Groups(raw: string): number[] | null {
    const addr = raw.split("%")[0]!.toLowerCase();
    let normalized = addr;
    const lastColon = addr.lastIndexOf(":");
    if (lastColon !== -1 && addr.slice(lastColon + 1).includes(".")) {
        const ipv4 = parseIPv4(addr.slice(lastColon + 1));
        if (!ipv4) return null;
        const hi = ((ipv4[0] << 8) | ipv4[1]).toString(16);
        const lo = ((ipv4[2] << 8) | ipv4[3]).toString(16);
        normalized = `${addr.slice(0, lastColon)}:${hi}:${lo}`;
    }
    const halves = normalized.split("::");
    if (halves.length > 2) return null;
    const parseSide = (side: string): number[] | null => {
        if (!side) return [];
        const out: number[] = [];
        for (const part of side.split(":")) {
            if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
            out.push(Number.parseInt(part, 16));
        }
        return out;
    };
    const left = parseSide(halves[0]!);
    if (!left) return null;
    if (halves.length === 1) return left.length === 8 ? left : null;
    const right = parseSide(halves[1]!);
    if (!right) return null;
    const missing = 8 - left.length - right.length;
    if (missing < 1) return null;
    return [...left, ...new Array<number>(missing).fill(0), ...right];
}

function isPrivateOrLoopbackHost(hostname: string): boolean {
    const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (
        host === "localhost"
        || host === "0.0.0.0"
        || host === "::1"
        || host === "::"
        || host === "metadata.google.internal"
        || host === "metadata.goog"
        || host.endsWith(".local")
        || host.endsWith(".internal")
    ) {
        return true;
    }
    const ipv4 = parseIPv4(host);
    if (ipv4) return isPrivateOrLoopbackIPv4(ipv4);
    if (host.includes(":")) {
        const groups = parseIPv6Groups(host);
        if (!groups) return true;
        const [g0, g1, g2, g3, g4, g5, g6, g7] = groups;
        const zeroHead = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0;
        if (zeroHead && g5 === 0 && g6 === 0 && (g7 === 0 || g7 === 1)) return true;
        if (zeroHead && (g5 === 0xffff || g5 === 0)) {
            return isPrivateOrLoopbackIPv4([(g6 >> 8) & 0xff, g6 & 0xff, (g7 >> 8) & 0xff, g7 & 0xff]);
        }
        if ((g0 & 0xfe00) === 0xfc00) return true;
        if ((g0 & 0xffc0) === 0xfe80) return true;
        if (g0 === 0x0064 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
            return isPrivateOrLoopbackIPv4([(g6 >> 8) & 0xff, g6 & 0xff, (g7 >> 8) & 0xff, g7 & 0xff]);
        }
    }
    return false;
}

export function assertSafeExternalUrl(rawUrl: string): URL {
    let parsed: URL;
    try {
        parsed = new URL(rawUrl);
    } catch {
        throw new Error(`Invalid external URL: ${rawUrl}`);
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
        throw new Error(`Unsupported URL protocol: ${parsed.protocol}`);
    }
    if (isPrivateOrLoopbackHost(parsed.hostname)) {
        throw new Error(`Refusing to fetch private or metadata host: ${parsed.hostname}`);
    }
    return parsed;
}

/**
 * `fetch` returning a Buffer (for image / audio / video payloads).
 * Enforces external URL safety (including across redirect hops) and a bounded byte limit.
 * Throws on non-2xx.
 */
export async function fetchBuffer(url: string, init: HttpFetchInit = {}): Promise<{ buffer: Buffer; contentType: string | null }> {
    let current = assertSafeExternalUrl(url);
    let headers = init.headers ? { ...init.headers } : undefined;
    let response: Response | undefined;
    for (let hop = 0; hop <= MAX_FETCH_REDIRECTS; hop += 1) {
        response = await fetch(current.toString(), {
            ...(init as RequestInit),
            ...(headers ? { headers } : {}),
            redirect: "manual",
        });
        if (response.status >= 300 && response.status < 400) {
            const location = response.headers.get("location");
            if (!location) {
                return await throwHttpError("fetchBuffer", current.toString(), response);
            }
            if (hop === MAX_FETCH_REDIRECTS) {
                throw new Error(`fetchBuffer exceeded maximum redirects (${MAX_FETCH_REDIRECTS}) @ ${url}`);
            }
            const next = assertSafeExternalUrl(new URL(location, current).toString());
            if (next.origin !== current.origin && headers) {
                headers = Object.fromEntries(
                    Object.entries(headers).filter(([k]) => !["authorization", "cookie"].includes(k.toLowerCase())),
                );
            }
            current = next;
            continue;
        }
        break;
    }
    if (!response) {
        throw new Error(`fetchBuffer received no response @ ${url}`);
    }
    if (!response.ok) await throwHttpError("fetchBuffer", current.toString(), response);
    const contentLength = Number.parseInt(response.headers.get("content-length") || "", 10);
    if (Number.isFinite(contentLength) && contentLength > MAX_FETCH_BUFFER_BYTES) {
        throw new Error(`fetchBuffer response exceeds maximum allowed size (${MAX_FETCH_BUFFER_BYTES} bytes)`);
    }
    if (!response.body) {
        const arrayBuffer = await response.arrayBuffer();
        if (arrayBuffer.byteLength > MAX_FETCH_BUFFER_BYTES) {
            throw new Error(`fetchBuffer response exceeds maximum allowed size (${MAX_FETCH_BUFFER_BYTES} bytes)`);
        }
        return {
            buffer: Buffer.from(arrayBuffer),
            contentType: response.headers.get("content-type"),
        };
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            if (value) {
                total += value.byteLength;
                if (total > MAX_FETCH_BUFFER_BYTES) {
                    await reader.cancel();
                    throw new Error(`fetchBuffer response exceeds maximum allowed size (${MAX_FETCH_BUFFER_BYTES} bytes)`);
                }
                chunks.push(value);
            }
        }
    } finally {
        reader.releaseLock();
    }
    return {
        buffer: Buffer.concat(chunks, total),
        contentType: response.headers.get("content-type"),
    };
}
