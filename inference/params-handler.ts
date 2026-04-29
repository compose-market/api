/**
 * Model Parameters Handler
 * 
 * Fetches model-specific optional parameters from video.json and image.json.
 * Used by the Playground UI to render dynamic parameter controls.
 */

import type { Request, Response } from "express";
import * as fs from "fs";
import * as path from "path";

// Parameter schema types
export interface ParamDefinition {
    type: "string" | "integer" | "number" | "boolean" | "array";
    required: boolean;
    default?: string | number | boolean;
    options?: (string | number)[];
    description?: string;
}

export interface ModelParams {
    modelId: string;
    provider: string;
    params: Record<string, ParamDefinition>;
}

export interface ResolvedModelParams {
    modelId: string;
    type: "video" | "image";
    provider: string;
    params: Record<string, ParamDefinition>;
    defaults: Record<string, unknown>;
}

// Cache for loaded param files
let videoParamsCache: Record<string, ModelParams> | null = null;
let videoParamAliasesCache: Record<string, string | Record<string, string>> | null = null;
let imageParamsCache: Record<string, ModelParams> | null = null;
let dataBasePath: string | null = null;

/**
 * Get base path for data files (same logic as registry.ts)
 * Note: CJS bundle means __dirname and import.meta.url won't reliably work
 * We use Api-specific paths and process.cwd() instead
 */
function getDataBasePath(): string {
    // Return cached path if already found
    if (dataBasePath !== null) return dataBasePath;

    const candidatePaths: string[] = [
        "/var/task/dist/data",
        "/var/task/data",
        path.join(process.cwd(), "inference", "data", "params"),
        path.join(process.cwd(), "dist", "data"),
        path.join(process.cwd(), "data", "params"),
    ];

    // Try each candidate path
    for (const p of candidatePaths) {
        try {
            // Check for either video.json or image.json
            if (fs.existsSync(path.join(p, "video.json")) || fs.existsSync(path.join(p, "image.json"))) {
                console.log(`[paramsHandler] Found params data at: ${p}`);
                dataBasePath = p;
                return p;
            }
        } catch {
            // Skip paths that can't be accessed
        }
    }

    console.error("[paramsHandler] ❌ Could not locate params JSON files!");
    console.error(`[paramsHandler] process.cwd(): ${process.cwd()}`);
    console.error(`[paramsHandler] Checked paths:`, candidatePaths);

    // List what's in dist/data for debugging
    try {
        const distDataPath = path.join(process.cwd(), "dist", "data");
        if (fs.existsSync(distDataPath)) {
            const contents = fs.readdirSync(distDataPath);
            console.error(`[paramsHandler] Contents of dist/data:`, contents);
        }
    } catch (e) {
        console.error("[paramsHandler] Could not list dist/data:", e);
    }

    // Return best guess
    dataBasePath = path.join(process.cwd(), "inference", "data", "params");
    return dataBasePath;
}

/**
 * Load and cache video.json
 */
function getVideoParams(): Record<string, ModelParams> {
    if (videoParamsCache !== null) return videoParamsCache;

    try {
        const basePath = getDataBasePath();
        const filePath = path.join(basePath, "video.json");

        if (!fs.existsSync(filePath)) {
            console.warn(`[paramsHandler] video.json not found at ${filePath}`);
            return {};
        }

        const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
        const params: Record<string, ModelParams> = data.parameters || {};
        videoParamAliasesCache = data.aliases || {};
        videoParamsCache = params;
        console.log(`[paramsHandler] Loaded ${Object.keys(params).length} video model params`);
        return params;
    } catch (err) {
        console.error("[paramsHandler] Failed to load video.json:", err);
        return {};
    }
}

function getVideoParamAliases(): Record<string, string | Record<string, string>> {
    if (videoParamAliasesCache !== null) return videoParamAliasesCache;
    getVideoParams();
    return videoParamAliasesCache || {};
}

/**
 * Load and cache image.json
 */
