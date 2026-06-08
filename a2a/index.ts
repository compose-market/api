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
    AgentManifest as BaseAgentManifest,
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
    AgentManifest,
    AgentExtensions,
} from "./agentSchema.js";

export {
    AgentExtensionsSchema,
    AgentManifestSchema,
    buildAgentEndpoints,
    toAgentManifest,
    isAgentManifest,
} from "./agentSchema.js";

// Workflow Schema
export type {
    WorkflowManifest,
    WorkflowExtensions,
    WorkflowEdge,
    Coordinator,
} from "./workflowSchema.js";

export {
    WorkflowExtensionsSchema,
    WorkflowEdgeSchema,
    CoordinatorSchema,
    WorkflowManifestSchema,
    toWorkflowManifest,
    isWorkflowManifest,
} from "./workflowSchema.js";
