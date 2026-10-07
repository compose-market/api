import type { Request, Response } from "express";
import type { PaymentRequired, PaymentRequirements } from "@x402/core/types";
import { validatePaymentRequired } from "@x402/core/schemas";
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";

import {
    getCompiledModels,
    type ModelCard,
} from "../inference/catalog/registry.js";
import {
    createPaymentExtensions,
    createPaymentRequirement,
    encodePaymentRequiredHeader,
    getFacilitatorSupported,
} from "./facilitator.js";
import {
    getDefaultUptoEnvelopeWei,
    getPaymentSignatureFromRequest,
} from "./index.js";
import { isServiceAllowedNetwork, type NetworkId } from "./configs/chains.js";
import { extractKeyFromHeader } from "./keys/middleware.js";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;

export const SELLER_ORIGIN = "https://api.compose.market";
export const MODELS_ENTRYPOINT = "/models";
export const MODELS_CATALOG = "/models/list";
const SUPPORTED_NETWORKS_PATH = "/api/x402/facilitator/supported";
const MODEL_EXECUTION_TEMPLATE = "/v1/responses/{selectedModelId}";

type DiscoveryScheme = "upto" | "batch-settlement";

interface PaginationInput {
    limit: number;
    offset: number;
}

function absoluteUrl(path: string, origin = SELLER_ORIGIN): string {
    return `${origin}${path}`;
}

function modelEndpoint(modelId: string, origin = SELLER_ORIGIN): string {
    return `${origin}/v1/responses/${encodeURIComponent(modelId)}`;
}

function parsePositiveInt(value: unknown, fallback: number): number {
    if (typeof value === "string" && /^\d+$/u.test(value.trim())) {
        const parsed = Number.parseInt(value, 10);
        if (Number.isInteger(parsed) && parsed >= 0) {
            return parsed;
        }
    }
    return fallback;
}

function paginationFromQuery(query: Record<string, string | undefined> | undefined): PaginationInput {
    const limit = Math.min(Math.max(parsePositiveInt(query?.limit, DEFAULT_LIMIT), 1), MAX_LIMIT);
    const cursorOffset = parsePositiveInt(query?.cursor, Number.NaN);
    const offset = Number.isInteger(cursorOffset)
        ? cursorOffset
        : parsePositiveInt(query?.offset, 0);
    return { limit, offset };
}

function nextCursor(offset: number, count: number, total: number): string | null {
    const next = offset + count;
    return next < total ? String(next) : null;
}

function modelCatalogRow(model: ModelCard, origin: string): Record<string, unknown> {
    return {
        object: "model",
        id: model.modelId,
        modelId: model.modelId,
        name: model.name,
        provider: model.provider,
        description: model.description,
        pricing: model.pricing,
        endpoint: modelEndpoint(model.modelId, origin),
        method: "POST",
    };
}

export function listModelCatalog(query?: Record<string, string | undefined>, origin = SELLER_ORIGIN): {
    object: "list";
    data: Array<Record<string, unknown>>;
    total: number;
    limit: number;
    offset: number;
    nextCursor: string | null;
} {
    const { limit, offset } = paginationFromQuery(query);
    const models = getCompiledModels().models;
    const slice = models.slice(offset, offset + limit);
    return {
        object: "list",
        data: slice.map((model) => modelCatalogRow(model, origin)),
        total: models.length,
        limit,
        offset,
        nextCursor: nextCursor(offset, slice.length, models.length),
    };
}

export function getModelCatalogCount(): number {
    return getCompiledModels().models.length;
}

export async function getAgentCatalogCount(): Promise<number> {
    const catalog = await fetchAgentCatalog({ limit: "1" });
    if (typeof catalog.total === "number") return catalog.total;
    if (typeof catalog.count === "number") return catalog.count;
    return Array.isArray(catalog.agents) ? catalog.agents.length : 0;
}

function uniqueStrings(values: string[]): string[] {
    return [...new Set(values.filter(Boolean))];
}

