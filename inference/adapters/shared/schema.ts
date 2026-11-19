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
    const required = Array.isArray(record.required)
        ? record.required.filter((value): value is string => typeof value === "string" && value in properties)
        : undefined;
    const out: Record<string, unknown> = {
        ...record,
        type: "object",
        properties,
    };
    if (required && required.length > 0) {
        out.required = required;
    } else {
        delete out.required;
    }
    return out;
}

export function json(schema?: Schema): Schema {
    return Object.keys(base(schema)).length > 0 ? base(schema) : object();
}

export function google(schema?: Schema): Schema {
    const record = base(schema);
    const union = Array.isArray(record.anyOf) ? record.anyOf : Array.isArray(record.oneOf) ? record.oneOf : undefined;
    if (!type(record.type) && union) {
        const hasNull = record.nullable === true || union.some((entry) => asRecord(entry)?.type === "null");
        const nonNull = union
            .map((entry) => asRecord(entry))
            .filter((entry): entry is Record<string, unknown> => entry !== null && entry.type !== "null");
        const allObjects = nonNull.length > 1 && nonNull.every((entry) => (
            type(entry.type) === "object" || asRecord(entry.properties) !== null
        ));
        if (allObjects) {
            const mergedProperties: Record<string, unknown> = {};
            const requiredSets: Array<Set<string>> = [];
            const variantLabels: string[] = [];
            for (const entry of nonNull) {
                const loweredEntry = google(entry as Schema);
                const props = asRecord(loweredEntry.properties) ?? {};
                for (const [key, propSchema] of Object.entries(props)) {
                    if (!(key in mergedProperties)) {
                        mergedProperties[key] = propSchema;
                    }
                }
                const req = Array.isArray(loweredEntry.required)
                    ? loweredEntry.required.filter((value): value is string => typeof value === "string")
                    : [];
                requiredSets.push(new Set(req));
                if (req.length > 0) {
                    variantLabels.push(`{${req.join(", ")}}`);
                } else {
                    const keys = Object.keys(props);
                    if (keys.length > 0) variantLabels.push(`{${keys.join(", ")}}`);
                }
            }
            const sharedRequired = requiredSets.length > 0
                ? [...requiredSets[0]].filter((key) => requiredSets.every((set) => set.has(key)))
                : [];
            const baseDesc = clean(record.description);
            const variantHint = variantLabels.length > 0
                ? `Use one of: ${variantLabels.join(" | ")}.`
                : undefined;
            const description = [baseDesc, variantHint].filter(Boolean).join(" ") || undefined;
            return {
                type: "object",
                properties: mergedProperties,
                ...(sharedRequired.length > 0 ? { required: sharedRequired } : {}),
                ...(description ? { description } : {}),
                ...(hasNull ? { nullable: true } : {}),
            };
        }
        const chosen = nonNull.find((entry) => type(entry.type) !== undefined) ?? nonNull[0] ?? union[0];
        const lowered = google(chosen as Schema);
        const description = clean(record.description);
        if (description && !lowered.description) lowered.description = description;
        if (hasNull) {
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
    let loweredProperties: Record<string, unknown> | undefined;
    if (properties) {
        const lowered: Record<string, unknown> = {};
        for (const [key, child] of Object.entries(properties)) {
            lowered[key] = google(child as Schema);
        }
        loweredProperties = lowered;
        out.properties = lowered;
    }
    if (Array.isArray(record.required) && loweredProperties) {
        const filteredRequired = record.required.filter(
            (value): value is string => typeof value === "string" && value in loweredProperties!,
        );
        if (filteredRequired.length > 0) {
            out.required = filteredRequired;
        }
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
