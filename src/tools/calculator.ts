import { tool } from "@langchain/core/tools";

export type CalculatorInput = {
  a: number;
  b: number;
  operation: "add" | "subtract" | "multiply" | "divide";
};

export const calculatorTool = tool(
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
