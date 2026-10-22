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
export const CONTEXT_COMPACTION_THRESHOLD = 0.7;
export const RECENT_MESSAGES_TO_KEEP = 6;

const SUMMARY_SYSTEM_PROMPT = [
  "Summarize the older conversation for use as agent memory.",
  "Preserve user goals, decisions, constraints, important facts, and relevant tool results.",
  "Be concise. Do not invent information.",
].join("\n");

export type MessageSnapshot = {
  role: string;
  content: string;
};

export type ModelCallKind = "agent" | "summary";

export type HarnessEvent =
  | {
      type: "llm_start";
      callId: number;
      kind: ModelCallKind;
      messages: MessageSnapshot[];
      timestamp: number;
    }
  | { type: "llm_chunk"; callId: number; content: string; timestamp: number }
  | {
      type: "llm_end";
      callId: number;
      kind: ModelCallKind;
      message: MessageSnapshot;
      timestamp: number;
    }
  | { type: "llm_error"; callId: number; kind: ModelCallKind; error: string; timestamp: number }
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
    }
  | {
      type: "context_compacted";
      summarizedMessageCount: number;
      summary: string;
      timestamp: number;
    };

type HarnessListener = (event: HarnessEvent) => void;
type HarnessModel = BaseChatModel<BaseChatModelCallOptions> & Partial<ContextUsageProvider>;

export class ChatHarness {
  private messages: BaseMessage[] = [];
  private listeners = new Set<HarnessListener>();
  private nextCallId = 1;
  private latestContextUsage: ModelContextUsage | null = null;
  private memorySummary = "";
  private summarizedMessageCount = 0;
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

  private contextUsageRatio() {
    const usage = this.latestContextUsage;
    if (!usage || usage.maxTokens <= 0) return 0;
    return usage.usedTokens / usage.maxTokens;
  }

  private messagesForModel(messages: BaseMessage[]) {
    const visibleMessages = messages.slice(this.summarizedMessageCount);
    const systemMessages: BaseMessage[] = [];

    if (this.tools.length > 0) {
      systemMessages.push(new SystemMessage(toolInstructions(this.tools)));
    }

    if (this.memorySummary) {
      systemMessages.push(
        new SystemMessage(`Conversation memory from older messages:\n${this.memorySummary}`),
      );
    }

    return [...systemMessages, ...visibleMessages];
  }

  private async invokeModel(messages: BaseMessage[], kind: ModelCallKind = "agent") {
    const callId = this.nextCallId++;
    this.emit({
      type: "llm_start",
      callId,
      kind,
      messages: messages.map((message) => this.snapshot(message)),
      timestamp: Date.now(),
    });

    try {
      const response = await this.model.invoke(messages);
      this.refreshContextUsage();
      this.emit({
        type: "llm_end",
        callId,
        kind,
        message: this.snapshot(response),
        timestamp: Date.now(),
      });
      return { callId, response };
    } catch (error) {
      this.emit({
        type: "llm_error",
        callId,
        kind,
        error: error instanceof Error ? error.message : String(error),
        timestamp: Date.now(),
      });
      throw error;
    }
  }

  private async streamModel(messages: BaseMessage[], onChunk: (chunk: string) => void) {
    const callId = this.nextCallId++;
    const kind: ModelCallKind = "agent";
    const bufferUntilComplete = this.tools.length > 0;

    this.emit({
      type: "llm_start",
      callId,
      kind,
      messages: messages.map((message) => this.snapshot(message)),
      timestamp: Date.now(),
    });

    try {
      const stream = await this.model.stream(messages);
      let output = "";

      for await (const chunk of stream) {
        const text = chunk.content.toString();
        output += text;

        if (!bufferUntilComplete) onChunk(text);
      }

      const response = new AIMessage(output);
      this.refreshContextUsage();
      this.emit({
        type: "llm_end",
        callId,
        kind,
        message: this.snapshot(response),
        timestamp: Date.now(),
      });

      return { callId, response, bufferUntilComplete };
    } catch (error) {
      this.emit({
        type: "llm_error",
        callId,
        kind,
        error: error instanceof Error ? error.message : String(error),
        timestamp: Date.now(),
      });
      throw error;
    }
  }

  private shouldCompactContext() {
    return (
      this.contextUsageRatio() >= CONTEXT_COMPACTION_THRESHOLD &&
      this.messages.length - this.summarizedMessageCount > RECENT_MESSAGES_TO_KEEP
    );
  }

  private async compactContextIfNeeded() {
    if (!this.shouldCompactContext()) return;

    const compactUntil = this.messages.length - RECENT_MESSAGES_TO_KEEP;
    if (compactUntil <= this.summarizedMessageCount) return;

    const messagesToSummarize = this.messages.slice(
      this.summarizedMessageCount,
      compactUntil,
    );
    const transcript = messagesToSummarize
      .map((message) => `${message.getType()}: ${message.content.toString()}`)
      .join("\n\n");
    const previousSummary = this.memorySummary
      ? `Previous memory summary:\n${this.memorySummary}\n\n`
      : "";

    const summaryCall = await this.invokeModel(
      [
        new SystemMessage(SUMMARY_SYSTEM_PROMPT),
        new HumanMessage(`${previousSummary}New older messages to fold into memory:\n${transcript}`),
      ],
      "summary",
    );

    this.memorySummary = summaryCall.response.content.toString().trim();
    this.summarizedMessageCount = compactUntil;
    this.emit({
      type: "context_compacted",
      summarizedMessageCount: this.summarizedMessageCount,
      summary: this.memorySummary,
      timestamp: Date.now(),
    });
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
    const resultContent =
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
      result: resultContent,
      timestamp: Date.now(),
    });

    const content = JSON.stringify({
      tool: tool.name,
      args: toolCall.args,
      result: resultContent,
    });

    return new ToolMessage({ content, tool_call_id: toolCallId, name: tool.name });
  }

  subscribe(listener: HarnessListener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async run(input: string) {
    await this.compactContextIfNeeded();

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
    await this.compactContextIfNeeded();

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
        if (modelCall.bufferUntilComplete) onChunk(output);
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

  contextMemory() {
    return {
      summary: this.memorySummary,
      summarizedMessageCount: this.summarizedMessageCount,
      recentMessageCount: this.messages.length - this.summarizedMessageCount,
    };
  }

  clear() {
    this.messages = [];
    this.latestContextUsage = null;
    this.memorySummary = "";
    this.summarizedMessageCount = 0;
  }
}