function getImageParams(): Record<string, ModelParams> {
    if (imageParamsCache !== null) return imageParamsCache;

    try {
        const basePath = getDataBasePath();
        const filePath = path.join(basePath, "image.json");

        if (!fs.existsSync(filePath)) {
            console.warn(`[paramsHandler] image.json not found at ${filePath}`);
            return {};
        }

        const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
        const params: Record<string, ModelParams> = data.parameters || {};
        imageParamsCache = params;
        console.log(`[paramsHandler] Loaded ${Object.keys(params).length} image model params`);
        return params;
    } catch (err) {
        console.error("[paramsHandler] Failed to load image.json:", err);
        return {};
    }
}

/**
 * Find matching model params with flexible matching
 * Tries: exact match, suffix match (e.g., flux/schnell matches fal-ai/flux/schnell),
 * and normalized matching (case-insensitive, strip dots)
 */
function findMatchingParams(
    modelId: string,
    paramsMap: Record<string, ModelParams>
): { key: string; params: ModelParams } | null {
    // Skip comment keys
    if (modelId.startsWith("_comment")) return null;

    // 1. Try exact match first
    if (paramsMap[modelId]) {
        return { key: modelId, params: paramsMap[modelId] };
    }

    // 2. Try suffix match - if modelId is "flux/schnell", match "fal-ai/flux/schnell"
    for (const key of Object.keys(paramsMap)) {
        if (key.startsWith("_comment")) continue;
        if (key.endsWith(`/${modelId}`) || key.endsWith(`/${modelId.toLowerCase()}`)) {
            return { key, params: paramsMap[key] };
        }
    }

    // 3. Try normalized matching (case-insensitive, strip dots and dashes)
    const normalize = (s: string) => s.toLowerCase().replace(/[.\-]/g, "");
    const normalizedModelId = normalize(modelId);

    for (const key of Object.keys(paramsMap)) {
        if (key.startsWith("_comment")) continue;
        if (normalize(key) === normalizedModelId) {
            return { key, params: paramsMap[key] };
        }
        // Also check if the model name portion matches
        const keyParts = key.split("/");
        const modelParts = modelId.split("/");
        if (keyParts.length > 0 && modelParts.length > 0) {
            // Match last part (model name)
            if (normalize(keyParts[keyParts.length - 1]) === normalize(modelParts[modelParts.length - 1])) {
                return { key, params: paramsMap[key] };
            }
        }
    }

    return null;
}

function filterOptionalParams(params: Record<string, ParamDefinition>): Record<string, ParamDefinition> {
    return Object.fromEntries(
        Object.entries(params).filter(([, definition]) => definition.required !== true),
    );
}

export function rankOptionValue(value: string | number): number | null {
    if (typeof value === "number" && Number.isFinite(value)) {
        return value;
    }

    if (typeof value !== "string") {
        return null;
    }

    const trimmed = value.trim().toLowerCase();
    const ordinalRank = (() => {
        switch (trimmed) {
            case "low":
            case "standard":
                return 1;
            case "medium":
                return 2;
            case "high":
            case "hd":
                return 3;
            default:
                return null;
        }
    })();
    if (ordinalRank !== null) {
        return ordinalRank;
    }

    const numeric = Number(trimmed);
    if (Number.isFinite(numeric)) {
        return numeric;
    }

    const dimensions = trimmed.match(/^(\d+)\s*x\s*(\d+)$/);
    if (dimensions) {
        const width = Number.parseInt(dimensions[1], 10);
        const height = Number.parseInt(dimensions[2], 10);
        if (Number.isFinite(width) && Number.isFinite(height)) {
            return width * height;
        }
    }

    const resolution = trimmed.match(/^(\d+)\s*p$/);
    if (resolution) {
        return Number.parseInt(resolution[1], 10);
    }

    const duration = trimmed.match(/^(\d+(?:\.\d+)?)\s*s$/);
    if (duration) {
        return Number.parseFloat(duration[1]);
    }

    return null;
}

