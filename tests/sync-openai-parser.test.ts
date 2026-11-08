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

const ENTRY_MODULE = `
import{b as q}from"./catalog-data.k2Lm8N.js";
const x={
  unrelated:[{name:"not_an_endpoint",label:"Ignore me"}],
  endpoints:[
    {name:"responses",label:"Responses",icon:"chat",route:"v1/responses"},
    {name:"speech_generation",label:"Speech generation",icon:"speech",route:"v1/audio/speech"}
  ]
};
export{x as z};
`;

const PRICING_MODULE = `
const a=JSON.parse(${JSON.stringify(JSON.stringify({
  name: "Canonical prices",
  subsections: [{
    title: "Text tokens",
    price_type: "Text tokens",
    columns: [
      { name: "input", label: "Input" },
      { name: "output", label: "Output" },
    ],
    items: [
      { name: "direct-model", values: { main: { input: 2, output: 8 } } },
      { name: "direct-model-pro", values: { main: { input: 20, output: 80 } } },
    ],
  }],
}))});
const b={
  name:"Snapshot and mixed-unit prices",
  subsections:[{
    title:"Audio tokens",
    price_type:"Audio tokens",
    price_unit:"1M tokens",
    columns:[
      {name:"input",label:"Input"},
      {name:"output",label:"Output"},
      {name:"estimated_cost",label:"Estimated cost"}
    ],
    items:[{
      name:"snapshot-priced-model-2026-01-02",
      units:{estimated_cost:"minute"},
      values:{main:{input:1.25,output:5,estimated_cost:.003}}
    }]
  },{
    title:"Character billing",
    price_type:"Characters",
    columns:[{name:"cost",label:"Cost"}],
    items:[{
      name:"direct-model",
      units:{cost:"1M characters"},
      values:{main:{cost:15}}
    }]
  },{
    title:"Duration billing",
    price_type:"Duration",
    price_unit:"minute",
    columns:[{name:"estimated_cost",label:"Per minute"}],
    items:[{
      name:"duration-model",
      units:{estimated_cost:"minute"},
      values:{main:{estimated_cost:.05}}
    }]
  }]
};
const r={renamed_bucket:a,another_arbitrary_bucket:b};
export{r as p};
`;