import type { Application, NextFunction, Request, Response } from "express";

import { getWalletPair, putWalletPair } from "./store.js";
import type { WalletPair } from "./types.js";
import { parsePairBody, parsePairLookupAddress } from "./validation.js";

export interface UserRouteDependencies {
  putPair?: (pair: WalletPair) => Promise<WalletPair>;
  findPair?: (address: string) => Promise<WalletPair | null>;
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
