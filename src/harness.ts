import { HumanMessage } from "@langchain/core/messages";
import { ChromeLanguageModelAdapter } from "./adapters/ChromeLanguageModelAdapter";

export class ChatHarness {
  constructor(private readonly model: ChromeLanguageModelAdapter) {}

  async run(input: string) {
    return this.model.invoke([new HumanMessage(input)]);
  }
}
