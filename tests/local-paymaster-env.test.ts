import test from "node:test";
import assert from "node:assert/strict";

import { loadSynapseRouteConfig } from "../local/paymaster.js";

test("loadSynapseRouteConfig pins compose mesh anchors to the compose namespace", () => {
  const config = loadSynapseRouteConfig({
    SYNAPSE_NETWORK: 'calibration   # "calibration" | "mainnet"',
    SYNAPSE_WALLET_PRIVATE_KEY: "53ebcede8386464068dec41e2ac15edad69fbeafab394c0c4037263309ccfd59   # payer",
    SYNAPSE_PROJECT_NAMESPACE: "wrong-namespace   # ignored for compose mesh anchors",
    FILECOIN_CALIBRATION_RPC: "https://rpc.example   # calibration rpc",
  });

  assert.equal(config.network, "calibration");
  assert.equal(config.source, "compose");
  assert.equal(config.rpcUrl, "https://rpc.example");
  assert.equal(
    config.walletPrivateKey,
    "0x53ebcede8386464068dec41e2ac15edad69fbeafab394c0c4037263309ccfd59",
  );
});
