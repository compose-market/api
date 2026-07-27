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
    type Address,
    type Blockhash,
} from "@solana/kit";
import {
    getMissingRelaySignatures,
    validateRelayFeePayerSigner,
} from "../svm/relay.js";

const SOLANA_DEVNET_RPC = process.env.SOLANA_DEVNET_RPC ?? "https://api.devnet.solana.com";
const SVM_FACILITATOR_KEY = process.env.SVM_FACILITATOR_KEY;
const FACILITATOR_ADDRESS = "139ckThCRxYDDFXgfRjH4TCiaTJETbb1UMLwACvWJ1fq" as Address;
const EXTRA_SIGNER_ADDRESS = "EMhuLpXRZrT4pwfhxeRFQbTmZYyo4Dsq3keNq6tj4PGW" as Address;
const WRONG_FEE_PAYER_ADDRESS = "HMb2gPddSGrBt4kjWHv2stA8otCC1NdoE9p7M9yRr3RS" as Address;

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
