import { HumanMessage } from "@langchain/core/messages";
import { ChromeLanguageModel } from "./ChromeLanguageModel";

export class ChatHarness {
  constructor(private readonly model: ChromeLanguageModel) {}

  async run(input: string) {
    return this.model.invoke([new HumanMessage(input)]);
  }
}
