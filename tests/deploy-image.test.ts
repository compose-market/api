import assert from "node:assert/strict";
import test from "node:test";

import { resolveServiceConfig, resolveServiceImageFromDescribe } from "../deploy.js";

test("resolveServiceImageFromDescribe reads service image from spec.template.spec.containers", () => {
  const image = resolveServiceImageFromDescribe({
    spec: {
      template: {
        spec: {
          containers: [{ image: "us-east1-docker.pkg.dev/project/repo/api:123" }],
        },
      },
    },
  });

  assert.equal(image, "us-east1-docker.pkg.dev/project/repo/api:123");
});

test("resolveServiceImageFromDescribe reads service image from template.containers", () => {
  const image = resolveServiceImageFromDescribe({
    template: {
      containers: [{ image: "us-east1-docker.pkg.dev/project/repo/api:456" }],
    },
  });

  assert.equal(image, "us-east1-docker.pkg.dev/project/repo/api:456");
});

test("resolveServiceImageFromDescribe hard-fails when image is missing", () => {
  assert.throws(
    () => resolveServiceImageFromDescribe({ spec: { template: { spec: { containers: [] } } } }),
    /Could not resolve deployed service image/i,
  );
});

test("resolveServiceConfig preserves production defaults", () => {
  assert.deepEqual(resolveServiceConfig({}), {
    port: "3000",
    cpu: "2",
    memory: "4Gi",
    minInstances: "1",
    maxInstances: "30",
    concurrency: "80",
    timeout: "1800",
  });
});

test("resolveServiceConfig reads Cloud Run knobs from env", () => {
  assert.deepEqual(resolveServiceConfig({
    API_CLOUD_RUN_PORT: "8080",
    API_CLOUD_RUN_CPU: "4",
    API_CLOUD_RUN_MEMORY: "8Gi",
    API_CLOUD_RUN_MIN_INSTANCES: "2",
    API_CLOUD_RUN_MAX_INSTANCES: "250",
    API_CLOUD_RUN_CONCURRENCY: "120",
    API_CLOUD_RUN_TIMEOUT: "900",
  }), {
    port: "8080",
    cpu: "4",
    memory: "8Gi",
    minInstances: "2",
    maxInstances: "250",
    concurrency: "120",
    timeout: "900",
  });
});
