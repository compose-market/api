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

// Cache for loaded param files
let videoParamsCache: Record<string, ModelParams> | null = null;
let imageParamsCache: Record<string, ModelParams> | null = null;
let dataBasePath: string | null = null;

/**
 * Get base path for data files (same logic as registry.ts)
 * Note: CJS bundle means __dirname and import.meta.url won't reliably work
 * We use Lambda-specific paths and process.cwd() instead
 */
function getDataBasePath(): string {
    // Return cached path if already found
    if (dataBasePath !== null) return dataBasePath;

    const candidatePaths: string[] = [
        // 1. Lambda-specific paths (dist/data contains the json files)
        "/var/task/dist/data",                    // Lambda deployment structure
        "/var/task/data",                         // Alternative Lambda structure

        // 2. process.cwd() based paths (reliable in Lambda)
        path.join(process.cwd(), "dist", "data"), // Lambda with dist folder
        path.join(process.cwd(), "data"),         // Direct data folder

        // 3. Relative to source (for local development with tsx)
        path.join(process.cwd(), "shared", "models", "data", "params"),
        path.join(process.cwd(), "backend", "lambda", "shared", "models", "data", "params"),
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
    dataBasePath = path.join(process.cwd(), "dist", "data");
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
        videoParamsCache = params;
        console.log(`[paramsHandler] Loaded ${Object.keys(params).length} video model params`);
        return params;
    } catch (err) {
        console.error("[paramsHandler] Failed to load video.json:", err);
        return {};
    }
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
    const modelId = req.params.model;

    if (!modelId) {
        res.status(400).json({ error: "Model ID is required" });
        return;
    }

    // Decode URL-encoded model ID (e.g., "flux%2Fschnell" -> "flux/schnell")
    const decodedModelId = decodeURIComponent(modelId);

    // Search in video params first
    const videoParams = getVideoParams();
    const videoMatch = findMatchingParams(decodedModelId, videoParams);
    if (videoMatch) {
        res.json({
            modelId: decodedModelId,
            type: "video",
            params: videoMatch.params.params,
            provider: videoMatch.params.provider,
        });
        return;
    }

    // Search in image params
    const imageParams = getImageParams();
    const imageMatch = findMatchingParams(decodedModelId, imageParams);
    if (imageMatch) {
        res.json({
            modelId: decodedModelId,
            type: "image",
            params: imageMatch.params.params,
            provider: imageMatch.params.provider,
        });
        return;
    }

    // No params found - return empty (not an error, just no optional params)
    res.json({
        modelId: decodedModelId,
        type: null,
        params: {},
        provider: null,
    });
}

