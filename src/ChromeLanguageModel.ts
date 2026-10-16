import {
  BaseChatModel,
  type BaseChatModelCallOptions,
} from "@langchain/core/language_models/chat_models";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import type { ChatResult } from "@langchain/core/outputs";

export const SYSTEM_PROMPT =
  "You are a concise programming assistant. Prefer short, precise explanations.";

export class ChromeLanguageModel extends BaseChatModel<BaseChatModelCallOptions> {
  private session?: ChromeLanguageModelSession;

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

  private async getSession() {
    if (this.session) return this.session;

    const availability = await this.availability();
    if (availability === "unsupported" || availability === "unavailable") {
      throw new Error("Chrome LanguageModel API is not available in this browser.");
    }

    this.session = await LanguageModel.create({
      initialPrompts: [{ role: "system", content: SYSTEM_PROMPT }],
      expectedInputs: [{ type: "text", languages: ["en"] }],
      expectedOutputs: [{ type: "text", languages: ["en"] }],
    });

    return this.session;
  }

  async _generate(
    messages: BaseMessage[],
    _options: BaseChatModelCallOptions,
  ): Promise<ChatResult> {
    const session = await this.getSession();

    const chromeMessages: ChromePrompt[] = messages
      .filter((message) => message.getType() !== "system")
      .map((message) => {
        const type = message.getType();
        const content = message.content.toString();

        if (type === "human") return { role: "user", content };
        if (type === "ai") return { role: "assistant", content };
        throw new Error(`Unsupported LangChain message type: ${type}`);
      });

    const output = await session.prompt(chromeMessages);

    return {
      generations: [
        {
          text: output,
          message: new AIMessage(output),
        },
      ],
    };
  }
}
