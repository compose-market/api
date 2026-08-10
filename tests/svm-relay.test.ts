import assert from "node:assert/strict";
import test from "node:test";
import { base58 } from "@scure/base";
import {
    createSolanaRpc,
    devnet as solanaDevnet,
    getBase64EncodedWireTransaction,
    createKeyPairSignerFromBytes,
    createTransactionMessage,
    setTransactionMessageFeePayerSigner,
    setTransactionMessageLifetimeUsingBlockhash,
    appendTransactionMessageInstruction,
    compileTransaction,
    signTransactionMessageWithSigners,
    setTransactionMessageFeePayer,
    AccountRole,
    getAddressEncoder,
    getBase64Decoder,
    getProgramDerivedAddress,
    address,
    type Address,
    type Blockhash,
} from "@solana/kit";
import {
    getMissingRelaySignatures,
    SVM_ACTIVATION_MEMO,
    validateSelfFundedSwigActivation,
    validateRelayFeePayerSigner,
} from "../svm/relay.js";

const SOLANA_DEVNET_RPC = process.env.SOLANA_DEVNET_RPC ?? "https://api.devnet.solana.com";
const SVM_FACILITATOR_KEY = process.env.SVM_FACILITATOR_KEY;
const FACILITATOR_ADDRESS = "139ckThCRxYDDFXgfRjH4TCiaTJETbb1UMLwACvWJ1fq" as Address;
const EXTRA_SIGNER_ADDRESS = "EMhuLpXRZrT4pwfhxeRFQbTmZYyo4Dsq3keNq6tj4PGW" as Address;
const WRONG_FEE_PAYER_ADDRESS = "HMb2gPddSGrBt4kjWHv2stA8otCC1NdoE9p7M9yRr3RS" as Address;
const SWIG_PROGRAM = "swigypWHEksbC64pWKwah1WTeh9JXwx8H1rJHLdbQMB" as Address;
const SYSTEM_PROGRAM = "11111111111111111111111111111111" as Address;
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" as Address;
const ASSOCIATED_TOKEN_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL" as Address;
const DEVNET_USDC = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU" as Address;
const MAINNET_USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" as Address;
const WRAPPED_SOL = "So11111111111111111111111111111111111111112" as Address;
const JUPITER_PROGRAM = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4" as Address;
const COMPUTE_BUDGET_PROGRAM = "ComputeBudget111111111111111111111111111111" as Address;
const MEMO_PROGRAM = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr" as Address;
const SOLANA_DEVNET = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1" as const;
const SOLANA_MAINNET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" as const;

test("SVM relay validation rejects transactions whose fee payer is not the facilitator", () => {
    const tx = compileRelayValidationTransaction({
        feePayer: WRONG_FEE_PAYER_ADDRESS,
    });

    assert.equal(
        validateRelayFeePayerSigner(tx, FACILITATOR_ADDRESS),
        `transaction fee payer must be ${FACILITATOR_ADDRESS}; got ${WRONG_FEE_PAYER_ADDRESS}`,
    );
});

test("SVM relay validation reports extra missing signatures before RPC submission", () => {
    const tx = compileRelayValidationTransaction({
        feePayer: FACILITATOR_ADDRESS,
        extraSigner: EXTRA_SIGNER_ADDRESS,
    });
    const afterFeePayerSignature = {
        ...tx,
        signatures: {
            ...tx.signatures,
            [FACILITATOR_ADDRESS]: new Uint8Array(64),
        },
    };

    assert.equal(validateRelayFeePayerSigner(tx, FACILITATOR_ADDRESS), null);
    assert.deepEqual(getMissingRelaySignatures(afterFeePayerSignature), [EXTRA_SIGNER_ADDRESS]);
});

