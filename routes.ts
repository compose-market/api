import type { Express, Request, Response } from "express";
import { type Server } from "http";
import { handleInference, handleGetModels } from "./inference.js";
import { handleGetHFModels, handleGetHFModelDetails, handleGetHFTasks } from "./huggingface.js";
import { searchAgents, getAgent, extractUniqueTags, extractUniqueCategories } from "./agentverse.js";

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
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
