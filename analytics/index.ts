import type { Application } from "express";

import { register as registerRoutes } from "./inference/routes.js";
import { record } from "./inference/store.js";
import { setInferenceTelemetrySink } from "../inference/events.js";

let sinkRegistered = false;

export function registerAnalyticsRoutes(app: Application): void {
  if (!sinkRegistered) {
    setInferenceTelemetrySink(({ request, settlements }) => record(request, settlements));
    sinkRegistered = true;
  }
  registerRoutes(app);
}
