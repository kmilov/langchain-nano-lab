import type { StructuredToolInterface } from "@langchain/core/tools";

export type RequiredToolRoutingPolicy = {
  mode: "required";
  route: (input: string) => Record<string, unknown> | null;
};

export type ToolRoutingPolicy = RequiredToolRoutingPolicy;

export type RegisteredAgentTool = {
  tool: StructuredToolInterface;
  routing?: ToolRoutingPolicy;
};

export type AgentTool = StructuredToolInterface | RegisteredAgentTool;

export function registerAgentTool(
  tool: StructuredToolInterface,
  routing?: ToolRoutingPolicy,
): RegisteredAgentTool {
  return { tool, routing };
}

export function normalizeAgentTool(tool: AgentTool): RegisteredAgentTool {
  return "tool" in tool ? tool : { tool };
}
