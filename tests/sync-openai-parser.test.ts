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

function duplicateTokenPricing(records: Array<{ values: Record<string, unknown> }>): string {
  return staticPricingModule({
    arbitraryCategory: {
      name: "Arbitrary category",
      subsections: records.map((record, index) => ({
        title: `Opaque ${index}`,
        price_type: "Text tokens",
        price_unit: "1M tokens",
        columns: [
          { name: "input", label: "Input" },
          { name: "output", label: "Output" },
        ],
        items: [{ name: "direct-model", values: record.values }],
      })),
    },
  });
}

function snapshotPricing(item: Record<string, unknown>): string {
  return staticPricingModule({
    arbitraryCategory: {
      name: "Publisher category",
      subsections: [{
        price_type: "Publisher pricing type",
        price_unit: "request",
        columns: [{ name: "cost", label: "Cost" }],
        items: [item],
      }],
    },
  });
}

test("loads model, snapshot, endpoint, and pricing manifests through arbitrary hashed imports", async () => {
  const source = await loadOpenAiStructuredSource({
    allModelsHtml: ALL_MODELS_HTML,
    pageUrl: PAGE_URL,
    loadModule: fixtureLoader(),
  });

  assert.deepEqual([...source.visibleSlugs].sort(), [
    "direct",
    "direct-model",
    "duration-model",
    "snapshot-priced-model",
  ]);
  assert.equal(source.modelPageUrls.get("direct-model"), "https://docs.example.test/api/docs/models/direct-model");

  assert.equal(keyed(source.models, "direct-model")?.description, "Direct model");
  assert.equal(keyed(source.models, "snapshot-priced-model")?.current_snapshot, "snapshot-priced-model-2026-01-02");
  assert.equal(keyed(source.snapshots, "direct-model-2026-01-01")?.context_window, 128_000);
  assert.deepEqual(keyed(source.snapshots, "snapshot-priced-model-2026-01-02")?.modalities, {
    input: ["audio"],
    output: ["text"],
  });
  assert.equal(keyed(source.snapshots, "publisher-alias")?.current_snapshot, "direct-model-2026-01-01");
  assert.equal(source.snapshotAliases.get("publisher-alias"), "direct-model-2026-01-01");

  const endpoints = source.endpoints instanceof Map
    ? [...source.endpoints.values()]
    : Array.isArray(source.endpoints)
      ? source.endpoints
      : Object.values(source.endpoints);
  assert.deepEqual(endpoints.map((endpoint) => ({
    name: endpoint.name,
    label: endpoint.label,
    route: endpoint.route,
  })), [
    { name: "responses", label: "Responses", route: "v1/responses" },
    { name: "speech_generation", label: "Speech generation", route: "v1/audio/speech" },
  ]);

  assert.ok(keyed(source.pricingById, "direct-model"));
  assert.ok(keyed(source.pricingById, "snapshot-priced-model-2026-01-02"));
  assert.equal(source.implicitPriceUnit, "publisher quanta");
});

test("rejects conflicting discovered hrefs for the same exact model id", async () => {
  const conflictingHtml = ALL_MODELS_HTML.replace(
    "    </astro-island>\n  </body>",
    '      <a href="/api/docs/models/direct-model?conflict=1">Conflicting exact href</a>\n    </astro-island>\n  </body>',
  );
  await assert.rejects(
    loadOpenAiStructuredSource({
      allModelsHtml: conflictingHtml,
      pageUrl: PAGE_URL,
      loadModule: fixtureLoader(),
    }),
    /conflicting canonical model links/i,
  );
});

test("resolves pricing only by an exact canonical id or its declared current snapshot", async () => {
  const source = await loadOpenAiStructuredSource({
    allModelsHtml: ALL_MODELS_HTML,
    pageUrl: PAGE_URL,
    loadModule: fixtureLoader(),
  });

  const direct = priceSectionsForModel(source, "direct-model");
  const implicit = direct.find((section) => section.unitKey === "per_publisher_quanta_usd");
  assert.deepEqual(implicit?.entries, { input: 2, output: 8 });

  const throughDeclaredSnapshot = priceSectionsForModel(source, "snapshot-priced-model");
  assert.equal(throughDeclaredSnapshot.length, 1);

  // `direct-model` and `direct-model-pro` exist in the pricing source. The
  // unpriced model `direct` must not acquire either through prefix matching.
  assert.deepEqual(priceSectionsForModel(source, "direct"), []);
});

