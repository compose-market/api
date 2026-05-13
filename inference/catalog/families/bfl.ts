/**
 * Black Forest Labs FLUX family wire.
 *
 * Pure protocol module. BFL exposes a uniform submit-then-poll workflow
 * for every image model:
 *
 *   - `POST /<model-path>` returns `{ id, polling_url }`
 *   - `GET /v1/get_result?id=...` returns `{ status, result }` until
 *     status is `"Ready"` (or terminal `"Error"` / `"Failed"`).
 *
 * NO endpoints, NO API keys, NO network calls. Vendors that route
 * BFL FLUX models (direct BFL, Azure-hosted FLUX under
 * `/providers/blackforestlabs/v1/...`, etc.) own the transport.
 *
 * Models supported (per https://docs.bfl.ml/llms.txt):
 *   - flux-pro, flux-pro-1.1, flux-pro-1.1-ultra (Ultra mode + RAW)
 *   - flux-dev
 *   - flux-pro-1.0-fill   (mask in/outpaint)
 *   - flux-pro-1.0-expand (canvas expand)
 *   - flux-kontext-pro / flux-kontext-max (legacy edit; use FLUX.2 PRO)
 *   - flux-2-pro / flux-2-flex / flux-2-max
 *   - flux-2-klein-4b / flux-2-klein-9b / flux-2-klein-9b-kv
 *
 * Spec index: https://docs.bfl.ml/llms.txt
 */

import { asRecord, clean } from "../shared/index.js";
import type { ImageEditMode, ImageInput } from "../modalities/image.js";

// ---------------------------------------------------------------------------
// Submit-poll protocol shapes
// ---------------------------------------------------------------------------

export interface BflJobHandle {
    id: string;
    /** Absolute URL the vendor SHOULD prefer for polling when present. */
    pollingUrl?: string;
}

export type BflJobStatus =
    | "Task not found"
    | "Pending"
    | "Request Moderated"
    | "Content Moderated"
    | "Ready"
    | "Error"
    | "Failed"
    | "Processing"
    | "Queued";

export interface BflJobResult {
    status: BflJobStatus;
    /** Present when status === "Ready". */
    result?: { sample?: string; prompt?: string;[key: string]: unknown };
    /** Present on error. */
    error?: string;
    progress?: number;
}

/**
 * Read a submission response body and return the job handle. Vendors
 * call this immediately after their POST returns.
 */
export function parseSubmitResponse(raw: unknown): BflJobHandle {
    const root = asRecord(raw) || {};
    const id = clean(root.id) || clean(asRecord(root.task)?.id);
    if (!id) throw new Error("BFL submit returned no job id");
    return {
        id,
        pollingUrl: clean(root.polling_url) || clean(root.polling) || undefined,
    };
}

/**
 * Decode the polling response body into a normalized status. Vendors
 * loop until `status === "Ready"` (or terminal error).
 */
export function parsePollResponse(raw: unknown): BflJobResult {
    const root = asRecord(raw) || {};
    return {
        status: (clean(root.status) || "Pending") as BflJobStatus,
        result: asRecord(root.result) ?? undefined,
        error: clean(root.error) || undefined,
        progress: typeof root.progress === "number" ? root.progress : undefined,
    };
}

/**
 * Build the relative poll URL for a job handle when the response did
 * not include a `polling_url`. Vendors prepend their own origin.
 */
export function pollPath(handle: BflJobHandle): string {
    return `/v1/get_result?id=${encodeURIComponent(handle.id)}`;
}

/**
 * Return `true` when the job has reached a terminal state.
 */
export function isTerminalStatus(status: BflJobStatus): boolean {
    return status === "Ready"
        || status === "Error"
        || status === "Failed"
        || status === "Content Moderated"
        || status === "Request Moderated"
        || status === "Task not found";
}

/**
 * Map a BFL terminal `BflJobResult` into an explanatory error string.
 * Returns `null` when the result is `Ready`.
 */
export function describeTerminalError(result: BflJobResult): string | null {
    if (result.status === "Ready") return null;
    if (result.status === "Error" || result.status === "Failed") {
        return `BFL job ${result.status}: ${result.error || "unknown"}`;
    }
    if (result.status === "Content Moderated" || result.status === "Request Moderated") {
        return `BFL moderation: ${result.status}`;
    }
    if (result.status === "Task not found") return "BFL job: Task not found";
    return null;
}

// ---------------------------------------------------------------------------
// Model paths
// ---------------------------------------------------------------------------

/**
 * Resolve the per-model submission path given a Compose model id /
 * shorthand. Returns `null` when the model id is not recognized as a
 * FLUX family member — the caller falls back to a generic dispatcher.
 */
