/**
 * Benchmark Routes — published Artificial Analysis snapshots joined to the
 * canonical Compose model catalog.
 */

import type { Application, Request, Response } from "express";

import {
    BenchmarkHttpError,
    compareBenchmarkModels,
    getBenchmarkForModel,
    getBenchmarkIndex,
} from "./service.js";
import {
    BENCHMARK_OPERATIONS,
    type BenchmarkModality,
    type BenchmarkOperation,
    type StandardBenchmarkModel,
} from "./types.js";

const ATTRIBUTION = {
    source: "Artificial Analysis",
    url: "https://artificialanalysis.ai",
    message: "Independent benchmark data provided by Artificial Analysis",
};

function truthy(value: unknown): boolean {
    return value === "1" || value === "true";
}

function setPublishedHeaders(res: Response, etag: string): void {
    res.set({
        "Cache-Control": "public, max-age=300, stale-while-revalidate=86400",
        "CDN-Cache-Control": "public, s-maxage=21600, stale-while-revalidate=86400",
        ETag: etag,
    });
}

function isNotModified(req: Request, etag: string): boolean {
    const candidate = req.headers["if-none-match"];
    return candidate === etag || (Array.isArray(candidate) && candidate.includes(etag));
}

function errorResponse(res: Response, error: unknown, fallback: string): void {
    if (error instanceof BenchmarkHttpError) {
        res.status(error.status).json({ ok: false, error: error.message });
        return;
    }
    console.error(`[benchmarks] ${fallback}:`, error);
    res.status(500).json({ ok: false, error: fallback });
}

function filterModels(
    models: StandardBenchmarkModel[],
    query: Request["query"],
): StandardBenchmarkModel[] {
    let result = models;

    if (truthy(query.frontier)) {
        result = result.filter((model) => model.isFrontier);
    }

    const family = typeof query.family === "string" ? query.family.trim().toLowerCase() : "";
    if (family) {
        result = result.filter((model) => model.family.toLowerCase() === family);
    }

    // Backwards compatibility for the first UI while family becomes canonical.
    const creator = typeof query.creator === "string" ? query.creator.trim().toLowerCase() : "";
    if (creator) {
        result = result.filter((model) =>
            model.creatorSlug.toLowerCase() === creator ||
            model.creator.toLowerCase() === creator ||
            model.family.toLowerCase() === creator
        );
    }

    const operation = typeof query.operation === "string" ? query.operation.trim() : "";
    if (operation) {
        if (!(BENCHMARK_OPERATIONS as readonly string[]).includes(operation)) {
            throw new BenchmarkHttpError(400, `Invalid operation filter: ${operation}`);
        }
        result = result.filter((model) => model.operation === operation as BenchmarkOperation);
    }

    const modality = typeof query.modality === "string" ? query.modality.trim() : "";
    if (modality) {
        if (!["text", "image", "audio", "video"].includes(modality)) {
            throw new BenchmarkHttpError(400, `Invalid modality filter: ${modality}`);
        }
        result = result.filter((model) => model.modality === modality as BenchmarkModality);
    }

    const search = typeof query.search === "string" ? query.search.trim().toLowerCase() : "";
    if (search) {
        result = result.filter((model) =>
            model.name.toLowerCase().includes(search) ||
            model.modelId.toLowerCase().includes(search) ||
            model.family.toLowerCase().includes(search) ||
            model.creator.toLowerCase().includes(search)
        );
    }

    return result;
}

export function registerBenchmarkRoutes(app: Application): void {
    app.get("/api/benchmarks", async (req: Request, res: Response) => {
        try {
            const index = await getBenchmarkIndex();
            if (isNotModified(req, index.etag)) {
                setPublishedHeaders(res, index.etag);
                res.status(304).end();
                return;
            }

            const models = filterModels(index.models, req.query);
            const operationCounts = Object.fromEntries(
                index.models.reduce<Array<[string, number]>>((entries, model) => {
                    const existing = entries.find(([operation]) => operation === model.operation);
                    if (existing) existing[1] += 1;
                    else entries.push([model.operation, 1]);
                    return entries;
                }, []),
            );

            setPublishedHeaders(res, index.etag);
            res.json({
                ok: true,
                total: models.length,
                frontierCount: models.filter((model) => model.isFrontier).length,
                operationCounts,
                snapshot: index.snapshot,
                data: models,
                attribution: ATTRIBUTION,
            });
        } catch (error) {
            errorResponse(res, error, "Failed to load benchmarks");
        }
    });

    app.get("/api/benchmarks/models/:id", async (req: Request, res: Response) => {
        try {
            const rawId = req.params.id;
            const id = Array.isArray(rawId) ? rawId[0] : rawId;
            if (!id) throw new BenchmarkHttpError(400, "Model ID is required");

            const [model, index] = await Promise.all([
                getBenchmarkForModel(id),
                getBenchmarkIndex(),
            ]);
            if (!model) {
                res.status(404).json({ ok: false, error: `No linked benchmark data found for model: ${id}` });
                return;
            }

            setPublishedHeaders(res, index.etag);
            res.json({ ok: true, snapshot: index.snapshot, data: model, attribution: ATTRIBUTION });
        } catch (error) {
            errorResponse(res, error, "Failed to load model benchmark");
        }
    });

    app.get("/api/benchmarks/compare", async (req: Request, res: Response) => {
        try {
            const modelsParam = typeof req.query.models === "string" ? req.query.models : "";
            const modelIds = modelsParam.split(",").map((id) => id.trim()).filter(Boolean);
            if (modelIds.length === 0) {
                throw new BenchmarkHttpError(400, "Query parameter 'models' must contain at least one model ID");
            }
            if (modelIds.length > 4) {
                throw new BenchmarkHttpError(400, "Head-to-head comparison supports at most four models");
            }

            const [comparison, index] = await Promise.all([
                compareBenchmarkModels(modelIds),
                getBenchmarkIndex(),
            ]);
            setPublishedHeaders(res, index.etag);
            res.json({ ok: true, snapshot: index.snapshot, data: comparison, attribution: ATTRIBUTION });
        } catch (error) {
            errorResponse(res, error, "Failed to generate comparison");
        }
    });
}
