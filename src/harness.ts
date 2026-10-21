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

export const MAX_TOOL_STEPS = 5;

export type MessageSnapshot = {
  role: string;
  content: string;
};

export type HarnessEvent =
  | { type: "llm_start"; callId: number; messages: MessageSnapshot[]; timestamp: number }
  | { type: "llm_chunk"; callId: number; content: string; timestamp: number }
  | { type: "llm_end"; callId: number; message: MessageSnapshot; timestamp: number }
  | { type: "llm_error"; callId: number; error: string; timestamp: number }
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
type HarnessModel = BaseChatModel<BaseChatModelCallOptions> & Partial<ContextUsageProvider>;

export class ChatHarness {
  private messages: BaseMessage[] = [];
  private listeners = new Set<HarnessListener>();
  private nextCallId = 1;
  private latestContextUsage: ModelContextUsage | null = null;
  private readonly tools: StructuredToolInterface[];

  constructor(
    private readonly model: HarnessModel,
    toolOrTools: StructuredToolInterface | StructuredToolInterface[] = [],
  ) {
    this.tools = Array.isArray(toolOrTools) ? toolOrTools : [toolOrTools];
  }

  private snapshot(message: BaseMessage): MessageSnapshot {
    return { role: message.getType(), content: message.content.toString() };
  }

  private emit(event: HarnessEvent) {
    for (const listener of this.listeners) listener(event);
  }

  private refreshContextUsage() {
    this.latestContextUsage = this.model.getContextUsage?.() ?? null;
  }

  private messagesForModel(messages: BaseMessage[]) {
    if (this.tools.length === 0) return messages;
    return [new SystemMessage(toolInstructions(this.tools)), ...messages];
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

  private async streamModel(messages: BaseMessage[], onChunk: (chunk: string) => void) {
    const callId = this.nextCallId++;
    this.emit({
      type: "llm_start",
      callId,
      messages: messages.map((message) => this.snapshot(message)),
      timestamp: Date.now(),
    });

    try {
      const stream = await this.model.stream(messages);
      let output = "";
      let toolCallCandidate: boolean | null = null;

      for await (const chunk of stream) {
        const text = chunk.content.toString();
        output += text;

        if (toolCallCandidate === null) {
          const trimmed = output.trimStart();
          if (trimmed.length > 0) {
            toolCallCandidate = trimmed.startsWith("{") || trimmed.startsWith("```");
            if (!toolCallCandidate) onChunk(output);
          }
        } else if (!toolCallCandidate) {
          onChunk(text);
        }
      }

      const response = new AIMessage(output);
      this.refreshContextUsage();
      this.emit({
        type: "llm_end",
        callId,
        message: this.snapshot(response),
        timestamp: Date.now(),
      });

      return { callId, response, toolCallCandidate };
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
    const tool = this.tools.find((candidate) => candidate.name === toolCall.tool);
    if (!tool) throw new Error(`Unknown tool requested: ${toolCall.tool}`);

    this.emit({
      type: "tool_start",
      callId,
      toolCallId,
      tool: tool.name,
      args: toolCall.args,
      timestamp: Date.now(),
    });

    const result = await tool.invoke(toolCall.args);
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
      tool: tool.name,
      result: content,
      timestamp: Date.now(),
    });

    return new ToolMessage({ content, tool_call_id: toolCallId, name: tool.name });
  }

  subscribe(listener: HarnessListener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async run(input: string) {
    let workingMessages = [...this.messages, new HumanMessage(input)];
    let toolSteps = 0;

    while (true) {
      const modelCall = await this.invokeModel(this.messagesForModel(workingMessages));
      const toolCall =
        this.tools.length > 0 ? parseToolCall(modelCall.response.content.toString()) : null;

      if (!toolCall) {
        this.messages = [...workingMessages, modelCall.response];
        return modelCall.response;
      }

      if (toolSteps >= MAX_TOOL_STEPS) {
        throw new Error(`Tool step limit reached (${MAX_TOOL_STEPS}).`);
      }

      const toolMessage = await this.executeTool(
        toolCall,
        `tool-${modelCall.callId}`,
        modelCall.callId,
      );
      workingMessages = [...workingMessages, modelCall.response, toolMessage];
      toolSteps += 1;
    }
  }

  async stream(input: string, onChunk: (chunk: string) => void) {
    let workingMessages = [...this.messages, new HumanMessage(input)];
    let toolSteps = 0;

    while (true) {
      const modelCall = await this.streamModel(
        this.messagesForModel(workingMessages),
        onChunk,
      );
      const output = modelCall.response.content.toString();
      const toolCall = this.tools.length > 0 ? parseToolCall(output) : null;

      if (!toolCall) {
        if (modelCall.toolCallCandidate !== false) onChunk(output);
        this.messages = [...workingMessages, modelCall.response];
        return modelCall.response;
      }

      if (toolSteps >= MAX_TOOL_STEPS) {
        throw new Error(`Tool step limit reached (${MAX_TOOL_STEPS}).`);
      }

      const toolMessage = await this.executeTool(
        toolCall,
        `tool-${modelCall.callId}`,
        modelCall.callId,
      );
      workingMessages = [...workingMessages, modelCall.response, toolMessage];
      toolSteps += 1;
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
