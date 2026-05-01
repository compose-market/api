import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAgentScopedComposioUserId,
  buildToolRouterSessionConfig,
} from "../backpack/composio.js";

test("buildAgentScopedComposioUserId derives a stable per-agent Composio user id", () => {
  assert.equal(
    buildAgentScopedComposioUserId(
      "0xABCD000000000000000000000000000000000123",
      "0xDeFf000000000000000000000000000000000456",
    ),
    "mesh:0xabcd000000000000000000000000000000000123:agent:0xdeff000000000000000000000000000000000456",
  );
});

test("buildToolRouterSessionConfig enables Composio session autonomy features", () => {
  const config = buildToolRouterSessionConfig("https://compose.market/auth-success.html");

  assert.deepEqual(config.manage_connections, {
    enable: true,
    enable_connection_removal: true,
    enable_wait_for_connections: true,
    callback_url: "https://compose.market/auth-success.html",
  });
  assert.deepEqual(config.multi_account, {
    enable: true,
    max_accounts_per_toolkit: 10,
    require_explicit_selection: true,
  });
  assert.deepEqual(config.workbench, {
    enable: true,
    enable_proxy_execution: true,
    auto_offload_threshold: 20_000,
  });
});