test("SVM relay validation accepts a fee-payer-only signed transaction", () => {
    const tx = compileRelayValidationTransaction({
        feePayer: FACILITATOR_ADDRESS,
    });
    const afterFeePayerSignature = {
        ...tx,
        signatures: {
            ...tx.signatures,
            [FACILITATOR_ADDRESS]: new Uint8Array(64),
        },
    };

    assert.equal(validateRelayFeePayerSigner(tx, FACILITATOR_ADDRESS), null);
    assert.deepEqual(getMissingRelaySignatures(afterFeePayerSignature), []);
});

test("SVM relay accepts canonical self-funded Swig activation", async () => {
    const activation = await compileSelfFundedActivationTransaction();
    const error = await validateSelfFundedSwigActivation(
        activation.transaction,
        FACILITATOR_ADDRESS,
        activationRpc(activation.walletAddress, activation.configAddress, activation.ataAddress),
        SOLANA_DEVNET,
    );
    assert.equal(error, null);
});

test("SVM relay rejects Swig activation that under-reimburses the facilitator", async () => {
    const activation = await compileSelfFundedActivationTransaction(1_675_399n);
    const error = await validateSelfFundedSwigActivation(
        activation.transaction,
        FACILITATOR_ADDRESS,
        activationRpc(activation.walletAddress, activation.configAddress, activation.ataAddress),
        SOLANA_DEVNET,
    );
    assert.equal(error, "Swig activation must reimburse exactly 1675400 lamports");
});

test("SVM relay rejects Swig activation with an arbitrary memo", async () => {
    const activation = await compileSelfFundedActivationTransaction(1_675_400n, "untrusted activation label");
    const error = await validateSelfFundedSwigActivation(
        activation.transaction,
        FACILITATOR_ADDRESS,
        activationRpc(activation.walletAddress, activation.configAddress, activation.ataAddress),
        SOLANA_DEVNET,
    );
    assert.equal(error, `Swig activation must begin with the exact memo: ${SVM_ACTIVATION_MEMO}`);
});

test("SVM relay rejects non-atomic Swig creation", async () => {
    const activation = await compileSelfFundedActivationTransaction();
    const decodedMessage = activation.transaction.messageBytes;
    assert.ok(decodedMessage);

    const id = new Uint8Array(32);
    const { createInstruction } = await buildActivationInstructions(id, 1_675_400n);
    const transaction = compileTransaction(pipe(
        createTransactionMessage({ version: 0 }),
        (message: any) => setTransactionMessageFeePayer(FACILITATOR_ADDRESS, message),
        (message: any) => setTransactionMessageLifetimeUsingBlockhash({
            blockhash: "11111111111111111111111111111111" as Blockhash,
            lastValidBlockHeight: 1n,
        }, message),
        (message: any) => appendTransactionMessageInstruction(memoInstruction(), message),
        (message: any) => appendTransactionMessageInstruction(createInstruction, message),
    ));
    const error = await validateSelfFundedSwigActivation(
        transaction,
        FACILITATOR_ADDRESS,
        activationRpc(activation.walletAddress, activation.configAddress, activation.ataAddress),
        SOLANA_DEVNET,
    );
    assert.equal(
        error,
        "Swig activation transaction has an unsupported instruction sequence",
    );
});

test("SVM relay accepts mainnet USDC-funded atomic activation", async () => {
    const activation = await compileUsdcFundedActivationTransaction();
    const error = await validateSelfFundedSwigActivation(
        activation.transaction,
        FACILITATOR_ADDRESS,
        mainnetActivationRpc(
            activation.walletAddress,
            activation.configAddress,
            activation.usdcAtaAddress,
        ),
        SOLANA_MAINNET,
    );
    assert.equal(error, null);
});

