import { HumanMessage, type BaseMessage } from "@langchain/core/messages";
import { ChromeLanguageModelAdapter } from "./adapters/ChromeLanguageModelAdapter";

export class ChatHarness {
  private messages: BaseMessage[] = [];

  constructor(private readonly model: ChromeLanguageModelAdapter) {}

  async run(input: string) {
    const nextMessages = [...this.messages, new HumanMessage(input)];
    const response = await this.model.invoke(nextMessages);

    this.messages = [...nextMessages, response];

    return response;
  }

  history() {
    return [...this.messages];
  }

  clear() {
    this.messages = [];
  }
}
