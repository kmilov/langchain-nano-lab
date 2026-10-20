import {
  BaseChatModel,
  type BaseChatModelCallOptions,
} from "@langchain/core/language_models/chat_models";
import { AIMessage, HumanMessage, type BaseMessage } from "@langchain/core/messages";
import type {
  ContextUsageProvider,
  ModelContextUsage,
} from "./model/capabilities";

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
type HarnessModel = BaseChatModel<BaseChatModelCallOptions> &
  Partial<ContextUsageProvider>;

export class ChatHarness {
  /**
   * The harness owns all the message history,
   * even though Chrome API keeps its own state,
   * we have more control in the side of harness for tools
   * implementation for instance
   */
  private messages: BaseMessage[] = [];

  private listeners = new Set<HarnessListener>();
  private nextCallId = 1;
  private latestContextUsage: ModelContextUsage | null = null;

  constructor(private readonly model: HarnessModel) {}

  private snapshot(message: BaseMessage): MessageSnapshot {
    return {
      role: message.getType(),
      content: message.content.toString(),
    };
  }

  private emit(event: HarnessEvent) {
    for (const listener of this.listeners) listener(event);
  }

  private refreshContextUsage() {
    this.latestContextUsage = this.model.getContextUsage?.() ?? null;
  }

  subscribe(listener: HarnessListener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Runs a single message. no stream
   * @param input message to the LLM
   * @returns
   */
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
      this.refreshContextUsage();

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

  /**
   * Uses the stream in the adapter side
   *
   * @param input message to the LLM
   * @param onChunk fn to process every chunk
   * @returns
   */
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
      this.refreshContextUsage();

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

  contextUsage(): ModelContextUsage | null {
    return this.latestContextUsage ? { ...this.latestContextUsage } : null;
  }

  clear() {
    this.messages = [];
    this.latestContextUsage = null;
  }
}
