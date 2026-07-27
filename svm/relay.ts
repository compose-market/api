/**
 * Solana fee-payer signing relay.
 *
 * This module is a GENERIC Solana transaction relay — it has zero knowledge
 * of Swig, account derivation, or any application-level semantics. It does
 * exactly one thing: sign a client-built unsigned transaction as the
 * fee-payer (using SVM_FACILITATOR_KEY) and submit it to the requested
 * Solana RPC endpoint.
 *
 * This is the Solana equivalent of the EVM paymaster/bundler: the client
 * builds the entire transaction (account creation, instructions, etc.) and
 * this endpoint only adds the fee-payer signature and broadcasts. The
 * facilitator key never leaves the server.
 *
 * Validation:
 *   - The fee-payer field in the decoded transaction MUST match the
 *     facilitator's public address (so we never sign as someone else).
 *   - Preflight simulation is enabled so the runtime rejects invalid txs
 *     before they land.
 *   - All relay requests are logged for audit.
 */

import type { Application, Request, Response } from "express";
import { base58, base64 } from "@scure/base";
import {
    createKeyPairSignerFromBytes,
    createSolanaRpc,
    devnet as solanaDevnet,
    getBase64EncodedWireTransaction,
    getTransactionDecoder,
    // mainnet as solanaMainnet,
    partiallySignTransaction,
} from "@solana/kit";
import {
    isSolanaNetwork,
    type SolanaNetworkId,
    getNetworkRpcUrl,
    NETWORK_IDS,
} from "../x402/configs/chains.js";
import { buildError } from "../http/errors.js";

const SVM_CONFIRM_ATTEMPTS = 30;
const SVM_CONFIRM_DELAY_MS = 1_000;
const SVM_MAX_TX_BYTES = 1232;

let cachedFeePayerAddress: string | null = null;
let cachedFeePayerSigner: Awaited<ReturnType<typeof createKeyPairSignerFromBytes>> | null = null;

type DecodedRelayTransaction = {
    signatures: Readonly<Record<string, Uint8Array | null>>;
};

export function getRelayRequiredSignerAddresses(transaction: DecodedRelayTransaction): string[] {
    return Object.keys(transaction.signatures);
}

export function getMissingRelaySignatures(transaction: DecodedRelayTransaction): string[] {
    return Object.entries(transaction.signatures)
        .filter(([, signature]) => !signature)
        .map(([address]) => address);
}

export function validateRelayFeePayerSigner(
    transaction: DecodedRelayTransaction,
    facilitatorAddress: string,
): string | null {
    const [feePayer] = getRelayRequiredSignerAddresses(transaction);
    if (!feePayer) {
        return "transaction has no required fee-payer signature";
    }
    if (feePayer !== facilitatorAddress) {
        return `transaction fee payer must be ${facilitatorAddress}; got ${feePayer}`;
    }
    return null;
}

async function getFacilitatorSigner() {
    if (cachedFeePayerSigner) return cachedFeePayerSigner;
    const privateKey = process.env.SVM_FACILITATOR_KEY?.trim();
    if (!privateKey) {
        throw new Error("SVM_FACILITATOR_KEY environment variable required");
    }
    cachedFeePayerSigner = await createKeyPairSignerFromBytes(base58.decode(privateKey));
    cachedFeePayerAddress = cachedFeePayerSigner.address;
    return cachedFeePayerSigner;
}

async function getFacilitatorAddress(): Promise<string> {
    if (cachedFeePayerAddress) return cachedFeePayerAddress;
    const signer = await getFacilitatorSigner();
    return signer.address;
}

function createSvmRpc(network: SolanaNetworkId) {
    const rpcUrl = getNetworkRpcUrl(network);
    if (network === NETWORK_IDS.solanaDevnet) { return createSolanaRpc(solanaDevnet(rpcUrl)); }
    // if (network === NETWORK_IDS.solana) { return createSolanaRpc(solanaMainnet(rpcUrl)); }
    throw new Error(`Unsupported SVM network: ${network}`);
}

