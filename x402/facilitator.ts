import { x402Facilitator } from "@x402/core/facilitator";
import {
    decodePaymentSignatureHeader as decodePaymentSignatureHeader_x402,
    encodePaymentRequiredHeader as encodePaymentRequiredHeader_x402,
    encodePaymentResponseHeader as encodePaymentResponseHeader_x402,
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
    SchemeNetworkFacilitator,
    SettleResponse,
    SupportedResponse,
    VerifyResponse,
} from "@x402/core/types";
import { ExactEvmScheme as ExactEvmFacilitator } from "@x402/evm/exact/facilitator";
import { UptoEvmScheme as UptoEvmFacilitator } from "@x402/evm/upto/facilitator";
import { BatchSettlementEvmScheme as BatchSettlementEvmFacilitator } from "@x402/evm/batch-settlement/facilitator";
import { toFacilitatorEvmSigner } from "@x402/evm";
import { toFacilitatorSvmSigner } from "@x402/svm";
import { ExactSvmScheme as ExactSvmFacilitator } from "@x402/svm/exact/facilitator";
import { createFacilitatorNearSigner } from "@x402/near";
import { ExactNearScheme as ExactNearFacilitator } from "@x402/near/exact/facilitator";
import { type KeyPairString } from "@near-js/crypto";
import {
    createKeyPairSignerFromBytes,
    address as solanaAddress,
    createSolanaRpc,
    devnet,
    getBase58Encoder,
    getPublicKeyFromAddress,
    getUtf8Encoder,
    mainnet,
    signatureBytes,
    verifySignature,
} from "@solana/kit";
import { base58 } from "@scure/base";
import { createPublicClient, createWalletClient, http, type Hex } from "viem";
import { nonceManager, privateKeyToAccount } from "viem/accounts";

import {
    type EvmNetworkId,
    type NearNetworkId,
    type NetworkId,
    NETWORK_IDS,
    getNetwork,
    getNetworkRpcUrl,
    getSupportedNetworks,
    getViemChain,
    isEvmNetwork,
    isNearNetwork,
    isSolanaNetwork,
    validateNearAddress,
    type SolanaNetworkId,
} from "./configs/chains.js";
import {
    commitNearBatchCharge,
    commitSvmBatchCharge,
    createBatchPaymentExtra,
    isBatchSettlementScheme,
    validateNearBatchPayment,
    validateSvmBatchPayment,
    verifyNearDetachedSignature,
} from "./batch.js";
import {
    settleKeyPaymentForNetwork,
    type KeyPaymentSettlementOptions,
    type SettlementResult,
} from "./settlement.js";
import {
    valkeyExists,
    valkeySetNXEX,
} from "./keys/valkey.js";

export const METERING_EXTENSION_KEY = "metering";
export const PAYMENT_INTENT_EXTENSION_KEY = "payment-intent";
export const COMPOSE_METERING_EXTENSION_KEY = METERING_EXTENSION_KEY;
export const COMPOSE_PAYMENT_INTENT_EXTENSION_KEY = PAYMENT_INTENT_EXTENSION_KEY;

const FACILITATOR_VERIFY_REQUEST_SCHEMA = z.object({
    x402Version: z.literal(2),
    paymentPayload: PaymentPayloadSchema,
    paymentRequirements: PaymentRequirementsSchema,
}).strict();

const FACILITATOR_SETTLE_REQUEST_SCHEMA = FACILITATOR_VERIFY_REQUEST_SCHEMA;

const facilitatorExtensions: FacilitatorExtension[] = [
    { key: METERING_EXTENSION_KEY },
    { key: PAYMENT_INTENT_EXTENSION_KEY },
];

const signerCache = new Map<EvmNetworkId, ReturnType<typeof toFacilitatorEvmSigner>>();
const batchSchemeCache = new Map<EvmNetworkId, BatchSettlementEvmFacilitator>();
let facilitatorSingleton: x402Facilitator | null = null;

