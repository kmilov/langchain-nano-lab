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
    "Only output JSON when you are requesting a tool.",
    "If you are not requesting a tool, respond only in normal natural language.",
    "Never wrap a normal answer in JSON and never append JSON to a normal answer.",
    "Choose the tool whose name and description best match the request.",
    "After a tool result is provided, either request another tool if needed or answer the user normally.",
    "Treat every tool result as authoritative. Do not recalculate, reinterpret, replace, or contradict a tool result.",
    "When you give the final answer, answer the user's original request completely and include all relevant results from every tool call in this turn exactly as returned by the tools.",
    "If no tool is needed, answer the user normally.",
    "",
    ...toolDescriptions,
  ].join("\n");
}

function parseToolCallJson(text: string): ToolCallRequest | null {
  try {
    const value: unknown = JSON.parse(text.trim());
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

export function parseToolCall(content: string): ToolCallRequest | null {
  const text = content.trim();

  const direct = parseToolCallJson(text);
  if (direct) return direct;

  const fencedBlocks = text.matchAll(/```(?:json)?\s*([\s\S]*?)\s*```/gi);
  for (const match of fencedBlocks) {
    const embedded = parseToolCallJson(match[1]);
    if (embedded) return embedded;
  }

  return null;
}
