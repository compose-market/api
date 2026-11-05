import "dotenv/config";

import assert from "node:assert/strict";
import test, { after, before } from "node:test";

import { handler } from "../handler.js";
import { getFacilitatorSupported } from "../x402/facilitator.js";
import { isServiceAllowedNetwork, isServiceBlockedNetwork, isTestnetNetwork } from "../x402/configs/chains.js";

const ORIGINAL_ENV = {
  FACILITATOR_KEY: process.env.FACILITATOR_KEY,
  MERCHANT_WALLET_ADDRESS: process.env.MERCHANT_WALLET_ADDRESS,
  AVALANCHE_MAINNET_RPC: process.env.AVALANCHE_MAINNET_RPC,
  SOLANA_MAINNET_RPC: process.env.SOLANA_MAINNET_RPC,
  SVM_TREASURY_SERVER_WALLET_PUBLIC: process.env.SVM_TREASURY_SERVER_WALLET_PUBLIC,
};

function createEvent(
  method: string,
  rawPath: string,
  body?: unknown,
  headers?: Record<string, string>,
) {
  return {
    rawPath,
    requestContext: { http: { method } },
    headers: { ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  };
}

before(() => {
  process.env.FACILITATOR_KEY = ORIGINAL_ENV.FACILITATOR_KEY || `0x${"11".repeat(32)}`;
  process.env.MERCHANT_WALLET_ADDRESS =
    ORIGINAL_ENV.MERCHANT_WALLET_ADDRESS || "0x2222222222222222222222222222222222222222";
  process.env.SVM_TREASURY_SERVER_WALLET_PUBLIC =
    ORIGINAL_ENV.SVM_TREASURY_SERVER_WALLET_PUBLIC || "11111111111111111111111111111111";
  delete process.env.SOLANA_MAINNET_RPC;
});

after(() => {
  if (ORIGINAL_ENV.FACILITATOR_KEY) process.env.FACILITATOR_KEY = ORIGINAL_ENV.FACILITATOR_KEY;
  if (ORIGINAL_ENV.MERCHANT_WALLET_ADDRESS) process.env.MERCHANT_WALLET_ADDRESS = ORIGINAL_ENV.MERCHANT_WALLET_ADDRESS;
  if (ORIGINAL_ENV.AVALANCHE_MAINNET_RPC) process.env.AVALANCHE_MAINNET_RPC = ORIGINAL_ENV.AVALANCHE_MAINNET_RPC;
  if (ORIGINAL_ENV.SOLANA_MAINNET_RPC) process.env.SOLANA_MAINNET_RPC = ORIGINAL_ENV.SOLANA_MAINNET_RPC;
  if (ORIGINAL_ENV.SVM_TREASURY_SERVER_WALLET_PUBLIC) process.env.SVM_TREASURY_SERVER_WALLET_PUBLIC = ORIGINAL_ENV.SVM_TREASURY_SERVER_WALLET_PUBLIC;
});

test("facilitator still supports all testnets for third-party products", async () => {
  const supported = await getFacilitatorSupported();
  const networks = new Set(supported.kinds.map((k) => k.network));

  // Third-party testnets MUST be supported by facilitator
  assert.ok(networks.has("eip155:421614"), "Arbitrum Sepolia in facilitator");
  assert.ok(networks.has("eip155:43113"), "Avalanche Fuji in facilitator");
  assert.ok(networks.has("eip155:1328"), "Sei Testnet in facilitator");
  assert.ok(networks.has("eip155:42431"), "Tempo Moderato in facilitator");
  assert.ok(networks.has("eip155:84532"), "Base Sepolia in facilitator");
  assert.ok(networks.has("solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1"), "Solana Devnet in facilitator");

  // Mainnets must also be in facilitator
  assert.ok(networks.has("eip155:8453"), "Base mainnet in facilitator");
  assert.ok(networks.has("eip155:42161"), "Arbitrum mainnet in facilitator");
  assert.ok(networks.has("eip155:43114"), "Avalanche mainnet in facilitator");
  assert.ok(networks.has("eip155:5042"), "Arc mainnet in facilitator");
  assert.ok(networks.has("eip155:1329"), "Sei mainnet in facilitator");
});

test("helper functions classify testnets and service allowance correctly", () => {
  // Testnets
  assert.equal(isTestnetNetwork("eip155:421614"), true);
  assert.equal(isTestnetNetwork("eip155:43113"), true);
  assert.equal(isTestnetNetwork("eip155:1328"), true);
  assert.equal(isTestnetNetwork("eip155:42431"), true);
  assert.equal(isTestnetNetwork("solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1"), true);
  assert.equal(isTestnetNetwork("eip155:84532"), true);

  // Mainnets
  assert.equal(isTestnetNetwork("eip155:8453"), false);
  assert.equal(isTestnetNetwork("eip155:42161"), false);
  assert.equal(isTestnetNetwork("eip155:43114"), false);
  assert.equal(isTestnetNetwork("eip155:5042"), false);
  assert.equal(isTestnetNetwork("eip155:1329"), false);

  // Service allowed: all mainnets + Base Sepolia & temporary NEAR Testnet exception for E2E testing
  assert.equal(isServiceAllowedNetwork("eip155:84532"), true);
  // TEMP(near:testnet): flip back when removing near:testnet exception
  assert.equal(isServiceAllowedNetwork("near:testnet"), true);
  assert.equal(isServiceAllowedNetwork("near:mainnet"), true);
  assert.equal(isServiceAllowedNetwork("eip155:8453"), true);
  assert.equal(isServiceAllowedNetwork("eip155:42161"), true);
  assert.equal(isServiceAllowedNetwork("eip155:43114"), true);
  assert.equal(isServiceAllowedNetwork("eip155:5042"), true);
  assert.equal(isServiceAllowedNetwork("eip155:1329"), true);

  // Service blocked: all other testnets
  assert.equal(isServiceBlockedNetwork("eip155:421614"), true);
  assert.equal(isServiceBlockedNetwork("eip155:43113"), true);
  assert.equal(isServiceBlockedNetwork("eip155:1328"), true);
  assert.equal(isServiceBlockedNetwork("eip155:42431"), true);
  assert.equal(isServiceBlockedNetwork("solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1"), true);

  // Not blocked: Base Sepolia, temporary NEAR Testnet, and mainnets
  assert.equal(isServiceBlockedNetwork("eip155:84532"), false);
  assert.equal(isServiceBlockedNetwork("near:testnet"), false);
  assert.equal(isServiceBlockedNetwork("eip155:8453"), false);
});

test("Compose Market service entrypoints reject blocked testnets with 400", async () => {
  const blockedTestnets = [
    "eip155:421614",
    "eip155:43113",
    "eip155:1328",
    "eip155:42431",
    "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
  ];

  for (const network of blockedTestnets) {
    const expectedError = `Network ${network} is not supported for this service. Use a Mainnet, or ask for Testnet access.`;

    const modelsRes = await handler(
      createEvent("POST", "/models/", {}, { "x-network-id": network }),
      {},
    );
    assert.equal(modelsRes.statusCode, 400, `POST /models/ with ${network} should return 400`);
    assert.ok(
      modelsRes.body.includes(expectedError),
      `Expected error message for ${network}: got ${modelsRes.body}`,
    );

    const intentRes = await handler(
      createEvent("POST", "/api/payments/prepare", {}, { "x-network-id": network }),
      {},
    );
    assert.equal(intentRes.statusCode, 400, `POST /api/payments/prepare with ${network} should return 400`);
    assert.ok(intentRes.body.includes(expectedError));

    const runtimeIntentRes = await handler(
      createEvent("POST", "/api/payments/prepare", { service: "runtime" }, { "x-network-id": network }),
      {},
    );
    assert.equal(runtimeIntentRes.statusCode, 400, `POST /api/payments/prepare (service=runtime) with ${network} should return 400`);
    assert.ok(runtimeIntentRes.body.includes(expectedError));
  }
});

test("Universal facilitator session and key endpoints accept testnets without service network denial", async () => {
  const testCases = [
    { network: "eip155:421614", address: "0x2222222222222222222222222222222222222222" }, // Arbitrum Sepolia
    { network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1", address: "11111111111111111111111111111111" }, // Solana Devnet
  ];

  for (const { network, address } of testCases) {
    const sessionRes = await handler(
      createEvent("GET", "/api/session", undefined, {
        "x-network-id": network,
        "x-session-user-address": address,
      }),
      {},
    );
    assert.equal(sessionRes.statusCode, 200, `GET /api/session with ${network} should return 200`);
    assert.equal(JSON.parse(sessionRes.body).hasSession, false);

    const keyRes = await handler(
      createEvent(
        "POST",
        "/api/keys",
        { purpose: "session", budgetLimit: 1000000, expiresAt: Date.now() + 60000 },
        {
          "x-network-id": network,
          "x-session-user-address": address,
        },
      ),
      {},
    );
    // Must NOT fail with "Network ... is not supported for this service"
    assert.ok(
      !keyRes.body.includes("is not supported for this service"),
      `POST /api/keys should not block testnet ${network} with service denial: got ${keyRes.body}`,
    );
  }
});