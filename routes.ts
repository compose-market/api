import type { Express, Request, Response } from "express";
import { type Server } from "http";
import { handleInference, handleGetModels } from "./inference.js";
import { handleGetHFModels, handleGetHFModelDetails, handleGetHFTasks } from "./providers/huggingface.js";
import { searchAgents, getAgent, extractUniqueTags, extractUniqueCategories } from "./agentverse.js";
import * as models from "./shared/models.js";

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  // ==========================================================================
  // Model Registry Routes
  // ==========================================================================

  // GET /api/registry/models - Get full model registry
  app.get("/api/registry/models", async (_req: Request, res: Response) => {
    try {
      const registry = await models.getModelRegistry();
      res.json(registry);
    } catch (error) {
      console.error("Registry models error:", error);
      res.status(500).json({ error: "Failed to fetch model registry" });
    }
  });

  // GET /api/registry/models/available - Get available models
  // Supports ?refresh=true to force cache refresh
  app.get("/api/registry/models/available", async (req: Request, res: Response) => {
    try {
      const forceRefresh = req.query.refresh === "true";

      if (forceRefresh) {
        const registry = await models.refreshRegistry();
        res.json({
          models: registry.models,
          total: registry.models.length,
          lastUpdated: registry.lastUpdated,
          sources: registry.sources
        });
        return;
      }

      const availableModels = await models.getAvailableModels();
      res.json({ models: availableModels, total: availableModels.length });
    } catch (error) {
      console.error("Available models error:", error);
      res.status(500).json({ error: "Failed to fetch available models" });
    }
  });

  // GET /api/registry/models/:source - Get models by source
  app.get("/api/registry/models/:source", async (req: Request, res: Response) => {
    try {
      const validSources = ["huggingface", "asi-one", "asi-cloud", "openai", "anthropic", "google", "openrouter", "aiml"];
      const source = req.params.source;

      if (!validSources.includes(source)) {
        res.status(400).json({ error: `Invalid source. Valid: ${validSources.join(", ")}` });
        return;
      }

      const sourceModels = await models.getModelsBySource(source as any);
      res.json({ source, models: sourceModels, total: sourceModels.length });
    } catch (error) {
      console.error("Models by source error:", error);
      res.status(500).json({ error: "Failed to fetch models by source" });
    }
  });

  // POST /api/registry/refresh - Force refresh the model registry
  app.post("/api/registry/refresh", async (_req: Request, res: Response) => {
    try {
      const registry = await models.refreshRegistry();
      res.json({
        message: "Registry refreshed",
        models: registry.models.length,
        sources: registry.sources,
        lastUpdated: registry.lastUpdated,
      });
    } catch (error) {
      console.error("Registry refresh error:", error);
      res.status(500).json({ error: "Failed to refresh registry" });
    }
  });

  // ==========================================================================
  // Inference Routes
  // ==========================================================================

  // x402 AI Inference endpoints
  // POST /api/inference - Pay-per-call AI inference with x402 payments
  app.post("/api/inference", (req, res, next) => {
    handleInference(req, res).catch(next);
  });

  // GET /api/models - Get available models and pricing info
  app.get("/api/models", (req, res, next) => {
    handleGetModels(req, res).catch(next);
  });

  // HuggingFace Inference Provider endpoints
  // GET /api/hf/models - Get inferrable models from HuggingFace
  app.get("/api/hf/models", (req, res, next) => {
    handleGetHFModels(req, res).catch(next);
  });

  // GET /api/hf/models/:modelId/details - Get detailed model metadata
  app.get("/api/hf/models/:modelId/details", (req, res, next) => {
    handleGetHFModelDetails(req, res).catch(next);
  });

  // GET /api/hf/tasks - Get available inference tasks
  app.get("/api/hf/tasks", (req, res, next) => {
    handleGetHFTasks(req, res);
    // handleGetHFTasks might be sync or async, assuming it handles its own response or errors, or we catch if async
  });

  // Agentverse API endpoints
  // GET /api/agentverse/agents - Search agents from Agentverse marketplace
  app.get("/api/agentverse/agents", async (req: Request, res: Response) => {
    try {
      const { search, category, tags, status, limit, offset, sort, direction } = req.query;

      const result = await searchAgents({
        search: search as string,
        category: category as string,
        tags: tags ? (tags as string).split(",") : undefined,
        status: status as "active" | "inactive",
        limit: limit ? parseInt(limit as string, 10) : 30,
        offset: offset ? parseInt(offset as string, 10) : 0,
        sort: sort as "relevancy" | "created-at" | "last-modified" | "interactions",
        direction: direction as "asc" | "desc",
      });

      // Extract unique tags and categories for filtering UI
      const uniqueTags = extractUniqueTags(result.agents);
      const uniqueCategories = extractUniqueCategories(result.agents);

      res.json({
        agents: result.agents,
        total: result.total,
        offset: result.offset,
        limit: result.limit,
        tags: uniqueTags,
        categories: uniqueCategories,
      });
    } catch (error) {
      console.error("Agentverse search error:", error);
      res.status(500).json({
        error: error instanceof Error ? error.message : "Failed to fetch agents"
      });
    }
  });

  // GET /api/agentverse/agents/:address - Get single agent details
  app.get("/api/agentverse/agents/:address", async (req: Request, res: Response) => {
    try {
      const { address } = req.params;
      const agent = await getAgent(address);

      if (!agent) {
        res.status(404).json({ error: "Agent not found" });
        return;
      }

      res.json(agent);
    } catch (error) {
      console.error("Agentverse get agent error:", error);
      res.status(500).json({
        error: error instanceof Error ? error.message : "Failed to fetch agent"
      });
    }
  });

  return httpServer;
}