function getLowestOptionValue(definition: ParamDefinition): unknown {
    if (!Array.isArray(definition.options) || definition.options.length === 0) {
        return undefined;
    }

    const ranked = definition.options
        .map((option, index) => ({
            option,
            index,
            rank: rankOptionValue(option),
        }));

    const comparable = ranked.filter((entry) => entry.rank !== null) as Array<{
        option: string | number;
        index: number;
        rank: number;
    }>;
    if (comparable.length === definition.options.length) {
        comparable.sort((a, b) => (a.rank - b.rank) || (a.index - b.index));
        return comparable[0].option;
    }

    return definition.options[0];
}

function getParamDefaultValue(definition: ParamDefinition): unknown {
    const lowestOption = getLowestOptionValue(definition);
    if (lowestOption !== undefined) {
        return lowestOption;
    }

    if (Object.prototype.hasOwnProperty.call(definition, "default")) {
        return definition.default;
    }

    return undefined;
}

export function buildModelParamDefaults(params: Record<string, ParamDefinition>): Record<string, unknown> {
    const defaults: Record<string, unknown> = {};

    for (const [key, definition] of Object.entries(params)) {
        const value = getParamDefaultValue(definition);
        if (value !== undefined) {
            defaults[key] = value;
        }
    }

    return defaults;
}

function asRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return null;
    }

    return value as Record<string, unknown>;
}

function requestBodyHasImageInput(requestBody?: Record<string, unknown>): boolean {
    if (!requestBody) {
        return false;
    }

    if (typeof requestBody.image_url === "string" || typeof requestBody.image === "string") {
        return true;
    }

    const attachmentCandidates = [
        requestBody.attachment,
        ...(Array.isArray(requestBody.attachments) ? requestBody.attachments : []),
    ];
    if (attachmentCandidates.some((attachment) => {
        const record = asRecord(attachment);
        if (!record) {
            return false;
        }
        const type = typeof record.type === "string" ? record.type.toLowerCase() : "";
        const mimeType = typeof record.mimeType === "string"
            ? record.mimeType.toLowerCase()
            : typeof record.mime_type === "string"
                ? record.mime_type.toLowerCase()
                : typeof record.contentType === "string"
                    ? record.contentType.toLowerCase()
                    : typeof record.content_type === "string"
                        ? record.content_type.toLowerCase()
                        : "";
        return type.includes("image")
            || mimeType.startsWith("image/")
            || typeof record.image_url === "string";
    })) {
        return true;
    }

    const customParams = asRecord(requestBody.custom_params);
    if (typeof customParams?.image_url === "string" || typeof customParams?.image === "string") {
        return true;
    }

    const input = requestBody.input;
    const inputs = Array.isArray(input) ? input : [];
    for (const item of inputs) {
        const record = asRecord(item);
        if (!record) {
            continue;
        }
        if (record.type === "input_image" && typeof record.image_url === "string") {
            return true;
        }
        const content = Array.isArray(record.content) ? record.content : [];
        if (content.some((part) => {
            const contentPart = asRecord(part);
            return contentPart?.type === "image_url" || contentPart?.type === "input_image";
        })) {
            return true;
        }
    }

    return false;
}

function resolveVideoParamAlias(
    modelId: string,
    requestBody?: Record<string, unknown>,
): string | null {
    const alias = getVideoParamAliases()[modelId];
    if (typeof alias === "string" && alias.length > 0) {
        return alias;
    }
    const aliasRecord = asRecord(alias);
    if (!aliasRecord) {
        return null;
    }

    const operation = requestBodyHasImageInput(requestBody) ? "image-to-video" : "text-to-video";
    const target = aliasRecord[operation];
    return typeof target === "string" && target.length > 0 ? target : null;
}

function coerceParamValue(definition: ParamDefinition, value: unknown): unknown {
    if (value === undefined || value === null) {
        return undefined;
    }

    if (definition.type === "integer") {
        if (typeof value === "number" && Number.isInteger(value)) {
            return value;
        }
        if (typeof value === "string" && /^-?\d+$/.test(value.trim())) {
            return Number.parseInt(value.trim(), 10);
        }
        return value;
    }

    if (definition.type === "number") {
        if (typeof value === "number" && Number.isFinite(value)) {
            return value;
        }
        if (typeof value === "string" && value.trim().length > 0) {
            const parsed = Number(value.trim());
            if (Number.isFinite(parsed)) {
                return parsed;
            }
        }
        return value;
    }

    if (definition.type === "boolean") {
        if (typeof value === "boolean") {
            return value;
        }
        if (typeof value === "string") {
            const normalized = value.trim().toLowerCase();
            if (normalized === "true") return true;
            if (normalized === "false") return false;
        }
    }

    return value;
}

