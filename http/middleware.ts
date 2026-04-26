/**
 * Request-Id + CORS + error-envelope Express middleware stack.
 *
 * Applied once at the root of api/ (see index.ts). Guarantees:
 *  - Every response, streaming or not, carries a canonical X-Request-Id header
 *    (either supplied by the caller if syntactically safe, or freshly minted).
 *  - Every response carries the canonical CORS policy (Vary: Origin, explicit
 *    Expose-Headers). Preflight OPTIONS requests short-circuit here.
 *  - `res.locals.requestId` is always set so downstream handlers can log and
 *    propagate the id without reaching for the header.
 */

import type { NextFunction, Request, Response } from "express";
import { corsMiddleware } from "./cors.js";
import { REQUEST_ID_HEADER, resolveRequestId } from "./request-context.js";

export function requestIdMiddleware() {
    return (req: Request, res: Response, next: NextFunction): void => {
        const requestId = resolveRequestId(
            req.headers as Record<string, string | string[] | undefined>,
        );
        (res.locals as Record<string, unknown>).requestId = requestId;
        res.setHeader(REQUEST_ID_HEADER, requestId);
        next();
    };
}

export function readRequestId(res: Response): string | undefined {
    const value = (res.locals as Record<string, unknown>).requestId;
    return typeof value === "string" ? value : undefined;
}

export { corsMiddleware };
