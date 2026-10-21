import type { StructuredToolInterface } from "@langchain/core/tools";

export type ToolCallRequest = {
  type: "tool_call";
  tool: string;
  args: Record<string, unknown>;
};

export function toolInstructions(tools: StructuredToolInterface[]): string {
  const toolDescriptions = tools.flatMap((tool) => [
    `Tool name: ${tool.name}`,
    `Description: ${tool.description}`,
    `Arguments JSON Schema: ${JSON.stringify(tool.schema)}`,
    "",
  ]);

  return [
    "You have access to the tools listed below.",
    "Use a tool when it is needed to answer the user's request accurately.",
    "Request at most one tool at a time.",
    "If you need a tool, reply with ONLY a JSON object in this exact shape:",
    '{"type":"tool_call","tool":"<tool name>","args":{...}}',
    "Do not wrap the JSON in Markdown or add any other text.",
    "Choose the tool whose name and description best match the request.",
    "After a tool result is provided, either request another tool if needed or answer the user normally.",
    "If no tool is needed, answer the user normally.",
    "",
    ...toolDescriptions,
  ].join("\n");
}

function stripOptionalCodeFence(content: string) {
  const text = content.trim();
  const match = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match ? match[1].trim() : text;
}

export function parseToolCall(content: string): ToolCallRequest | null {
  const text = stripOptionalCodeFence(content);
  if (!text.startsWith("{") || !text.endsWith("}")) return null;

  try {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== "object") return null;

    const candidate = value as Record<string, unknown>;
    if (
      candidate.type !== "tool_call" ||
      typeof candidate.tool !== "string" ||
      !candidate.args ||
      typeof candidate.args !== "object" ||
      Array.isArray(candidate.args)
    ) {
      return null;
    }

    return {
      type: "tool_call",
      tool: candidate.tool,
      args: candidate.args as Record<string, unknown>,
    };
  } catch {
    return null;
  }
}
