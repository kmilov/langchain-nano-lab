import {
  BaseChatModel,
  type BaseChatModelCallOptions,
} from "@langchain/core/language_models/chat_models";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import type { ChatResult } from "@langchain/core/outputs";
import type { ChromePrompt } from "./types";

export const SYSTEM_PROMPT =
  "You are a concise programming assistant. Prefer short, precise explanations.";

export class ChromeLanguageModelAdapter extends BaseChatModel<BaseChatModelCallOptions> {
  _llmType() {
    return "chrome-gemini-nano";
  }

  async availability() {
    if (!("LanguageModel" in globalThis)) return "unsupported" as const;

    return LanguageModel.availability({
      expectedInputs: [{ type: "text", languages: ["en"] }],
      expectedOutputs: [{ type: "text", languages: ["en"] }],
    });
  }

  private async createSession() {
    const availability = await this.availability();
    if (availability === "unsupported" || availability === "unavailable") {
      throw new Error("Chrome LanguageModel API is not available in this browser.");
    }

    return LanguageModel.create({
      initialPrompts: [{ role: "system", content: SYSTEM_PROMPT }],
      expectedInputs: [{ type: "text", languages: ["en"] }],
      expectedOutputs: [{ type: "text", languages: ["en"] }],
    });
  }

  private toChromeMessages(messages: BaseMessage[]) {
    return messages
      .filter((message) => message.getType() !== "system")
      .map((message): ChromePrompt => {
        const type = message.getType();
        const content = message.content.toString();

        if (type === "human") return { role: "user", content };
        if (type === "ai") return { role: "assistant", content };
        throw new Error(`Unsupported LangChain message type: ${type}`);
      });
  }

  async streamResponse(
    messages: BaseMessage[],
    onChunk: (chunk: string) => void,
  ): Promise<AIMessage> {
    const session = await this.createSession();

    try {
      const stream = session.promptStreaming(this.toChromeMessages(messages));
      let output = "";

      for await (const chunk of stream) {
        output += chunk;
        onChunk(chunk);
      }

      return new AIMessage(output);
    } finally {
      session.destroy();
    }
  }

  async _generate(
    messages: BaseMessage[],
    _options: BaseChatModelCallOptions,
  ): Promise<ChatResult> {
    const session = await this.createSession();

    try {
      const output = await session.prompt(this.toChromeMessages(messages));

      return {
        generations: [
          {
            text: output,
            message: new AIMessage(output),
          },
        ],
      };
    } finally {
      session.destroy();
    }
  }
}
