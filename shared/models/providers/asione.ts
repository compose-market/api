/**
 * ASI:One Models Provider
 * 
 * ASI:One API (asi1.ai) is OpenAI-compatible but does NOT have a /models endpoint.
 * Models are documented at: https://docs.asi1.ai/documentation/getting-started/models
 * 
 * Available models (from documentation):
 * - asi1-mini: Balanced performance for everyday agent workflows
 * - asi1-fast: Ultra-low latency for real-time applications  
 * - asi1-extended: Enhanced capabilities for complex reasoning
 * - asi1-agentic: Specialized for agent interactions
 * - asi1-fast-agentic: Fast + agentic capabilities
 * - asi1-extended-agentic: Extended + agentic capabilities
 * - asi1-graph: Optimized for data analytics and visualization
 * 
 * All models support chat completions and tool calling.
 */

const ASI_ONE_API_KEY = process.env.ASI_ONE_API_KEY;

if (!ASI_ONE_API_KEY) {
    console.warn("[asione] ASI_ONE_API_KEY not set - ASI:One model discovery disabled");
}

// =============================================================================
// Types
// =============================================================================

export interface ASIOneModelInfo {
    id: string;
    name: string;
    ownedBy: string;
    task: string;
    description: string;
}

// =============================================================================
// Model List - From ASI:One Documentation
// =============================================================================

const ASI_ONE_MODELS: ASIOneModelInfo[] = [
    {
        id: "asi1-mini",
        name: "ASI-1 Mini",
        ownedBy: "asi-one",
        task: "text-generation",
        description: "Balanced performance and speed for everyday agent workflows",
    },
    {
        id: "asi1-fast",
        name: "ASI-1 Fast",
        ownedBy: "asi-one",
        task: "text-generation",
        description: "Ultra-low latency for real-time applications",
    },
    {
        id: "asi1-extended",
        name: "ASI-1 Extended",
        ownedBy: "asi-one",
        task: "text-generation",
        description: "Enhanced capabilities for complex reasoning and multi-hop retrieval",
    },
    {
        id: "asi1-agentic",
        name: "ASI-1 Agentic",
        ownedBy: "asi-one",
        task: "text-generation",
        description: "Specialized for agent discovery, orchestration, and delegation",
    },
    {
        id: "asi1-fast-agentic",
        name: "ASI-1 Fast Agentic",
        ownedBy: "asi-one",
        task: "text-generation",
        description: "Fast model with agentic capabilities",
    },
    {
        id: "asi1-extended-agentic",
        name: "ASI-1 Extended Agentic",
        ownedBy: "asi-one",
        task: "text-generation",
        description: "Extended model with agentic capabilities",
    },
    {
        id: "asi1-graph",
        name: "ASI-1 Graph",
        ownedBy: "asi-one",
        task: "text-generation",
        description: "Optimized for data analytics and visualization",
    },
];

// =============================================================================
// API Fetcher
// =============================================================================

export async function fetchASIOneModels(forceRefresh = false): Promise<ASIOneModelInfo[]> {
    if (!ASI_ONE_API_KEY) {
        console.warn("[asione] API key not set, skipping model fetch");
        return [];
    }

    // ASI:One does NOT have a /v1/models endpoint - return documented models
    console.log(`[asione] Returning ${ASI_ONE_MODELS.length} documented models`);
    return ASI_ONE_MODELS;
}

export function clearASIOneCache(): void {
    // No cache since models are static from documentation
}
