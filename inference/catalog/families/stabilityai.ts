/**
 * Stability AI family wire (v2beta REST API).
 *
 * Pure protocol module — path constants, body builders, response
 * parsers. NO endpoints, NO API keys, NO network calls.
 *
 * Stability v2beta speaks **multipart/form-data** for every endpoint
 * (with the API key in `Authorization: Bearer <key>` and
 * `Accept: image/*` or `application/json`). That is the only major
 * deviation from the JSON-body convention every other family follows
 * — vendors must assemble the multipart themselves.
 *
 * Surfaces (per https://platform.stability.ai/docs/api-reference):
 *
 *   Image generation
 *     - `POST /v2beta/stable-image/generate/sd3`           SD3 / SD3.5
 *     - `POST /v2beta/stable-image/generate/ultra`         Stable Image Ultra
 *     - `POST /v2beta/stable-image/generate/core`          Stable Image Core
 *
 *   Image control
 *     - `POST /v2beta/stable-image/control/sketch`         sketch → image
 *     - `POST /v2beta/stable-image/control/structure`      structure-preserving
 *     - `POST /v2beta/stable-image/control/style`          style transfer
 *     - `POST /v2beta/stable-image/control/style-transfer` v2 style transfer
 *
 *   Image edit
 *     - `POST /v2beta/stable-image/edit/erase`             erase region
 *     - `POST /v2beta/stable-image/edit/inpaint`           mask inpaint
 *     - `POST /v2beta/stable-image/edit/outpaint`          extend canvas
 *     - `POST /v2beta/stable-image/edit/search-and-replace` semantic edit
 *     - `POST /v2beta/stable-image/edit/search-and-recolor` semantic recolor
 *     - `POST /v2beta/stable-image/edit/remove-background` matte
 *     - `POST /v2beta/stable-image/edit/replace-background-and-relight`
 *
 *   Upscale
 *     - `POST /v2beta/stable-image/upscale/conservative`    sync
 *     - `POST /v2beta/stable-image/upscale/creative`        async
 *     - `POST /v2beta/stable-image/upscale/fast`            sync 4x
 *     - `GET  /v2beta/stable-image/upscale/creative/result/{id}` poll
 *
 *   Image-to-Video
 *     - `POST /v2beta/image-to-video`                       async submit
 *     - `GET  /v2beta/image-to-video/result/{id}`           poll
 *
 *   Audio (Stable Audio 2.0)
 *     - `POST /v2beta/audio/stable-audio-2/text-to-audio`   sync (mp3)
 *     - `POST /v2beta/audio/stable-audio-2/audio-to-audio`  audio-cond.
 *     - `POST /v2beta/audio/stable-audio-2/inpaint`         inpaint
 *
 *   3D
 *     - `POST /v2beta/3d/stable-fast-3d`                   image → glb
 *     - `POST /v2beta/3d/stable-point-aware-3d`            point-aware
 *
 *   Legacy v1 (still alive for some users)
 *     - `POST /v1/generation/{engine_id}/text-to-image`     SDXL, etc.
 *     - `POST /v1/generation/{engine_id}/image-to-image`
 *
 * Stability native lexicon Compose round-trips:
 *   - `output_format`: "png" | "jpeg" | "webp"
 *   - `aspect_ratio`: "16:9" | "1:1" | "21:9" | "2:3" | "3:2" | "4:5" | "5:4" | "9:16" | "9:21"
 *   - `style_preset`: 17 preset values (3d-model, anime, cinematic, …)
 *   - `cfg_scale`: 1-10 (default 7)
 *   - `seed`: 0-4294967294
 *   - `negative_prompt`: text
 *   - `mode`: "text-to-image" | "image-to-image"  (SD3 family)
 *   - `model`: "sd3.5-large" | "sd3.5-large-turbo" | "sd3.5-medium" |
 *               "sd3-large" | "sd3-medium"  (SD3 endpoint only)
 *   - `strength`: 0-1 (image-to-image weight)
 *   - `control_strength`: 0-1 (control endpoints)
 *   - `creativity`: 0-1 (upscale-creative + outpaint)
 *   - `fidelity`: 0-1 (search-and-replace, replace-background)
 *   - `grow_mask`: -100..100 (inpaint)
 *   - `select_prompt`: text (search endpoints — what to find)
 *
 * Stability error envelopes:
 *   `{ id, name, errors: [...] }` (validation, content moderation,
 *   rate limit, etc.). Vendors check the response Content-Type — a
 *   non-image body indicates an error.
 */

