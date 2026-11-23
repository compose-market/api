/**
 * Solana fee-payer signing relay.
 *
 * Most transactions are relayed generically. Swig creation is the exception:
 * it must include the canonical, atomic reimbursement from the prefunded Swig
 * wallet so the facilitator does not sponsor user account activation.
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
    getAddressEncoder,
    getBase64EncodedWireTransaction,
    getBase64Decoder,
    getCompiledTransactionMessageDecoder,
    decompileTransactionMessageFetchingLookupTables,
    getProgramDerivedAddress,
    getTransactionDecoder,
    mainnet as solanaMainnet,
    partiallySignTransaction,
    address as solanaAddress,
} from "@solana/kit";
import {
    isSolanaNetwork,
    type SolanaNetworkId,
    getNetworkRpcUrl,
    NETWORK_IDS,
    getNetwork,
} from "../x402/configs/chains.js";
import { buildError } from "../http/errors.js";

const SVM_CONFIRM_ATTEMPTS = 30;
const SVM_CONFIRM_DELAY_MS = 1_000;
const SVM_MAX_TX_BYTES = 1232;
const SWIG_PROGRAM = "swigypWHEksbC64pWKwah1WTeh9JXwx8H1rJHLdbQMB";
const SYSTEM_PROGRAM = "11111111111111111111111111111111";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const ASSOCIATED_TOKEN_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const IDENTITY_PROGRAM = (process.env.SOLANA_IDENTITY_PROGRAM_ID || "AoaWgzq4tRrTbmWKmnC5VhpszqjFqEYuEeLQSGx8K6DY").trim();
const REPUTATION_PROGRAM = (process.env.SOLANA_REPUTATION_PROGRAM_ID || "35UrJCxmsyqPLcFNVHqsM8UZZjx6UQYNBS5ChrvUfLPR").trim();
const VALIDATION_PROGRAM = (process.env.SOLANA_VALIDATION_PROGRAM_ID || "GQHB7DDt2558Tncx3hHtw8w9fi2xZhvXQ5nGmgyGaL2H").trim();
const MARKET_PROGRAM = (process.env.SOLANA_MARKET_PROGRAM_ID || "7B3dAgwdmWK3YnobSPYP5fPYNp7x8btNs5GMCD498uo8").trim();
const TOKEN_METADATA_PROGRAM = (process.env.SOLANA_TOKEN_METADATA_PROGRAM_ID || "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s").trim();
const MAX_RELAY_COMPUTE_UNITS = 1_400_000;
const MAX_RELAY_COMPUTE_UNIT_PRICE_MICROLAMPORTS = 1_000_000n;
const SPL_APPROVE_DISCRIMINATOR = 4;
const SPL_APPROVE_CHECKED_DISCRIMINATOR = 13;
const RELAY_ALLOWED_PROGRAMS = new Set<string>([
    SWIG_PROGRAM,
    SYSTEM_PROGRAM,
    TOKEN_PROGRAM,
    TOKEN_2022_PROGRAM,
    ASSOCIATED_TOKEN_PROGRAM,
    "ComputeBudget111111111111111111111111111111",
    "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
    IDENTITY_PROGRAM,
    REPUTATION_PROGRAM,
    VALIDATION_PROGRAM,
    MARKET_PROGRAM,
    TOKEN_METADATA_PROGRAM,
].filter(Boolean));
const SWIG_CREATE_V1 = 0;
const SWIG_SIGN_V2 = 11;
const SECP256K1_AUTHORITY = 3;
const ALL_PERMISSION = 7;
const CREATE_IDEMPOTENT_ATA = 1;
const SYSTEM_TRANSFER = 2;
const SWIG_CONFIG_SIZE = 112n;
const TOKEN_ACCOUNT_SIZE = 165n;
const ACTIVATION_MINIMUM_LAMPORTS = 50_000_000n;
const COMPUTE_BUDGET_PROGRAM = "ComputeBudget111111111111111111111111111111";
const JUPITER_PROGRAM = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
const WRAPPED_SOL_MINT = "So11111111111111111111111111111111111111112";
const MEMO_PROGRAM = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
export const SVM_ACTIVATION_MEMO = "compose.market: activate account";

let cachedFeePayerAddress: string | null = null;
let cachedFeePayerSigner: Awaited<ReturnType<typeof createKeyPairSignerFromBytes>> | null = null;

type DecodedRelayTransaction = {
    signatures: Readonly<Record<string, Uint8Array | null>>;
    messageBytes?: Parameters<ReturnType<typeof getCompiledTransactionMessageDecoder>["decode"]>[0];
};

type RelayInstruction = {
    programAddress: string;
    accounts?: readonly { address: string; role: number }[];
    data?: Readonly<Uint8Array>;
};

type CompactInstruction = {
    programIdIndex: number;
    accountIndexes: number[];
    data: Uint8Array;
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
    if (network === NETWORK_IDS.solana) { return createSolanaRpc(solanaMainnet(rpcUrl)); }
    throw new Error(`Unsupported SVM network: ${network}`);
}

function readU16(data: Readonly<Uint8Array>, offset: number): number {
    return new DataView(data.buffer, data.byteOffset, data.byteLength).getUint16(offset, true);
}

function readU32(data: Readonly<Uint8Array>, offset: number): number {
    return new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(offset, true);
}

function readU64(data: Readonly<Uint8Array>, offset: number): bigint {
    return new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(offset, true);
}

function decodeCompactInstructions(data: Readonly<Uint8Array>): CompactInstruction[] | null {
    if (data.length === 0) return null;
    const count = data[0]!;
    const instructions: CompactInstruction[] = [];
    let cursor = 1;
    for (let index = 0; index < count; index += 1) {
        if (cursor + 2 > data.length) return null;
        const programIdIndex = data[cursor++]!;
        const accountCount = data[cursor++]!;
        if (cursor + accountCount + 2 > data.length) return null;
        const accountIndexes = Array.from(data.slice(cursor, cursor + accountCount));
        cursor += accountCount;
        const dataLength = readU16(data, cursor);
        cursor += 2;
        if (cursor + dataLength > data.length) return null;
        instructions.push({
            programIdIndex,
            accountIndexes,
            data: Uint8Array.from(data.slice(cursor, cursor + dataLength)),
        });
        cursor += dataLength;
    }
    return cursor === data.length ? instructions : null;
}

function accountDataBytes(value: unknown): Uint8Array | null {
    if (!Array.isArray(value) || typeof value[0] !== "string") return null;
    return Uint8Array.from(Buffer.from(value[0], "base64"));
}

async function deriveActivationAddresses(id: Uint8Array) {
    const encoder = getAddressEncoder();
    const [configAddress, configBump] = await getProgramDerivedAddress({
        programAddress: solanaAddress(SWIG_PROGRAM),
        seeds: [new TextEncoder().encode("swig"), id],
    });
    const [walletAddress, walletBump] = await getProgramDerivedAddress({
        programAddress: solanaAddress(SWIG_PROGRAM),
        seeds: [new TextEncoder().encode("swig-wallet-address"), encoder.encode(configAddress)],
    });
    return { configAddress, configBump, walletAddress, walletBump };
}

async function deriveAta(owner: string, mint: string) {
    const encoder = getAddressEncoder();
    const [ata] = await getProgramDerivedAddress({
        programAddress: solanaAddress(ASSOCIATED_TOKEN_PROGRAM),
        seeds: [
            encoder.encode(solanaAddress(owner)),
            encoder.encode(solanaAddress(TOKEN_PROGRAM)),
            encoder.encode(solanaAddress(mint)),
        ],
    });
    return ata;
}

/** Return null for non-create transactions or a validation error for invalid activation. */
export async function validateSelfFundedSwigActivation(
    transaction: DecodedRelayTransaction,
    facilitatorAddress: string,
    rpc: ReturnType<typeof createSvmRpc>,
    network: SolanaNetworkId,
): Promise<string | null> {
    if (!transaction.messageBytes) return null;
    const message = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes as never);
    const decompiled = await decompileTransactionMessageFetchingLookupTables(message, rpc as any);
    const allInstructions = decompiled.instructions as unknown as readonly RelayInstruction[];
    const createInstructions = allInstructions.filter((instruction) =>
        instruction.programAddress === SWIG_PROGRAM
        && instruction.data
        && instruction.data.length >= 2
        && readU16(instruction.data, 0) === SWIG_CREATE_V1
    );
    if (createInstructions.length === 0) return null;
    if (createInstructions.length !== 1) return "Swig activation must contain exactly one CreateV1 instruction";

    const memo = allInstructions[0];
    const expectedMemo = new TextEncoder().encode(SVM_ACTIVATION_MEMO);
    if (
        memo?.programAddress !== MEMO_PROGRAM
        || (memo.accounts?.length ?? 0) !== 0
        || !memo.data
        || memo.data.length !== expectedMemo.length
        || !memo.data.every((byte, index) => byte === expectedMemo[index])
    ) {
        return `Swig activation must begin with the exact memo: ${SVM_ACTIVATION_MEMO}`;
    }
    const instructions = allInstructions.slice(1);

    const create = createInstructions[0]!;
    const createIndex = instructions.indexOf(create);
    const standardActivation = instructions.length === 2 && createIndex === 0;
    const usdcActivation = network === NETWORK_IDS.solana
        && instructions.length === 4
        && createIndex === 2
        && instructions[0]?.programAddress === COMPUTE_BUDGET_PROGRAM
        && instructions[1]?.programAddress === SYSTEM_PROGRAM;
    if (!standardActivation && !usdcActivation) {
        return "Swig activation transaction has an unsupported instruction sequence";
    }
    if (usdcActivation) {
        const computeData = instructions[0]?.data;
        if (
            !computeData
            || computeData.length !== 5
            || computeData[0] !== 2
            || readU32(computeData, 1) > 1_400_000
        ) {
            return "USDC-funded activation may set only a bounded compute-unit limit";
        }
    }
    const createData = create.data!;
    const createAccounts = create.accounts ?? [];
    if (createData.length !== Number(SWIG_CONFIG_SIZE)) {
        return "Swig CreateV1 must use the canonical 112-byte payload";
    }
    if (
        readU16(createData, 2) !== SECP256K1_AUTHORITY
        || readU16(createData, 4) !== 64
        || readU16(createData, 104) !== ALL_PERMISSION
        || readU16(createData, 106) !== 0
        || readU32(createData, 108) !== 8
    ) {
        return "Swig activation must create one unrestricted secp256k1 root authority";
    }
    const id = Uint8Array.from(createData.slice(8, 40));
    const derived = await deriveActivationAddresses(id);
    if (
        createData[6] !== derived.configBump
        || createData[7] !== derived.walletBump
        || createAccounts.length !== 4
        || createAccounts[0]?.address !== derived.configAddress
        || createAccounts[1]?.address !== facilitatorAddress
        || createAccounts[2]?.address !== derived.walletAddress
        || createAccounts[3]?.address !== SYSTEM_PROGRAM
    ) {
        return "Swig CreateV1 accounts do not match its derived config, wallet, and facilitator payer";
    }

    const sign = instructions[createIndex + 1]!;
    const signData = sign.data;
    const signAccounts = sign.accounts ?? [];
    if (
        sign.programAddress !== SWIG_PROGRAM
        || !signData
        || signData.length < 8 + 77
        || readU16(signData, 0) !== SWIG_SIGN_V2
        || readU32(signData, 4) !== 0
        || signAccounts[0]?.address !== derived.configAddress
        || signAccounts[1]?.address !== derived.walletAddress
    ) {
        return "Swig activation must end with role-0 SignV2 for the derived wallet";
    }
    const compactLength = readU16(signData, 2);
    if (signData.length < 8 + compactLength + 77) {
        return "Swig activation SignV2 payload is truncated";
    }
    const compact = decodeCompactInstructions(signData.slice(8, 8 + compactLength));
    if (!compact) return "Swig activation SignV2 contains invalid compact instructions";
    const counterOffset = 8 + compactLength + 8;
    if (readU32(signData, counterOffset) !== 1) {
        return "Swig activation must use the initial secp256k1 odometer value";
    }

    const resolveProgram = (instruction: CompactInstruction) =>
        signAccounts[instruction.programIdIndex]?.address ?? null;
    const resolveAccounts = (instruction: CompactInstruction) =>
        instruction.accountIndexes.map((index) => signAccounts[index]?.address ?? null);
    const ataInstruction = compact[0]!;
    const reimbursementInstruction = compact.at(-1)!;
    const ataAccounts = resolveAccounts(ataInstruction);
    const reimbursementAccounts = resolveAccounts(reimbursementInstruction);
    const definition = getNetwork(network);
    const expectedMint = definition.asset.address;
    const expectedAta = await deriveAta(derived.walletAddress, expectedMint);
    const expectedWsolAta = await deriveAta(derived.walletAddress, WRAPPED_SOL_MINT);
    if (standardActivation) {
        if (compact.length !== 2
            || resolveProgram(ataInstruction) !== ASSOCIATED_TOKEN_PROGRAM
            || ataInstruction.data.length !== 1
            || ataInstruction.data[0] !== CREATE_IDEMPOTENT_ATA
            || ataAccounts.length !== 6
            || ataAccounts[0] !== derived.walletAddress
            || ataAccounts[1] !== expectedAta
            || ataAccounts[2] !== derived.walletAddress
            || ataAccounts[3] !== expectedMint
            || ataAccounts[4] !== SYSTEM_PROGRAM
            || ataAccounts[5] !== TOKEN_PROGRAM
        ) {
            return "Swig activation must idempotently create the configured USDC ATA using the user wallet as payer";
        }
    } else {
        if (compact.length !== 4) return "USDC-funded activation must contain setup, swap, cleanup, and return instructions";
        const swapInstruction = compact[1]!;
        const cleanupInstruction = compact[2]!;
        const swapAccounts = resolveAccounts(swapInstruction);
        const cleanupAccounts = resolveAccounts(cleanupInstruction);
        const facilitatorUsedBeforeReturn = compact.slice(0, -1).some((instruction) =>
            resolveAccounts(instruction).includes(facilitatorAddress)
        );
        if (
            resolveProgram(ataInstruction) !== ASSOCIATED_TOKEN_PROGRAM
            || ataInstruction.data.length !== 1
            || ataInstruction.data[0] !== CREATE_IDEMPOTENT_ATA
            || ataAccounts.join(",") !== [
                derived.walletAddress,
                expectedWsolAta,
                derived.walletAddress,
                WRAPPED_SOL_MINT,
                SYSTEM_PROGRAM,
                TOKEN_PROGRAM,
            ].join(",")
            || resolveProgram(swapInstruction) !== JUPITER_PROGRAM
            || !swapAccounts.includes(derived.walletAddress)
            || !swapAccounts.includes(expectedAta)
            || !swapAccounts.includes(expectedWsolAta)
            || resolveProgram(cleanupInstruction) !== TOKEN_PROGRAM
            || cleanupInstruction.data.length !== 1
            || cleanupInstruction.data[0] !== 9
            || cleanupAccounts.join(",") !== [expectedWsolAta, derived.walletAddress, derived.walletAddress].join(",")
            || facilitatorUsedBeforeReturn
        ) {
            return "USDC-funded activation contains an invalid Jupiter SOL recovery route";
        }
    }
    if (
        resolveProgram(reimbursementInstruction) !== SYSTEM_PROGRAM
        || reimbursementInstruction.data.length !== 12
        || readU32(reimbursementInstruction.data, 0) !== SYSTEM_TRANSFER
        || reimbursementAccounts.length !== 2
        || reimbursementAccounts[0] !== derived.walletAddress
        || reimbursementAccounts[1] !== facilitatorAddress
    ) {
        return "Swig activation reimbursement must transfer SOL from the user wallet to the facilitator";
    }

    const [configInfo, walletInfo, mintInfo, ataInfo, configRent, ataRent, feeResponse] =
        await Promise.all([
            rpc.getAccountInfo(derived.configAddress, { encoding: "base64" }).send(),
            rpc.getAccountInfo(derived.walletAddress, { encoding: "base64" }).send(),
            rpc.getAccountInfo(solanaAddress(expectedMint), { encoding: "base64" }).send(),
            rpc.getAccountInfo(expectedAta, { encoding: "base64" }).send(),
            rpc.getMinimumBalanceForRentExemption(SWIG_CONFIG_SIZE).send(),
            rpc.getMinimumBalanceForRentExemption(TOKEN_ACCOUNT_SIZE).send(),
            rpc.getFeeForMessage(getBase64Decoder().decode(transaction.messageBytes as never) as never, {
                commitment: "confirmed",
            }).send(),
        ]);
    if (configInfo.value) return "Swig config account is already initialized";
    if (walletInfo.value) {
        const walletData = accountDataBytes(walletInfo.value.data);
        if (walletInfo.value.owner !== SYSTEM_PROGRAM || !walletData || walletData.length !== 0) {
            return "Swig wallet must be a zero-data System Program account";
        }
    } else if (standardActivation) {
        return "Standard activation requires the displayed Swig wallet to be funded";
    }
    if (!mintInfo.value || mintInfo.value.owner !== TOKEN_PROGRAM) {
        return "Configured activation mint must be owned by the standard SPL Token program";
    }
    if (feeResponse.value === null) return "Unable to quote the activation transaction fee";
    const reimbursement = readU64(reimbursementInstruction.data, 4);
    let expectedReimbursement = configRent + feeResponse.value;
    if (usdcActivation) {
        const prefundInstruction = instructions[1]!;
        const prefundAccounts = prefundInstruction.accounts ?? [];
        if (
            !prefundInstruction.data
            || prefundInstruction.data.length !== 12
            || readU32(prefundInstruction.data, 0) !== SYSTEM_TRANSFER
            || readU64(prefundInstruction.data, 4) !== ataRent
            || prefundAccounts.length !== 2
            || prefundAccounts[0]?.address !== facilitatorAddress
            || prefundAccounts[1]?.address !== derived.walletAddress
        ) {
            return "USDC-funded activation must advance exactly one temporary WSOL-account rent reserve";
        }
        expectedReimbursement += ataRent;
    }
    if (reimbursement !== expectedReimbursement) {
        return `Swig activation must reimburse exactly ${expectedReimbursement} lamports`;
    }
    if (ataInfo.value) {
        const ataData = accountDataBytes(ataInfo.value.data);
        if (
            ataInfo.value.owner !== TOKEN_PROGRAM
            || !ataData
            || ataData.length < 64
            || Buffer.from(ataData.slice(0, 32)).compare(Buffer.from(getAddressEncoder().encode(solanaAddress(expectedMint)))) !== 0
            || Buffer.from(ataData.slice(32, 64)).compare(Buffer.from(getAddressEncoder().encode(derived.walletAddress))) !== 0
        ) {
            return "Existing activation ATA does not belong to the configured mint and Swig wallet";
        }
    }
    if (standardActivation && BigInt(walletInfo.value!.lamports) < ACTIVATION_MINIMUM_LAMPORTS) {
        return `Swig wallet requires at least ${ACTIVATION_MINIMUM_LAMPORTS} lamports for activation`;
    }
    if (usdcActivation) {
        if (!ataInfo.value) return "USDC-funded activation requires an existing mainnet USDC ATA";
        const ataData = accountDataBytes(ataInfo.value.data);
        if (!ataData || ataData.length < 72 || readU64(ataData, 64) === 0n) {
            return "USDC-funded activation requires a positive mainnet USDC balance";
        }
    }
    return null;
}