async function paymentAcceptsForScheme(scheme: DiscoveryScheme, amountWei?: string): Promise<PaymentRequirements[]> {
    const supported = await getFacilitatorSupported();
    const networks = uniqueStrings(
        supported.kinds
            .filter((kind) => kind.scheme === scheme)
            .map((kind) => kind.network),
    );
    const amount = amountWei && /^\d+$/u.test(amountWei) && BigInt(amountWei) > 0n
        ? amountWei
        : getDefaultUptoEnvelopeWei();
    return networks.map((network) => createPaymentRequirement({
        amountWei: amount,
        network: network as NetworkId,
        scheme,
    }));
}

export async function getOwnershipProofs(): Promise<string[]> {
    const [modelAccepts, agentAccepts] = await Promise.all([
        paymentAcceptsForScheme("upto"),
        paymentAcceptsForScheme("batch-settlement"),
    ]);
    return uniqueStrings([...modelAccepts, ...agentAccepts].map((accept) => accept.payTo));
}

function declareHttpDiscoveryExtension(config: Record<string, unknown>): Record<string, unknown> {
    return declareDiscoveryExtension(config as never);
}

function entrypointInputSchema(kind: "model" | "agent", count: number, origin: string): Record<string, unknown> {
    const catalogPath = kind === "model" ? MODELS_CATALOG : AGENTS_CATALOG;
    const executionTemplate = kind === "model" ? MODEL_EXECUTION_TEMPLATE : AGENT_EXECUTION_TEMPLATE;
    const noun = kind === "model" ? "model" : "agent stream";
    return {
        type: "object",
        description: `No request body is required. This endpoint returns an x402 challenge with instructions for choosing one of ${count} payable ${noun}s from GET ${absoluteUrl(catalogPath, origin)} and then calling POST ${absoluteUrl(executionTemplate, origin)}.`,
        properties: {},
        additionalProperties: true,
    };
}

function entrypointOutput(kind: "model" | "agent", count: number, origin: string): Record<string, unknown> {
    const catalogPath = kind === "model" ? MODELS_CATALOG : AGENTS_CATALOG;
    const executionTemplate = kind === "model" ? MODEL_EXECUTION_TEMPLATE : AGENT_EXECUTION_TEMPLATE;
    const noun = kind === "model" ? "models" : "agent streams";
    return {
        type: "json",
        example: {
            resource: kind === "model" ? "models" : "agents",
            payableCount: count,
            catalog: `GET ${absoluteUrl(catalogPath, origin)}`,
            supportedNetworks: `Use accepts[].network from the 402 challenge or GET ${absoluteUrl(SUPPORTED_NETWORKS_PATH, origin)}.`,
            headers: ["x-network-id", "PAYMENT-SIGNATURE"],
            next: `Choose one of the ${noun}, then call POST ${absoluteUrl(executionTemplate, origin)}.`,
        },
        schema: {
            type: "object",
            properties: {
                resource: { type: "string" },
                payableCount: { type: "integer" },
                catalog: { type: "string" },
                supportedNetworks: { type: "string" },
                headers: { type: "array", items: { type: "string" } },
                next: { type: "string" },
            },
        },
    };
}

function entrypointBazaarExtension(kind: "model" | "agent", count: number, origin: string): Record<string, unknown> {
    return declareHttpDiscoveryExtension({
        method: "POST",
        bodyType: "json",
        input: {},
        inputSchema: entrypointInputSchema(kind, count, origin),
        output: entrypointOutput(kind, count, origin),
    });
}

function modelExecutionBodySchema(): Record<string, unknown> {
    return {
        type: "object",
        properties: {
            input: {
                description: "Text, multimodal input, or OpenAI Responses input items for the selected model.",
                oneOf: [
                    { type: "string" },
                    { type: "array", items: { type: "object", additionalProperties: true } },
                    { type: "object", additionalProperties: true },
                ],
            },
            messages: {
                description: "Chat-style messages accepted by the existing Responses gateway.",
                type: "array",
                items: { type: "object", additionalProperties: true },
            },
            stream: { type: "boolean", default: false },
            tools: { type: "array", items: { type: "object", additionalProperties: true } },
        },
        additionalProperties: true,
    };
}