test("SVM relay: facilitator can sign + submit a self-transfer to devnet", async (t) => {
    if (!SVM_FACILITATOR_KEY) {
        t.skip("SVM_FACILITATOR_KEY not set — skipping devnet round-trip");
        return;
    }

    const signer = await createKeyPairSignerFromBytes(base58.decode(SVM_FACILITATOR_KEY));
    const rpc = createSolanaRpc(solanaDevnet(SOLANA_DEVNET_RPC));

    const { value: latestBlockhash } = await rpc.getLatestBlockhash().send();

    const transferIx = {
        programAddress: "11111111111111111111111111111111" as Address,
        accounts: [
            { address: signer.address, role: 3 },
            { address: signer.address, role: 3 },
        ],
        data: new Uint8Array([2, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0]),
    };

    const transactionMessage = pipe(
        createTransactionMessage({ version: 0 }),
        (msg: any) => setTransactionMessageFeePayerSigner(signer, msg),
        (msg: any) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, msg),
        (msg: any) => appendTransactionMessageInstruction(transferIx, msg),
    );

    const signedTx = await signTransactionMessageWithSigners(transactionMessage as any);
    const wireTx = getBase64EncodedWireTransaction(signedTx);

    const signature = await rpc.sendTransaction(wireTx, {
        encoding: "base64",
        preflightCommitment: "confirmed",
    }).send();

    assert.ok(typeof signature === "string", "Transaction must return a signature");
});

function pipe<T>(value: T, ...fns: Array<(v: T) => T>): T {
    return fns.reduce((v, fn) => fn(v), value);
}

function compileRelayValidationTransaction(input: {
    feePayer: Address;
    extraSigner?: Address;
}) {
    const blockhash = {
        blockhash: "11111111111111111111111111111111" as Blockhash,
        lastValidBlockHeight: 1n,
    };
    const instruction = {
        programAddress: "11111111111111111111111111111111" as Address,
        accounts: input.extraSigner
            ? [{ address: input.extraSigner, role: AccountRole.READONLY_SIGNER }]
            : [],
        data: new Uint8Array(),
    };

    return compileTransaction(pipe(
        createTransactionMessage({ version: 0 }),
        (msg: any) => setTransactionMessageFeePayer(input.feePayer, msg),
        (msg: any) => setTransactionMessageLifetimeUsingBlockhash(blockhash, msg),
        (msg: any) => appendTransactionMessageInstruction(instruction, msg),
    ));
}

async function compileSelfFundedActivationTransaction(
    reimbursement = 1_675_400n,
    memo = SVM_ACTIVATION_MEMO,
) {
    const id = new Uint8Array(32);
    const built = await buildActivationInstructions(id, reimbursement);
    const transaction = compileTransaction(pipe(
        createTransactionMessage({ version: 0 }),
        (message: any) => setTransactionMessageFeePayer(FACILITATOR_ADDRESS, message),
        (message: any) => setTransactionMessageLifetimeUsingBlockhash({
            blockhash: "11111111111111111111111111111111" as Blockhash,
            lastValidBlockHeight: 1n,
        }, message),
        (message: any) => appendTransactionMessageInstruction(memoInstruction(memo), message),
        (message: any) => appendTransactionMessageInstruction(built.createInstruction, message),
        (message: any) => appendTransactionMessageInstruction(built.signInstruction, message),
    ));
    return { transaction, ...built };
}

