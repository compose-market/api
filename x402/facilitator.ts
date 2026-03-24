import { x402Facilitator } from "@x402/core/facilitator";
import {
    decodePaymentSignatureHeader,
    encodePaymentRequiredHeader,
    encodePaymentResponseHeader,
} from "@x402/core/http";
import {
    PaymentPayloadSchema,
    PaymentRequirementsSchema,
    validatePaymentPayload,
    validatePaymentRequired,
    validatePaymentRequirements,
    z,
} from "@x402/core/schemas";
import type {
    FacilitatorExtension,
    PaymentPayload,
    PaymentRequired,
    PaymentRequirements,
    SettleResponse,
    SupportedResponse,
    VerifyResponse,
} from "@x402/core/types";
import { ExactEvmScheme } from "@x402/evm/exact/facilitator";
import { toFacilitatorEvmSigner } from "@x402/evm";
import { createPublicClient, createWalletClient, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import {
    CHAIN_CONFIG,
    type ChainId,
    getChainConfig,
    getRpcUrl,
    getSupportedChainIds,
    getUsdcAddress,
    getViemChain,
} from "./configs/chains.js";
import { merchantWalletAddress } from "./wallets.js";

export const COMPOSE_METERING_EXTENSION_KEY = "compose-metering-v1";
export const COMPOSE_PAYMENT_INTENT_EXTENSION_KEY = "compose-payment-intent-v1";

const FACILITATOR_VERIFY_REQUEST_SCHEMA = z.object({
    x402Version: z.literal(2),
    paymentPayload: PaymentPayloadSchema,
    paymentRequirements: PaymentRequirementsSchema,
}).strict();

const FACILITATOR_SETTLE_REQUEST_SCHEMA = FACILITATOR_VERIFY_REQUEST_SCHEMA;

const composeFacilitatorExtensions: FacilitatorExtension[] = [
    { key: COMPOSE_METERING_EXTENSION_KEY },
    { key: COMPOSE_PAYMENT_INTENT_EXTENSION_KEY },
];

const signerCache = new Map<ChainId, ReturnType<typeof toFacilitatorEvmSigner>>();
let facilitatorSingleton: x402Facilitator | null = null;

function assertCaip2Network(network: string): `${string}:${string}` {
    if (!network.includes(":")) {
        throw new Error(`Invalid CAIP-2 network identifier: ${network}`);
    }
    return network as `${string}:${string}`;
}

function parseV2PaymentRequirements(input: unknown): PaymentRequirements {
    const parsed = validatePaymentRequirements(input);
    if (!("amount" in parsed)) {
        throw new Error("Only x402 v2 payment requirements are supported");
    }

    return {
        scheme: parsed.scheme,
        network: assertCaip2Network(parsed.network),
        asset: parsed.asset,
        amount: parsed.amount,
        payTo: parsed.payTo,
        maxTimeoutSeconds: parsed.maxTimeoutSeconds,
        extra: parsed.extra ?? {},
    };
}

function parseV2PaymentRequired(input: unknown): PaymentRequired {
    const parsed = validatePaymentRequired(input);
    if (!("resource" in parsed)) {
        throw new Error("Only x402 v2 payment-required payloads are supported");
    }

    return {
        x402Version: 2,
        error: parsed.error,
        resource: parsed.resource,
        accepts: parsed.accepts.map((accept) => parseV2PaymentRequirements(accept)),
        ...(parsed.extensions ? { extensions: parsed.extensions } : {}),
    };
}

function parseV2PaymentPayload(input: unknown): PaymentPayload {
    const parsed = validatePaymentPayload(input);
    if (!("accepted" in parsed)) {
        throw new Error("Only x402 v2 payment payloads are supported");
    }

    return {
        x402Version: 2,
        accepted: parseV2PaymentRequirements(parsed.accepted),
        payload: parsed.payload,
        ...(parsed.resource ? { resource: parsed.resource } : {}),
        ...(parsed.extensions ? { extensions: parsed.extensions } : {}),
    };
}

function getFacilitatorAccount() {
    const privateKey = process.env.DEPLOYER_KEY;
    if (!privateKey) {
        throw new Error("DEPLOYER_KEY environment variable is required for the Compose facilitator");
    }

    return privateKeyToAccount((privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`) as Hex);
}

function getConfiguredFacilitatorChainIds(): ChainId[] {
    return getSupportedChainIds().filter((chainId) => {
        const config = CHAIN_CONFIG[chainId];
        return Boolean(config && process.env[config.rpcEnvVar]);
    });
}

function createExactSchemeForChain(chainId: ChainId) {
    const cached = signerCache.get(chainId);
    if (cached) {
        return new ExactEvmScheme(cached);
    }

    const chain = getViemChain(chainId);
    const rpcUrl = getRpcUrl(chainId);
    const account = getFacilitatorAccount();
    const publicClient = createPublicClient({
        chain,
        transport: http(rpcUrl),
    });
    const walletClient = createWalletClient({
        account,
        chain,
        transport: http(rpcUrl),
    });

    const signer = toFacilitatorEvmSigner({
        address: account.address,
        readContract: (args) => publicClient.readContract(args),
        verifyTypedData: (args) => publicClient.verifyTypedData(args as never),
        writeContract: (args) =>
            walletClient.writeContract({
                ...args,
                account,
                chain,
            }),
        sendTransaction: (args) =>
            walletClient.sendTransaction({
                ...args,
                account,
                chain,
            }),
        waitForTransactionReceipt: (args) => publicClient.waitForTransactionReceipt(args),
        getCode: (args) => publicClient.getCode(args),
    });

    signerCache.set(chainId, signer);
    return new ExactEvmScheme(signer);
}

function createComposeFacilitator(): x402Facilitator {
    const chainIds = getConfiguredFacilitatorChainIds();
    if (chainIds.length === 0) {
        throw new Error("Compose facilitator has no configured EVM chains");
    }

    const facilitator = new x402Facilitator();
    for (const extension of composeFacilitatorExtensions) {
        facilitator.registerExtension(extension);
    }

    for (const chainId of chainIds) {
        facilitator.register(`eip155:${chainId}`, createExactSchemeForChain(chainId));
    }

    return facilitator;
}

export function getComposeFacilitator(): x402Facilitator {
    if (!facilitatorSingleton) {
        facilitatorSingleton = createComposeFacilitator();
    }
    return facilitatorSingleton;
}

export function getComposeFacilitatorSupported(): SupportedResponse {
    const supported = getComposeFacilitator().getSupported();
    return {
        kinds: supported.kinds.map((kind) => ({
            x402Version: kind.x402Version,
            scheme: kind.scheme,
            network: assertCaip2Network(kind.network),
            ...(kind.extra ? { extra: kind.extra } : {}),
        })),
        extensions: [...supported.extensions],
        signers: supported.signers,
    };
}

export function createComposePaymentExtensions(): Record<string, unknown> {
    return {
        [COMPOSE_METERING_EXTENSION_KEY]: {
            mode: "authoritative_usage",
            meterEndpoint: "/api/payments/meter/model",
        },
        [COMPOSE_PAYMENT_INTENT_EXTENSION_KEY]: {
            authorizeEndpoint: "/api/payments/prepare",
            settleEndpoint: "/api/payments/settle",
            abortEndpoint: "/api/payments/abort",
        },
    };
}

export function createComposePaymentRequirement(input: {
    amountWei: number | string;
    chainId: number;
    payTo?: `0x${string}`;
    maxTimeoutSeconds?: number;
}): PaymentRequirements {
    return parseV2PaymentRequirements({
        scheme: "exact",
        network: `eip155:${input.chainId}`,
        amount: String(input.amountWei),
        asset: getUsdcAddress(input.chainId),
        payTo: input.payTo || merchantWalletAddress,
        maxTimeoutSeconds: input.maxTimeoutSeconds ?? 300,
        extra: {
            compose: {
                metering: "authoritative_usage",
                intents: "supported",
            },
        },
    });
}

export function createComposePaymentRequired(input: {
    amountWei: number | string;
    chainId: number;
    resourceUrl: string;
    description: string;
    mimeType: string;
    error?: string;
}): PaymentRequired {
    return parseV2PaymentRequired({
        x402Version: 2,
        error: input.error,
        resource: {
            url: input.resourceUrl,
            description: input.description,
            mimeType: input.mimeType,
        },
        accepts: [createComposePaymentRequirement({
            amountWei: input.amountWei,
            chainId: input.chainId,
        })],
        extensions: createComposePaymentExtensions(),
    });
}

export function encodeComposePaymentRequiredHeader(paymentRequired: PaymentRequired): string {
    return encodePaymentRequiredHeader(paymentRequired);
}

export function encodeComposePaymentResponseHeader(settleResponse: SettleResponse): string {
    return encodePaymentResponseHeader(settleResponse);
}

export function decodeComposePaymentSignatureHeader(paymentData: string): PaymentPayload {
    return parseV2PaymentPayload(decodePaymentSignatureHeader(paymentData));
}

export function getChainIdFromPaymentPayload(paymentPayload: PaymentPayload): number {
    if (paymentPayload.x402Version !== 2) {
        throw new Error(`Unsupported x402 version: ${paymentPayload.x402Version}`);
    }

    const [, chainIdPart] = paymentPayload.accepted.network.split(":");
    const chainId = Number.parseInt(chainIdPart || "", 10);
    if (!Number.isInteger(chainId) || chainId <= 0) {
        throw new Error(`Invalid payment network: ${paymentPayload.accepted.network}`);
    }

    return chainId;
}

export async function verifyComposePayment(
    paymentPayload: PaymentPayload,
    paymentRequirements: PaymentRequirements,
): Promise<VerifyResponse> {
    return getComposeFacilitator().verify(paymentPayload, paymentRequirements);
}

export async function settleComposePayment(
    paymentPayload: PaymentPayload,
    paymentRequirements: PaymentRequirements,
): Promise<SettleResponse> {
    return getComposeFacilitator().settle(paymentPayload, paymentRequirements);
}

export function parseComposeFacilitatorVerifyRequest(body: unknown): {
    paymentPayload: PaymentPayload;
    paymentRequirements: PaymentRequirements;
} {
    const parsed = FACILITATOR_VERIFY_REQUEST_SCHEMA.parse(body);
    return {
        paymentPayload: parseV2PaymentPayload(parsed.paymentPayload),
        paymentRequirements: parseV2PaymentRequirements(parsed.paymentRequirements),
    };
}

export function parseComposeFacilitatorSettleRequest(body: unknown): {
    paymentPayload: PaymentPayload;
    paymentRequirements: PaymentRequirements;
} {
    const parsed = FACILITATOR_SETTLE_REQUEST_SCHEMA.parse(body);
    return {
        paymentPayload: parseV2PaymentPayload(parsed.paymentPayload),
        paymentRequirements: parseV2PaymentRequirements(parsed.paymentRequirements),
    };
}

export function getComposeFacilitatorChainMetadata(): Array<{
    chainId: number;
    name: string;
    network: `eip155:${number}`;
}> {
    return getConfiguredFacilitatorChainIds().map((chainId) => ({
        chainId,
        name: getChainConfig(chainId).name,
        network: `eip155:${chainId}`,
    }));
}
