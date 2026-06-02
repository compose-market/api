/**
 * Canonical inference surface.
 *
 * Single import point for the inference kernel. Mirrors what
 * `@compose-market/x402-inference` exposes once it is published — keeping
 * the api server and the package in lock-step.
 *
 * Boundary:
 *   - `streamWithTools` / `generateWithTools` ASK the model and emit
 *     canonical events / output. They DO NOT execute tools.
 *   - `retrieveJob` / `cancelJob` operate on async media jobs.
 *   - Tool execution is a CALLER concern (the gateway / runtime / agent
 *     framework decides when and how to dispatch). Convenience helpers
 *     `runStream` / `runGenerate` (Phase 7) will compose this surface
 *     with caller-supplied tool execute functions.
 */

export {
  generateWithTools,
  streamWithTools,
  retrieveJob,
  cancelJob,
  type AdapterTarget,
  type AdapterResult,
  type AdapterStatus,
} from "./catalog/adapter.js";
export {
  generate,
  stream,
  retrieve,
  cancel,
  resolve,
  type Run,
} from "./engine.js";

export type {
  Request,
  Message,
  Part,
  Tool,
  Choice,
  Call,
  Output,
  Result,
  Usage,
  Event,
  Mode,
  Modality,
  Model,
  Schema,
} from "./core.js";

export type {
  ModelCard,
  ModelProvider,
} from "./types.js";