export function resolveFluxPath(modelId: string): string | null {
    const id = modelId.trim().toLowerCase();
    if (!id) return null;
    // FLUX.2
    if (id.includes("flux.2-pro-preview") || id.includes("flux-2-pro-preview")) return "/v1/flux-2-pro-preview";
    if (id.includes("flux.2-pro") || id.includes("flux-2-pro")) return "/v1/flux-2-pro";
    if (id.includes("flux.2-flex") || id.includes("flux-2-flex")) return "/v1/flux-2-flex";
    if (id.includes("flux.2-max") || id.includes("flux-2-max")) return "/v1/flux-2-max";
    if (id.includes("flux.2-klein-9b-kv") || id.includes("flux-2-klein-9b-kv")) return "/v1/flux-2-klein-9b-kv";
    if (id.includes("flux.2-klein-9b") || id.includes("flux-2-klein-9b")) return "/v1/flux-2-klein-9b";
    if (id.includes("flux.2-klein-4b") || id.includes("flux-2-klein-4b")) return "/v1/flux-2-klein-4b";
    // FLUX.1 "tools"
    if (id.includes("flux-1.0-fill") || id.includes("flux.1.0-fill") || id.includes("flux-pro-1.0-fill")) return "/v1/flux-pro-1.0-fill";
    if (id.includes("flux-pro-1.0-expand") || id.includes("flux-1.0-expand")) return "/v1/flux-pro-1.0-expand";
    // FLUX.1 Kontext (legacy editing)
    if (id.includes("kontext-max")) return "/v1/flux-kontext-max";
    if (id.includes("kontext-pro") || id.includes("kontext")) return "/v1/flux-kontext-pro";
    // FLUX 1.1 [pro]
    if (id.includes("flux-pro-1.1-ultra") || id.includes("flux-1.1-ultra")) return "/v1/flux-pro-1.1-ultra";
    if (id.includes("flux-pro-1.1-finetuned-ultra")) return "/v1/flux-pro-1.1-finetuned-ultra";
    if (id.includes("flux-pro-1.1") || id.includes("flux-1.1")) return "/v1/flux-pro-1.1";
    if (id.includes("flux-dev") || id.includes("flux.1-dev")) return "/v1/flux-dev";
    if (id.includes("flux-pro") || id.includes("flux.1-pro")) return "/v1/flux-pro";
    return null;
}

// ---------------------------------------------------------------------------
// Body builders — from canonical request shapes
// ---------------------------------------------------------------------------

/**
 * Translate an `ImageInput` to its FLUX wire form. FLUX accepts URLs
 * and base64 strings (no data: prefix) interchangeably. `file_id`
 * inputs are not supported by BFL and throw.
 */
function imageInputToWire(input: ImageInput): string {
    if (input.type === "url") return input.url;
    if (input.type === "base64") return input.data;
    throw new Error(`BFL FLUX does not accept file_id image inputs (received "${input.fileId}")`);
}

/**
 * Build a body for text-to-image / image-edit on the FLUX family.
 * FLUX.2 endpoints accept an `image_prompts` array of up to 10 refs
 * for editing; single-reference modes (fill, outpaint) collapse to
 * `image_prompt`.
 */
export function buildFluxBody(args: {
    prompt: string;
    images?: ImageInput[];
    mask?: ImageInput;
    width?: number;
    height?: number;
    aspectRatio?: string;
    n?: number;
    seed?: number;
    steps?: number;
    guidance?: number;
    safetyTolerance?: number;
    promptUpsampling?: boolean;
    raw?: boolean;
    outputFormat?: string;
    /** Outpaint expansion (FLUX.1 Expand only). */
    expand?: { top?: number; bottom?: number; left?: number; right?: number };
    /** Per-mode hint (used to decide which fields apply). */
    mode?: ImageEditMode;
    customParams?: Record<string, unknown>;
}): Record<string, unknown> {
    const body: Record<string, unknown> = { prompt: args.prompt };
    if (args.width != null) body.width = args.width;
    if (args.height != null) body.height = args.height;
    if (args.aspectRatio) body.aspect_ratio = args.aspectRatio;
    if (typeof args.seed === "number") body.seed = args.seed;
    if (typeof args.steps === "number") body.steps = args.steps;
    if (typeof args.guidance === "number") body.guidance = args.guidance;
    if (typeof args.safetyTolerance === "number") body.safety_tolerance = args.safetyTolerance;
    if (typeof args.promptUpsampling === "boolean") body.prompt_upsampling = args.promptUpsampling;
    if (typeof args.raw === "boolean") body.raw = args.raw;
    if (args.outputFormat) body.output_format = args.outputFormat;

    // FLUX.2 multi-reference editing.
    if (args.images && args.images.length > 0) {
        if (args.mode === "fill" || args.mode === "outpaint" || args.images.length === 1) {
            body.image_prompt = imageInputToWire(args.images[0]);
        } else {
            body.image_prompts = args.images.map(imageInputToWire);
        }
    }
    if (args.mask) body.mask = imageInputToWire(args.mask);

    // FLUX Expand.
    if (args.expand) {
        if (typeof args.expand.top === "number") body.top = args.expand.top;
        if (typeof args.expand.bottom === "number") body.bottom = args.expand.bottom;
        if (typeof args.expand.left === "number") body.left = args.expand.left;
        if (typeof args.expand.right === "number") body.right = args.expand.right;
    }

    if (args.customParams) Object.assign(body, args.customParams);
    return body;
}
