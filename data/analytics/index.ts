import type { Application } from "express";

import { register as registerRoutes } from "./inference/routes.js";
import { record, recordSettlement } from "./inference/store.js";
import { setInferenceSettlementSink, setInferenceTelemetrySink } from "../../inference/events.js";

let sinkRegistered = false;

export function registerAnalyticsRoutes(app: Application): void {
  if (!sinkRegistered) {
    setInferenceTelemetrySink(({ request, settlements }) => record(request, settlements));
    setInferenceSettlementSink((lifecycle, settlement) => recordSettlement(lifecycle, settlement));
    sinkRegistered = true;
  }
  registerRoutes(app);
}