class SvmTransactionFailedError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "SvmTransactionFailedError";
    }
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
            throw new SvmTransactionFailedError(`SVM relay transaction failed: ${JSON.stringify(current.err)}`);
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

function isFacilitatorSafeInInstruction(
    programAddress: string,
    accountAddresses: readonly string[],
    data: Readonly<Uint8Array> | undefined,
    facilitatorAddress: string,
): string | null {
    const indexes: number[] = [];
    for (let i = 0; i < accountAddresses.length; i += 1) {
        if (accountAddresses[i] === facilitatorAddress) {
            indexes.push(i);
        }
    }
    if (indexes.length === 0) {
        return null;
    }
    if (programAddress === SYSTEM_PROGRAM) {
        // Only allow facilitator as recipient (index 1) of a SystemProgram.Transfer (u32 opcode = 2).
        const isTransfer = Boolean(data && data.length >= 4 && readU32(data, 0) === SYSTEM_TRANSFER);
        if (isTransfer && indexes.every((idx) => idx === 1)) {
            return null;
        }
        return "Relay refuses SystemProgram instructions that debit or authorize the facilitator fee payer";
    }
    if (programAddress === TOKEN_PROGRAM || programAddress === TOKEN_2022_PROGRAM) {
        // Allow facilitator only as delegate: index 1 for SPL Approve (4), index 2 for ApproveChecked (13; index 1 is mint).
        const opcode = data?.[0];
        const allowedDelegateIndex = opcode === SPL_APPROVE_DISCRIMINATOR
            ? 1
            : opcode === SPL_APPROVE_CHECKED_DISCRIMINATOR
                ? 2
                : -1;
        if (allowedDelegateIndex >= 0 && indexes.every((idx) => idx === allowedDelegateIndex)) {
            return null;
        }
        return "Relay refuses SPL Token instructions that debit or authorize the facilitator fee payer";
    }
    return `Relay refuses ${programAddress} instructions referencing the facilitator fee payer`;
}