import { asRecord, clean } from "../shared/index.js";

// ---------------------------------------------------------------------------
// Path constants
// ---------------------------------------------------------------------------

export const STABILITY_PATH_GENERATE_SD3 = "/v2beta/stable-image/generate/sd3";
export const STABILITY_PATH_GENERATE_ULTRA = "/v2beta/stable-image/generate/ultra";
export const STABILITY_PATH_GENERATE_CORE = "/v2beta/stable-image/generate/core";

export const STABILITY_PATH_CONTROL_SKETCH = "/v2beta/stable-image/control/sketch";
export const STABILITY_PATH_CONTROL_STRUCTURE = "/v2beta/stable-image/control/structure";
export const STABILITY_PATH_CONTROL_STYLE = "/v2beta/stable-image/control/style";
export const STABILITY_PATH_CONTROL_STYLE_TRANSFER = "/v2beta/stable-image/control/style-transfer";

export const STABILITY_PATH_EDIT_ERASE = "/v2beta/stable-image/edit/erase";
export const STABILITY_PATH_EDIT_INPAINT = "/v2beta/stable-image/edit/inpaint";
export const STABILITY_PATH_EDIT_OUTPAINT = "/v2beta/stable-image/edit/outpaint";
export const STABILITY_PATH_EDIT_SEARCH_REPLACE = "/v2beta/stable-image/edit/search-and-replace";
export const STABILITY_PATH_EDIT_SEARCH_RECOLOR = "/v2beta/stable-image/edit/search-and-recolor";
export const STABILITY_PATH_EDIT_REMOVE_BACKGROUND = "/v2beta/stable-image/edit/remove-background";
export const STABILITY_PATH_EDIT_REPLACE_BACKGROUND = "/v2beta/stable-image/edit/replace-background-and-relight";

export const STABILITY_PATH_UPSCALE_CONSERVATIVE = "/v2beta/stable-image/upscale/conservative";
export const STABILITY_PATH_UPSCALE_CREATIVE = "/v2beta/stable-image/upscale/creative";
export const STABILITY_PATH_UPSCALE_FAST = "/v2beta/stable-image/upscale/fast";

export const STABILITY_PATH_IMAGE_TO_VIDEO = "/v2beta/image-to-video";

export const STABILITY_PATH_AUDIO_T2A = "/v2beta/audio/stable-audio-2/text-to-audio";
export const STABILITY_PATH_AUDIO_A2A = "/v2beta/audio/stable-audio-2/audio-to-audio";
export const STABILITY_PATH_AUDIO_INPAINT = "/v2beta/audio/stable-audio-2/inpaint";

export const STABILITY_PATH_3D_FAST = "/v2beta/3d/stable-fast-3d";
export const STABILITY_PATH_3D_POINT_AWARE = "/v2beta/3d/stable-point-aware-3d";

/** Compose the polling URL for an async upscale job. */
export function upscaleCreativeResultPath(jobId: string): string {
    return `/v2beta/stable-image/upscale/creative/result/${encodeURIComponent(jobId)}`;
}

/** Compose the polling URL for an image-to-video job. */
export function imageToVideoResultPath(jobId: string): string {
    return `/v2beta/image-to-video/result/${encodeURIComponent(jobId)}`;
}

/** Legacy v1 path for the named engine. */
export function legacyV1Path(engineId: string, op: "text-to-image" | "image-to-image"): string {
    return `/v1/generation/${encodeURIComponent(engineId)}/${op}`;
}

