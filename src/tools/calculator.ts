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

  const number = "(-?\\d+(?:\\.\\d+)?)";
  const patterns: Array<{
    operation: CalculatorInput["operation"];
    regex: RegExp;
  }> = [
    {
      operation: "add",
      regex: new RegExp(`(?:add|sum(?: of)?|what is)\\s+${number}\\s+(?:and|plus|\\+)\\s+${number}`, "i"),
    },
    {
      operation: "subtract",
      regex: new RegExp(`(?:subtract|what is)\\s+${number}\\s+(?:minus|-)\\s+${number}`, "i"),
    },
    {
      operation: "multiply",
      regex: new RegExp(`(?:multiply\\s+)?${number}\\s+(?:times|multiply(?:ed)?(?: by)?)\\s+${number}`, "i"),
    },
    {
      operation: "divide",
      regex: new RegExp(`(?:divide\\s+)?${number}\\s+(?:divided by|divide(?: by)?)\\s+${number}`, "i"),
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

export const calculatorTool = registerAgentTool(
  rawCalculatorTool,
  {
    mode: "required",
    route: parseCalculatorRoute,
  },
  {
    useFor: [
      "Basic arithmetic using two numeric values: add, subtract, multiply, or divide.",
      "Arithmetic on numeric results produced by earlier tool steps.",
    ],
    notFor: [
      "Looking up facts or numeric values that are not already available.",
      "Population, weather, search, or other information retrieval.",
    ],
  },
);
