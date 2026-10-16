import { AIMessage, HumanMessage, type BaseMessage } from "@langchain/core/messages";
import { ChromeLanguageModelAdapter } from "./adapters/ChromeLanguageModelAdapter";

export type MessageSnapshot = {
  role: string;
  content: string;
};

export type HarnessEvent =
  | {
      type: "llm_start";
      callId: number;
      messages: MessageSnapshot[];
      timestamp: number;
    }
  | {
      type: "llm_chunk";
      callId: number;
      content: string;
      timestamp: number;
    }
  | {
      type: "llm_end";
      callId: number;
      message: MessageSnapshot;
      timestamp: number;
    }
  | {
      type: "llm_error";
      callId: number;
      error: string;
      timestamp: number;
    };

type HarnessListener = (event: HarnessEvent) => void;

export class ChatHarness {
  private messages: BaseMessage[] = [];
  private listeners = new Set<HarnessListener>();
  private nextCallId = 1;

  constructor(private readonly model: ChromeLanguageModelAdapter) {}

  private snapshot(message: BaseMessage): MessageSnapshot {
    return {
      role: message.getType(),
      content: message.content.toString(),
    };
  }

  private emit(event: HarnessEvent) {
    for (const listener of this.listeners) listener(event);
  }

  subscribe(listener: HarnessListener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async run(input: string) {
    const nextMessages = [...this.messages, new HumanMessage(input)];
    const callId = this.nextCallId++;

    this.emit({
      type: "llm_start",
      callId,
      messages: nextMessages.map((message) => this.snapshot(message)),
      timestamp: Date.now(),
    });

    try {
      const response = await this.model.invoke(nextMessages);
      this.messages = [...nextMessages, response];

      this.emit({
        type: "llm_end",
        callId,
        message: this.snapshot(response),
        timestamp: Date.now(),
      });

      return response;
    } catch (error) {
      this.emit({
        type: "llm_error",
        callId,
        error: error instanceof Error ? error.message : String(error),
        timestamp: Date.now(),
      });
      throw error;
    }
  }

  async stream(input: string, onChunk: (chunk: string) => void) {
    const nextMessages = [...this.messages, new HumanMessage(input)];
    const callId = this.nextCallId++;

    this.emit({
      type: "llm_start",
      callId,
      messages: nextMessages.map((message) => this.snapshot(message)),
      timestamp: Date.now(),
    });

    try {
      const stream = await this.model.stream(nextMessages);
      let output = "";

      for await (const chunk of stream) {
        const text = chunk.content.toString();
        output += text;
        onChunk(text);
      }

      const response = new AIMessage(output);
      this.messages = [...nextMessages, response];

      this.emit({
        type: "llm_end",
        callId,
        message: this.snapshot(response),
        timestamp: Date.now(),
      });

      return response;
    } catch (error) {
      this.emit({
        type: "llm_error",
        callId,
        error: error instanceof Error ? error.message : String(error),
        timestamp: Date.now(),
      });
      throw error;
    }
  }

  history() {
    return [...this.messages];
  }

  clear() {
    this.messages = [];
  }
}
