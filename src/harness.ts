import {
  BaseChatModel,
  type BaseChatModelCallOptions,
} from "@langchain/core/language_models/chat_models";
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import type { StructuredToolInterface } from "@langchain/core/tools";
import type {
  ContextUsageProvider,
  ModelContextUsage,
} from "./model/capabilities";
import {
  parseToolCall,
  toolInstructions,
  type ToolCallRequest,
} from "./tools/protocol";

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
    }
  | {
      type: "tool_start";
      callId: number;
      toolCallId: string;
      tool: string;
      args: Record<string, unknown>;
      timestamp: number;
    }
  | {
      type: "tool_end";
      callId: number;
      toolCallId: string;
      tool: string;
      result: string;
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

  constructor(
    private readonly model: HarnessModel,
    private readonly tool?: StructuredToolInterface,
  ) {}

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

  private messagesForModel(messages: BaseMessage[]) {
    if (!this.tool) return messages;
    return [new SystemMessage(toolInstructions(this.tool)), ...messages];
  }

  private async invokeModel(messages: BaseMessage[]) {
    const callId = this.nextCallId++;

    this.emit({
      type: "llm_start",
      callId,
      messages: messages.map((message) => this.snapshot(message)),
      timestamp: Date.now(),
    });

    try {
      const response = await this.model.invoke(messages);
      this.refreshContextUsage();

      this.emit({
        type: "llm_end",
        callId,
        message: this.snapshot(response),
        timestamp: Date.now(),
      });

      return { callId, response };
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

  private async executeTool(
    toolCall: ToolCallRequest,
    toolCallId: string,
    callId: number,
  ) {
    if (!this.tool || toolCall.tool !== this.tool.name) {
      throw new Error(`Unknown tool requested: ${toolCall.tool}`);
    }

    this.emit({
      type: "tool_start",
      callId,
      toolCallId,
      tool: this.tool.name,
      args: toolCall.args,
      timestamp: Date.now(),
    });

    const result = await this.tool.invoke(toolCall.args);
    const content =
      typeof result === "string"
        ? result
        : result && typeof result === "object" && "content" in result
          ? String(result.content)
          : String(result);

    this.emit({
      type: "tool_end",
      callId,
      toolCallId,
      tool: this.tool.name,
      result: content,
      timestamp: Date.now(),
    });

    return new ToolMessage({
      content,
      tool_call_id: toolCallId,
      name: this.tool.name,
    });
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
    const first = await this.invokeModel(this.messagesForModel(nextMessages));
    const toolCall = this.tool ? parseToolCall(first.response.content.toString()) : null;

    if (!toolCall) {
      this.messages = [...nextMessages, first.response];
      return first.response;
    }

    const toolMessage = await this.executeTool(
      toolCall,
      `tool-${first.callId}`,
      first.callId,
    );
    const workingMessages = [...nextMessages, first.response, toolMessage];
    const final = await this.invokeModel(this.messagesForModel(workingMessages));

    this.messages = [...workingMessages, final.response];
    return final.response;
  }

  /**
   * Streams normal answers immediately. A response that begins with JSON is
   * buffered until the harness can determine whether it is a tool request.
   *
   * @param input message to the LLM
   * @param onChunk fn to process every user-visible chunk
   * @returns
   */
  async stream(input: string, onChunk: (chunk: string) => void) {
    const nextMessages = [...this.messages, new HumanMessage(input)];
    const firstMessages = this.messagesForModel(nextMessages);
    const firstCallId = this.nextCallId++;

    this.emit({
      type: "llm_start",
      callId: firstCallId,
      messages: firstMessages.map((message) => this.snapshot(message)),
      timestamp: Date.now(),
    });

    try {
      const stream = await this.model.stream(firstMessages);
      let output = "";
      let jsonCandidate: boolean | null = null;

      for await (const chunk of stream) {
        const text = chunk.content.toString();
        output += text;

        if (jsonCandidate === null) {
          const trimmed = output.trimStart();
          if (trimmed.length > 0) {
            jsonCandidate = trimmed.startsWith("{");
            if (!jsonCandidate) onChunk(output);
          }
        } else if (!jsonCandidate) {
          onChunk(text);
        }
      }

      const firstResponse = new AIMessage(output);
      this.refreshContextUsage();

      this.emit({
        type: "llm_end",
        callId: firstCallId,
        message: this.snapshot(firstResponse),
        timestamp: Date.now(),
      });

      const toolCall = this.tool ? parseToolCall(output) : null;

      if (!toolCall) {
        if (jsonCandidate !== false) onChunk(output);
        this.messages = [...nextMessages, firstResponse];
        return firstResponse;
      }

      const toolMessage = await this.executeTool(
        toolCall,
        `tool-${firstCallId}`,
        firstCallId,
      );
      const workingMessages = [...nextMessages, firstResponse, toolMessage];
      const finalMessages = this.messagesForModel(workingMessages);
      const finalCallId = this.nextCallId++;

      this.emit({
        type: "llm_start",
        callId: finalCallId,
        messages: finalMessages.map((message) => this.snapshot(message)),
        timestamp: Date.now(),
      });

      try {
        const finalStream = await this.model.stream(finalMessages);
        let finalOutput = "";

        for await (const chunk of finalStream) {
          const text = chunk.content.toString();
          finalOutput += text;
          onChunk(text);
        }

        const finalResponse = new AIMessage(finalOutput);
        this.refreshContextUsage();
        this.messages = [...workingMessages, finalResponse];

        this.emit({
          type: "llm_end",
          callId: finalCallId,
          message: this.snapshot(finalResponse),
          timestamp: Date.now(),
        });

        return finalResponse;
      } catch (error) {
        this.emit({
          type: "llm_error",
          callId: finalCallId,
          error: error instanceof Error ? error.message : String(error),
          timestamp: Date.now(),
        });
        throw error;
      }
    } catch (error) {
      this.emit({
        type: "llm_error",
        callId: firstCallId,
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
