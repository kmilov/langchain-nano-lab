import { tool } from "@langchain/core/tools";
import { registerAgentTool } from "./routing";

export type WordCountInput = {
  text: string;
};

const rawWordCountTool = tool(
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


export const wordCountTool = registerAgentTool(
  rawWordCountTool,
  {
    mode: "required",
    route(input) {
      if (!/\b(count|how many)\b.*\bwords?\b|\bwords?\b.*\b(count|how many)\b/i.test(input)) {
        return null;
      }

      const quoted = input.match(/["“](.+?)["”]/);
      return { text: quoted?.[1] ?? input };
    },
  },
  {
    useFor: [
      "Counting words in user-supplied text.",
      "Counting words in text produced by an earlier tool step.",
    ],
    notFor: [
      "Counting people, objects, places, money, or other real-world quantities.",
      "Population questions.",
      "Retrieving facts or external information.",
    ],
    accepts(input) {
      return /\bword(?:s| count)?\b/i.test(input);
    },
    groundedArgs: ["text"],
  },
);
