import { tool } from "@langchain/core/tools";
import { registerAgentTool } from "./routing";

export type CalculatorInput = {
  a: number;
  b: number;
  operation: "add" | "subtract" | "multiply" | "divide";
};

const rawCalculatorTool = tool(
  async ({ a, b, operation }: CalculatorInput) => {
    switch (operation) {
      case "add":
        return String(a + b);
      case "subtract":
        return String(a - b);
      case "multiply":
        return String(a * b);
      case "divide":
        if (b === 0) throw new Error("Cannot divide by zero.");
        return String(a / b);
    }
  },
  {
    name: "calculator",
    description:
      "Perform basic arithmetic with two numbers. Use this instead of calculating arithmetic mentally.",
    schema: {
      type: "object",
      properties: {
        a: { type: "number" },
        b: { type: "number" },
        operation: {
          type: "string",
          enum: ["add", "subtract", "multiply", "divide"],
        },
      },
      required: ["a", "b", "operation"],
      additionalProperties: false,
    },
  },
);


function parseCalculatorRoute(input: string): CalculatorInput | null {
  const normalized = input
    .toLowerCase()
    .replace(/,/g, "")
    .replace(/[×x*]/g, " multiply ")
    .replace(/[÷/]/g, " divide ");

  const patterns: Array<{
    operation: CalculatorInput["operation"];
    regex: RegExp;
  }> = [
    {
      operation: "add",
      regex: /(?:add|plus|sum of|what is)\s+(-?\d+(?:\.\d+)?)\s+(?:and|plus|\+)\s+(-?\d+(?:\.\d+)?)/i,
    },
    {
      operation: "subtract",
      regex: /(?:subtract|minus|what is)\s+(-?\d+(?:\.\d+)?)\s+(?:minus|-)\s+(-?\d+(?:\.\d+)?)/i,
    },
    {
      operation: "multiply",
      regex: /(?:multiply|what is)\s+(-?\d+(?:\.\d+)?)\s+(?:by\s+)?(?:multiply\s+)?(-?\d+(?:\.\d+)?)/i,
    },
    {
      operation: "divide",
      regex: /(?:divide|what is)\s+(-?\d+(?:\.\d+)?)\s+(?:by\s+)?(?:divide\s+)?(-?\d+(?:\.\d+)?)/i,
    },
  ];

  for (const { operation, regex } of patterns) {
    const match = normalized.match(regex);
    if (!match) continue;

    return {
      a: Number(match[1]),
      b: Number(match[2]),
      operation,
    };
  }

  return null;
}

export const calculatorTool = registerAgentTool(rawCalculatorTool, {
  mode: "required",
  route: parseCalculatorRoute,
});