test("uses an explicit publisher metric unit without renaming its metric", async () => {
  const source = await loadOpenAiStructuredSource({
    allModelsHtml: ALL_MODELS_HTML,
    pageUrl: PAGE_URL,
    loadModule: fixtureLoader(),
  });

  const characters = priceSectionsForModel(source, "direct-model")
    .find((section) => section.unitKey === "per_1m_characters_usd");
  assert.deepEqual(characters?.entries, { cost: 15 });
  assert.equal(characters?.source.publisherUnit, "1M characters");
  assert.equal(characters?.source.currency, null);
  assert.equal(characters?.source.unitKeyOrigin, "repository_adapter");
});

test("rejects distinct publisher units that collide in the repository unit-key adapter", async () => {
  const source = await loadOpenAiStructuredSource({
    allModelsHtml: ALL_MODELS_HTML,
    pageUrl: PAGE_URL,
    loadModule: fixtureLoader({
      [PRICING_URL]: staticPricingModule({
        arbitraryCategory: {
          name: "Publisher category",
          subsections: [
            {
              price_type: "First type",
              columns: [{ name: "cost", label: "Cost" }],
              items: [{ name: "direct-model", units: { cost: "1M tokens" }, values: { main: { cost: 2 } } }],
            },
            {
              price_type: "Second type",
              columns: [{ name: "cost", label: "Cost" }],
              items: [{ name: "direct-model", units: { cost: "1m_tokens" }, values: { main: { cost: 3 } } }],
            },
          ],
        },
      }),
    }),
  });

  assert.throws(() => priceSectionsForModel(source, "direct-model"), /collide.*repository adapter key/i);
});

test("rejects conflicting explicit metric units", async () => {
  const source = await loadOpenAiStructuredSource({
    allModelsHtml: ALL_MODELS_HTML,
    pageUrl: PAGE_URL,
    loadModule: fixtureLoader({
      [PRICING_URL]: snapshotPricing({
        name: "publisher-parent",
        current_snapshot: "direct-model-2026-01-01",
        units: { cost: "minute" },
        values: { main: { cost: 2 } },
        snapshots: [{
          name: "direct-model-2026-01-01",
          units: { cost: "second" },
          values: { main: { cost: 2 } },
        }],
      }),
    }),
  });

  assert.throws(() => priceSectionsForModel(source, "direct-model"), /conflicting explicit units/i);
});

test("rejects a category-only unit that the publisher renderer does not inherit", async () => {
  const source = await loadOpenAiStructuredSource({
    allModelsHtml: ALL_MODELS_HTML,
    pageUrl: PAGE_URL,
    loadModule: fixtureLoader({
      [PRICING_URL]: staticPricingModule({
        arbitraryCategory: {
          name: "Publisher category",
          price_unit: "request",
          subsections: [{
            price_type: "Publisher pricing type",
            columns: [{ name: "cost", label: "Cost" }],
            items: [{ name: "direct-model", values: { main: { cost: 2 } } }],
          }],
        },
      }),
    }),
  });

  assert.throws(() => priceSectionsForModel(source, "direct-model"), /category unit.*renderer-established precedence/i);
});

test("rejects equal billing sections with conflicting publisher identities instead of keeping the first", async () => {
  const source = await loadOpenAiStructuredSource({
    allModelsHtml: ALL_MODELS_HTML,
    pageUrl: PAGE_URL,
    loadModule: fixtureLoader({
      [PRICING_URL]: staticPricingModule({
        arbitraryCategory: {
          name: "Publisher category",
          subsections: ["First identity", "Second identity"].map((priceType) => ({
            price_type: priceType,
            columns: [{ name: "cost", label: "Cost" }],
            items: [{
              name: "direct-model",
              units: { cost: "request" },
              values: { main: { cost: 2 } },
            }],
          })),
        },
      }),
    }),
  });

  assert.throws(
    () => priceSectionsForModel(source, "direct-model"),
    /ambiguous equal pricing sections.*conflicting publisher labels/i,
  );
});

test("rejects a billable record with no publisher label instead of inventing one", async () => {
  const source = await loadOpenAiStructuredSource({
    allModelsHtml: ALL_MODELS_HTML,
    pageUrl: PAGE_URL,
    loadModule: fixtureLoader({
      [PRICING_URL]: staticPricingModule({
        arbitraryCategory: {
          subsections: [{
            price_unit: "request",
            columns: [{ name: "cost", label: "Cost" }],
            items: [{ name: "direct-model", values: { main: { cost: 2 } } }],
          }],
        },
      }),
    }),
  });

  assert.throws(() => priceSectionsForModel(source, "direct-model"), /publisher.*label|price.type|title|category/i);
});

