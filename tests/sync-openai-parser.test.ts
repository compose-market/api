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

function registryModule(currentSnapshot = "direct-model-2026-01-01", suffix = ""): string {
  return `
import{p as z${suffix}}from"./rates.Z9v3Bc.js";
var a${suffix}={name:"direct-model",slug:"direct-model",current_snapshot:"${currentSnapshot}",tagline:"Direct",description:"Direct model",type:"chat",snapshots:["${currentSnapshot}"]};
const A${suffix}=Object.freeze(Object.defineProperty({__proto__:null,default:a${suffix},name:a${suffix}.name,slug:a${suffix}.slug,current_snapshot:a${suffix}.current_snapshot},Symbol.toStringTag,{value:"Module"}));
var b${suffix}={name:"snapshot-priced-model",slug:"snapshot-priced-model",current_snapshot:"snapshot-priced-model-2026-01-02",tagline:"Snapshot",description:"Snapshot-priced model",type:"audio",snapshots:["snapshot-priced-model-2026-01-02"]};
const B${suffix}=Object.freeze(Object.defineProperty({__proto__:null,default:b${suffix},name:b${suffix}.name,slug:b${suffix}.slug,current_snapshot:b${suffix}.current_snapshot},Symbol.toStringTag,{value:"Module"}));
var c${suffix}={name:"direct",slug:"direct",current_snapshot:"direct-snapshot",tagline:"Exact",description:"Must not prefix-match",type:"chat",snapshots:["direct-snapshot"]};
const C${suffix}=Object.freeze(Object.defineProperty({__proto__:null,default:c${suffix},name:c${suffix}.name,slug:c${suffix}.slug,current_snapshot:c${suffix}.current_snapshot},Symbol.toStringTag,{value:"Module"}));
var h${suffix}={name:"duration-model",slug:"duration-model",current_snapshot:"duration-snapshot",tagline:"Duration",description:"Duration model",type:"audio",snapshots:["duration-snapshot"]};
const H${suffix}=Object.freeze(Object.defineProperty({__proto__:null,default:h${suffix},name:h${suffix}.name,slug:h${suffix}.slug,current_snapshot:h${suffix}.current_snapshot},Symbol.toStringTag,{value:"Module"}));

var d${suffix}={name:"direct-model-2026-01-01",slug:"direct-model-2026-01-01",modalities:{input:["text"],output:["text"]},supported_features:["streaming"],supported_endpoints:["responses"],context_window:128e3,max_output_tokens:16e3,knowledge_cutoff:new Date(17356896e5),reasoning_tokens:!1};
const D${suffix}=Object.freeze(Object.defineProperty({__proto__:null,default:d${suffix},name:d${suffix}.name,slug:d${suffix}.slug},Symbol.toStringTag,{value:"Module"}));
var e${suffix}={name:"snapshot-priced-model-2026-01-02",slug:"snapshot-priced-model-2026-01-02",modalities:{input:["audio"],output:["text"]},supported_features:["streaming"],supported_endpoints:["speech_generation"],context_window:64e3,max_output_tokens:8e3,knowledge_cutoff:new Date(1735776e6),reasoning_tokens:!1};
const E${suffix}=Object.freeze(Object.defineProperty({__proto__:null,default:e${suffix},name:e${suffix}.name,slug:e${suffix}.slug},Symbol.toStringTag,{value:"Module"}));
var f${suffix}={name:"direct-snapshot",slug:"direct-snapshot",modalities:{input:["text"],output:["text"]},supported_features:[],supported_endpoints:["responses"],context_window:32e3,max_output_tokens:4e3,reasoning_tokens:!1};
const F${suffix}=Object.freeze(Object.defineProperty({__proto__:null,default:f${suffix},name:f${suffix}.name,slug:f${suffix}.slug},Symbol.toStringTag,{value:"Module"}));
var i${suffix}={name:"duration-snapshot",slug:"duration-snapshot",modalities:{input:["audio"],output:["text"]},supported_features:[],supported_endpoints:["speech_generation"],context_window:32e3,max_output_tokens:4e3,reasoning_tokens:!1};
const I${suffix}=Object.freeze(Object.defineProperty({__proto__:null,default:i${suffix},name:i${suffix}.name,slug:i${suffix}.slug},Symbol.toStringTag,{value:"Module"}));
var g${suffix}={name:"publisher-alias",slug:"publisher-alias",current_snapshot:"direct-model-2026-01-01",snapshots:["direct-model-2026-01-01"]};
const G${suffix}=Object.freeze(Object.defineProperty({__proto__:null,default:g${suffix},name:g${suffix}.name,slug:g${suffix}.slug,current_snapshot:g${suffix}.current_snapshot},Symbol.toStringTag,{value:"Module"}));

function normalizePricing${suffix}(value){
  const{snapshot,price_type,price_unit,columns,values,units}=value;
  const effectiveUnit${suffix}=price_unit??"publisher quanta";
  return{snapshot,price_type,price_unit:effectiveUnit${suffix},columns,values,units};
}

const m${suffix}=Object.assign({
  "arbitrary-one":A${suffix},
  "opaque:two":B${suffix},
  "third-key":C${suffix},
  "fourth-key":H${suffix}
});
const s${suffix}=Object.assign({
  "unrelated-four":D${suffix},
  "opaque:five":E${suffix},
  "sixth-key":F${suffix},
  "seventh-key":I${suffix},
  "alias-key":G${suffix}
});
export{m${suffix} as b,s${suffix} as c};
`;
}

type LoaderOverrides = Record<string, string | undefined>;

function fixtureLoader(overrides: LoaderOverrides = {}) {
  const modules = new Map<string, string>([
    [ENTRY_URL, ENTRY_MODULE],
    [MANIFEST_URL, registryModule()],
    [PRICING_URL, PRICING_MODULE],
  ]);
  for (const [url, source] of Object.entries(overrides)) {
    if (source === undefined) modules.delete(url);
    else modules.set(url, source);
  }

  return async (url: string | URL): Promise<string> => {
    const key = String(url);
    const source = modules.get(key);
    if (source === undefined) throw new Error(`Fixture has no module for ${key}`);
    return source;
  };
}

function keyed<T>(collection: Map<string, T> | Record<string, T>, key: string): T | undefined {
  return collection instanceof Map ? collection.get(key) : collection[key];
}

function scalarStrings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(scalarStrings);
  if (value !== null && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      .flatMap(([key, child]) => [key, ...scalarStrings(child)]);
  }
  return [];
}

function staticPricingModule(catalog: unknown): string {
  return `const catalog=JSON.parse(${JSON.stringify(JSON.stringify(catalog))});export{catalog as arbitraryExport};`;
}

function encodeAstroValue(value: unknown): unknown {
  if (Array.isArray(value)) return [1, value.map(encodeAstroValue)];
  return [0, value];
}

function pricingTableIsland(props: Record<string, unknown>): string {
  const encoded = Object.fromEntries(Object.entries(props).map(([key, value]) => [key, encodeAstroValue(value)]));
  return `<astro-island props='${JSON.stringify(encoded)}'></astro-island>`;
}

function defaultTierPricingPage(tier: string, rows: unknown[][]): string {
  return `<div data-content-switcher-root data-content-switcher-initial="${tier}">
    <div data-content-switcher-pane data-value="${tier}">
      ${pricingTableIsland({ tier, rows })}
    </div>
  </div>`;
}