// ---------------------------------------------------------------------------
// Multipart entry builder — vendors call this to assemble the FormData
// ---------------------------------------------------------------------------

export interface StabilityImageRef {
    /** Field name in the multipart body — usually "image", "subject_image", etc. */
    field: string;
    /** Image bytes. */
    bytes: Buffer | Uint8Array;
    /** Filename — for content-disposition. */
    filename?: string;
    /** Optional MIME, default "image/png". */
    contentType?: string;
}

/**
 * Convert a flat record of fields plus optional images into an array
 * of `[name, value]` tuples ready to feed into a `FormData` instance.
 * Image refs are kept as Buffer/Uint8Array so the vendor adds them
 * with `form.append(name, new Blob([buf]), filename)` or equivalent.
 */
export function toMultipartEntries(
    fields: Record<string, unknown>,
    images: StabilityImageRef[] = [],
): Array<[string, string | StabilityImageRef]> {
    const out: Array<[string, string | StabilityImageRef]> = [];
    for (const [k, v] of Object.entries(fields)) {
        if (v === undefined || v === null) continue;
        if (typeof v === "boolean") out.push([k, v ? "true" : "false"]);
        else if (typeof v === "number") out.push([k, String(v)]);
        else if (typeof v === "string") out.push([k, v]);
        else out.push([k, JSON.stringify(v)]);
    }
    for (const img of images) {
        out.push([img.field, img]);
    }
    return out;
}

// ---------------------------------------------------------------------------
// Native types
// ---------------------------------------------------------------------------

export type StabilityOutputFormat = "png" | "jpeg" | "webp";

export type StabilityAspectRatio =
    | "16:9" | "1:1" | "21:9"
    | "2:3" | "3:2" | "4:5"
    | "5:4" | "9:16" | "9:21";

export type StabilityStylePreset =
    | "3d-model" | "analog-film" | "anime" | "cinematic"
    | "comic-book" | "digital-art" | "enhance" | "fantasy-art"
    | "isometric" | "line-art" | "low-poly" | "modeling-compound"
    | "neon-punk" | "origami" | "photographic"
    | "pixel-art" | "tile-texture";

export type StabilitySd3Model =
    | "sd3.5-large" | "sd3.5-large-turbo" | "sd3.5-medium"
    | "sd3-large" | "sd3-large-turbo" | "sd3-medium";

// ---------------------------------------------------------------------------
// Image generation — body builders
// ---------------------------------------------------------------------------

export interface StabilityCommonImageOptions {
    negativePrompt?: string;
    seed?: number;
    aspectRatio?: StabilityAspectRatio;
    outputFormat?: StabilityOutputFormat;
    stylePreset?: StabilityStylePreset;
}

export interface StabilitySD3Options extends StabilityCommonImageOptions {
    model?: StabilitySd3Model;
    /** Required for image-to-image mode. */
    image?: StabilityImageRef;
    /** When `image` is provided, mode is `image-to-image`; otherwise `text-to-image`. */
    mode?: "text-to-image" | "image-to-image";
    /** image-to-image only — denoising strength (0-1). */
    strength?: number;
    cfgScale?: number;
}

export function buildSD3GenerateRequest(prompt: string, options: StabilitySD3Options = {}): {
    fields: Record<string, unknown>;
    images: StabilityImageRef[];
} {
    const isI2I = !!options.image || options.mode === "image-to-image";
    return {
        fields: {
            prompt,
            ...(options.model ? { model: options.model } : {}),
            mode: isI2I ? "image-to-image" : "text-to-image",
            ...(options.negativePrompt ? { negative_prompt: options.negativePrompt } : {}),
            ...(typeof options.seed === "number" ? { seed: options.seed } : {}),
            ...(typeof options.cfgScale === "number" ? { cfg_scale: options.cfgScale } : {}),
            ...(typeof options.strength === "number" ? { strength: options.strength } : {}),
            ...(isI2I ? {} : (options.aspectRatio ? { aspect_ratio: options.aspectRatio } : {})),
            ...(options.outputFormat ? { output_format: options.outputFormat } : {}),
            ...(options.stylePreset ? { style_preset: options.stylePreset } : {}),
        },
        images: options.image ? [{ ...options.image, field: "image" }] : [],
    };
}

