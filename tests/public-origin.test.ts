import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_PUBLIC_ORIGIN,
  isPublicHost,
  publicOriginFromHost,
} from "../http/public-origin.js";

test("publicOriginFromHost accepts only configured public domains", () => {
  assert.equal(publicOriginFromHost("api.compose.market"), DEFAULT_PUBLIC_ORIGIN);
  assert.equal(publicOriginFromHost("api.inference.diy"), "https://api.inference.diy");
  assert.equal(publicOriginFromHost("API.INFERENCE.DIY:443"), "https://api.inference.diy");
  assert.equal(publicOriginFromHost("attacker.example"), DEFAULT_PUBLIC_ORIGIN);
  assert.equal(publicOriginFromHost("api.inference.diy, attacker.example"), "https://api.inference.diy");
  assert.equal(isPublicHost("api.inference.diy"), true);
  assert.equal(isPublicHost("attacker.example"), false);
});
