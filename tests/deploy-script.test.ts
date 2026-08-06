import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("default deployment updates the API service and settlement jobs", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
    scripts?: Record<string, string>;
  };
  const deploy = packageJson.scripts?.deploy || "";

  assert.match(deploy, /(?:^|&&\s*)npx tsx deploy\.ts$/u);
  assert.doesNotMatch(deploy, /--fast|--skip-jobs/u);
});

test("both settlement job deployment paths bind the Analytics database", async () => {
  const deploySource = await readFile(new URL("../deploy.ts", import.meta.url), "utf8");
  const dynamicStart = deploySource.indexOf('name: "compose-market-settlement"');
  const dynamicEnd = deploySource.indexOf('name: "compose-market-expiry"', dynamicStart);
  assert.notEqual(dynamicStart, -1);
  assert.notEqual(dynamicEnd, -1);
  assert.match(deploySource.slice(dynamicStart, dynamicEnd), /"ANALYTICS_DATABASE_URL"/u);

  const cloudBuild = await readFile(new URL("../cloudbuild.yaml", import.meta.url), "utf8");
  const staticStart = cloudBuild.indexOf("# Batch Settlement Job");
  const staticEnd = cloudBuild.indexOf("# Expiry Scan Job", staticStart);
  assert.notEqual(staticStart, -1);
  assert.notEqual(staticEnd, -1);
  const bindings = cloudBuild.slice(staticStart, staticEnd).match(/ANALYTICS_DATABASE_URL=ANALYTICS_DATABASE_URL:latest/gu) || [];
  assert.equal(bindings.length, 2, "settlement job update and create commands must both bind Analytics Neon");
});
