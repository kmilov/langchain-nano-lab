import type { StructuredToolInterface } from "@langchain/core/tools";

export type ToolCallRequest = {
  type: "tool_call";
  tool: string;
  args: Record<string, unknown>;
};

export function toolInstructions(tool: StructuredToolInterface): string {
  return [
    "You have access to one tool.",
    "Use it when it is needed to answer the user's request accurately.",
    "You may request the tool at most once per user message.",
    "If you need the tool, reply with ONLY a JSON object in this exact shape:",
    '{"type":"tool_call","tool":"<tool name>","args":{...}}',
    "Do not wrap the JSON in Markdown or add any other text.",
    "After a tool result is provided, answer the user normally and do not request another tool.",
    "If no tool is needed, answer the user normally.",
    "",
    `Tool name: ${tool.name}`,
    `Description: ${tool.description}`,
    `Arguments JSON Schema: ${JSON.stringify(tool.schema)}`,
  ].join("\n");
}

export function parseToolCall(content: string): ToolCallRequest | null {
  const text = content.trim();
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
