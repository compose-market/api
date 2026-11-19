/**
 * Roboflow serverless vision family bridge.
 *
 * Uses route metadata emitted by `sync-roboflow.ts`. The transport is
 * Roboflow Serverless Hosted API v2; billing evidence is taken from
 * Roboflow's processing-time response headers / body timing fields.
 */

import { getModelById } from "../registry.js";

const ROBOFLOW_API_KEY = process.env.ROBOFLOW_API_KEY;
const ROBOFLOW_DEFAULT_PROJECT = process.env.ROBOFLOW_DEFAULT_PROJECT;
const ROBOFLOW_DEFAULT_VERSION = process.env.ROBOFLOW_DEFAULT_VERSION;
const ROBOFLOW_BASE_URL = "https://serverless.roboflow.com";
const ROBOFLOW_LEGACY_BASE_URL = "https://detect.roboflow.com";

if (!ROBOFLOW_API_KEY) {
    console.warn("[roboflow] ROBOFLOW_API_KEY not set — Roboflow vision disabled");
}

type RoboflowBodyStyle = "json" | "legacy-form";

export interface RoboflowRouteMetadata {
    kind: string;
    path: string;
    baseUrl?: string;
    method?: "POST" | "GET";
    bodyStyle?: RoboflowBodyStyle;
    modelIdValue?: string;
    targetModelId?: string;
    requestFields?: string[];
    requiredFields?: string[];
}

export interface RoboflowAnalyzeResult {
    text: string;
    raw: Record<string, unknown>;
    billingMetrics: Record<string, unknown>;
    billableSeconds: number;
}

export interface RoboflowEmbeddingResult {
    embeddings: number[][];
    raw: Record<string, unknown>;
    billingMetrics: Record<string, unknown>;
    billableSeconds: number;
}

function requireRoboflowApiKey(): string {
    if (!ROBOFLOW_API_KEY) {
        throw new Error("ROBOFLOW_API_KEY not configured");
    }
    return ROBOFLOW_API_KEY;
}

function clean(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
}

function asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === "object" && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

