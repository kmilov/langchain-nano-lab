import type { StructuredToolInterface } from "@langchain/core/tools";

export type RequiredToolRoutingPolicy = {
  mode: "required";
  route: (input: string) => Record<string, unknown> | null;
};

export type ToolRoutingPolicy = RequiredToolRoutingPolicy;

export type ToolCapability = {
  useFor: string[];
  notFor?: string[];
  accepts?: (input: string, args: Record<string, unknown>) => boolean;
  groundedArgs?: string[];
};

export type RegisteredAgentTool = {
  tool: StructuredToolInterface;
  routing?: ToolRoutingPolicy;
  capability?: ToolCapability;
};

export type AgentTool = StructuredToolInterface | RegisteredAgentTool;

export function registerAgentTool(
  tool: StructuredToolInterface,
  routing?: ToolRoutingPolicy,
  capability?: ToolCapability,
): RegisteredAgentTool {
  return { tool, routing, capability };
}

export function normalizeAgentTool(tool: AgentTool): RegisteredAgentTool {
  return "tool" in tool ? tool : { tool };
}