function requireEnv(name: string): string {
    const value = process.env[name]?.trim();
    if (!value) {
        throw new Error(`${name} environment variable is required`);
    }
    return value;
}

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
    const privateKey = process.env.FACILITATOR_KEY;
    if (!privateKey) {
        throw new Error("FACILITATOR_KEY environment variable is required for the Compose facilitator");
    }

    return privateKeyToAccount((privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`) as Hex, { nonceManager });
}

function getReceiverAuthorizer() {
    const account = getFacilitatorAccount();
    return {
        address: account.address,
        signTypedData: (params: {
            domain: Record<string, unknown>;
            types: Record<string, unknown>;
            primaryType: string;
            message: Record<string, unknown>;
        }) => account.signTypedData(params as never),
    };
}

function getConfiguredFacilitatorNetworks(): NetworkId[] {
    return getSupportedNetworks()
        .filter((definition) => Boolean(process.env[definition.rpcEnvVar]))
        .map((definition) => definition.id);
}

function createExactSchemeForChain(network: EvmNetworkId) {
    const cached = signerCache.get(network);
    if (cached) {
        return new ExactEvmFacilitator(cached);
    }

    const chain = getViemChain(network);
    const rpcUrl = getNetworkRpcUrl(network);
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
        // Inject `account` into every readContract / eth_call so upstream
        // simulations (e.g. @x402/evm's `simulatePermit2Settle`) run with
        // `msg.sender = facilitator`. Without this, the x402UptoPermit2Proxy's
        // `settle()` call reverts during simulation because its own
        // `require(msg.sender == witness.facilitator)` check fails for the
        // zero-address caller the viem default uses. See @x402/evm
        // dist/cjs/upto/facilitator/index.js:634 `simulatePermit2Settle`.
        readContract: (args) => publicClient.readContract({ ...args, account }),
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

    signerCache.set(network, signer);
    return new ExactEvmFacilitator(signer);
}

function createUptoSchemeForChain(network: EvmNetworkId) {
    const cached = signerCache.get(network);
    if (cached) {
        return new UptoEvmFacilitator(cached);
    }

    createExactSchemeForChain(network);
    const signer = signerCache.get(network);
    if (!signer) {
        throw new Error(`Compose facilitator signer missing for network ${network}`);
    }

    return new UptoEvmFacilitator(signer);
}

function createBatchSchemeForChain(network: EvmNetworkId) {
    const cached = batchSchemeCache.get(network);
    if (cached) {
        return cached;
    }

    createExactSchemeForChain(network);
    const signer = signerCache.get(network);
    if (!signer) {
        throw new Error(`Compose facilitator signer missing for network ${network}`);
    }

    const scheme = new BatchSettlementEvmFacilitator(signer, getReceiverAuthorizer());
    batchSchemeCache.set(network, scheme);
    return scheme;
}

type SvmAuthorization = {
    scheme: "upto";
    network: SolanaNetworkId;
    asset: string;
    payTo: string;
    resource: string;
    payer: string;
    maxAmount: string;
    nonce: string;
    deadline: string | number;
};

type SvmNonceStore = {
    has: (key: string) => Promise<boolean>;
    consume: (key: string, ttlSeconds: number) => Promise<boolean>;
};

type SvmSettlement = (
    userAddress: string,
    amountWei: string,
    network: NetworkId,
    options?: KeyPaymentSettlementOptions,
) => Promise<SettlementResult>;

const svmUtf8Encoder = getUtf8Encoder();
const svmBase58Encoder = getBase58Encoder();

function orderedRecord(input: Record<string, unknown>): Record<string, unknown> {
    return Object.keys(input)
        .filter((key) => input[key] !== undefined)
        .sort()
        .reduce<Record<string, unknown>>((acc, key) => {
            const value = input[key];
            acc[key] = value && typeof value === "object" && !Array.isArray(value)
                ? orderedRecord(value as Record<string, unknown>)
                : value;
            return acc;
        }, {});
}

function canonicalJson(input: Record<string, unknown>): string {
    return JSON.stringify(orderedRecord(input));
}

function utf8Bytes(value: string): Uint8Array {
    return new Uint8Array(svmUtf8Encoder.encode(value));
}

function signatureFromBase58(value: string) {
    return signatureBytes(new Uint8Array(svmBase58Encoder.encode(value)));
}

function record(value: unknown): Record<string, unknown> | null {
    return value && typeof value === "object" && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

function stringField(input: Record<string, unknown>, field: string): string | null {
    const value = input[field];
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function positiveInteger(value: string): boolean {
    return /^\d+$/u.test(value) && BigInt(value) > 0n;
}

function validateSolanaAddress(value: string): boolean {
    try {
        solanaAddress(value);
        return true;
    } catch {
        return false;
    }
}

function parseSvmAuthorization(payload: PaymentPayload): {
    authorization: SvmAuthorization;
    signature: string;
} | { error: string } {
    const raw = record(payload.payload);
    const authorizationRaw = raw ? record(raw.authorization) : null;
    const signature = raw ? stringField(raw, "signature") : null;
    if (!authorizationRaw || !signature) {
        return { error: "invalid_svm_upto_payload" };
    }

    const scheme = stringField(authorizationRaw, "scheme");
    const network = stringField(authorizationRaw, "network");
    const asset = stringField(authorizationRaw, "asset");
    const payTo = stringField(authorizationRaw, "payTo");
    const resource = stringField(authorizationRaw, "resource");
    const payer = stringField(authorizationRaw, "payer");
    const maxAmount = stringField(authorizationRaw, "maxAmount");
    const nonce = stringField(authorizationRaw, "nonce");
    const deadlineValue = authorizationRaw.deadline;
    const deadline = typeof deadlineValue === "string" || typeof deadlineValue === "number"
        ? deadlineValue
        : null;

    if (
        scheme !== "upto"
        || !network
        || !isSolanaNetwork(network as NetworkId)
        || !asset
        || !payTo
        || !resource
        || !payer
        || !maxAmount
        || !nonce
        || deadline === null
    ) {
        return { error: "invalid_svm_upto_authorization" };
    }

    return {
        authorization: {
            scheme,
            network: network as SolanaNetworkId,
            asset,
            payTo,
            resource,
            payer,
            maxAmount,
            nonce,
            deadline,
        },
        signature,
    };
}

function svmAuthorizationMessage(authorization: SvmAuthorization): Uint8Array {
    return utf8Bytes(canonicalJson({
        asset: authorization.asset,
        deadline: String(authorization.deadline),
        maxAmount: authorization.maxAmount,
        network: authorization.network,
        nonce: authorization.nonce,
        payTo: authorization.payTo,
        payer: authorization.payer,
        resource: authorization.resource,
        scheme: authorization.scheme,
    }));
}

function nonceKey(authorization: SvmAuthorization): string {
    return [
        "x402",
        "svm",
        "upto",
        "nonce",
        authorization.network,
        authorization.payer,
        authorization.nonce,
    ].join(":");
}

const valkeySvmNonceStore: SvmNonceStore = {
    has: (key) => valkeyExists(key),
    consume: (key, ttlSeconds) => valkeySetNXEX(key, "1", ttlSeconds),
};

function settleFailure(
    network: NetworkId,
    payer: string,
    errorReason: string,
    errorMessage?: string,
): SettleResponse {
    return {
        success: false,
        transaction: "",
        network,
        payer,
        errorReason,
        ...(errorMessage ? { errorMessage } : {}),
    };
}

class UptoSvmFacilitator implements SchemeNetworkFacilitator {
    readonly caipFamily = "solana:*";
    readonly scheme = "upto";

    constructor(
        private readonly feePayer: string,
        private readonly settleKeyPayment: SvmSettlement = settleKeyPaymentForNetwork,
        private readonly nonceStore: SvmNonceStore = valkeySvmNonceStore,
    ) { }

    getExtra(network: string): Record<string, unknown> | undefined {
        assertCaip2Network(network);
        return { feePayer: this.feePayer };
    }

    getSigners(network: string): string[] {
        assertCaip2Network(network);
        return [this.feePayer];
    }

    async verify(
        payload: PaymentPayload,
        requirements: PaymentRequirements,
    ): Promise<VerifyResponse> {
        const parsed = parseSvmAuthorization(payload);
        if ("error" in parsed) {
            return { isValid: false, invalidReason: parsed.error, payer: "" };
        }
        const { authorization, signature } = parsed;
        const payer = authorization.payer;

        if (payload.accepted.scheme !== "upto" || requirements.scheme !== "upto") {
            return { isValid: false, invalidReason: "unsupported_scheme", payer };
        }
        if (payload.accepted.network !== requirements.network || authorization.network !== requirements.network) {
            return { isValid: false, invalidReason: "network_mismatch", payer };
        }
        if (!isSolanaNetwork(requirements.network as NetworkId)) {
            return { isValid: false, invalidReason: "unsupported_network", payer };
        }
        if (payload.accepted.asset !== requirements.asset || authorization.asset !== requirements.asset) {
            return { isValid: false, invalidReason: "asset_mismatch", payer };
        }
        if (payload.accepted.payTo !== requirements.payTo || authorization.payTo !== requirements.payTo) {
            return { isValid: false, invalidReason: "pay_to_mismatch", payer };
        }
        if (payload.resource?.url !== authorization.resource) {
            return { isValid: false, invalidReason: "resource_mismatch", payer };
        }
        if (
            !positiveInteger(requirements.amount)
            || !positiveInteger(payload.accepted.amount)
            || !positiveInteger(authorization.maxAmount)
        ) {
            return { isValid: false, invalidReason: "invalid_amount", payer };
        }
        if (BigInt(requirements.amount) > BigInt(authorization.maxAmount)) {
            return { isValid: false, invalidReason: "amount_exceeds_authorization", payer };
        }
        if (BigInt(requirements.amount) > BigInt(payload.accepted.amount)) {
            return { isValid: false, invalidReason: "amount_exceeds_accepted", payer };
        }
        const rawDeadline = String(authorization.deadline ?? "").trim();
        if (!/^\d+$/u.test(rawDeadline)) {
            return { isValid: false, invalidReason: "invalid_deadline", payer };
        }
        const deadline = BigInt(rawDeadline);
        if (deadline < BigInt(Math.floor(Date.now() / 1000))) {
            return { isValid: false, invalidReason: "authorization_expired", payer };
        }
        if (!validateSolanaAddress(payer) || !validateSolanaAddress(requirements.asset) || !validateSolanaAddress(requirements.payTo)) {
            return { isValid: false, invalidReason: "invalid_solana_address", payer };
        }
        if (await this.nonceStore.has(nonceKey(authorization))) {
            return { isValid: false, invalidReason: "duplicate_authorization", payer };
        }

        try {
            const valid = await verifySignature(
                await getPublicKeyFromAddress(solanaAddress(payer)),
                signatureFromBase58(signature),
                svmAuthorizationMessage(authorization),
            );
            if (!valid) {
                return { isValid: false, invalidReason: "invalid_signature", payer };
            }
        } catch {
            return { isValid: false, invalidReason: "invalid_signature", payer };
        }

        return {
            isValid: true,
            payer,
            extra: {
                nonce: authorization.nonce,
                maxAmount: authorization.maxAmount,
            },
        };
    }

    async settle(
        payload: PaymentPayload,
        requirements: PaymentRequirements,
    ): Promise<SettleResponse> {
        const verification = await this.verify(payload, requirements);
        const payer = verification.payer || "";
        if (!verification.isValid) {
            return settleFailure(
                requirements.network as NetworkId,
                payer,
                verification.invalidReason || "verification_failed",
                verification.invalidMessage,
            );
        }

        const parsed = parseSvmAuthorization(payload);
        if ("error" in parsed) {
            return settleFailure(requirements.network as NetworkId, payer, parsed.error);
        }
        const ttlSeconds = Math.max(
            1,
            Number(BigInt(String(parsed.authorization.deadline)) - BigInt(Math.floor(Date.now() / 1000))),
        );
        const consumed = await this.nonceStore.consume(nonceKey(parsed.authorization), ttlSeconds);
        if (!consumed) {
            return settleFailure(requirements.network as NetworkId, payer, "duplicate_authorization");
        }

        const result = await this.settleKeyPayment(
            payer,
            requirements.amount,
            requirements.network as NetworkId,
            {
                payTo: requirements.payTo,
                royalties: requirements.extra?.royalties as { creator?: string; treasury?: string } | undefined,
                providerAmountWei: typeof requirements.extra?.providerAmountWei === "string" ? requirements.extra.providerAmountWei : undefined,
                platformFeeWei: typeof requirements.extra?.platformFeeWei === "string" ? requirements.extra.platformFeeWei : undefined,
                memo: typeof requirements.extra?.memo === "string" ? requirements.extra.memo : undefined,
                service: typeof requirements.extra?.service === "string" ? requirements.extra.service : undefined,
            },
        );
        if (!result.success || !result.txHash) {
            return settleFailure(
                requirements.network as NetworkId,
                payer,
                "transaction_failed",
                result.error || "SVM settlement failed",
            );
        }

        return {
            success: true,
            transaction: result.txHash,
            network: requirements.network,
            amount: requirements.amount,
            payer,
        };
    }
}

class BatchSettlementSvmFacilitator implements SchemeNetworkFacilitator {
    readonly caipFamily = "solana:*";
    readonly scheme = "batch-settlement";

    constructor(
        private readonly feePayer: string,
        private readonly commitBatch: typeof commitSvmBatchCharge = commitSvmBatchCharge,
    ) { }

    getExtra(network: string): Record<string, unknown> | undefined {
        assertCaip2Network(network);
        return { feePayer: this.feePayer };
    }

    getSigners(network: string): string[] {
        assertCaip2Network(network);
        return [this.feePayer];
    }

    async verify(
        payload: PaymentPayload,
        requirements: PaymentRequirements,
    ): Promise<VerifyResponse> {
        const validation = await validateSvmBatchPayment(payload, requirements);
        if (!validation.valid) {
            return {
                isValid: false,
                invalidReason: validation.invalidReason,
                payer: validation.payer || "",
            };
        }
        return {
            isValid: true,
            payer: validation.payer,
            extra: {
                channelId: validation.channelId,
                maxClaimableAmount: validation.maxClaimableAmount,
                chargedCumulativeAmount: validation.chargedCumulativeAmount,
            },
        };
    }

    async settle(
        payload: PaymentPayload,
        requirements: PaymentRequirements,
    ): Promise<SettleResponse> {
        const verification = await this.verify(payload, requirements);
        const payer = verification.payer || "";
        if (!verification.isValid) {
            return settleFailure(
                requirements.network as NetworkId,
                payer,
                verification.invalidReason || "verification_failed",
                verification.invalidMessage,
            );
        }

        const batch = await this.commitBatch(payload, requirements.amount, requirements);
        return {
            success: true,
            transaction: "",
            network: requirements.network,
            amount: requirements.amount,
            payer,
            extra: {
                settlementStatus: "queued",
                channelId: batch.channelId,
                cumulativeAmountWei: batch.cumulativeAmountWei,
            },
        };
    }
}

async function registerSvmSchemes(facilitator: x402Facilitator, networks: NetworkId[]): Promise<void> {
    const svmNetworks = networks.filter(isSolanaNetwork);
    if (svmNetworks.length === 0) return;
    const privateKey = requireEnv("SVM_FACILITATOR_KEY");
    const keypair = await createKeyPairSignerFromBytes(base58.decode(privateKey));
    const rpcs: Record<string, ReturnType<typeof createSolanaRpc>> = {};
    if (svmNetworks.includes(NETWORK_IDS.solanaDevnet)) {
        rpcs[NETWORK_IDS.solanaDevnet] = createSolanaRpc(devnet(getNetworkRpcUrl(NETWORK_IDS.solanaDevnet)));
    }
    if (svmNetworks.includes(NETWORK_IDS.solana)) {
        rpcs[NETWORK_IDS.solana] = createSolanaRpc(mainnet(getNetworkRpcUrl(NETWORK_IDS.solana)));
    }
    const signer = toFacilitatorSvmSigner(keypair, rpcs as never);
    const feePayer = requireEnv("SVM_TREASURY_SERVER_WALLET_PUBLIC");
    if (!signer.getAddresses().map(String).includes(feePayer)) {
        throw new Error("SVM_TREASURY_SERVER_WALLET_PUBLIC must match SVM_FACILITATOR_KEY signer address");
    }
    const exact = new ExactSvmFacilitator(signer);
    facilitator.register(svmNetworks, exact);
    facilitator.register(svmNetworks, new UptoSvmFacilitator(feePayer));
    facilitator.register(svmNetworks, new BatchSettlementSvmFacilitator(feePayer));
}

type NearAuthorization = {
    scheme: "upto";
    network: NearNetworkId;
    asset: string;
    payTo: string;
    resource: string;
    payer: string;
    maxAmount: string;
    nonce: string;
    deadline: string | number;
    publicKey?: string;
};

function parseNearAuthorization(payload: PaymentPayload): {
    authorization: NearAuthorization;
    signature: string;
} | { error: string } {
    const raw = record(payload.payload);
    const authorizationRaw = raw ? record(raw.authorization) : null;
    const signature = raw ? stringField(raw, "signature") : null;
    if (!authorizationRaw || !signature) {
        return { error: "invalid_near_upto_payload" };
    }

    const scheme = stringField(authorizationRaw, "scheme");
    const network = stringField(authorizationRaw, "network");
    const asset = stringField(authorizationRaw, "asset");
    const payTo = stringField(authorizationRaw, "payTo");
    const resource = stringField(authorizationRaw, "resource");
    const payer = stringField(authorizationRaw, "payer");
    const maxAmount = stringField(authorizationRaw, "maxAmount");
    const nonce = stringField(authorizationRaw, "nonce");
    const publicKey = stringField(authorizationRaw, "publicKey") ?? stringField(raw!, "publicKey") ?? undefined;
    const deadlineValue = authorizationRaw.deadline;
    const deadline = typeof deadlineValue === "string" || typeof deadlineValue === "number"
        ? deadlineValue
        : null;

    if (
        scheme !== "upto"
        || !network
        || !isNearNetwork(network as NetworkId)
        || !asset
        || !payTo
        || !resource
        || !payer
        || !maxAmount
        || !nonce
        || deadline === null
    ) {
        return { error: "invalid_near_upto_authorization" };
    }

    return {
        authorization: {
            scheme,
            network: network as NearNetworkId,
            asset,
            payTo,
            resource,
            payer,
            maxAmount,
            nonce,
            deadline,
            ...(publicKey ? { publicKey } : {}),
        },
        signature,
    };
}

function nearAuthorizationMessage(authorization: NearAuthorization): Uint8Array {
    return utf8Bytes(canonicalJson({
        asset: authorization.asset,
        deadline: String(authorization.deadline),
        maxAmount: authorization.maxAmount,
        network: authorization.network,
        nonce: authorization.nonce,
        payTo: authorization.payTo,
        payer: authorization.payer,
        resource: authorization.resource,
        scheme: authorization.scheme,
    }));
}

function nearNonceKey(authorization: NearAuthorization): string {
    return [
        "x402",
        "near",
        "upto",
        "nonce",
        authorization.network,
        authorization.payer,
        authorization.nonce,
    ].join(":");
}

export class UptoNearFacilitator implements SchemeNetworkFacilitator {
    readonly caipFamily = "near:*";
    readonly scheme = "upto";

    constructor(
        private readonly feePayer: string,
        private readonly settleKeyPayment: SvmSettlement = settleKeyPaymentForNetwork,
        private readonly nonceStore: SvmNonceStore = valkeySvmNonceStore,
    ) { }

    getExtra(network: string): Record<string, unknown> | undefined {
        assertCaip2Network(network);
        return { feePayer: this.feePayer };
    }

    getSigners(network: string): string[] {
        assertCaip2Network(network);
        return [this.feePayer];
    }

    async verify(
        payload: PaymentPayload,
        requirements: PaymentRequirements,
    ): Promise<VerifyResponse> {
        const parsed = parseNearAuthorization(payload);
        if ("error" in parsed) {
            return { isValid: false, invalidReason: parsed.error, payer: "" };
        }
        const { authorization, signature } = parsed;
        const payer = authorization.payer;

        if (payload.accepted.scheme !== "upto" || requirements.scheme !== "upto") {
            return { isValid: false, invalidReason: "unsupported_scheme", payer };
        }
        if (payload.accepted.network !== requirements.network || authorization.network !== requirements.network) {
            return { isValid: false, invalidReason: "network_mismatch", payer };
        }
        if (!isNearNetwork(requirements.network as NetworkId)) {
            return { isValid: false, invalidReason: "unsupported_network", payer };
        }
        if (payload.accepted.asset !== requirements.asset || authorization.asset !== requirements.asset) {
            return { isValid: false, invalidReason: "asset_mismatch", payer };
        }
        if (payload.accepted.payTo !== requirements.payTo || authorization.payTo !== requirements.payTo) {
            return { isValid: false, invalidReason: "pay_to_mismatch", payer };
        }
        if (payload.resource?.url !== authorization.resource) {
            return { isValid: false, invalidReason: "resource_mismatch", payer };
        }
        if (
            !positiveInteger(requirements.amount)
            || !positiveInteger(payload.accepted.amount)
            || !positiveInteger(authorization.maxAmount)
        ) {
            return { isValid: false, invalidReason: "invalid_amount", payer };
        }
        if (BigInt(requirements.amount) > BigInt(authorization.maxAmount)) {
            return { isValid: false, invalidReason: "amount_exceeds_authorization", payer };
        }
        if (BigInt(requirements.amount) > BigInt(payload.accepted.amount)) {
            return { isValid: false, invalidReason: "amount_exceeds_accepted", payer };
        }
        const rawDeadline = String(authorization.deadline ?? "").trim();
        if (!/^\d+$/u.test(rawDeadline)) {
            return { isValid: false, invalidReason: "invalid_deadline", payer };
        }
        const deadline = BigInt(rawDeadline);
        if (deadline < BigInt(Math.floor(Date.now() / 1000))) {
            return { isValid: false, invalidReason: "authorization_expired", payer };
        }
        if (!validateNearAddress(payer) || !validateNearAddress(requirements.asset) || !validateNearAddress(requirements.payTo)) {
            return { isValid: false, invalidReason: "invalid_near_address", payer };
        }
        if (await this.nonceStore.has(nearNonceKey(authorization))) {
            return { isValid: false, invalidReason: "duplicate_authorization", payer };
        }

        const valid = await verifyNearDetachedSignature({
            network: authorization.network,
            payer,
            signature,
            message: nearAuthorizationMessage(authorization),
            publicKeyHint: authorization.publicKey,
        });
        if (!valid) {
            return { isValid: false, invalidReason: "invalid_signature", payer };
        }

        return {
            isValid: true,
            payer,
            extra: {
                nonce: authorization.nonce,
                maxAmount: authorization.maxAmount,
            },
        };
    }

    async settle(
        payload: PaymentPayload,
        requirements: PaymentRequirements,
    ): Promise<SettleResponse> {
        const verification = await this.verify(payload, requirements);
        const payer = verification.payer || "";
        if (!verification.isValid) {
            return settleFailure(
                requirements.network as NetworkId,
                payer,
                verification.invalidReason || "verification_failed",
                verification.invalidMessage,
            );
        }

        const parsed = parseNearAuthorization(payload);
        if ("error" in parsed) {
            return settleFailure(requirements.network as NetworkId, payer, parsed.error);
        }
        const ttlSeconds = Math.max(
            1,
            Number(BigInt(String(parsed.authorization.deadline)) - BigInt(Math.floor(Date.now() / 1000))),
        );
        const consumed = await this.nonceStore.consume(nearNonceKey(parsed.authorization), ttlSeconds);
        if (!consumed) {
            return settleFailure(requirements.network as NetworkId, payer, "duplicate_authorization");
        }

        const result = await this.settleKeyPayment(
            payer,
            requirements.amount,
            requirements.network as NetworkId,
            {
                payTo: requirements.payTo,
                royalties: requirements.extra?.royalties as { creator?: string; treasury?: string } | undefined,
                providerAmountWei: typeof requirements.extra?.providerAmountWei === "string" ? requirements.extra.providerAmountWei : undefined,
                platformFeeWei: typeof requirements.extra?.platformFeeWei === "string" ? requirements.extra.platformFeeWei : undefined,
                memo: typeof requirements.extra?.memo === "string" ? requirements.extra.memo : undefined,
                service: typeof requirements.extra?.service === "string" ? requirements.extra.service : undefined,
            },
        );
        if (!result.success || !result.txHash) {
            return settleFailure(
                requirements.network as NetworkId,
                payer,
                "transaction_failed",
                result.error || "NEAR settlement failed",
            );
        }

        return {
            success: true,
            transaction: result.txHash,
            network: requirements.network,
            amount: requirements.amount,
            payer,
        };
    }
}

export class BatchSettlementNearFacilitator implements SchemeNetworkFacilitator {
    readonly caipFamily = "near:*";
    readonly scheme = "batch-settlement";

    constructor(
        private readonly feePayer: string,
        private readonly commitBatch: typeof commitNearBatchCharge = commitNearBatchCharge,
        private readonly validateBatch: typeof validateNearBatchPayment = validateNearBatchPayment,
    ) { }

    getExtra(network: string): Record<string, unknown> | undefined {
        assertCaip2Network(network);
        return { feePayer: this.feePayer };
    }

    getSigners(network: string): string[] {
        assertCaip2Network(network);
        return [this.feePayer];
    }

    async verify(
        payload: PaymentPayload,
        requirements: PaymentRequirements,
    ): Promise<VerifyResponse> {
        const validation = await this.validateBatch(payload, requirements);
        if (!validation.valid) {
            return {
                isValid: false,
                invalidReason: validation.invalidReason,
                payer: validation.payer || "",
            };
        }
        return {
            isValid: true,
            payer: validation.payer,
            extra: {
                channelId: validation.channelId,
                maxClaimableAmount: validation.maxClaimableAmount,
                chargedCumulativeAmount: validation.chargedCumulativeAmount,
            },
        };
    }

    async settle(
        payload: PaymentPayload,
        requirements: PaymentRequirements,
    ): Promise<SettleResponse> {
        const verification = await this.verify(payload, requirements);
        const payer = verification.payer || "";
        if (!verification.isValid) {
            return settleFailure(
                requirements.network as NetworkId,
                payer,
                verification.invalidReason || "verification_failed",
                verification.invalidMessage,
            );
        }

        const batch = await this.commitBatch(payload, requirements.amount, requirements);
        return {
            success: true,
            transaction: "",
            network: requirements.network,
            amount: requirements.amount,
            payer,
            extra: {
                settlementStatus: "queued",
                channelId: batch.channelId,
                cumulativeAmountWei: batch.cumulativeAmountWei,
            },
        };
    }
}

async function registerNearSchemes(facilitator: x402Facilitator, networks: NetworkId[]): Promise<void> {
    const nearNetworks = networks.filter(isNearNetwork);
    if (nearNetworks.length === 0) return;
    const rawKey = requireEnv("NEAR_FACILITATOR_KEY");
    const secretKey = (rawKey.includes(":") ? rawKey : `ed25519:${rawKey}`) as KeyPairString;
    const feePayer = process.env.NEAR_FACILITATOR_ACCOUNT?.trim() || requireEnv("NEAR_TREASURY_SERVER_WALLET_PUBLIC");
    const testnetFeePayer = process.env.NEAR_TESTNET_FACILITATOR_ACCOUNT?.trim()
        || process.env.NEAR_TESTNET_TREASURY_SERVER_WALLET_PUBLIC?.trim()
        || feePayer;
    const rpcUrls: Record<string, string> = {};
    if (nearNetworks.includes(NETWORK_IDS.nearTestnet)) {
        rpcUrls[NETWORK_IDS.nearTestnet] = getNetworkRpcUrl(NETWORK_IDS.nearTestnet);
    }
    if (nearNetworks.includes(NETWORK_IDS.near)) {
        rpcUrls[NETWORK_IDS.near] = getNetworkRpcUrl(NETWORK_IDS.near);
    }
    const relayers = testnetFeePayer !== feePayer
        ? [
            { accountId: feePayer, secretKey },
            { accountId: testnetFeePayer, secretKey },
        ]
        : [{ accountId: feePayer, secretKey }];
    const signer = createFacilitatorNearSigner({
        relayers,
        rpcUrls,
    });
    const exact = new ExactNearFacilitator(signer);
    facilitator.register(nearNetworks, exact);
    if (testnetFeePayer !== feePayer) {
        const mainnetNets = nearNetworks.filter((n) => n !== NETWORK_IDS.nearTestnet);
        const testnetNets = nearNetworks.filter((n) => n === NETWORK_IDS.nearTestnet);
        if (mainnetNets.length > 0) {
            facilitator.register(mainnetNets, new UptoNearFacilitator(feePayer));
            facilitator.register(mainnetNets, new BatchSettlementNearFacilitator(feePayer));
        }
        if (testnetNets.length > 0) {
            facilitator.register(testnetNets, new UptoNearFacilitator(testnetFeePayer));
            facilitator.register(testnetNets, new BatchSettlementNearFacilitator(testnetFeePayer));
        }
    } else {
        facilitator.register(nearNetworks, new UptoNearFacilitator(feePayer));
        facilitator.register(nearNetworks, new BatchSettlementNearFacilitator(feePayer));
    }
}

async function createFacilitator(): Promise<x402Facilitator> {
    const networks = getConfiguredFacilitatorNetworks();
    if (networks.length === 0) {
        throw new Error("Compose facilitator has no configured networks");
    }

    const facilitator = new x402Facilitator();
    for (const extension of facilitatorExtensions) {
        facilitator.registerExtension(extension);
    }

    for (const network of networks.filter(isEvmNetwork)) {
        facilitator.register(network, createExactSchemeForChain(network));
        facilitator.register(network, createUptoSchemeForChain(network));
        facilitator.register(network, createBatchSchemeForChain(network));
    }
    await registerSvmSchemes(facilitator, networks);
    await registerNearSchemes(facilitator, networks);

    return facilitator;
}

let facilitatorPromise: Promise<x402Facilitator> | null = null;

export async function getFacilitator(): Promise<x402Facilitator> {
    if (!facilitatorSingleton) {
        facilitatorPromise ??= createFacilitator();
        facilitatorSingleton = await facilitatorPromise;
    }
    return facilitatorSingleton;
}

export async function getFacilitatorSupported(): Promise<SupportedResponse> {
    const supported = (await getFacilitator()).getSupported();
    return {
        kinds: supported.kinds.filter((kind) => kind.x402Version === 2 && kind.network.includes(":")).map((kind) => ({
            x402Version: kind.x402Version,
            scheme: kind.scheme,
            network: assertCaip2Network(kind.network),
            ...(kind.extra ? { extra: kind.extra } : {}),
        })),
        extensions: [...supported.extensions],
        signers: supported.signers,
    };
}

export function createPaymentExtensions(): Record<string, unknown> {
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

export function createPaymentRequirement(input: {
    amountWei: number | string;
    network: NetworkId;
    scheme?: "exact" | "upto" | "batch-settlement";
    payTo?: string;
    maxTimeoutSeconds?: number;
}): PaymentRequirements {
    const scheme = input.scheme === "upto" || input.scheme === "batch-settlement" ? input.scheme : "exact";
    const extra: Record<string, unknown> = {};

    if (scheme === "upto" && isEvmNetwork(input.network)) {
        extra.assetTransferMethod = "permit2";
        extra.facilitatorAddress = getFacilitatorAccount().address;
    }
    if (scheme === "exact" && isEvmNetwork(input.network)) {
        const assetTransferMethod = getNetwork(input.network).asset.assetTransferMethod;
        if (assetTransferMethod) {
            extra.assetTransferMethod = assetTransferMethod;
        }
    }
    if (isBatchSettlementScheme(scheme) && isEvmNetwork(input.network)) {
        Object.assign(extra, createBatchPaymentExtra(input.network, getReceiverAuthorizer().address));
    }
    if (isSolanaNetwork(input.network)) {
        extra.feePayer = requireEnv("SVM_TREASURY_SERVER_WALLET_PUBLIC");
    }
    if (isNearNetwork(input.network)) {
        extra.feePayer = input.network === NETWORK_IDS.nearTestnet
            ? (process.env.NEAR_TESTNET_FACILITATOR_ACCOUNT?.trim()
                || process.env.NEAR_TESTNET_TREASURY_SERVER_WALLET_PUBLIC?.trim()
                || process.env.NEAR_FACILITATOR_ACCOUNT?.trim()
                || requireEnv("NEAR_TREASURY_SERVER_WALLET_PUBLIC"))
            : (process.env.NEAR_FACILITATOR_ACCOUNT?.trim()
                || requireEnv("NEAR_TREASURY_SERVER_WALLET_PUBLIC"));
    }

    const definition = getNetwork(input.network);
    const payTo = input.payTo ?? (isSolanaNetwork(input.network)
        ? requireEnv("SVM_MERCHANT_WALLET_ADDRESS")
        : isNearNetwork(input.network)
            ? (input.network === NETWORK_IDS.nearTestnet
                ? (process.env.NEAR_TESTNET_MERCHANT_WALLET_ADDRESS?.trim() || requireEnv("NEAR_MERCHANT_WALLET_ADDRESS"))
                : requireEnv("NEAR_MERCHANT_WALLET_ADDRESS"))
            : requireEnv("MERCHANT_WALLET_ADDRESS"));

    return parseV2PaymentRequirements({
        scheme,
        network: input.network,
        amount: String(input.amountWei),
        asset: definition.asset.address,
        payTo,
        maxTimeoutSeconds: input.maxTimeoutSeconds ?? 300,
        extra,
    });
}

export function createPaymentRequired(input: {
    amountWei: number | string;
    network: NetworkId;
    scheme?: "exact" | "upto" | "batch-settlement";
    resourceUrl: string;
    description: string;
    mimeType: string;
    maxTimeoutSeconds?: number;
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
        accepts: [createPaymentRequirement({
            amountWei: input.amountWei,
            network: input.network,
            scheme: input.scheme,
            maxTimeoutSeconds: input.maxTimeoutSeconds,
        })],
        extensions: createPaymentExtensions(),
    });
}

export function encodePaymentRequiredHeader(paymentRequired: PaymentRequired): string {
    return encodePaymentRequiredHeader_x402(paymentRequired);
}

export function encodePaymentResponseHeader(settleResponse: SettleResponse): string {
    return encodePaymentResponseHeader_x402(settleResponse);
}

export function decodePaymentSignatureHeader(paymentData: string): PaymentPayload {
    return parseV2PaymentPayload(decodePaymentSignatureHeader_x402(paymentData));
}

export function getNetworkFromPaymentPayload(paymentPayload: PaymentPayload): NetworkId {
    if (paymentPayload.x402Version !== 2) {
        throw new Error(`Unsupported x402 version: ${paymentPayload.x402Version}`);
    }

    const network = paymentPayload.accepted.network;
    if (!getSupportedNetworks().some((entry) => entry.id === network)) {
        throw new Error(`Invalid payment network: ${paymentPayload.accepted.network}`);
    }
    return network as NetworkId;
}

export async function verifyPayment(
    paymentPayload: PaymentPayload,
    paymentRequirements: PaymentRequirements,
): Promise<VerifyResponse> {
    return (await getFacilitator()).verify(paymentPayload, paymentRequirements);
}

export async function settlePayment(
    paymentPayload: PaymentPayload,
    paymentRequirements: PaymentRequirements,
): Promise<SettleResponse> {
    return (await getFacilitator()).settle(paymentPayload, paymentRequirements);
}

export function parseFacilitatorVerifyRequest(body: unknown): {
    paymentPayload: PaymentPayload;
    paymentRequirements: PaymentRequirements;
} {
    const parsed = FACILITATOR_VERIFY_REQUEST_SCHEMA.parse(body);
    return {
        paymentPayload: parseV2PaymentPayload(parsed.paymentPayload),
        paymentRequirements: parseV2PaymentRequirements(parsed.paymentRequirements),
    };
}

export function parseFacilitatorSettleRequest(body: unknown): {
    paymentPayload: PaymentPayload;
    paymentRequirements: PaymentRequirements;
} {
    const parsed = FACILITATOR_SETTLE_REQUEST_SCHEMA.parse(body);
    return {
        paymentPayload: parseV2PaymentPayload(parsed.paymentPayload),
        paymentRequirements: parseV2PaymentRequirements(parsed.paymentRequirements),
    };
}

export async function getFacilitatorChainMetadata(): Promise<Array<{
    name: string;
    network: NetworkId;
    schemes: string[];
}>> {
    const supported = await getFacilitatorSupported();
    const schemesByNetwork = new Map<NetworkId, string[]>();
    for (const kind of supported.kinds) {
        const network = kind.network as NetworkId;
        const schemes = schemesByNetwork.get(network) ?? [];
        if (!schemes.includes(kind.scheme)) {
            schemes.push(kind.scheme);
            schemesByNetwork.set(network, schemes);
        }
    }
    return getConfiguredFacilitatorNetworks().map((network) => ({
        name: getNetwork(network).name,
        network,
        schemes: schemesByNetwork.get(network) ?? [],
    }));
}
