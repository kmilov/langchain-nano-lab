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
import {
  normalizeAgentTool,
  type AgentTool,
  type RegisteredAgentTool,
} from "./tools/routing";
import type {
  ContextUsageProvider,
  ModelContextUsage,
} from "./model/capabilities";
import {
  parseToolCall,
  toolInstructions,
  type ToolCallRequest,
} from "./tools/protocol";
import {
  parseToolPlan,
  plannerInstructions,
  type PlannedToolStep,
} from "./planning";

export const MAX_TOOL_STEPS = 5;
export const CONTEXT_COMPACTION_THRESHOLD = 0.3;
export const RECENT_MESSAGES_TO_KEEP = 6;

const SUMMARY_SYSTEM_PROMPT = [
  "Summarize the older conversation for use as agent memory.",
  "Preserve user goals, decisions, constraints, important facts, and relevant tool results.",
  "Be concise. Do not invent information.",
].join("\n");

const FINALIZER_SYSTEM_PROMPT = [
  "You are the finalizer. Produce only the final natural-language answer.",
  "Do not request tools and do not output tool-call JSON.",
  "Treat successful tool results in the current turn as authoritative.",
  "Never claim a tool succeeded if it returned an error or was not executed.",
  "Never invent tool results.",
  "Never claim access to external information, the web, search, databases, APIs, or live data unless a successful tool result in this turn actually provided it.",
  "If the available tools cannot retrieve required information, say so plainly.",
  "You may use built-in model knowledge when useful, but do not present it as externally verified or current.",
].join("\n");

export type MessageSnapshot = {
  role: string;
  content: string;
};

export type PersistedHarnessMessage = {
  role: "human" | "ai" | "tool";
  content: string;
  toolCallId?: string;
  name?: string;
};

export type ChatHarnessState = {
  version: 1;
  messages: PersistedHarnessMessage[];
  memorySummary: string;
  summarizedMessageCount: number;
};