async function buildActivationInstructions(id: Uint8Array, reimbursement: bigint) {
    const encoder = getAddressEncoder();
    const [configAddress, configBump] = await getProgramDerivedAddress({
        programAddress: SWIG_PROGRAM,
        seeds: [new TextEncoder().encode("swig"), id],
    });
    const [walletAddress, walletBump] = await getProgramDerivedAddress({
        programAddress: SWIG_PROGRAM,
        seeds: [new TextEncoder().encode("swig-wallet-address"), encoder.encode(configAddress)],
    });
    const [ataAddress] = await getProgramDerivedAddress({
        programAddress: ASSOCIATED_TOKEN_PROGRAM,
        seeds: [encoder.encode(walletAddress), encoder.encode(TOKEN_PROGRAM), encoder.encode(DEVNET_USDC)],
    });

    const createData = new Uint8Array(112);
    const createView = new DataView(createData.buffer);
    createView.setUint16(0, 0, true);
    createView.setUint16(2, 3, true);
    createView.setUint16(4, 64, true);
    createData[6] = configBump;
    createData[7] = walletBump;
    createData.set(id, 8);
    createData[40] = 2;
    createView.setUint16(104, 7, true);
    createView.setUint16(106, 0, true);
    createView.setUint32(108, 8, true);
    const createInstruction = {
        programAddress: SWIG_PROGRAM,
        accounts: [
            { address: configAddress, role: AccountRole.WRITABLE },
            { address: FACILITATOR_ADDRESS, role: AccountRole.WRITABLE_SIGNER },
            { address: walletAddress, role: AccountRole.WRITABLE },
            { address: SYSTEM_PROGRAM, role: AccountRole.READONLY },
        ],
        data: createData,
    };

    const transferData = new Uint8Array(12);
    const transferView = new DataView(transferData.buffer);
    transferView.setUint32(0, 2, true);
    transferView.setBigUint64(4, reimbursement, true);
    const compact = new Uint8Array(30);
    let cursor = 0;
    compact[cursor++] = 2;
    compact[cursor++] = 2;
    compact[cursor++] = 6;
    compact.set([1, 3, 1, 4, 5, 6], cursor);
    cursor += 6;
    new DataView(compact.buffer).setUint16(cursor, 1, true);
    cursor += 2;
    compact[cursor++] = 1;
    compact[cursor++] = 7;
    compact[cursor++] = 2;
    compact.set([1, 8], cursor);
    cursor += 2;
    new DataView(compact.buffer).setUint16(cursor, transferData.length, true);
    cursor += 2;
    compact.set(transferData, cursor);

    const signData = new Uint8Array(8 + compact.length + 77);
    const signView = new DataView(signData.buffer);
    signView.setUint16(0, 11, true);
    signView.setUint16(2, compact.length, true);
    signView.setUint32(4, 0, true);
    signData.set(compact, 8);
    signView.setBigUint64(8 + compact.length, 1n, true);
    signView.setUint32(8 + compact.length + 8, 1, true);
    const signInstruction = {
        programAddress: SWIG_PROGRAM,
        accounts: [
            { address: configAddress, role: AccountRole.WRITABLE },
            { address: walletAddress, role: AccountRole.WRITABLE },
            { address: ASSOCIATED_TOKEN_PROGRAM, role: AccountRole.READONLY },
            { address: ataAddress, role: AccountRole.WRITABLE },
            { address: DEVNET_USDC, role: AccountRole.READONLY },
            { address: SYSTEM_PROGRAM, role: AccountRole.READONLY },
            { address: TOKEN_PROGRAM, role: AccountRole.READONLY },
            { address: SYSTEM_PROGRAM, role: AccountRole.READONLY },
            { address: FACILITATOR_ADDRESS, role: AccountRole.WRITABLE_SIGNER },
        ],
        data: signData,
    };
    return { createInstruction, signInstruction, configAddress, walletAddress, ataAddress };
}

