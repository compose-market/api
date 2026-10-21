/**
 * Tests for the ChainGPT chat relay route (`POST /chaingpt/chat`,
 * `api/handler.ts:handleChaingptRoutes` + `api/chaingpt.ts`).
 *
 * The connectors Worker cannot reach api.chaingpt.org (its Cloudflare-zone
 * edge rejects Worker-originated requests with TLS version "none"), so it
 * relays edge-gated ChainGPT calls through the api's GCP egress. The route
 * is internal-token gated with the same machinery as `/gated/resolve`;
 * first-party CHAIN_GPT_SECRET_KEY only.
 */
import "dotenv/config";

import test, { after } from "node:test";
import assert from "node:assert/strict";

import { handler } from "../handler.js";
import { callChainGptChat } from "../chaingpt.js";

const ORIGINAL_FETCH = globalThis.fetch;
let lastFetchUrl: string | null = null;
let lastFetchBody: string | null = null;