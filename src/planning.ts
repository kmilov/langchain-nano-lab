import type { RegisteredAgentTool } from "./tools/routing";

export type PlannedToolStep = {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  dependsOn?: string[];
};

export type ToolPlan = {
  type: "plan";
  steps: PlannedToolStep[];
};

export function plannerInstructions(tools: RegisteredAgentTool[]): string {
  const descriptions = tools
    .map(({ tool, capability }) => {
      const lines = [
        `Tool: ${tool.name}`,
        `Description: ${tool.description}`,
        `Arguments: ${JSON.stringify(tool.schema)}`,
      ];

      if (capability?.useFor?.length) {
        lines.push(`Use for: ${capability.useFor.join(" | ")}`);
      }

      if (capability?.notFor?.length) {
        lines.push(`Do NOT use for: ${capability.notFor.join(" | ")}`);
      }

      if (capability?.groundedArgs?.length) {
        lines.push(`Grounded arguments: ${capability.groundedArgs.join(", ")}`);
      }

      return lines.join("\n");
    })
    .join("\n\n");

  return [
    "You are a planning component. Do not solve the user's task yourself.",
    "Decide whether the request needs one or more of the available tools.",
    "Before selecting any tool, identify the actual operation required by that subtask and verify that the tool capability explicitly supports it.",
    "Do not select a tool merely because words in the request resemble the tool name or description.",
    "If no available tool supports a required operation, do not invent a substitute tool step.",
    "Return ONLY valid JSON. Do not use Markdown.",
    'If no tool is needed, return: {"type":"plan","steps":[]}',
    "If tools are needed, return a plan with one step per tool invocation.",
    'Shape: {"type":"plan","steps":[{"id":"step-1","tool":"<tool>","args":{...},"dependsOn":["step-0"]}]}',
    "Steps execute in array order.",
    "For grounded arguments copied from the user, use the literal value directly in args.",
    'Example: {"tool":"calculator","args":{"a":18,"b":7,"operation":"add"}}',
    'To use an earlier step result as an argument, use exactly {"$step":"step-id"} as that argument value.',
    'Example dependency: {"tool":"word_count","args":{"text":{"$step":"step-1"}},"dependsOn":["step-1"]}',
    "Never invent a value for a grounded argument. A grounded literal must appear in the user\'s request; otherwise use an earlier $step result.",
    "When the user refers to a value produced by another step with phrases like \"the result\", \"that answer\", \"the solution\", \"the previous result\", or similar references, you MUST use a $step reference. Do not copy or reinterpret text from the user's request.",
    "Whenever a step uses a $step reference, also list that step id in dependsOn.",
    "A $step reference always means the raw result returned by that earlier tool step.",
    "Do not invent literal argument text when the requested value should come from another planned step.",
    "Never calculate, count, search, or otherwise perform tool work inside the plan.",
    "Use only tool names listed below.",
    "",
    descriptions,
  ].join("\n");
}

function parsePlanJson(text: string): ToolPlan | null {
  try {
    const value: unknown = JSON.parse(text.trim());
    if (!value || typeof value !== "object") return null;

    const candidate = value as Record<string, unknown>;
    if (candidate.type !== "plan" || !Array.isArray(candidate.steps)) return null;

    const ids = new Set<string>();
    const steps: PlannedToolStep[] = [];

    for (const rawStep of candidate.steps) {
      if (!rawStep || typeof rawStep !== "object") return null;
      const step = rawStep as Record<string, unknown>;

      if (
        typeof step.id !== "string" ||
        !step.id ||
        ids.has(step.id) ||
        typeof step.tool !== "string" ||
        !step.tool ||
        !step.args ||
        typeof step.args !== "object" ||
        Array.isArray(step.args)
      ) {
        return null;
      }

      ids.add(step.id);
      const dependsOn =
        step.dependsOn === undefined
          ? undefined
          : Array.isArray(step.dependsOn) &&
              step.dependsOn.every(
                (dependency) => typeof dependency === "string" && dependency,
              )
            ? (step.dependsOn as string[])
            : null;

      if (dependsOn === null) return null;

      steps.push({
        id: step.id,
        tool: step.tool,
        args: step.args as Record<string, unknown>,
        ...(dependsOn ? { dependsOn } : {}),
      });
    }

    return { type: "plan", steps };
  } catch {
    return null;
  }
}

export function parseToolPlan(content: string): ToolPlan | null {
  const text = content.trim();
  const direct = parsePlanJson(text);
  if (direct) return direct;

  const fencedBlocks = text.matchAll(/```(?:json)?\s*([\s\S]*?)\s*```/gi);
  for (const match of fencedBlocks) {
    const embedded = parsePlanJson(match[1]);
    if (embedded) return embedded;
  }

  return null;
}
