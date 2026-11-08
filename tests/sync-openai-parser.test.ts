import assert from "node:assert/strict";
import test from "node:test";

import {
  extractOpenApiParamsByEndpoint,
  loadOpenAiStructuredSource,
  priceSectionsForModel,
} from "../inference/scripts/sync-openai.js";

const PAGE_URL = "https://docs.example.test/api/docs/models/all";
const ENTRY_URL = "https://docs.example.test/_astro/catalog-entry.A7f9Qx.js";
const MANIFEST_URL = "https://docs.example.test/_astro/catalog-data.k2Lm8N.js";
const SECOND_MANIFEST_URL = "https://docs.example.test/_astro/catalog-data.second.R4p6.js";
const PRICING_URL = "https://docs.example.test/_astro/rates.Z9v3Bc.js";