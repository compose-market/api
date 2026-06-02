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

    constructor(label: string, url: string, response: Response, body: string) {
        super(`${label} HTTP ${response.status} ${response.statusText} @ ${url}: ${body}`);
        this.name = "HttpError";
        this.statusCode = response.status;
        this.statusText = response.statusText;
        this.url = url;
        this.body = body;
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

/**
 * `fetch` returning a Buffer (for image / audio / video payloads).
 * Throws on non-2xx.
 */
export async function fetchBuffer(url: string, init: HttpFetchInit = {}): Promise<{ buffer: Buffer; contentType: string | null }> {
    const response = await fetch(url, init as RequestInit);
    if (!response.ok) await throwHttpError("fetchBuffer", url, response);
    const arrayBuffer = await response.arrayBuffer();
    return {
        buffer: Buffer.from(arrayBuffer),
        contentType: response.headers.get("content-type"),
    };
}
