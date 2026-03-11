/**
 * Compose Schema Module
 * 
 * A2A/ACP-compliant schemas for Agent and Workflow manifests.
 * Single source of truth for metadata across the system.
 * 
 * @module shared/schema
 */

// ACP Base Types
export type {
    AgentManifest,
    AgentMetadata,
    AgentStatus,
    Person,
    Link,
    RunStatus,
    RunMode,
    Message,
    MessagePart,
    Run,
    TaskType,
} from "./types.js";

export { taskTypeToContentTypes } from "./types.js";

// Agent Schema
export type {
    ComposeAgentManifest,
    ComposeAgentExtensions,
} from "./agentSchema.js";

export {
    ComposeAgentExtensionsSchema,
    ComposeAgentManifestSchema,
    buildAgentEndpoints,
    toAgentManifest,
    isComposeAgentManifest,
} from "./agentSchema.js";

// Workflow Schema
export type {
    WorkflowManifest,
    ComposeWorkflowExtensions,
    WorkflowEdge,
    Coordinator,
} from "./workflowSchema.js";

export {
    ComposeWorkflowExtensionsSchema,
    WorkflowEdgeSchema,
    CoordinatorSchema,
    WorkflowManifestSchema,
    toWorkflowManifest,
    isWorkflowManifest,
} from "./workflowSchema.js";
