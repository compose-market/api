import assert from "node:assert/strict";
import test from "node:test";

import {
  buildComposioUserId,
  buildToolRouterSessionConfig,
} from "../backpack/accounts.js";

test("buildComposioUserId derives a stable user-scoped Composio user id", () => {
  assert.equal(
    buildComposioUserId("0xABCD000000000000000000000000000000000123"),
    "compose:0xabcd000000000000000000000000000000000123",
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