function stripProviderPrefix(modelId: string): string {
    return modelId.replace(/^roboflow\//, "").replace(/^\/+|\/+$/g, "");
}

function resolveDefaultTarget(): RoboflowRouteMetadata {
    if (!ROBOFLOW_DEFAULT_PROJECT || !ROBOFLOW_DEFAULT_VERSION) {
        throw new Error("ROBOFLOW_DEFAULT_PROJECT and ROBOFLOW_DEFAULT_VERSION are required");
    }
    return {
        kind: "legacy-model-inference",
        path: `/${encodeURIComponent(ROBOFLOW_DEFAULT_PROJECT)}/${encodeURIComponent(ROBOFLOW_DEFAULT_VERSION)}`,
        baseUrl: ROBOFLOW_LEGACY_BASE_URL,
        method: "POST",
        bodyStyle: "legacy-form",
    };
}

function routeFromCompiledCatalog(modelId: string): RoboflowRouteMetadata | null {
    const card = getModelById(modelId, "roboflow");
    const metadata = asRecord(card?.sourceMetadata);
    const roboflow = asRecord(metadata?.roboflow);
    const route = asRecord(roboflow?.route);
    const path = clean(route?.path);
    const kind = clean(route?.kind);
    if (!path || !kind) {
        return null;
    }
    return {
        kind,
        path,
        method: clean(route?.method).toUpperCase() === "GET" ? "GET" : "POST",
        bodyStyle: clean(route?.bodyStyle) === "json" ? "json" : "legacy-form",
        ...(clean(route?.modelIdValue) ? { modelIdValue: clean(route?.modelIdValue) } : {}),
        ...(clean(route?.targetModelId) ? { targetModelId: clean(route?.targetModelId) } : {}),
        requestFields: Array.isArray(route?.requestFields) ? route.requestFields.map(clean).filter(Boolean) : undefined,
        requiredFields: Array.isArray(route?.requiredFields) ? route.requiredFields.map(clean).filter(Boolean) : undefined,
    };
}

function resolveRoboflowRoute(modelId: string): RoboflowRouteMetadata {
    const compiled = routeFromCompiledCatalog(modelId);
    if (compiled) return compiled;

    const withoutPrefix = stripProviderPrefix(modelId);
    if (withoutPrefix === "default" || withoutPrefix === "detect" || withoutPrefix === "latest") {
        return resolveDefaultTarget();
    }

    if (!withoutPrefix) {
        return resolveDefaultTarget();
    }

    return {
        kind: "legacy-model-inference",
        path: `/${withoutPrefix}`,
        baseUrl: ROBOFLOW_LEGACY_BASE_URL,
        method: "POST",
        bodyStyle: "legacy-form",
    };
}

function target(route: RoboflowRouteMetadata, params: Record<string, unknown>): string {
    return clean(params.model_id) || clean(route.modelIdValue) || clean(route.targetModelId);
}

function roboflowUrl(route: RoboflowRouteMetadata, params: Record<string, unknown> = {}): string {
    const baseUrl = route.baseUrl || ROBOFLOW_BASE_URL;
    const modelId = target(route, params);
    if (route.path.includes("{model_id}") && !modelId) {
        throw Object.assign(new Error("Roboflow route requires custom_params.model_id"), { statusCode: 400 });
    }
    const path = route.path.replace("{model_id}", encodeURIComponent(modelId));
    const url = new URL(`${baseUrl}${path.startsWith("/") ? path : `/${path}`}`);
    url.searchParams.set("api_key", requireRoboflowApiKey());
    return url.toString();
}

function requestId(): string {
    return `rf_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function imagePayload(imageBuffer: Buffer): { type: "base64"; value: string } {
    return { type: "base64", value: imageBuffer.toString("base64") };
}

function defaultPrompt(prompt?: string): string {
    return clean(prompt) || "Describe the image.";
}

function textList(value: unknown, fallback: string): string[] {
    if (Array.isArray(value)) {
        return value.map(clean).filter(Boolean);
    }
    const text = clean(value) || fallback;
    return text ? [text] : [];
}

function customParams(params?: Record<string, unknown>): Record<string, unknown> {
    return params && typeof params === "object" && !Array.isArray(params) ? params : {};
}

export function buildRoboflowJsonBody(args: {
    route: RoboflowRouteMetadata;
    modelId: string;
    imageBuffer: Buffer;
    prompt?: string;
    customParams?: Record<string, unknown>;
}): Record<string, unknown> {
    const route = args.route;
    const params = customParams(args.customParams);
    const image = imagePayload(args.imageBuffer);
    const id = requestId();
    const body: Record<string, unknown> = {
        id,
        image,
        ...params,
    };

    switch (route.kind) {
        case "vision-language":
            {
                const modelId = target(route, params);
                if (!modelId && route.requiredFields?.includes("model_id")) {
                    throw Object.assign(new Error("Roboflow vision-language routes require custom_params.model_id"), { statusCode: 400 });
                }
                if (modelId) body.model_id = modelId;
            }
            body.prompt = defaultPrompt(args.prompt);
            break;
        case "ocr":
            break;
        case "gaze-detection":
            break;
        case "clip-image-embedding":
            break;
        case "clip-text-embedding":
            delete body.image;
            body.text = params.text ?? defaultPrompt(args.prompt);
            break;
        case "clip-compare":
            delete body.image;
            body.subject = image;
            body.subject_type = params.subject_type ?? "image";
            body.prompt = params.prompt ?? [defaultPrompt(args.prompt)];
            body.prompt_type = params.prompt_type ?? "text";
            break;
        case "open-vocabulary-detection":
            body.text = params.text ?? defaultPrompt(args.prompt);
            break;
        case "visual-grounding":
            body.text = textList(params.text, defaultPrompt(args.prompt));
            break;
        case "one-shot-detection":
            if (params.training_data === undefined) {
                body.training_data = [];
            }
            break;
        case "promptable-segmentation":
            if (params.prompts === undefined && clean(args.prompt)) {
                body.prompts = [{ type: "text", text: clean(args.prompt) }];
            }
            break;
        case "segmentation-embedding":
            break;
        default:
            if (route.modelIdValue) {
                body.model_id = route.modelIdValue;
            }
            if (clean(args.prompt) && body.prompt === undefined && route.requestFields?.includes("prompt")) {
                body.prompt = clean(args.prompt);
            }
            if (clean(args.prompt) && body.text === undefined && route.requestFields?.includes("text")) {
                body.text = clean(args.prompt);
            }
            break;
    }

    return body;
}

function buildLegacyBody(imageBuffer: Buffer): string {
    return imageBuffer.toString("base64");
}

function parsePositiveSeconds(value: string | null): number | undefined {
    if (!value) return undefined;
    const trimmed = value.trim().toLowerCase();
    const numeric = Number.parseFloat(trimmed);
    if (!Number.isFinite(numeric) || numeric <= 0) return undefined;
    return trimmed.includes("ms") ? numeric / 1000 : numeric;
}

function readNestedNumber(value: unknown, keys: Set<string>, depth = 0): number | undefined {
    if (depth > 5 || value == null) return undefined;
    if (Array.isArray(value)) {
        for (const entry of value) {
            const found = readNestedNumber(entry, keys, depth + 1);
            if (found !== undefined) return found;
        }
        return undefined;
    }
    if (!asRecord(value)) return undefined;
    for (const [key, child] of Object.entries(value)) {
        const normalized = key.toLowerCase().replace(/[_-]/g, "");
        if (keys.has(normalized) && typeof child === "number" && Number.isFinite(child) && child > 0) {
            return child;
        }
        const found = readNestedNumber(child, keys, depth + 1);
        if (found !== undefined) return found;
    }
    return undefined;
}

function billableSeconds(response: Response, raw: unknown): number {
    const headerSeconds =
        parsePositiveSeconds(response.headers.get("x-processing-time"))
        ?? parsePositiveSeconds(response.headers.get("x-remote-processing-time"));
    const bodySeconds = readNestedNumber(raw, new Set(["time", "processingtime", "duration", "seconds"]));
    const seconds = headerSeconds ?? bodySeconds ?? 0.1;
    return Math.max(seconds, 0.1);
}

async function parseJsonResponse(response: Response): Promise<Record<string, unknown>> {
    const text = await response.text();
    if (!text.trim()) return {};
    try {
        const parsed = JSON.parse(text) as unknown;
        return asRecord(parsed) ?? { value: parsed };
    } catch {
        return { text };
    }
}

function predictionLabel(prediction: Record<string, unknown>, index: number): string {
    return clean(prediction.class)
        || clean(prediction.label)
        || clean(prediction.class_name)
        || clean(prediction.name)
        || `prediction_${index + 1}`;
}

function summarizePredictions(predictions: unknown[], prompt?: string): string {
    if (predictions.length === 0) {
        return prompt
            ? `Roboflow found no detections relevant to: ${prompt}.`
            : "Roboflow found no detections in the supplied image.";
    }

    const lines = predictions.slice(0, 12).map((entry, index) => {
        const prediction = asRecord(entry) || {};
        const label = predictionLabel(prediction, index);
        const confidence = typeof prediction.confidence === "number"
            ? `${(prediction.confidence * 100).toFixed(1)}%`
            : typeof prediction.score === "number"
                ? `${(prediction.score * 100).toFixed(1)}%`
                : "unknown confidence";
        const x = typeof prediction.x === "number" ? prediction.x.toFixed(0) : "?";
        const y = typeof prediction.y === "number" ? prediction.y.toFixed(0) : "?";
        const width = typeof prediction.width === "number" ? prediction.width.toFixed(0) : "?";
        const height = typeof prediction.height === "number" ? prediction.height.toFixed(0) : "?";
        if (prediction.x !== undefined || prediction.y !== undefined || prediction.width !== undefined || prediction.height !== undefined) {
            return `${label} at (${x}, ${y}) size ${width}x${height} confidence ${confidence}`;
        }
        return `${label} confidence ${confidence}`;
    });

    const preface = prompt
        ? `Roboflow detections for "${prompt}":`
        : "Roboflow detections:";

    return [preface, ...lines].join("\n");
}

function collectTextFields(value: unknown, depth = 0): string[] {
    if (depth > 4 || value == null) return [];
    if (typeof value === "string") return value.trim() ? [value.trim()] : [];
    if (Array.isArray(value)) return value.flatMap((entry) => collectTextFields(entry, depth + 1));
    const record = asRecord(value);
    if (!record) return [];
    const direct = ["text", "value", "response", "answer", "caption", "ocr_text", "recognized_text"]
        .map((key) => record[key])
        .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
    if (direct.length > 0) return direct;
    return Object.values(record).flatMap((entry) => collectTextFields(entry, depth + 1));
}

function isNumberVector(value: unknown): value is number[] {
    return Array.isArray(value) && value.every((entry) => typeof entry === "number" && Number.isFinite(entry));
}

function collectEmbeddingVectors(value: unknown, depth = 0): number[][] {
    if (depth > 6 || value == null) return [];
    if (isNumberVector(value)) return [value];
    if (Array.isArray(value)) return value.flatMap((entry) => collectEmbeddingVectors(entry, depth + 1));
    const record = asRecord(value);
    if (!record) return [];
    const direct = record.embedding ?? record.embeddings ?? record.vector ?? record.vectors;
    const directVectors = collectEmbeddingVectors(direct, depth + 1);
    if (directVectors.length > 0) return directVectors;
    return Object.values(record).flatMap((entry) => collectEmbeddingVectors(entry, depth + 1));
}

function parseEmbeddings(raw: Record<string, unknown>): number[][] {
    const embeddings = collectEmbeddingVectors(raw);
    if (embeddings.length === 0) {
        throw new Error("Roboflow embedding response contained no vectors");
    }
    return embeddings;
}


export function summarizeRoboflowResponse(raw: Record<string, unknown>, prompt?: string): string {
    const predictions = Array.isArray(raw.predictions)
        ? raw.predictions
        : Array.isArray(raw.prompt_results)
            ? raw.prompt_results.flatMap((entry) => Array.isArray(asRecord(entry)?.predictions) ? asRecord(entry)?.predictions as unknown[] : [])
            : [];
    if (predictions.length > 0) {
        return summarizePredictions(predictions, prompt);
    }

    if (Array.isArray(raw.embeddings)) {
        return `Roboflow returned ${raw.embeddings.length} embedding${raw.embeddings.length === 1 ? "" : "s"}.`;
    }

    const texts = collectTextFields(raw).slice(0, 12);
    if (texts.length > 0) {
        return texts.join("\n");
    }

    const keys = Object.keys(raw);
    if (keys.length > 0) {
        return `Roboflow returned JSON fields: ${keys.slice(0, 12).join(", ")}.`;
    }

    return "Roboflow returned an empty response.";
}

export async function generateRoboflowEmbeddings(args: {
    modelId: string;
    text?: string;
    imageBuffer?: Buffer;
    customParams?: Record<string, unknown>;
}): Promise<RoboflowEmbeddingResult> {
    const route = resolveRoboflowRoute(args.modelId);
    if (route.bodyStyle !== "json") {
        throw new Error("Roboflow embeddings require a JSON route");
    }

    const params = customParams(args.customParams);
    const body: Record<string, unknown> = {
        id: requestId(),
        ...params,
    };

    switch (route.kind) {
        case "clip-image-embedding":
        case "segmentation-embedding":
            if (!args.imageBuffer) {
                throw new Error("Roboflow image embeddings require an image input");
            }
            body.image = imagePayload(args.imageBuffer);
            break;
        case "clip-text-embedding":
            body.text = params.text ?? defaultPrompt(args.text);
            break;
        default:
            throw new Error(`Roboflow embedding route is not supported: ${route.kind}`);
    }

    if (route.modelIdValue) {
        body.model_id = route.modelIdValue;
    }

    const response = await fetch(roboflowUrl(route, body), {
        method: route.method || "POST",
        headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
        },
        body: JSON.stringify(body),
    });
    const payload = await parseJsonResponse(response);
    if (!response.ok) {
        throw new Error(`Roboflow embedding failed: ${response.status} ${JSON.stringify(payload).slice(0, 700)}`);
    }

    const seconds = billableSeconds(response, payload);
    return {
        embeddings: parseEmbeddings(payload),
        raw: payload,
        billableSeconds: seconds,
        billingMetrics: {
            second: seconds,
            duration: seconds,
            request: 1,
        },
    };
}

export async function analyzeRoboflowImage(args: {
    modelId: string;
    imageBuffer: Buffer;
    prompt?: string;
    customParams?: Record<string, unknown>;
}): Promise<RoboflowAnalyzeResult> {
    const route = resolveRoboflowRoute(args.modelId);
    const body = route.bodyStyle === "json"
        ? buildRoboflowJsonBody({
            route,
            modelId: args.modelId,
            imageBuffer: args.imageBuffer,
            prompt: args.prompt,
            customParams: args.customParams,
        })
        : {};
    const url = roboflowUrl(route, body);
    const response = await fetch(url, route.bodyStyle === "json"
        ? {
            method: route.method || "POST",
            headers: {
                "Content-Type": "application/json",
                Accept: "application/json",
            },
            body: JSON.stringify(body),
        }
        : {
            method: route.method || "POST",
            headers: {
                "Content-Type": "application/x-www-form-urlencoded",
                Accept: "application/json",
            },
            body: buildLegacyBody(args.imageBuffer),
        });

    const payload = await parseJsonResponse(response);
    if (!response.ok) {
        throw new Error(`Roboflow inference failed: ${response.status} ${JSON.stringify(payload).slice(0, 700)}`);
    }

    const seconds = billableSeconds(response, payload);
    return {
        text: summarizeRoboflowResponse(payload, args.prompt),
        raw: payload,
        billableSeconds: seconds,
        billingMetrics: {
            second: seconds,
            duration: seconds,
            request: 1,
        },
    };
}
