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
const PRICING_PAGE_URL = "https://docs.example.test/api/pricing";

const ALL_MODELS_HTML = `<!doctype html>
<html>
  <body>
    <astro-island
      component-url="/_astro/ModelView.legacy.js"
      component-export="LegacyModelView"
      props='{"view":[0,"detail"],"modelName":[0,"decoy-model"]}'
    >
      <a href="/api/docs/models/decoy-model">Unrelated detail-island link</a>
    </astro-island>
    <astro-island
      component-url="/_astro/catalog-entry.A7f9Qx.js"
      component-export="RenamedCatalogRenderer"
      props='{"view":[0,"all"],"localization":[0]}'
    >
      <a href="/api/docs/models/direct-model">Direct model</a>
      <a href="/api/docs/models/snapshot-priced-model">Snapshot-priced model</a>
      <a href="/api/docs/models/direct">Exact-match sentinel</a>
      <a href="/api/docs/models/duration-model">Duration model</a>
    </astro-island>
  </body>
</html>`;