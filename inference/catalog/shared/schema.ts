import type { Schema } from "../../core.js";
import { asRecord, clean } from "./coerce.js";

function type(value: unknown): string | undefined {
    if (typeof value === "string" && value !== "null") return value;
    if (!Array.isArray(value)) return undefined;
    return value.find((entry): entry is string => typeof entry === "string" && entry !== "null");
}

function base(schema: unknown): Record<string, unknown> {
    const record = asRecord(schema);
    return record ? JSON.parse(JSON.stringify(record)) as Record<string, unknown> : {};
}

export function object(schema?: Schema): Schema {
    const record = base(schema);
    const properties = asRecord(record.properties) ?? {};
    return {
        ...record,
        type: "object",
        properties,
        ...(Array.isArray(record.required) ? { required: record.required.filter((value): value is string => typeof value === "string") } : {}),
    };
}

export function json(schema?: Schema): Schema {
    return Object.keys(base(schema)).length > 0 ? base(schema) : object();
}

export function google(schema?: Schema): Schema {
    const record = base(schema);
    const union = Array.isArray(record.anyOf) ? record.anyOf : Array.isArray(record.oneOf) ? record.oneOf : undefined;
    if (!type(record.type) && union) {
        const chosen = union.find((entry) => type(asRecord(entry)?.type) !== undefined) ?? union[0];
        const lowered = google(chosen as Schema);
        const description = clean(record.description);
        if (description && !lowered.description) lowered.description = description;
        if (record.nullable === true || union.some((entry) => asRecord(entry)?.type === "null")) {
            lowered.nullable = true;
        }
        return lowered;
    }

    const out: Record<string, unknown> = {};
    const kind = type(record.type);
    if (kind) out.type = kind;
    const description = clean(record.description);
    if (description) out.description = description;
    const format = clean(record.format);
    if (format) out.format = format;
    if (Array.isArray(record.type) && record.type.includes("null")) out.nullable = true;
    if (Array.isArray(record.enum) && record.enum.length > 0) {
        out.enum = record.enum.filter((entry) =>
            typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean"
        );
    }
    if (typeof record.nullable === "boolean") out.nullable = record.nullable;

    const properties = asRecord(record.properties);
    if (properties) {
        const lowered: Record<string, unknown> = {};
        for (const [key, child] of Object.entries(properties)) {
            lowered[key] = google(child as Schema);
        }
        out.properties = lowered;
    }
    if (Array.isArray(record.required)) {
        out.required = record.required.filter((value): value is string => typeof value === "string");
    }
    if (record.items !== undefined) {
        out.items = google(record.items as Schema);
    }

    if (!out.type) {
        if (out.properties) out.type = "object";
        else if (out.items) out.type = "array";
    }

    return out;
}