test("rejects an exact populated price record that yields no validated numeric billing", async () => {
  const source = await loadOpenAiStructuredSource({
    allModelsHtml: ALL_MODELS_HTML,
    pageUrl: PAGE_URL,
    loadModule: fixtureLoader({
      [PRICING_URL]: staticPricingModule({
        arbitraryCategory: {
          name: "Publisher category",
          subsections: [{
            price_type: "Publisher pricing type",
            price_unit: "request",
            columns: [{ name: "cost", label: "Cost" }],
            items: [{ name: "direct-model", values: { main: { cost: "$2" } } }],
          }],
        },
      }),
    }),
  });

  assert.throws(() => priceSectionsForModel(source, "direct-model"), /no validated billable sections/i);
});

test("preserves publisher Free as a zero rate instead of treating it as missing", async () => {
  const source = await loadOpenAiStructuredSource({
    allModelsHtml: ALL_MODELS_HTML,
    pageUrl: PAGE_URL,
    loadModule: fixtureLoader({
      [PRICING_URL]: staticPricingModule({
        arbitraryCategory: {
          name: "Publisher category",
          subsections: [{
            price_type: "Publisher pricing type",
            price_unit: "request",
            columns: [{ name: "cost", label: "Cost" }],
            items: [{ name: "direct-model", values: { main: { cost: "Free" } } }],
          }],
        },
      }),
    }),
  });

  assert.deepEqual(priceSectionsForModel(source, "direct-model")[0]?.entries, { cost: 0 });
});

test("prefers exact direct-id pricing over the declared current snapshot", async () => {
  const source = await loadOpenAiStructuredSource({
    allModelsHtml: ALL_MODELS_HTML,
    pageUrl: PAGE_URL,
    loadModule: fixtureLoader({
      [PRICING_URL]: staticPricingModule({
        arbitraryCategory: {
          name: "Publisher category",
          subsections: [{
            price_type: "Publisher pricing type",
            price_unit: "request",
            columns: [{ name: "cost", label: "Cost" }],
            items: [
              { name: "direct-model", values: { main: { cost: 2 } } },
              { name: "direct-model-2026-01-01", values: { main: { cost: 9 } } },
            ],
          }],
        },
      }),
    }),
  });

  assert.deepEqual(priceSectionsForModel(source, "direct-model")[0]?.entries, { cost: 2 });
});

test("emits exact publisher selectors for distinct conditional prices", async () => {
  const source = await loadOpenAiStructuredSource({
    allModelsHtml: ALL_MODELS_HTML,
    pageUrl: PAGE_URL,
    loadModule: fixtureLoader({
      [PRICING_URL]: staticPricingModule({
        arbitraryCategory: {
          name: "Publisher category",
          subsections: [{
            price_type: "Conditional pricing",
            columns: [
              { name: "quality", label: "Quality" },
              { name: "cost", label: "Cost" },
            ],
            items: [
              { name: "direct-model", units: { cost: "image" }, values: { main: { quality: "low", cost: 0.01 } } },
              { name: "direct-model", units: { cost: "image" }, values: { main: { quality: "high", cost: 0.04 } } },
            ],
          }],
        },
      }),
    }),
  });

  const sections = priceSectionsForModel(source, "direct-model");
  assert.deepEqual(sections.map((section) => ({ selector: section.selector, entries: section.entries })), [
    { selector: { quality: "low" }, entries: { cost: 0.01 } },
    { selector: { quality: "high" }, entries: { cost: 0.04 } },
  ]);
});

