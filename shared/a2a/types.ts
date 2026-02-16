/**
 * ACP Base Types
 * 
 * Core types from the Agent Communication Protocol (ACP).
 * See: https://agentcommunicationprotocol.dev
 */

// =============================================================================
// ACP Agent Manifest (Base)
// =============================================================================

/**
 * ACP AgentManifest - the standard agent card format
 */
export interface AgentManifest {
    /** Unique agent name (RFC 1123 DNS label format) */
    name: string;

    /** Human-readable description */
    description: string;

    /** Supported input MIME types (e.g., "text/plain", "image/*") */
    input_content_types: string[];

    /** Supported output MIME types */
    output_content_types: string[];

    /** Agent metadata for discovery */
    metadata?: AgentMetadata;

    /** Runtime status (optional) */
    status?: AgentStatus;
}

// =============================================================================
// ACP Metadata
// =============================================================================

export interface AgentMetadata {
    /** Agent capabilities */
    capabilities?: Array<{
        name: string;
        description: string;
    }>;

    /** Classification tags */
    tags?: string[];

    /** Domain areas (e.g., "finance", "healthcare") */
    domains?: string[];

    /** Author information */
    author?: Person;

    /** Contributors */
    contributors?: Person[];

    /** Related links */
    links?: Link[];

    /** Recommended AI models */
    recommended_models?: string[];

    /** Programming language */
    programming_language?: string;

    /** Agent framework */
    framework?: string;

    /** Documentation (markdown) */
    documentation?: string;

    /** License (SPDX ID) */
    license?: string;

    /** Creation timestamp (ISO 8601) */
    created_at?: string;

    /** Last update timestamp */
    updated_at?: string;

    /** Key-value annotations */
    annotations?: Record<string, unknown>;
}

export interface AgentStatus {
    /** Average tokens per run */
    avg_run_tokens?: number;

    /** Average run time in seconds */
    avg_run_time_seconds?: number;

    /** Success rate (0-100) */
    success_rate?: number;
}

export interface Person {
    name: string;
    email?: string;
    url?: string;
}

export interface Link {
    type: "source-code" | "container-image" | "homepage" | "documentation";
    url: string;
}

// =============================================================================
// ACP Run Types
// =============================================================================

export type RunStatus =
    | "created"
    | "in-progress"
    | "awaiting"
    | "cancelling"
    | "cancelled"
    | "completed"
    | "failed";

export type RunMode = "sync" | "async" | "stream";

export interface Message {
    role: "user" | "agent" | string;
    parts: MessagePart[];
    created_at?: string;
    completed_at?: string;
}

export interface MessagePart {
    content_type: string;
    content?: string;
    content_encoding?: "plain" | "base64";
    content_url?: string;
    name?: string;
}

export interface Run {
    agent_name: string;
    run_id: string;
    session_id?: string;
    status: RunStatus;
    output: Message[];
    error?: { code: string; message: string };
    created_at: string;
    finished_at?: string;
}

// =============================================================================
// Task Types (from Model Registry)
// =============================================================================

export type TaskType =
    | "text-generation"
    | "text-to-image"
    | "image-to-image"
    | "text-to-speech"
    | "text-to-audio"
    | "automatic-speech-recognition"
    | "text-to-video"
    | "image-to-video"
    | "feature-extraction"
    | "other";

/**
 * Map TaskType to ACP content types
 */
export function taskTypeToContentTypes(task: TaskType): {
    input: string[];
    output: string[];
} {
    switch (task) {
        case "text-generation":
            return { input: ["text/plain", "application/json"], output: ["text/plain", "application/json"] };
        case "text-to-image":
            return { input: ["text/plain"], output: ["image/png", "image/jpeg"] };
        case "image-to-image":
            return { input: ["image/png", "image/jpeg", "text/plain"], output: ["image/png", "image/jpeg"] };
        case "text-to-speech":
        case "text-to-audio":
            return { input: ["text/plain"], output: ["audio/mpeg", "audio/wav"] };
        case "automatic-speech-recognition":
            return { input: ["audio/mpeg", "audio/wav"], output: ["text/plain"] };
        case "text-to-video":
        case "image-to-video":
            return { input: ["text/plain", "image/png"], output: ["video/mp4"] };
        case "feature-extraction":
            return { input: ["text/plain"], output: ["application/json"] };
        default:
            return { input: ["*/*"], output: ["*/*"] };
    }
}
