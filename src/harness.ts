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

const SUMMARY_SYSTEM_PROMPT = `Summarize the older conversation