test("rejects invalid, duplicate, missing-current, and conflicting same-id pricing snapshots", async () => {
  const invalidItems: Array<{ item: Record<string, unknown>; error: RegExp }> = [
    {
      item: { name: "direct-model", values: { main: { cost: 2 } }, snapshots: "not-an-array" },
      error: /invalid snapshots declaration/i,
    },
    {
      item: {
        name: "direct-model",
        current_snapshot: "snapshot-one",
        values: { main: { cost: 2 } },
        snapshots: [
          { name: "snapshot-one", values: { main: { cost: 2 } } },
          { name: "snapshot-one", values: { main: { cost: 2 } } },
        ],
      },
      error: /duplicate snapshot/i,
    },
    {
      item: {
        name: "direct-model",
        current_snapshot: "missing-snapshot",
        values: { main: { cost: 2 } },
        snapshots: [{ name: "snapshot-one", values: { main: { cost: 2 } } }],
      },
      error: /current snapshot.*missing/i,
    },
    {
      item: {
        name: "direct-model",
        current_snapshot: "direct-model",
        values: { main: { cost: 2 } },
        snapshots: [{ name: "direct-model", values: { main: { cost: 3 } } }],
      },
      error: /same-id snapshot/i,
    },
  ];

  for (const { item, error } of invalidItems) {
    await assert.rejects(
      loadOpenAiStructuredSource({
        allModelsHtml: ALL_MODELS_HTML,
        pageUrl: PAGE_URL,
        loadModule: fixtureLoader({ [PRICING_URL]: snapshotPricing(item) }),
      }),
      error,
    );
  }
});

test("selects a duplicate pricing record only from an exact publisher default-tier row", async () => {
  const source = await loadOpenAiStructuredSource({
    allModelsHtml: ALL_MODELS_HTML,
    pageUrl: PAGE_URL,
    pricingPageHtml: defaultTierPricingPage("publisher-default", [["direct-model", 2, 8]]),
    pricingPageUrl: PRICING_PAGE_URL,
    loadModule: fixtureLoader({
      [PRICING_URL]: duplicateTokenPricing([
        { values: { main: { input: 1, output: 4 } } },
        { values: { main: { input: 2, output: 8 } } },
      ]),
    }),
  });

  const sections = priceSectionsForModel(source, "direct-model");
  assert.equal(sections.length, 1);
  assert.deepEqual(sections[0]?.entries, { input: 2, output: 8 });
  assert.equal(sections[0]?.default, undefined);
  assert.ok(scalarStrings(sections[0]?.source.raw).includes("opaque_duplicate_dimension"));
});

test("rejects duplicate pricing when exact default-tier evidence is absent", async () => {
  const source = await loadOpenAiStructuredSource({
    allModelsHtml: ALL_MODELS_HTML,
    pageUrl: PAGE_URL,
    loadModule: fixtureLoader({
      [PRICING_URL]: duplicateTokenPricing([
        { values: { main: { input: 3, output: 12 }, flex: { input: 1, output: 4 } } },
        { values: { main: { input: 1, output: 4 } } },
      ]),
    }),
  });

  assert.throws(
    () => priceSectionsForModel(source, "direct-model"),
    /default-tier evidence|ambiguous duplicate/i,
  );
});

test("rejects duplicate pricing when a default-tier row matches more than one record", async () => {
  const source = await loadOpenAiStructuredSource({
    allModelsHtml: ALL_MODELS_HTML,
    pageUrl: PAGE_URL,
    pricingPageHtml: defaultTierPricingPage("publisher-default", [["direct-model", 2, 8]]),
    pricingPageUrl: PRICING_PAGE_URL,
    loadModule: fixtureLoader({
      [PRICING_URL]: duplicateTokenPricing([
        { values: { main: { input: 2, output: 8 } } },
        { values: { main: { input: 2, output: 8 } } },
      ]),
    }),
  });

  assert.throws(
    () => priceSectionsForModel(source, "direct-model"),
    /default-tier evidence|ambiguous duplicate/i,
  );
});

test("keeps a mixed-unit estimated cost as provenance instead of additive billing", async () => {
  const source = await loadOpenAiStructuredSource({
    allModelsHtml: ALL_MODELS_HTML,
    pageUrl: PAGE_URL,
    loadModule: fixtureLoader(),
  });
  const sections = priceSectionsForModel(source, "snapshot-priced-model");

  const tokens = sections.find((section) => section.unitKey === "per_1m_tokens_usd");
  const minutes = sections.find((section) => section.unitKey === "per_minute_usd");
  assert.deepEqual(tokens?.entries, { input: 1.25, output: 5 });
  assert.equal(minutes, undefined);

  const retained = scalarStrings(tokens?.source.raw);
  assert.ok(retained.includes("estimated_cost"), "raw metadata must retain the publisher metric name");
  assert.ok(retained.includes("Estimated cost"), "raw metadata must retain the publisher column label");
  assert.ok(retained.includes("minute"), "raw metadata must retain the publisher-declared unit");
});