export interface StabilityUltraOptions extends StabilityCommonImageOptions {
    /** Optional reference image — `strength` controls influence. */
    image?: StabilityImageRef;
    strength?: number;
}

export function buildUltraGenerateRequest(prompt: string, options: StabilityUltraOptions = {}): {
    fields: Record<string, unknown>;
    images: StabilityImageRef[];
} {
    return {
        fields: {
            prompt,
            ...(options.negativePrompt ? { negative_prompt: options.negativePrompt } : {}),
            ...(typeof options.seed === "number" ? { seed: options.seed } : {}),
            ...(typeof options.strength === "number" ? { strength: options.strength } : {}),
            ...(options.aspectRatio ? { aspect_ratio: options.aspectRatio } : {}),
            ...(options.outputFormat ? { output_format: options.outputFormat } : {}),
            ...(options.stylePreset ? { style_preset: options.stylePreset } : {}),
        },
        images: options.image ? [{ ...options.image, field: "image" }] : [],
    };
}

export interface StabilityCoreOptions extends StabilityCommonImageOptions {
    cfgScale?: number;
}

export function buildCoreGenerateRequest(prompt: string, options: StabilityCoreOptions = {}): {
    fields: Record<string, unknown>;
    images: StabilityImageRef[];
} {
    return {
        fields: {
            prompt,
            ...(options.negativePrompt ? { negative_prompt: options.negativePrompt } : {}),
            ...(typeof options.seed === "number" ? { seed: options.seed } : {}),
            ...(typeof options.cfgScale === "number" ? { cfg_scale: options.cfgScale } : {}),
            ...(options.aspectRatio ? { aspect_ratio: options.aspectRatio } : {}),
            ...(options.outputFormat ? { output_format: options.outputFormat } : {}),
            ...(options.stylePreset ? { style_preset: options.stylePreset } : {}),
        },
        images: [],
    };
}

// ---------------------------------------------------------------------------
// Image edit / control
// ---------------------------------------------------------------------------

export interface StabilityEditOptions extends StabilityCommonImageOptions {
    /** Required base image to edit. */
    image: StabilityImageRef;
    /** Inpaint / erase only. */
    mask?: StabilityImageRef;
    /** outpaint / search-and-replace / search-and-recolor. */
    prompt?: string;
    /** search endpoints — what to find. */
    selectPrompt?: string;
    /** outpaint expansion in pixels. */
    left?: number;
    right?: number;
    up?: number;
    down?: number;
    /** outpaint creativity. */
    creativity?: number;
    /** search-replace fidelity. */
    fidelity?: number;
    /** inpaint mask grow. */
    growMask?: number;
    /** replace-background-and-relight only. */
    backgroundReference?: StabilityImageRef;
    backgroundPrompt?: string;
    foregroundPrompt?: string;
    lightSource?: string;
    lightSourceStrength?: number;
}

