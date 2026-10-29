import "dotenv/config";

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import test from "node:test";

import express from "express";

import { handler, registerHandlerRoutes } from "../handler.js";
import { registerUtilityRoutes } from "../routes.js";

function source(relativePath: string): string {
  return readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");
}

async function withServer<T>(
  app: express.Application,
  run: (baseUrl: string) => Promise<T>,
): Promise<T> {
  const server = createServer(app);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const { port } = server.address() as AddressInfo;

  try {
    return await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}
