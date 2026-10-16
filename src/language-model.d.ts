type ChromePromptRole = "system" | "user" | "assistant";

type ChromePrompt = {
  role: ChromePromptRole;
  content: string;
};

type ChromeAvailability =
  | "unavailable"
  | "downloadable"
  | "downloading"
  | "available";

interface ChromeLanguageModelSession {
  prompt(input: string | ChromePrompt[]): Promise<string>;
  promptStreaming(input: string | ChromePrompt[]): ReadableStream<string>;
  destroy(): void;
}

interface ChromeLanguageModelFactory {
  availability(options?: {
    expectedInputs?: Array<{ type: "text"; languages?: string[] }>;
    expectedOutputs?: Array<{ type: "text"; languages?: string[] }>;
  }): Promise<ChromeAvailability>;

  create(options?: {
    initialPrompts?: ChromePrompt[];
    expectedInputs?: Array<{ type: "text"; languages?: string[] }>;
    expectedOutputs?: Array<{ type: "text"; languages?: string[] }>;
  }): Promise<ChromeLanguageModelSession>;
}

declare const LanguageModel: ChromeLanguageModelFactory;