async function confirmSvmSignature(
    rpc: ReturnType<typeof createSvmRpc>,
    signature: string,
): Promise<void> {
    for (let attempt = 0; attempt < SVM_CONFIRM_ATTEMPTS; attempt += 1) {
        const status = await rpc.getSignatureStatuses([signature as never], {
            searchTransactionHistory: true,
        }).send();
        const current = status.value[0];
        if (current?.err) {
            throw new Error(`SVM relay transaction failed: ${JSON.stringify(current.err)}`);
        }
        if (
            current?.confirmationStatus === "confirmed"
            || current?.confirmationStatus === "finalized"
        ) {
            return;
        }
        await new Promise((resolve) => setTimeout(resolve, SVM_CONFIRM_DELAY_MS));
    }
    throw new Error("SVM relay transaction confirmation timeout");
}

export function registerSvmRoutes(app: Application): void {
    app.get("/api/svm/fee-payer", async (_req, res) => {
        try {
            const feePayer = await getFacilitatorAddress();
            res.json({ feePayer });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.error("[svm/fee-payer] Error:", message);
            res.status(500).json(buildError("internal_error", message));
        }
    });

    app.post("/api/svm/relay", async (req, res) => {
        try {
            const { unsignedTransaction, network } = req.body ?? {};

            if (typeof unsignedTransaction !== "string" || unsignedTransaction.length === 0) {
                res.status(400).json(buildError("validation_error", "unsignedTransaction (base64) is required"));
                return;
            }
            if (typeof network !== "string" || !isSolanaNetwork(network as SolanaNetworkId)) {
                res.status(400).json(buildError("validation_error", "network must be a supported solana: network id"));
                return;
            }

            const txBytes = base64.decode(unsignedTransaction);
            if (txBytes.byteLength > SVM_MAX_TX_BYTES) {
                res.status(400).json(buildError("validation_error", `transaction exceeds max size (${SVM_MAX_TX_BYTES} bytes)`));
                return;
            }

            const signer = await getFacilitatorSigner();

            const unsignedTx = getTransactionDecoder().decode(txBytes);
            const feePayerValidationError = validateRelayFeePayerSigner(unsignedTx, signer.address);
            if (feePayerValidationError) {
                res.status(400).json(buildError("validation_error", feePayerValidationError));
                return;
            }

            const rpc = createSvmRpc(network as SolanaNetworkId);

            const signedTx = await partiallySignTransaction([signer.keyPair], unsignedTx);
            const missingSignatures = getMissingRelaySignatures(signedTx);
            if (missingSignatures.length > 0) {
                res.status(400).json(buildError(
                    "validation_error",
                    `transaction is missing required signatures after fee-payer signing: ${missingSignatures.join(", ")}`,
                ));
                return;
            }
            const wireTx = getBase64EncodedWireTransaction(signedTx);

            const signature = await rpc.sendTransaction(wireTx, {
                encoding: "base64",
                preflightCommitment: "confirmed",
            }).send();

            const signatureStr = typeof signature === "string" ? signature : String(signature);

            console.log(`[svm/relay] Transaction submitted: ${signatureStr} (network: ${network})`);

            try {
                await confirmSvmSignature(rpc, signatureStr);
                console.log(`[svm/relay] Transaction confirmed: ${signatureStr}`);
            } catch (confirmError) {
                const message = confirmError instanceof Error ? confirmError.message : String(confirmError);
                console.error(`[svm/relay] Confirmation timeout for ${signatureStr}: ${message}`);
                res.status(202).json({ signature: signatureStr, confirmed: false });
                return;
            }

            res.json({ signature: signatureStr, confirmed: true });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.error("[svm/relay] Error:", message);
            const status = message.includes("Already") || message.includes("Blockhash") ? 409 : 500;
            res.status(status).json(buildError(
                status === 409 ? "conflict" : "internal_error",
                message,
            ));
        }
    });
}