/**
 * Validate non-activation transactions so the facilitator fee payer can never
 * be abused to execute arbitrary Solana programs or debit facilitator funds.
 */
export async function validateRelayInstructions(
    transaction: DecodedRelayTransaction,
    facilitatorAddress: string,
    rpc: ReturnType<typeof createSvmRpc>,
): Promise<string | null> {
    if (!transaction.messageBytes) {
        return "Relay transaction is missing messageBytes";
    }
    const message = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes as never);
    const decompiled = await decompileTransactionMessageFetchingLookupTables(message, rpc as any);
    const instructions = decompiled.instructions as unknown as readonly RelayInstruction[];
    if (instructions.length === 0) {
        return "Relay transaction must contain at least one instruction";
    }

    for (const instruction of instructions) {
        const program = instruction.programAddress;
        if (!RELAY_ALLOWED_PROGRAMS.has(program)) {
            return `Relay does not allow program ${program}`;
        }

        if (program === COMPUTE_BUDGET_PROGRAM) {
            if ((instruction.accounts?.length ?? 0) > 0) {
                return "ComputeBudget instruction cannot reference accounts";
            }
            const data = instruction.data;
            if (!data || data.length === 0) {
                return "Invalid ComputeBudget instruction data";
            }
            if (data[0] === 2) {
                if (data.length !== 5 || readU32(data, 1) > MAX_RELAY_COMPUTE_UNITS) {
                    return "ComputeBudget unit limit exceeds relay maximum";
                }
            } else if (data[0] === 3) {
                if (data.length !== 9 || readU64(data, 1) > MAX_RELAY_COMPUTE_UNIT_PRICE_MICROLAMPORTS) {
                    return "ComputeBudget unit price exceeds relay maximum";
                }
            } else if (data[0] === 1 || data[0] === 4) {
                // RequestHeapFrame / SetLoadedAccountsDataSizeLimit: safe read-only compute settings
            } else {
                return "Unsupported ComputeBudget instruction";
            }
            continue;
        }

        const accounts = (instruction.accounts ?? []).map((acc) => acc.address);
        if (program === SWIG_PROGRAM) {
            // If facilitator is passed into a Swig SignV2 instruction, verify every
            // inner compact instruction respects facilitator safety rules.
            const hasFacilitator = accounts.includes(facilitatorAddress);
            if (!hasFacilitator) {
                continue;
            }
            const data = instruction.data;
            if (!data || data.length < 8) {
                return "Invalid Swig instruction data";
            }
            const swigOp = readU16(data, 0);
            if (swigOp !== SWIG_SIGN_V2) {
                return "Relay refuses non-SignV2 Swig instructions referencing facilitator";
            }
            const payloadLen = readU16(data, 2);
            const compactBytes = data.slice(8, 8 + payloadLen);
            const inner = decodeCompactInstructions(compactBytes);
            if (!inner || inner.length === 0) {
                return "Relay could not decode inner Swig SignV2 instructions";
            }
            for (const item of inner) {
                const innerProgram = accounts[item.programIdIndex] ?? "";
                if (!RELAY_ALLOWED_PROGRAMS.has(innerProgram) && innerProgram !== JUPITER_PROGRAM) {
                    return `Relay refuses inner Swig program ${innerProgram}`;
                }
                const innerAccounts = item.accountIndexes.map((idx) => accounts[idx] ?? "");
                const innerErr = isFacilitatorSafeInInstruction(innerProgram, innerAccounts, item.data, facilitatorAddress);
                if (innerErr) {
                    return innerErr;
                }
            }
            continue;
        }

        const accountErr = isFacilitatorSafeInInstruction(program, accounts, instruction.data, facilitatorAddress);
        if (accountErr) {
            return accountErr;
        }
    }

    return null;
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

            const activationValidationError = await validateSelfFundedSwigActivation(
                unsignedTx,
                signer.address,
                rpc,
                network as SolanaNetworkId,
            );
            if (activationValidationError) {
                res.status(400).json(buildError("validation_error", activationValidationError));
                return;
            }

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