async function compileUsdcFundedActivationTransaction() {
    const id = new Uint8Array(32).fill(19);
    const encoder = getAddressEncoder();
    const [configAddress, configBump] = await getProgramDerivedAddress({
        programAddress: SWIG_PROGRAM,
        seeds: [new TextEncoder().encode("swig"), id],
    });
    const [walletAddress, walletBump] = await getProgramDerivedAddress({
        programAddress: SWIG_PROGRAM,
        seeds: [new TextEncoder().encode("swig-wallet-address"), encoder.encode(configAddress)],
    });
    const [usdcAtaAddress] = await getProgramDerivedAddress({
        programAddress: ASSOCIATED_TOKEN_PROGRAM,
        seeds: [encoder.encode(walletAddress), encoder.encode(TOKEN_PROGRAM), encoder.encode(MAINNET_USDC)],
    });
    const [wsolAtaAddress] = await getProgramDerivedAddress({
        programAddress: ASSOCIATED_TOKEN_PROGRAM,
        seeds: [encoder.encode(walletAddress), encoder.encode(TOKEN_PROGRAM), encoder.encode(WRAPPED_SOL)],
    });

    const createData = new Uint8Array(112);
    const createView = new DataView(createData.buffer);
    createView.setUint16(0, 0, true);
    createView.setUint16(2, 3, true);
    createView.setUint16(4, 64, true);
    createData[6] = configBump;
    createData[7] = walletBump;
    createData.set(id, 8);
    createData[40] = 2;
    createView.setUint16(104, 7, true);
    createView.setUint32(108, 8, true);
    const createInstruction = {
        programAddress: SWIG_PROGRAM,
        accounts: [
            { address: configAddress, role: AccountRole.WRITABLE },
            { address: FACILITATOR_ADDRESS, role: AccountRole.WRITABLE_SIGNER },
            { address: walletAddress, role: AccountRole.WRITABLE },
            { address: SYSTEM_PROGRAM, role: AccountRole.READONLY },
        ],
        data: createData,
    };

    const signAccounts = [
        { address: configAddress, role: AccountRole.WRITABLE },
        { address: walletAddress, role: AccountRole.WRITABLE },
        { address: ASSOCIATED_TOKEN_PROGRAM, role: AccountRole.READONLY },
        { address: wsolAtaAddress, role: AccountRole.WRITABLE },
        { address: WRAPPED_SOL, role: AccountRole.READONLY },
        { address: SYSTEM_PROGRAM, role: AccountRole.READONLY },
        { address: TOKEN_PROGRAM, role: AccountRole.READONLY },
        { address: JUPITER_PROGRAM, role: AccountRole.READONLY },
        { address: usdcAtaAddress, role: AccountRole.WRITABLE },
        { address: FACILITATOR_ADDRESS, role: AccountRole.WRITABLE_SIGNER },
    ];
    const reimbursement = 2_039_280n + 1_670_400n + 5_000n;
    const compactParts = [
        encodeCompactInstruction(2, [1, 3, 1, 4, 5, 6], new Uint8Array([1])),
        encodeCompactInstruction(7, [1, 8, 3], new Uint8Array([1])),
        encodeCompactInstruction(6, [3, 1, 1], new Uint8Array([9])),
        encodeCompactInstruction(5, [1, 9], systemTransferData(reimbursement)),
    ];
    const compactLength = 1 + compactParts.reduce((sum, part) => sum + part.length, 0);
    const compact = new Uint8Array(compactLength);
    compact[0] = compactParts.length;
    let compactOffset = 1;
    for (const part of compactParts) {
        compact.set(part, compactOffset);
        compactOffset += part.length;
    }
    const signData = new Uint8Array(8 + compact.length + 77);
    const signView = new DataView(signData.buffer);
    signView.setUint16(0, 11, true);
    signView.setUint16(2, compact.length, true);
    signData.set(compact, 8);
    signView.setBigUint64(8 + compact.length, 1n, true);
    signView.setUint32(8 + compact.length + 8, 1, true);
    const signInstruction = { programAddress: SWIG_PROGRAM, accounts: signAccounts, data: signData };

    const computeData = new Uint8Array(5);
    computeData[0] = 2;
    new DataView(computeData.buffer).setUint32(1, 1_400_000, true);
    const prefundInstruction = {
        programAddress: SYSTEM_PROGRAM,
        accounts: [
            { address: FACILITATOR_ADDRESS, role: AccountRole.WRITABLE_SIGNER },
            { address: walletAddress, role: AccountRole.WRITABLE },
        ],
        data: systemTransferData(2_039_280n),
    };
    const transaction = compileTransaction(pipe(
        createTransactionMessage({ version: 0 }),
        (message: any) => setTransactionMessageFeePayer(FACILITATOR_ADDRESS, message),
        (message: any) => setTransactionMessageLifetimeUsingBlockhash({
            blockhash: "11111111111111111111111111111111" as Blockhash,
            lastValidBlockHeight: 1n,
        }, message),
        (message: any) => appendTransactionMessageInstruction(memoInstruction(), message),
        (message: any) => appendTransactionMessageInstruction({
            programAddress: COMPUTE_BUDGET_PROGRAM,
            accounts: [],
            data: computeData,
        }, message),
        (message: any) => appendTransactionMessageInstruction(prefundInstruction, message),
        (message: any) => appendTransactionMessageInstruction(createInstruction, message),
        (message: any) => appendTransactionMessageInstruction(signInstruction, message),
    ));
    return { transaction, walletAddress, configAddress, usdcAtaAddress };
}