export function buildEditRequest(operation: "erase" | "inpaint" | "outpaint" | "search-and-replace" | "search-and-recolor" | "remove-background" | "replace-background-and-relight", options: StabilityEditOptions): {
    fields: Record<string, unknown>;
    images: StabilityImageRef[];
} {
    const fields: Record<string, unknown> = {
        ...(options.prompt ? { prompt: options.prompt } : {}),
        ...(options.selectPrompt ? { select_prompt: options.selectPrompt } : {}),
        ...(options.negativePrompt ? { negative_prompt: options.negativePrompt } : {}),
        ...(typeof options.seed === "number" ? { seed: options.seed } : {}),
        ...(options.outputFormat ? { output_format: options.outputFormat } : {}),
    };
    if (operation === "outpaint") {
        if (typeof options.left === "number") fields.left = options.left;
        if (typeof options.right === "number") fields.right = options.right;
        if (typeof options.up === "number") fields.up = options.up;
        if (typeof options.down === "number") fields.down = options.down;
        if (typeof options.creativity === "number") fields.creativity = options.creativity;
    }
    if (operation === "search-and-replace" || operation === "search-and-recolor") {
        if (typeof options.fidelity === "number") fields.fidelity = options.fidelity;
    }
    if (operation === "inpaint") {
        if (typeof options.growMask === "number") fields.grow_mask = options.growMask;
    }
    if (operation === "replace-background-and-relight") {
        if (options.backgroundPrompt) fields.background_prompt = options.backgroundPrompt;
        if (options.foregroundPrompt) fields.foreground_prompt = options.foregroundPrompt;
        if (options.lightSource) fields.light_source_direction = options.lightSource;
        if (typeof options.lightSourceStrength === "number") fields.light_source_strength = options.lightSourceStrength;
    }

    const images: StabilityImageRef[] = [{ ...options.image, field: "image" }];
    if (options.mask) images.push({ ...options.mask, field: "mask" });
    if (options.backgroundReference) {
        images.push({ ...options.backgroundReference, field: "background_reference" });
    }
    return { fields, images };
}

export interface StabilityControlOptions extends StabilityCommonImageOptions {
    image: StabilityImageRef;
    prompt: string;
    controlStrength?: number;
}

export function buildControlRequest(options: StabilityControlOptions): {
    fields: Record<string, unknown>;
    images: StabilityImageRef[];
} {
    return {
        fields: {
            prompt: options.prompt,
            ...(options.negativePrompt ? { negative_prompt: options.negativePrompt } : {}),
            ...(typeof options.controlStrength === "number" ? { control_strength: options.controlStrength } : {}),
            ...(typeof options.seed === "number" ? { seed: options.seed } : {}),
            ...(options.outputFormat ? { output_format: options.outputFormat } : {}),
            ...(options.stylePreset ? { style_preset: options.stylePreset } : {}),
        },
        images: [{ ...options.image, field: "image" }],
    };
}

// ---------------------------------------------------------------------------
// Upscale
// ---------------------------------------------------------------------------

export interface StabilityUpscaleOptions {
    image: StabilityImageRef;
    prompt?: string;
    negativePrompt?: string;
    seed?: number;
    creativity?: number;
    outputFormat?: StabilityOutputFormat;
}

export function buildUpscaleRequest(options: StabilityUpscaleOptions): {
    fields: Record<string, unknown>;
    images: StabilityImageRef[];
} {
    return {
        fields: {
            ...(options.prompt ? { prompt: options.prompt } : {}),
            ...(options.negativePrompt ? { negative_prompt: options.negativePrompt } : {}),
            ...(typeof options.seed === "number" ? { seed: options.seed } : {}),
            ...(typeof options.creativity === "number" ? { creativity: options.creativity } : {}),
            ...(options.outputFormat ? { output_format: options.outputFormat } : {}),
        },
        images: [{ ...options.image, field: "image" }],
    };
}

// ---------------------------------------------------------------------------
// Image-to-Video — async submit + poll
// ---------------------------------------------------------------------------

export interface StabilityImageToVideoOptions {
    image: StabilityImageRef;
    seed?: number;
    cfgScale?: number;
    motionBucketId?: number;
}

export function buildImageToVideoRequest(options: StabilityImageToVideoOptions): {
    fields: Record<string, unknown>;
    images: StabilityImageRef[];
} {
    return {
        fields: {
            ...(typeof options.seed === "number" ? { seed: options.seed } : {}),
            ...(typeof options.cfgScale === "number" ? { cfg_scale: options.cfgScale } : {}),
            ...(typeof options.motionBucketId === "number" ? { motion_bucket_id: options.motionBucketId } : {}),
        },
        images: [{ ...options.image, field: "image" }],
    };
}

export interface StabilityJobHandle {
    id: string;
    raw: unknown;
}

export function parseJobSubmitResponse(raw: unknown): StabilityJobHandle {
    const root = asRecord(raw) || {};
    const id = clean(root.id);
    if (!id) throw new Error("Stability submit returned no job id");
    return { id, raw };
}

