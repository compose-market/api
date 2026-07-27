import { insertRequest } from "./db.js";
import type { Settlement, StoredRequest } from "./types.js";
import type { InferenceTelemetryRecord } from "../../inference/events.js";

export async function record(request: InferenceTelemetryRecord["request"], settlements: InferenceTelemetryRecord["settlements"]): Promise<void> {
  await insertRequest(request as StoredRequest, settlements as Settlement[]);
}