function memoInstruction(value = SVM_ACTIVATION_MEMO) {
    return {
        programAddress: MEMO_PROGRAM,
        accounts: [],
        data: new TextEncoder().encode(value),
    };
}

function encodeCompactInstruction(programIndex: number, accountIndexes: number[], data: Uint8Array) {
    const encoded = new Uint8Array(1 + 1 + accountIndexes.length + 2 + data.length);
    let offset = 0;
    encoded[offset++] = programIndex;
    encoded[offset++] = accountIndexes.length;
    encoded.set(accountIndexes, offset);
    offset += accountIndexes.length;
    new DataView(encoded.buffer).setUint16(offset, data.length, true);
    offset += 2;
    encoded.set(data, offset);
    return encoded;
}

function systemTransferData(amount: bigint) {
    const data = new Uint8Array(12);
    const view = new DataView(data.buffer);
    view.setUint32(0, 2, true);
    view.setBigUint64(4, amount, true);
    return data;
}

function activationRpc(walletAddress: Address, configAddress: Address, ataAddress: Address) {
    const emptyBase64 = getBase64Decoder().decode(new Uint8Array());
    return {
        getAccountInfo(requested: Address) {
            return {
                send: async () => {
                    if (requested === configAddress || requested === ataAddress) return { value: null };
                    if (requested === walletAddress) {
                        return {
                            value: {
                                owner: SYSTEM_PROGRAM,
                                lamports: 50_000_000n,
                                data: [emptyBase64, "base64"],
                            },
                        };
                    }
                    if (requested === DEVNET_USDC) {
                        return {
                            value: {
                                owner: TOKEN_PROGRAM,
                                lamports: 1n,
                                data: [emptyBase64, "base64"],
                            },
                        };
                    }
                    throw new Error(`Unexpected account lookup: ${requested}`);
                },
            };
        },
        getMinimumBalanceForRentExemption(size: bigint) {
            return {
                send: async () => size === 112n ? 1_670_400n : size === 165n ? 2_039_280n : 890_880n,
            };
        },
        getFeeForMessage() {
            return { send: async () => ({ value: 5_000n }) };
        },
    } as any;
}

function mainnetActivationRpc(walletAddress: Address, configAddress: Address, usdcAtaAddress: Address) {
    const emptyBase64 = getBase64Decoder().decode(new Uint8Array());
    const tokenData = new Uint8Array(165);
    const encoder = getAddressEncoder();
    tokenData.set(encoder.encode(MAINNET_USDC), 0);
    tokenData.set(encoder.encode(walletAddress), 32);
    new DataView(tokenData.buffer).setBigUint64(64, 10_000_000n, true);
    const tokenBase64 = getBase64Decoder().decode(tokenData);
    return {
        getAccountInfo(requested: Address) {
            return {
                send: async () => {
                    if (requested === configAddress || requested === walletAddress) return { value: null };
                    if (requested === MAINNET_USDC) {
                        return { value: { owner: TOKEN_PROGRAM, lamports: 1n, data: [emptyBase64, "base64"] } };
                    }
                    if (requested === usdcAtaAddress) {
                        return { value: { owner: TOKEN_PROGRAM, lamports: 2_039_280n, data: [tokenBase64, "base64"] } };
                    }
                    throw new Error(`Unexpected mainnet account lookup: ${requested}`);
                },
            };
        },
        getMinimumBalanceForRentExemption(size: bigint) {
            return { send: async () => size === 112n ? 1_670_400n : 2_039_280n };
        },
        getFeeForMessage() {
            return { send: async () => ({ value: 5_000n }) };
        },
    } as any;
}
