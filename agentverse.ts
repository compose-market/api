/**
 * Agentverse API Client
 * 
 * Fetches agents from Agentverse that conform to the Compose structure.
 * Only imports agents that have protocols defined (callable skills).
 */

const AGENTVERSE_API_URL = "https://agentverse.ai/v1";

// =============================================================================
// Types
// =============================================================================

export interface AgentverseProtocol {
  name: string;
  version: string;
  digest: string;
}

export interface AgentverseAgent {
  address: string;
  name: string;
  description: string;
  readme: string;
  protocols: AgentverseProtocol[];
  avatar_href: string | null;
  total_interactions: number;
  recent_interactions: number;
  rating: number;
  status: "active" | "inactive";
  type: "hosted" | "local";
  featured: boolean;
  category: string;
  system_wide_tags: string[];
  last_updated: string;
  created_at: string;
  owner: string;
}

export interface SearchAgentsOptions {
  search?: string;
  category?: string;
  tags?: string[];
  status?: "active" | "inactive";
  limit?: number;
  offset?: number;
  sort?: "relevancy" | "created-at" | "last-modified" | "interactions";
  direction?: "asc" | "desc";
}

// =============================================================================
// Compose-Compatible Filter
// =============================================================================

/**
 * Check if an agent conforms to compose structure.
 * An agent is compose-compatible if:
 * - It has at least one protocol defined (callable skill)
 * - It is active
 * - It has a name and description
 */
function isComposeCompatible(agent: AgentverseAgent): boolean {
  return (
    agent.status === "active" &&
    agent.name.length > 0 &&
    agent.description.length > 0 &&
    Array.isArray(agent.protocols) &&
    agent.protocols.length > 0
  );
}

/**
 * Score agent quality for deduplication
 */
function scoreAgent(agent: AgentverseAgent): number {
  let score = 0;
  
  // Protocols = skills
  score += agent.protocols.length * 5;
  
  // Readme quality
  if (agent.readme?.length > 100) score += 3;
  if (agent.readme?.length > 500) score += 2;
  
  // Rating
  if (agent.rating > 0) score += agent.rating;
  
  // Interactions
  if (agent.total_interactions > 1000) score += 2;
  if (agent.total_interactions > 10000) score += 2;
  
  // Verified
  if (agent.system_wide_tags?.includes("verified")) score += 3;
  if (agent.featured) score += 3;
  
  return score;
}

/**
 * Deduplicate agents by name, keeping highest quality
 */
function deduplicateAgents(agents: AgentverseAgent[]): AgentverseAgent[] {
  const byName = new Map<string, AgentverseAgent>();
  
  for (const agent of agents) {
    const key = agent.name.toLowerCase().trim();
    const existing = byName.get(key);
    
    if (!existing || scoreAgent(agent) > scoreAgent(existing)) {
      byName.set(key, agent);
    }
  }
  
  return Array.from(byName.values());
}

// =============================================================================
// API Functions
// =============================================================================

/**
 * Search for compose-compatible agents on Agentverse
 */
export async function searchAgents(options: SearchAgentsOptions = {}): Promise<{
  agents: AgentverseAgent[];
  total: number;
  offset: number;
  limit: number;
}> {
  const apiKey = process.env.AGENTVERSE_API_KEY;
  
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  
  if (apiKey) {
    headers["Authorization"] = `bearer ${apiKey}`;
  }
  
  const payload: Record<string, unknown> = {
    offset: options.offset ?? 0,
    limit: options.limit ?? 30,
    sort: options.sort ?? "interactions",
    direction: options.direction ?? "desc",
  };
  
  if (options.search) {
    payload.search_text = options.search;
    payload.semantic_search = true;
  }
  
  // Always filter for active agents
  const filters: Record<string, unknown> = {
    state: ["active"],
  };
  
  if (options.category) {
    filters.category = [options.category];
  }
  
  payload.filters = filters;
  
  const response = await fetch(`${AGENTVERSE_API_URL}/search/agents`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });
  
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Agentverse API error: ${response.status} - ${text}`);
  }
  
  const data = await response.json();
  
  // Filter to compose-compatible agents only
  let agents: AgentverseAgent[] = (data.agents || []).filter(isComposeCompatible);
  
  // Deduplicate by name
  agents = deduplicateAgents(agents);
  
  // Filter by tags if specified
  if (options.tags?.length) {
    agents = agents.filter(agent => 
      options.tags!.some(tag => 
        agent.system_wide_tags?.includes(tag) ||
        agent.category?.toLowerCase() === tag.toLowerCase()
      )
    );
  }
  
  return {
    agents,
    total: data.total,
    offset: data.offset,
    limit: data.limit,
  };
}

/**
 * Get a single agent by address
 */
export async function getAgent(address: string): Promise<AgentverseAgent | null> {
  const apiKey = process.env.AGENTVERSE_API_KEY;
  
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  
  if (apiKey) {
    headers["Authorization"] = `bearer ${apiKey}`;
  }
  
  const response = await fetch(`${AGENTVERSE_API_URL}/search/agents/${encodeURIComponent(address)}`, {
    method: "GET",
    headers,
  });
  
  if (!response.ok) {
    if (response.status === 404) return null;
    const text = await response.text();
    throw new Error(`Agentverse API error: ${response.status} - ${text}`);
  }
  
  const agent: AgentverseAgent = await response.json();
  
  // Only return if compose-compatible
  return isComposeCompatible(agent) ? agent : null;
}

/**
 * Extract unique tags from agents
 */
export function extractUniqueTags(agents: AgentverseAgent[]): string[] {
  const tags = new Set<string>();
  for (const agent of agents) {
    agent.system_wide_tags?.forEach(t => tags.add(t));
    if (agent.category) tags.add(agent.category);
  }
  return Array.from(tags).sort();
}

/**
 * Extract unique categories from agents
 */
export function extractUniqueCategories(agents: AgentverseAgent[]): string[] {
  const categories = new Set<string>();
  for (const agent of agents) {
    if (agent.category) categories.add(agent.category);
  }
  return Array.from(categories).sort();
}