export type ModelCallKind = "agent" | "summary" | "planner" | "finalizer";

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
  private readonly registeredTools: RegisteredAgentTool[];
  private readonly tools: StructuredToolInterface[];

  constructor(
    private readonly model: HarnessModel,
    toolOrTools: AgentTool | AgentTool[] = [],
  ) {
    const tools = Array.isArray(toolOrTools) ? toolOrTools : [toolOrTools];
    this.registeredTools = tools.map((tool) => normalizeAgentTool(tool));
    this.tools = this.registeredTools.map((registered) => registered.tool);
  }

  private snapshot(message: BaseMessage): MessageSnapshot {
    return { role: message.getType(), content: message.content.toString() };
  }

  private persistMessage(message: BaseMessage): PersistedHarnessMessage {
    const role = message.getType();
    const content = message.content.toString();

    if (role === "human" || role === "ai") {
      return { role, content: role === "ai" ? content.trimEnd() : content };
    }

    if (role === "tool") {
      const toolMessage = message as ToolMessage;
      return {
        role: "tool",
        content,
        toolCallId: toolMessage.tool_call_id,
        name: toolMessage.name,
      };
    }

    throw new Error(`Cannot persist unsupported message type: ${role}`);
  }

  private restoreMessage(message: PersistedHarnessMessage): BaseMessage {
    if (message.role === "human") return new HumanMessage(message.content);
    if (message.role === "ai") return new AIMessage(message.content.trimEnd());

    if (!message.toolCallId) {
      throw new Error("Persisted tool message is missing toolCallId.");
    }

    return new ToolMessage({
      content: message.content,
      tool_call_id: message.toolCallId,
      name: message.name,
    });
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

      const response = new AIMessage(output.trimEnd());
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

  private requiredToolCall(input: string): ToolCallRequest | null {
    for (const registered of this.registeredTools) {
      if (registered.routing?.mode !== "required") continue;

      const args = registered.routing.route(input);
      if (args) {
        return {
          type: "tool_call",
          tool: registered.tool.name,
          args,
        };
      }
    }

    return null;
  }

  private async executeRequiredTool(
    input: string,
    workingMessages: BaseMessage[],
  ): Promise<BaseMessage[] | null> {
    const toolCall = this.requiredToolCall(input);
    if (!toolCall) return null;

    const callId = this.nextCallId++;
    const toolMessage = await this.executeTool(
      input,
      toolCall,
      `tool-${callId}`,
      callId,
    );

    return [
      ...workingMessages,
      new AIMessage(JSON.stringify(toolCall)),
      toolMessage,
    ];
  }

  private resolvePlanValue(
    value: unknown,
    results: Map<string, string>,
  ): unknown {
    if (Array.isArray(value)) {
      return value.map((item) => this.resolvePlanValue(item, results));
    }

    if (value && typeof value === "object") {
      const objectValue = value as Record<string, unknown>;

      if (this.isUserValue(objectValue)) {
        return objectValue.$value;
      }

      if (
        Object.keys(objectValue).length === 1 &&
        typeof objectValue.$step === "string"
      ) {
        const result = results.get(objectValue.$step);
        if (result === undefined) {
          throw new Error(`Plan references unavailable step: ${objectValue.$step}`);
        }
        return result;
      }

      return Object.fromEntries(
        Object.entries(objectValue).map(([key, nested]) => [
          key,
          this.resolvePlanValue(nested, results),
        ]),
      );
    }

    return value;
  }

  private isStepReference(value: unknown): value is { $step: string } {
    return Boolean(
      value &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        Object.keys(value as Record<string, unknown>).length === 1 &&
        typeof (value as Record<string, unknown>).$step === "string",
    );
  }

  private isUserValue(value: unknown): value is { $value: unknown; $source: "user" } {
    return Boolean(
      value &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        (value as Record<string, unknown>).$source === "user" &&
        "$value" in (value as Record<string, unknown>),
    );
  }

  private valueAppearsInInput(input: string, value: unknown) {
    if (typeof value !== "string" && typeof value !== "number") return false;
    return input.toLowerCase().includes(String(value).toLowerCase());
  }

  private collectStepReferences(value: unknown, references = new Set<string>()) {
    if (this.isStepReference(value)) {
      references.add(value.$step);
      return references;
    }

    if (Array.isArray(value)) {
      for (const item of value) this.collectStepReferences(item, references);
      return references;
    }

    if (value && typeof value === "object") {
      for (const nested of Object.values(value as Record<string, unknown>)) {
        this.collectStepReferences(nested, references);
      }
    }

    return references;
  }

  private validatePlan(input: string, steps: PlannedToolStep[]) {
    const completed = new Set<string>();

    for (const step of steps) {
      const registered = this.registeredTools.find(
        (candidate) => candidate.tool.name === step.tool,
      );
      if (!registered) return { valid: false, reason: `Unknown tool: ${step.tool}` };

      for (const dependency of step.dependsOn ?? []) {
        if (!completed.has(dependency)) {
          return { valid: false, reason: `Invalid dependency: ${dependency}` };
        }
      }

      const references = this.collectStepReferences(step.args);
      for (const reference of references) {
        if (!completed.has(reference) || !(step.dependsOn ?? []).includes(reference)) {
          return { valid: false, reason: `Ungrounded step reference: ${reference}` };
        }
      }

      for (const argName of registered.capability?.groundedArgs ?? []) {
        const value = step.args[argName];
        if (this.isStepReference(value)) continue;

        if (!this.isUserValue(value) || !this.valueAppearsInInput(input, value.$value)) {
          return {
            valid: false,
            reason: `Argument "${argName}" for ${step.tool} is not grounded.`,
          };
        }
      }

      if (registered.capability?.accepts && !registered.capability.accepts(input, step.args)) {
        return { valid: false, reason: `Tool ${step.tool} is outside its capability.` };
      }

      completed.add(step.id);
    }

    return { valid: true, reason: "" };
  }
  private async planTools(input: string, workingMessages: BaseMessage[]) {
    if (this.tools.length === 0) return null;

    const priorVisible = this.messages
      .slice(this.summarizedMessageCount)
      .filter(
        (message) =>
          message.getType() !== "tool" &&
          !(message.getType() === "ai" && parseToolCall(message.content.toString())),
      );

    const plannerMessages: BaseMessage[] = [
      new SystemMessage(plannerInstructions(this.registeredTools)),
      ...(this.memorySummary
        ? [new SystemMessage(`Conversation memory from older messages:\n${this.memorySummary}`)]
        : []),
      ...priorVisible,
      new HumanMessage(input),
    ];

    const call = await this.invokeModel(plannerMessages, "planner");
    return parseToolPlan(call.response.content.toString());
  }

  private async executePlan(
    input: string,
    steps: PlannedToolStep[],
    workingMessages: BaseMessage[],
  ) {
    let messages = [...workingMessages];
    const results = new Map<string, string>();

    for (const step of steps) {
      const args = this.resolvePlanValue(step.args, results) as Record<string, unknown>;
      const callId = this.nextCallId++;
      const toolMessage = await this.executeTool(
        input,
        { type: "tool_call", tool: step.tool, args },
        `tool-${callId}`,
        callId,
      );

      const parsed = JSON.parse(toolMessage.content.toString()) as {
        result?: unknown;
        error?: unknown;
      };
      results.set(
        step.id,
        parsed.result !== undefined
          ? String(parsed.result)
          : parsed.error !== undefined
            ? String(parsed.error)
            : toolMessage.content.toString(),
      );

      messages = [
        ...messages,
        new AIMessage(
          JSON.stringify({
            type: "tool_call",
            tool: step.tool,
            args,
          }),
        ),
        toolMessage,
      ];
    }

    return messages;
  }

  private finalizerMessages(input: string, workingMessages: BaseMessage[]) {
    const priorVisible = this.messages
      .slice(this.summarizedMessageCount)
      .filter(
        (message) =>
          message.getType() !== "tool" &&
          !(message.getType() === "ai" && parseToolCall(message.content.toString())),
      );
    const currentTurn = workingMessages.slice(this.messages.length);

    return [
      new SystemMessage(FINALIZER_SYSTEM_PROMPT),
      ...(this.memorySummary
        ? [new SystemMessage(`Conversation memory from older messages:\n${this.memorySummary}`)]
        : []),
      ...priorVisible,
      ...currentTurn,
    ];
  }

  private async finalize(input: string, workingMessages: BaseMessage[]) {
    return this.invokeModel(this.finalizerMessages(input, workingMessages), "finalizer");
  }

  private async streamFinalizer(
    input: string,
    workingMessages: BaseMessage[],
    onChunk: (chunk: string) => void,
  ) {
    const callId = this.nextCallId++;
    const kind: ModelCallKind = "finalizer";
    const messages = this.finalizerMessages(input, workingMessages);

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
        onChunk(text);
      }

      const response = new AIMessage(output.trimEnd());
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
  private async executeTool(
    input: string,
    toolCall: ToolCallRequest,
    toolCallId: string,
    callId: number,
  ) {
    const registered = this.registeredTools.find(
      (candidate) => candidate.tool.name === toolCall.tool,
    );
    const tool = registered?.tool;

    this.emit({
      type: "tool_start",
      callId,
      toolCallId,
      tool: toolCall.tool,
      args: toolCall.args,
      timestamp: Date.now(),
    });

    if (!tool) {
      const resultContent = `Tool "${toolCall.tool}" is not available. Do not request it again. Answer the user without using that tool.`;

      this.emit({
        type: "tool_end",
        callId,
        toolCallId,
        tool: toolCall.tool,
        result: resultContent,
        timestamp: Date.now(),
      });

      const content = JSON.stringify({
        tool: toolCall.tool,
        args: toolCall.args,
        error: resultContent,
      });

      return new ToolMessage({
        content,
        tool_call_id: toolCallId,
        name: toolCall.tool,
      });
    }

    if (
      registered.capability?.accepts &&
      !registered.capability.accepts(input, toolCall.args)
    ) {
      const resultContent = `Tool "${toolCall.tool}" is outside its declared capability for this request. Do not use it as a substitute for an unsupported operation.`;

      this.emit({
        type: "tool_end",
        callId,
        toolCallId,
        tool: toolCall.tool,
        result: resultContent,
        timestamp: Date.now(),
      });

      return new ToolMessage({
        content: JSON.stringify({
          tool: toolCall.tool,
          args: toolCall.args,
          error: resultContent,
        }),
        tool_call_id: toolCallId,
        name: toolCall.tool,
      });
    }

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
    const plan = await this.planTools(input, workingMessages);

    if (plan && plan.steps.length > 0) {
      if (plan.steps.length > MAX_TOOL_STEPS) {
        throw new Error(`Tool step limit reached (${MAX_TOOL_STEPS}).`);
      }

      const validation = this.validatePlan(input, plan.steps);
      if (validation.valid) {
        workingMessages = await this.executePlan(input, plan.steps, workingMessages);
      }
    } else {
      const requiredMessages = await this.executeRequiredTool(input, workingMessages);
      if (requiredMessages) workingMessages = requiredMessages;
    }

    const finalCall = await this.finalize(input, workingMessages);
    this.messages = [...this.messages, new HumanMessage(input), finalCall.response];
    return finalCall.response;
  }

  async stream(input: string, onChunk: (chunk: string) => void) {
    await this.compactContextIfNeeded();

    let workingMessages = [...this.messages, new HumanMessage(input)];
    const plan = await this.planTools(input, workingMessages);

    if (plan && plan.steps.length > 0) {
      if (plan.steps.length > MAX_TOOL_STEPS) {
        throw new Error(`Tool step limit reached (${MAX_TOOL_STEPS}).`);
      }

      const validation = this.validatePlan(input, plan.steps);
      if (validation.valid) {
        workingMessages = await this.executePlan(input, plan.steps, workingMessages);
      }
    } else {
      const requiredMessages = await this.executeRequiredTool(input, workingMessages);
      if (requiredMessages) workingMessages = requiredMessages;
    }

    const finalCall = await this.streamFinalizer(input, workingMessages, onChunk);
    this.messages = [...this.messages, new HumanMessage(input), finalCall.response];
    return finalCall.response;
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

  exportState(): ChatHarnessState {
    return {
      version: 1,
      messages: this.messages.map((message) => this.persistMessage(message)),
      memorySummary: this.memorySummary,
      summarizedMessageCount: this.summarizedMessageCount,
    };
  }

  importState(state: ChatHarnessState) {
    if (state.version !== 1 || !Array.isArray(state.messages)) {
      throw new Error("Unsupported persisted Harness state.");
    }

    const messages = state.messages.map((message) => this.restoreMessage(message));
    const summarizedMessageCount = Math.max(
      0,
      Math.min(messages.length, Math.floor(state.summarizedMessageCount || 0)),
    );

    this.messages = messages;
    this.memorySummary = typeof state.memorySummary === "string" ? state.memorySummary : "";
    this.summarizedMessageCount = summarizedMessageCount;
    this.latestContextUsage = null;
    this.nextCallId = 1;
  }

  clear() {
    this.messages = [];
    this.latestContextUsage = null;
    this.memorySummary = "";
    this.summarizedMessageCount = 0;
    this.nextCallId = 1;
  }
}
