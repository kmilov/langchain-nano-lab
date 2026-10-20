import {
  BaseChatModel,
  type BaseChatModelCallOptions,
} from "@langchain/core/language_models/chat_models";
import { AIMessage, AIMessageChunk, type BaseMessage } from "@langchain/core/messages";
import { ChatGenerationChunk, type ChatResult } from "@langchain/core/outputs";
import type {
  ContextUsageProvider,
  ModelContextUsage,
} from "../../model/capabilities";
import type { ChromeLanguageModelSession, ChromePrompt } from "./types";

export const SYSTEM_PROMPT =
  "You are a concise programming assistant. Prefer short, precise explanations.";

export class ChromeLanguageModelAdapter
  extends BaseChatModel<BaseChatModelCallOptions>
  implements ContextUsageProvider
{
  private lastContextUsage: ModelContextUsage | null = null;

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

  getContextUsage(): ModelContextUsage | null {
    return this.lastContextUsage ? { ...this.lastContextUsage } : null;
  }

  private captureContextUsage(session: ChromeLanguageModelSession) {
    const usedTokens = session.contextUsage;
    const maxTokens = session.contextWindow;

    if (
      typeof usedTokens !== "number" ||
      !Number.isFinite(usedTokens) ||
      typeof maxTokens !== "number" ||
      !Number.isFinite(maxTokens) ||
      maxTokens <= 0
    ) {
      this.lastContextUsage = null;
      return;
    }

    this.lastContextUsage = { usedTokens, maxTokens };
  }

  private toInitialPrompts(messages: BaseMessage[]): ChromePrompt[] {
    const dynamicSystemPrompts = messages
      .filter((message) => message.getType() === "system")
      .map((message): ChromePrompt => ({
        role: "system",
        content: message.content.toString(),
      }));

    return [
      { role: "system", content: SYSTEM_PROMPT },
      ...dynamicSystemPrompts,
    ];
  }

  private async createSession(messages: BaseMessage[]) {
    const availability = await this.availability();
    if (availability === "unsupported" || availability === "unavailable") {
      throw new Error("Chrome LanguageModel API is not available in this browser.");
    }

    return LanguageModel.create({
      initialPrompts: this.toInitialPrompts(messages),
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
        if (type === "tool") {
          return { role: "user", content: `Tool result: ${content}` };
        }

        throw new Error(`Unsupported LangChain message type: ${type}`);
      });
  }

  async *_streamResponseChunks(
    messages: BaseMessage[],
    _options: BaseChatModelCallOptions,
  ): AsyncGenerator<ChatGenerationChunk> {
    const session = await this.createSession(messages);

    try {
      // messages array comes as LangChain messages,
      // we then transform them to what chrome expects
      const stream = session.promptStreaming(this.toChromeMessages(messages));

      for await (const chunk of stream) {
        yield new ChatGenerationChunk({
          text: chunk,
          message: new AIMessageChunk({ content: chunk }),
        });
      }

      this.captureContextUsage(session);
    } finally {
      session.destroy();
    }
  }

  async _generate(
    messages: BaseMessage[],
    _options: BaseChatModelCallOptions,
  ): Promise<ChatResult> {
    const session = await this.createSession(messages);

    try {
      const output = await session.prompt(this.toChromeMessages(messages));
      this.captureContextUsage(session);

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
