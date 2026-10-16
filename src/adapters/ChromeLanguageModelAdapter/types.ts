export type ChromePromptRole = "system" | "user" | "assistant";

export type ChromePrompt = {
  role: ChromePromptRole;
  content: string;
};

export type ChromeAvailability =
  | "unavailable"
  | "downloadable"
  | "downloading"
  | "available";

export interface ChromeLanguageModelSession {
  prompt(input: string | ChromePrompt[]): Promise<string>;
  promptStreaming(input: string | ChromePrompt[]): ReadableStream<string>;
  destroy(): void;
}

export interface ChromeLanguageModelFactory {
  availability(options?: {
    expectedInputs?: Array<{ type: "text"; languages?: string[] }>;
    expectedOutputs?: Array<{ type: "text"; languages?: string[] }>;
  }): Promise<ChromeAvailability>;

  params?(): Promise<Record<string, unknown>>;

  create(options?: {
    initialPrompts?: ChromePrompt[];
    expectedInputs?: Array<{ type: "text"; languages?: string[] }>;
    expectedOutputs?: Array<{ type: "text"; languages?: string[] }>;
  }): Promise<ChromeLanguageModelSession>;
}

declare global {
  const LanguageModel: ChromeLanguageModelFactory;
}
