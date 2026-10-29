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