function modelExecutionBazaarExtension(modelId: string, origin = SELLER_ORIGIN): Record<string, unknown> {
    return declareHttpDiscoveryExtension({
        method: "POST",
        bodyType: "json",
        input: { input: "Hello", stream: false },
        inputSchema: modelExecutionBodySchema(),
        pathParams: { modelId },
        pathParamsSchema: {
            properties: {
                modelId: {
                    type: "string",
                    description: `Model ID selected from GET ${absoluteUrl(MODELS_CATALOG, origin)}.`,
                },
            },
            required: ["modelId"],
        },
        output: {
            example: {
                id: "resp_example",
                object: "response",
                model: modelId,
                output_text: "Hello from Compose Market.",
            },
            schema: {
                type: "object",
                properties: {
                    id: { type: "string" },
                    object: { type: "string" },
                    model: { type: "string" },
                    output_text: { type: "string" },
                },
            },
        },
    });
}

function agentExecutionBazaarExtension(walletAddress: string, origin = SELLER_ORIGIN): Record<string, unknown> {
    return declareHttpDiscoveryExtension({
        method: "POST",
        bodyType: "json",
        input: { input: "Hello", stream: true },
        inputSchema: {
            type: "object",
            properties: {
                input: {
                    description: "Instruction or task for the selected agent stream.",
                    oneOf: [
                        { type: "string" },
                        { type: "array", items: { type: "object", additionalProperties: true } },
                        { type: "object", additionalProperties: true },
                    ],
                },
                messages: {
                    type: "array",
                    items: { type: "object", additionalProperties: true },
                },
            },
            additionalProperties: true,
        },
        pathParams: { walletAddress },
        pathParamsSchema: {
            properties: {
                walletAddress: {
                    type: "string",
                    description: `Agent wallet selected from GET ${absoluteUrl(AGENTS_CATALOG, origin)}.`,
                },
            },
            required: ["walletAddress"],
        },
        output: {
            example: {
                event: "done",
                data: {
                    type: "done",
                    text: "Agent stream completed.",
                },
            },
            schema: {
                type: "object",
                properties: {
                    event: { type: "string" },
                    data: { type: "object", additionalProperties: true },
                },
            },
        },
    });
}

function parsePaymentRequiredV2(value: unknown): PaymentRequired {
    const parsed = validatePaymentRequired(value);
    if (parsed.x402Version !== 2 || !("resource" in parsed)) {
        throw new Error("Only x402 v2 PaymentRequired responses are supported for discovery");
    }
    return parsed as PaymentRequired;
}

async function buildPaymentRequired(params: {
    scheme: DiscoveryScheme;
    resourceUrl: string;
    description: string;
    extensions: Record<string, unknown>;
    amountWei?: string;
}): Promise<PaymentRequired> {
    const accepts = await paymentAcceptsForScheme(params.scheme, params.amountWei);
    return parsePaymentRequiredV2({
        x402Version: 2,
        error: "payment_required",
        resource: {
            url: params.resourceUrl,
            description: params.description,
            mimeType: "application/json",
            serviceName: "Compose Market",
            tags: params.scheme === "upto" ? ["models", "ai", "x402"] : ["agents", "ai", "x402"],
            iconUrl: `https://compose.market/favicon.png`,
        },
        accepts,
        extensions: {
            ...createPaymentExtensions(),
            ...params.extensions,
        },
    });
}

function modelInstructions(count: number, origin: string): string {
    return `Choose one of ${count} currently payable models from GET ${absoluteUrl(MODELS_CATALOG, origin)}. Select an accept entry from this 402 challenge, set x-network-id to its CAIP-2 accepts[].network value, sign the x402 payment, then send PAYMENT-SIGNATURE with the actual paid request. After choosing a modelId from the catalog, invoke POST ${absoluteUrl(MODEL_EXECUTION_TEMPLATE, origin)}.`;
}