export type StabilityJobStatus = "in-progress" | "complete" | "errored";

export interface StabilityJobResult {
    status: StabilityJobStatus;
    /** When `status === "complete"` and the response Content-Type was `image/*`. */
    image?: { bytes: Buffer; contentType: string };
    /** When `status === "complete"` and the response Content-Type was `video/mp4`. */
    video?: { bytes: Buffer; contentType: string };
    /** Caller can also receive a JSON envelope (status only) before the bytes are ready. */
    finishReason?: string;
    seed?: number;
    raw: unknown;
}

/** Inspect a successful poll response. */
export function parseJobJsonResult(raw: unknown): StabilityJobResult {
    const root = asRecord(raw) || {};
    const status = clean(root.status);
    return {
        status: ((status === "in-progress" || status === "complete" || status === "errored") ? status : "in-progress") as StabilityJobStatus,
        ...(typeof root.finish_reason === "string" ? { finishReason: root.finish_reason } : {}),
        ...(typeof root.seed === "number" ? { seed: root.seed } : {}),
        raw,
    };
}

// ---------------------------------------------------------------------------
// Audio (Stable Audio 2.0)
// ---------------------------------------------------------------------------

export interface StabilityAudioOptions {
    prompt: string;
    negativePrompt?: string;
    seed?: number;
    durationSeconds?: number;       // 1-190 typical
    steps?: number;
    cfgScale?: number;
    outputFormat?: "mp3" | "wav";
    /** audio-to-audio only. */
    audio?: StabilityImageRef;       // reuse image ref shape
    strength?: number;
}

export function buildAudioRequest(operation: "text-to-audio" | "audio-to-audio" | "inpaint", options: StabilityAudioOptions): {
    fields: Record<string, unknown>;
    images: StabilityImageRef[];
} {
    return {
        fields: {
            prompt: options.prompt,
            ...(options.negativePrompt ? { negative_prompt: options.negativePrompt } : {}),
            ...(typeof options.seed === "number" ? { seed: options.seed } : {}),
            ...(typeof options.durationSeconds === "number" ? { duration: options.durationSeconds } : {}),
            ...(typeof options.steps === "number" ? { steps: options.steps } : {}),
            ...(typeof options.cfgScale === "number" ? { cfg_scale: options.cfgScale } : {}),
            ...(typeof options.strength === "number" ? { strength: options.strength } : {}),
            ...(options.outputFormat ? { output_format: options.outputFormat } : {}),
        },
        images: options.audio && operation !== "text-to-audio" ? [{ ...options.audio, field: "audio" }] : [],
    };
}

// ---------------------------------------------------------------------------
// 3D
// ---------------------------------------------------------------------------

export interface StabilityFast3DOptions {
    image: StabilityImageRef;
    textureResolution?: 1024 | 2048;
    foregroundRatio?: number;
    remesh?: "none" | "quad" | "triangle";
}

export function buildFast3DRequest(options: StabilityFast3DOptions): {
    fields: Record<string, unknown>;
    images: StabilityImageRef[];
} {
    return {
        fields: {
            ...(typeof options.textureResolution === "number" ? { texture_resolution: options.textureResolution } : {}),
            ...(typeof options.foregroundRatio === "number" ? { foreground_ratio: options.foregroundRatio } : {}),
            ...(options.remesh ? { remesh: options.remesh } : {}),
        },
        images: [{ ...options.image, field: "image" }],
    };
}

// ---------------------------------------------------------------------------
// Error shape
// ---------------------------------------------------------------------------

export interface StabilityErrorEnvelope {
    id: string;
    name: string;
    errors: string[];
}

export function parseErrorEnvelope(raw: unknown): StabilityErrorEnvelope | null {
    const root = asRecord(raw);
    if (!root) return null;
    const errs = Array.isArray(root.errors) ? root.errors.map(clean).filter(Boolean) : [];
    if (errs.length === 0 && !root.name) return null;
    return {
        id: clean(root.id),
        name: clean(root.name),
        errors: errs,
    };
}
