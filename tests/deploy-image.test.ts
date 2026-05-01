import assert from "node:assert/strict";
import test from "node:test";

import { resolveServiceImageFromDescribe } from "../deploy.js";

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