function agentInstructions(count: number, origin: string): string {
    return `Choose one of ${count} currently payable agent streams from GET ${absoluteUrl(AGENTS_CATALOG, origin)}. Select an accept entry from this 402 challenge, set x-network-id to its CAIP-2 accepts[].network value, sign the x402 payment, then send PAYMENT-SIGNATURE with the actual paid request. After choosing an agent wallet from the catalog, invoke POST ${absoluteUrl(AGENT_EXECUTION_TEMPLATE, origin)}.`;
}

export async function buildModelsPaymentRequired(origin = SELLER_ORIGIN): Promise<PaymentRequired> {
    const count = getModelCatalogCount();
    return buildPaymentRequired({
        scheme: "upto",
        resourceUrl: absoluteUrl(MODELS_ENTRYPOINT, origin),
        description: modelInstructions(count, origin),
        extensions: entrypointBazaarExtension("model", count, origin),
    });
}

export async function buildAgentsPaymentRequired(origin = SELLER_ORIGIN): Promise<PaymentRequired> {
    const count = await getAgentCatalogCount();
    return buildPaymentRequired({
        scheme: "batch-settlement",
        resourceUrl: absoluteUrl(AGENTS_ENTRYPOINT, origin),
        description: agentInstructions(count, origin),
        extensions: entrypointBazaarExtension("agent", count, origin),
    });
}

export async function buildModelEndpointPaymentRequired(modelId: string, resourceUrl?: string): Promise<PaymentRequired> {
    const count = getModelCatalogCount();
    const origin = resourceUrl ? new URL(resourceUrl).origin : SELLER_ORIGIN;
    return buildPaymentRequired({
        scheme: "upto",
        resourceUrl: resourceUrl || modelEndpoint(modelId),
        description: `Pay to run model ${modelId}. It is selected from ${count} currently payable models in GET ${absoluteUrl(MODELS_CATALOG, origin)}. Set x-network-id from the selected accept entry before sending PAYMENT-SIGNATURE.`,
        extensions: modelExecutionBazaarExtension(modelId, origin),
    });
}

export async function buildAgentStreamPaymentRequired(
    walletAddress: string,
    resourceUrl?: string,
    amountWei?: string,
): Promise<PaymentRequired> {
    const count = await getAgentCatalogCount();
    const origin = resourceUrl ? new URL(resourceUrl).origin : SELLER_ORIGIN;
    return buildPaymentRequired({
        scheme: "batch-settlement",
        resourceUrl: resourceUrl || agentEndpoint(walletAddress),
        description: `Pay to stream agent ${walletAddress}. Use GET ${absoluteUrl(AGENTS_CATALOG, origin)} to discover agents. ${count} agents available. Set x-network-id from the selected accept entry before sending PAYMENT-SIGNATURE.`,
        extensions: agentExecutionBazaarExtension(walletAddress, origin),
        amountWei,
    });
}

export function sendPaymentRequired(res: Response, paymentRequired: PaymentRequired): void {
    res.setHeader("PAYMENT-REQUIRED", encodePaymentRequiredHeader(paymentRequired));
    res.status(402).json(paymentRequired);
}

function requestHasComposeKey(req: Request): boolean {
    const authorization = typeof req.headers.authorization === "string" ? req.headers.authorization : "";
    return Boolean(extractKeyFromHeader(authorization));
}

function requestSignedWithoutNetwork(req: Request): boolean {
    return Boolean(getPaymentSignatureFromRequest(req)) && !getNetworkFromRequest(req);
}

export function shouldDirectChallenge(req: Request): boolean {
    return !requestHasComposeKey(req) && !getPaymentSignatureFromRequest(req);
}

