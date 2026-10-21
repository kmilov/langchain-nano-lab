import { tool } from "@langchain/core/tools";

export type WordCountInput = {
  text: string;
};

export const wordCountTool = tool(
  async ({ text }: WordCountInput) => {
    const trimmed = text.trim();
    if (!trimmed) return "0";

    return String(trimmed.split(/\s+/).length);
  },
  {
    name: "word_count",
    description: "Count how many whitespace-separated words are in a piece of text.",
    schema: {
      type: "object",
      properties: {
        text: { type: "string" },
      },
      required: ["text"],
      additionalProperties: false,
    },
  },
);
