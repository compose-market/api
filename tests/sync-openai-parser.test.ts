import assert from "node:assert/strict";
import test from "node:test";

import {
  extractOpenApiParamsByEndpoint,
  loadOpenAiStructuredSource,
  priceSectionsForModel,
} from "../inference/scripts/sync-openai.js";

const PAGE_URL = "https://docs.example.test/api/docs/models/all";