function headerValue(req: Request, name: string): string | undefined {
    const value = req.get?.(name) ?? req.headers[name];
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

// A nested execution (runtime-forwarded child call under a paid root run) carries
// its own execution run id or a parent execution run id and settles continuously
// against the root run's pinned x402 envelope. It has no Compose Key and no fresh
// PAYMENT-SIGNATURE, so it must not be treated as a blind dial that needs a
// discovery challenge; prepareInferencePayment resolves the inherited envelope
// (and fails closed with a corrective 402 if none exists). Mirrors the
// isNestedExecution condition in prepareRawInferenceX402Payment.
function requestIsNestedExecution(req: Request): boolean {
    const runId = headerValue(req, "x-run-id");
    if (!runId) return false;
    const explicitExecutionRunId = headerValue(req, "x-execution-run-id");
    const parentExecutionRunId = headerValue(req, "x-parent-run-id");
    const executionRunId = explicitExecutionRunId ?? runId;
    return executionRunId !== runId || Boolean(parentExecutionRunId);
}

export async function maybeSendAgentStreamDiscoveryChallenge(
    req: Request,
    res: Response,
): Promise<boolean> {
    if (requestSignedWithoutNetwork(req)) {
        res.status(400).json({ error: "x-network-id header is required" });
        return true;
    }
    if (requestIsNestedExecution(req)) {
        return false;
    }
    if (!shouldDirectChallenge(req)) {
        return false;
    }
    const wallet = typeof req.params.walletAddress === "string" ? req.params.walletAddress : "";
    sendPaymentRequired(
        res,
        await buildAgentStreamPaymentRequired(wallet, publicResourceUrl(req), getRawInferenceMaxAmount(req) ?? undefined),
    );
    return true;
}

function modelIdsForOpenApi(): string[] {
    return getCompiledModels().models.map((model) => model.modelId);
}

function networkHeaderParameter(networks: string[], required: boolean): Record<string, unknown> {
    return {
        name: "x-network-id",
        in: "header",
        required,
        description: `CAIP-2 network identifier. For ${MODELS_ENTRYPOINT} and ${AGENTS_ENTRYPOINT}, select one of accepts[].network from the 402 challenge. The same values are available from GET ${absoluteUrl(SUPPORTED_NETWORKS_PATH)}.`,
        schema: networks.length > 0
            ? { type: "string", enum: networks }
            : { type: "string" },
        examples: Object.fromEntries(networks.slice(0, 8).map((network) => [
            network.replace(/[^a-zA-Z0-9]/gu, "_"),
            { value: network },
        ])),
    };
}

function paymentInfo(kind: "model" | "agent"): Record<string, unknown> {
    return {
        protocols: [{ x402: {} }],
        price: kind === "model"
            ? { mode: "dynamic", currency: "USD", min: "0.00000001", max: "1.00" }
            : { mode: "dynamic", currency: "USD", min: "0.00000001", max: "5.00" },
    };
}

function payment402Response(description: string): Record<string, unknown> {
    return {
        description,
        headers: {
            "PAYMENT-REQUIRED": {
                description: "Base64url-encoded x402 v2 PaymentRequired challenge.",
                schema: { type: "string" },
            },
        },
        content: {
            "application/json": {
                schema: { $ref: "#/components/schemas/PaymentRequired" },
            },
        },
    };
}

function paidEntrypointOperation(kind: "model" | "agent", networks: string[]): Record<string, unknown> {
    const countDescription = kind === "model"
        ? `The 402 response tells callers how many payable models are currently available and points them to GET ${MODELS_CATALOG}.`
        : `The 402 response tells callers how many payable agent streams are currently available and points them to GET ${AGENTS_CATALOG}.`;
    return {
        summary: kind === "model" ? "Discover payable model calls" : "Discover payable agent stream calls",
        description: `${countDescription} This operation is an x402 marketplace entrypoint only; it is not the catalog and it is not the final execution URL.`,
        security: [],
        parameters: [{ $ref: "#/components/parameters/NetworkIdHeaderOptional" }],
        requestBody: {
            required: false,
            content: {
                "application/json": {
                    schema: { $ref: "#/components/schemas/DiscoveryProbeInput" },
                    example: {},
                },
            },
        },
        responses: {
            "200": {
                description: "Instruction response after a valid paid request.",
                content: {
                    "application/json": {
                        schema: { $ref: "#/components/schemas/DiscoveryInstructions" },
                    },
                },
            },
            "402": payment402Response("x402 payment challenge with Bazaar input/output metadata and live instructions."),
        },
        "x-payment-info": paymentInfo(kind),
        "x-supported-networks": networks,
    };
}

export async function buildOpenApiDocument(origin = SELLER_ORIGIN): Promise<Record<string, unknown>> {
    const supported = await getFacilitatorSupported();
    const allNetworks = uniqueStrings(supported.kinds.map((kind) => kind.network));
    const uptoNetworks = uniqueStrings(supported.kinds.filter((kind) => kind.scheme === "upto").map((kind) => kind.network));
    const batchNetworks = uniqueStrings(supported.kinds.filter((kind) => kind.scheme === "batch-settlement").map((kind) => kind.network));
    const modelIds = modelIdsForOpenApi();

    return {
        openapi: "3.1.0",
        info: {
            title: "Compose Market x402 Seller API",
            version: "1.0.0",
            description: "Two x402 marketplace entrypoints for discovering payable Compose Market model and agent calls.",
            contact: { email: "team@compose.market" },
            "x-guidance": `POST ${MODELS_ENTRYPOINT} and POST ${AGENTS_ENTRYPOINT} are the only advertised x402 resources. Their 402 challenges instruct callers to use GET ${MODELS_CATALOG} or GET ${AGENTS_CATALOG}, select a resource, set x-network-id from the challenge accepts, sign, and send PAYMENT-SIGNATURE to the selected execution URL.`,
        },
        servers: [{ url: origin }],
        paths: {
            [MODELS_ENTRYPOINT]: {
                post: paidEntrypointOperation("model", uptoNetworks),
            },
            [AGENTS_ENTRYPOINT]: {
                post: paidEntrypointOperation("agent", batchNetworks),
            },
            [MODELS_CATALOG]: {
                get: {
                    summary: "List compiled models",
                    description: `Free paginated catalog used after reading the ${MODELS_ENTRYPOINT} 402 instructions.`,
                    security: [],
                    parameters: [
                        { $ref: "#/components/parameters/Limit" },
                        { $ref: "#/components/parameters/Offset" },
                        { $ref: "#/components/parameters/Cursor" },
                    ],
                    responses: {
                        "200": {
                            description: "Compiled model catalog.",
                            content: {
                                "application/json": {
                                    schema: { $ref: "#/components/schemas/ModelCatalog" },
                                },
                            },
                        },
                    },
                },
            },
            [AGENTS_CATALOG]: {
                get: {
                    summary: "List indexed agents",
                    description: `Free public agent catalog used after reading the ${AGENTS_ENTRYPOINT} 402 instructions.`,
                    security: [],
                    parameters: [
                        { $ref: "#/components/parameters/Limit" },
                        { $ref: "#/components/parameters/Offset" },
                        { $ref: "#/components/parameters/Cursor" },
                    ],
                    responses: {
                        "200": {
                            description: "Live agent catalog.",
                            content: {
                                "application/json": {
                                    schema: { $ref: "#/components/schemas/AgentCatalog" },
                                },
                            },
                        },
                    },
                },
            },
            [SUPPORTED_NETWORKS_PATH]: {
                get: {
                    summary: "List facilitator supported payment kinds",
                    description: "Free helper for choosing x-network-id values. This is not an advertised x402 resource.",
                    security: [],
                    responses: {
                        "200": {
                            description: "Facilitator support.",
                            content: {
                                "application/json": {
                                    schema: { type: "object", additionalProperties: true },
                                },
                            },
                        },
                    },
                },
            },
        },
        components: {
            securitySchemes: {},
            parameters: {
                NetworkIdHeaderOptional: networkHeaderParameter(allNetworks, false),
                Limit: {
                    name: "limit",
                    in: "query",
                    required: false,
                    schema: { type: "integer", minimum: 1, maximum: MAX_LIMIT, default: DEFAULT_LIMIT },
                },
                Offset: {
                    name: "offset",
                    in: "query",
                    required: false,
                    schema: { type: "integer", minimum: 0, default: 0 },
                },
                Cursor: {
                    name: "cursor",
                    in: "query",
                    required: false,
                    schema: { type: "string" },
                },
            },
            schemas: {
                DiscoveryProbeInput: {
                    type: "object",
                    description: "No body is required for the marketplace discovery probe.",
                    additionalProperties: true,
                },
                DiscoveryInstructions: {
                    type: "object",
                    required: ["catalog", "headers", "next"],
                    properties: {
                        catalog: { type: "string" },
                        headers: { type: "array", items: { type: "string" } },
                        next: { type: "string" },
                    },
                    additionalProperties: true,
                },
                PaymentRequired: {
                    type: "object",
                    required: ["x402Version", "resource", "accepts"],
                    properties: {
                        x402Version: { type: "integer", const: 2 },
                        error: { type: "string" },
                        resource: { type: "object", additionalProperties: true },
                        accepts: { type: "array", minItems: 1, items: { type: "object", additionalProperties: true } },
                        extensions: { type: "object", additionalProperties: true },
                    },
                },
                ModelCatalog: {
                    type: "object",
                    required: ["object", "data", "total", "limit", "offset", "nextCursor"],
                    properties: {
                        object: { type: "string", const: "list" },
                        data: {
                            type: "array",
                            items: { $ref: "#/components/schemas/ModelCatalogItem" },
                        },
                        total: { type: "integer" },
                        limit: { type: "integer" },
                        offset: { type: "integer" },
                        nextCursor: { oneOf: [{ type: "string" }, { type: "null" }] },
                    },
                },
                ModelCatalogItem: {
                    type: "object",
                    required: ["modelId", "endpoint", "method"],
                    properties: {
                        id: { type: "string" },
                        modelId: { type: "string", enum: modelIds },
                        name: { type: "string" },
                        provider: { type: "string" },
                        description: { type: "string" },
                        endpoint: { type: "string", format: "uri" },
                        method: { type: "string", const: "POST" },
                    },
                },
                AgentCatalog: {
                    type: "object",
                    additionalProperties: true,
                    properties: {
                        agents: {
                            type: "array",
                            items: { $ref: "#/components/schemas/AgentCatalogItem" },
                        },
                        total: { type: "integer" },
                        count: { type: "integer" },
                        nextCursor: { oneOf: [{ type: "string" }, { type: "null" }] },
                    },
                },
                AgentCatalogItem: {
                    type: "object",
                    required: ["walletAddress"],
                    additionalProperties: true,
                    properties: {
                        walletAddress: { type: "string", pattern: "^(0x[a-fA-F0-9]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})$" },
                        name: { type: "string" },
                        description: { type: "string" },
                    },
                },
            },
        },
    };
}

export async function buildWellKnownX402(origin = SELLER_ORIGIN): Promise<Record<string, unknown>> {
    return {
        version: 1,
        resources: [
            absoluteUrl(MODELS_ENTRYPOINT, origin),
            absoluteUrl(AGENTS_ENTRYPOINT, origin),
        ],
        ownershipProofs: await getOwnershipProofs(),
        instructions: `Only ${absoluteUrl(MODELS_ENTRYPOINT, origin)} and ${absoluteUrl(AGENTS_ENTRYPOINT, origin)} are advertised x402 marketplace resources. Their 402 challenges explain the separate catalogs and final paid execution URLs.`,
    };
}