function extractProvidedParamValues(
    params: Record<string, ParamDefinition>,
    requestBody?: Record<string, unknown>,
): Record<string, unknown> {
    if (!requestBody) {
        return {};
    }

    const customParams = asRecord(requestBody.custom_params);
    const provided: Record<string, unknown> = {};

    for (const key of Object.keys(params)) {
        const definition = params[key];
        if (customParams && customParams[key] !== undefined) {
            provided[key] = coerceParamValue(definition, customParams[key]);
            continue;
        }

        if (requestBody[key] !== undefined) {
            provided[key] = coerceParamValue(definition, requestBody[key]);
        }
    }

    return provided;
}

export function resolveModelParams(
    modelId: string,
    preferredType?: "video" | "image",
    requestBody?: Record<string, unknown>,
): ResolvedModelParams | null {
    const decodedModelId = decodeURIComponent(modelId);
    const lookups: Array<{
        type: "video" | "image";
        map: Record<string, ModelParams>;
    }> = preferredType === "video"
        ? [
            { type: "video", map: getVideoParams() },
            { type: "image", map: getImageParams() },
        ]
        : preferredType === "image"
            ? [
                { type: "image", map: getImageParams() },
                { type: "video", map: getVideoParams() },
            ]
            : [
                { type: "video", map: getVideoParams() },
                { type: "image", map: getImageParams() },
            ];

    for (const lookup of lookups) {
        const aliasTarget = lookup.type === "video" ? resolveVideoParamAlias(decodedModelId, requestBody) : null;
        const match = findMatchingParams(aliasTarget || decodedModelId, lookup.map);
        if (!match) {
            continue;
        }

        const params = filterOptionalParams(match.params.params);
        return {
            modelId: decodedModelId,
            type: lookup.type,
            provider: match.params.provider,
            params,
            defaults: buildModelParamDefaults(params),
        };
    }

    return null;
}

export function resolveOptionalModelParamValues(
    modelId: string,
    preferredType?: "video" | "image",
    requestBody?: Record<string, unknown>,
): ResolvedModelParams & { values: Record<string, unknown> } | null {
    const resolved = resolveModelParams(modelId, preferredType, requestBody);
    if (!resolved) {
        return null;
    }

    const provided = extractProvidedParamValues(resolved.params, requestBody);
    return {
        ...resolved,
        values: {
            ...resolved.defaults,
            ...provided,
        },
    };
}

export function resolveProvidedOptionalModelParamValues(
    modelId: string,
    preferredType?: "video" | "image",
    requestBody?: Record<string, unknown>,
): ResolvedModelParams & { values: Record<string, unknown> } | null {
    const resolved = resolveModelParams(modelId, preferredType, requestBody);
    if (!resolved) {
        return null;
    }

    return {
        ...resolved,
        values: extractProvidedParamValues(resolved.params, requestBody),
    };
}

/**
 * GET /v1/models/:model/params
 * 
 * Returns optional parameter schema for a given model.
 * Searches video.json first, then image.json.
 * Uses flexible matching to handle different model ID formats.
 */
export async function handleGetModelParams(
    req: Request,
    res: Response
): Promise<void> {
    const modelIdParam = req.params.model;
    const modelId = Array.isArray(modelIdParam) ? modelIdParam[0] : modelIdParam;

    if (!modelId) {
        res.status(400).json({ error: "Model ID is required" });
        return;
    }

    const resolved = resolveModelParams(modelId);
    if (resolved) {
        res.json(resolved);
        return;
    }

    // No params found - return empty (not an error, just no optional params)
    res.json({
        modelId: decodeURIComponent(modelId),
        type: null,
        params: {},
        defaults: {},
        provider: null,
    });
}
