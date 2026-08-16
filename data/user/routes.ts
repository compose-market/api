import type { Application, NextFunction, Request, Response } from "express";

import { getWalletPair, putWalletPair, getUserConsent, putUserConsent } from "./store.js";
import type { WalletPair, UserConsentRecord, RecordConsentInput, ConsentLookupQuery, ConsentStatusResponse } from "./types.js";
import { parsePairBody, parsePairLookupAddress, parseConsentBody, parseConsentLookup } from "./validation.js";

export interface UserRouteDependencies {
  putPair?: (pair: WalletPair) => Promise<WalletPair>;
  findPair?: (address: string) => Promise<WalletPair | null>;
  putConsent?: (consent: RecordConsentInput) => Promise<UserConsentRecord>;
  findConsent?: (lookup: ConsentLookupQuery) => Promise<UserConsentRecord | null>;
}

function missingPair(): Error & { statusCode: number } {
  const error = new Error("Wallet pair not found") as Error & { statusCode: number };
  error.statusCode = 404;
  return error;
}

export function registerUserRoutes(
  app: Application,
  dependencies: UserRouteDependencies = {},
): void {
  const putPair = dependencies.putPair ?? putWalletPair;
  const findPair = dependencies.findPair ?? getWalletPair;
  const putConsent = dependencies.putConsent ?? putUserConsent;
  const findConsent = dependencies.findConsent ?? getUserConsent;

  app.put("/api/user", (request: Request, response: Response, next: NextFunction) => {
    let pair: WalletPair;
    try {
      pair = parsePairBody(request.body);
    } catch (error) {
      next(error);
      return;
    }
    void putPair(pair).then((stored) => response.status(200).json(stored)).catch(next);
  });

  const handleConsentPost = (request: Request, response: Response, next: NextFunction) => {
    let consent: RecordConsentInput;
    try {
      consent = parseConsentBody(request.body);
    } catch (error) {
      next(error);
      return;
    }
    void putConsent(consent).then((stored) => response.status(200).json(stored)).catch(next);
  };

  app.post("/api/user/consent", handleConsentPost);
  app.put("/api/user/consent", handleConsentPost);

  app.get("/api/user/consent/:address", (request: Request, response: Response, next: NextFunction) => {
    let lookup: ConsentLookupQuery;
    try {
      lookup = parseConsentLookup(request.params.address, request.query as Record<string, unknown>);
    } catch (error) {
      next(error);
      return;
    }
    void findConsent(lookup)
      .then((record) => {
        const result: ConsentStatusResponse = {
          consented: record !== null,
          evmAddress: record?.evmAddress ?? null,
          svmAddress: record?.svmAddress ?? null,
          record,
        };
        response.status(200).json(result);
      })
      .catch(next);
  });

  app.get("/api/user/:address", (request: Request, response: Response, next: NextFunction) => {
    let address: string;
    try {
      address = parsePairLookupAddress(request.params.address).value;
    } catch (error) {
      next(error);
      return;
    }
    void findPair(address)
      .then((pair) => {
        if (!pair) throw missingPair();
        response.status(200).json(pair);
      })
      .catch(next);
  });
}
