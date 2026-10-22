<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from "vue";
import {
  ChromeLanguageModelAdapter,
  SYSTEM_PROMPT,
  type ChromeAvailability,
} from "./adapters/ChromeLanguageModelAdapter";
import {
  ChatHarness,
  CONTEXT_COMPACTION_THRESHOLD,
  RECENT_MESSAGES_TO_KEEP,
  type HarnessEvent,
} from "./harness";
import type { ModelContextUsage } from "./model/capabilities";
import { calculatorTool } from "./tools/calculator";
import { wordCountTool } from "./tools/wordCount";

type Availability = "checking" | "unsupported" | ChromeAvailability;
type ChatMessage = {
  role: "user" | "assistant" | "error";
  content: string;
};
type SideTab = "code" | "debug";
type ModelParamsStatus = "loading" | "available" | "unsupported" | "error";
type DebugCall = {
  callId: number;
  start?: Extract<HarnessEvent, { type: "llm_start" }>;
  end?: Extract<HarnessEvent, { type: "llm_end" }>;
  error?: Extract<HarnessEvent, { type: "llm_error" }>;
  toolStart?: Extract<HarnessEvent, { type: "tool_start" }>;
  toolEnd?: Extract<HarnessEvent, { type: "tool_end" }>;
};

const model = new ChromeLanguageModelAdapter({});
const harness = new ChatHarness(model, [calculatorTool, wordCountTool]);

const availability = ref<Availability>("checking");
const input = ref("");
const busy = ref(false);
const messages = ref<ChatMessage[]>([]);
const historySize = ref(0);
const contextUsage = ref<ModelContextUsage>({ usedTokens: 0, maxTokens: 0 });
const memorySummary = ref("");
const summarizedMessageCount = ref(0);
const recentMessageCount = ref(0);
const messagesEl = ref<HTMLElement | null>(null);
const activeTab = ref<SideTab>("code");
const debugEvents = ref<HarnessEvent[]>([]);
const modelParamsStatus = ref<ModelParamsStatus>("loading");
const modelParams = ref<Record<string, unknown> | null>(null);
const modelParamsError = ref("");

harness.subscribe((event) => {
  if (event.type !== "llm_chunk") {
    debugEvents.value.push(event);
  }
});

const ready = computed(() =>
  ["available", "downloadable", "downloading"].includes(availability.value),
);

const contextUsageLabel = computed(() => {
  const usage = contextUsage.value;
  if (usage.maxTokens <= 0) return "0% context";

  const percentage = Math.max(
    0,
    Math.min(100, Math.round((usage.usedTokens / usage.maxTokens) * 100)),
  );

  return `${percentage}% of ${formatTokenCount(usage.maxTokens)} context`;
});

const modelParamsText = computed(() => {
  if (modelParamsStatus.value === "loading") return "Loading LanguageModel.params()…";
  if (modelParamsStatus.value === "unsupported") {
    return "LanguageModel.params() is not exposed by this browser build.";
  }
  if (modelParamsStatus.value === "error") return modelParamsError.value;
  return JSON.stringify(modelParams.value, null, 2);
});

const debugCalls = computed<DebugCall[]>(() => {
  const calls = new Map<number, DebugCall>();

  for (const event of debugEvents.value) {
    if (event.type === "context_compacted") continue;

    const call = calls.get(event.callId) ?? { callId: event.callId };

    if (event.type === "llm_start") call.start = event;
    if (event.type === "llm_end") call.end = event;
    if (event.type === "llm_error") call.error = event;
    if (event.type === "tool_start") call.toolStart = event;
    if (event.type === "tool_end") call.toolEnd = event;

    calls.set(event.callId, call);
  }

  return [...calls.values()];
});

const compactionEvents = computed(() =>
  debugEvents.value.filter(
    (event): event is Extract<HarnessEvent, { type: "context_compacted" }> =>
      event.type === "context_compacted",
  ),
);

const adapterCode = `async *_streamResponseChunks(messages) {
  const session = await this.createSession(messages);

  try {
    const stream = session.promptStreaming(
      this.toChromeMessages(messages),
    );

    for await (const chunk of stream) {
      yield new ChatGenerationChunk({
        text: chunk,
        message: new AIMessageChunk({ content: chunk }),
      });
    }
  } finally {
    session.destroy();
  }
}`;

const harnessCode = `await compactContextIfNeeded();

while (true) {
  const modelCall = await streamModel(
    messagesForModel(workingMessages),
    onChunk,
  );

  const toolCall = parseToolCall(
    modelCall.response.content.toString(),
  );

  if (!toolCall) return modelCall.response;

  const toolMessage = await executeTool(toolCall);
  workingMessages.push(modelCall.response, toolMessage);
}`;

function eventTime(event: HarnessEvent) {
  return new Date(event.timestamp).toLocaleTimeString();
}

function formatTokenCount(tokens: number) {
  if (tokens < 1000) return `${Math.round(tokens)}`;

  const thousands = Math.round((tokens / 1000) * 10) / 10;
  return `${thousands.toString()}k`;
}

function refreshHarnessState() {
  historySize.value = harness.history().length;
  contextUsage.value = harness.contextUsage() ?? { usedTokens: 0, maxTokens: 0 };

  const memory = harness.contextMemory();
  memorySummary.value = memory.summary;
  summarizedMessageCount.value = memory.summarizedMessageCount;
  recentMessageCount.value = memory.recentMessageCount;
}

async function loadModelParams() {
  if (!("LanguageModel" in globalThis) || typeof LanguageModel.params !== "function") {
    modelParamsStatus.value = "unsupported";
    return;
  }

  try {
    modelParams.value = await LanguageModel.params();
    modelParamsStatus.value = "available";
  } catch (error) {
    modelParamsError.value = error instanceof Error ? error.message : String(error);
    modelParamsStatus.value = "error";
  }
}

async function scrollToBottom() {
  await nextTick();
  if (messagesEl.value) {
    messagesEl.value.scrollTop = messagesEl.value.scrollHeight;
  }
}

async function sendMessage() {
  const prompt = input.value.trim();
  if (!prompt || busy.value) return;

  input.value = "";
  messages.value.push({ role: "user", content: prompt });
  const assistantIndex = messages.value.push({
    role: "assistant",
    content: "",
  }) - 1;

  busy.value = true;
  await scrollToBottom();

  try {
    await harness.stream(prompt, (chunk) => {
      messages.value[assistantIndex].content += chunk;
      void scrollToBottom();
    });

    refreshHarnessState();
  } catch (error) {
    messages.value[assistantIndex] = {
      role: "error",
      content: error instanceof Error ? error.message : String(error),
    };
  } finally {
    busy.value = false;
    await scrollToBottom();
  }
}

function clearDebug() {
  debugEvents.value = [];
}

function onComposerKeydown(event: KeyboardEvent) {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    void sendMessage();
  }
}

onMounted(async () => {
  void loadModelParams();

  try {
    availability.value = await model.availability();
  } catch {
    availability.value = "unavailable";
  }
});
</script>

<template>
  <main class="shell">
    <header class="topbar">
      <div>
        <div class="brand">LangChain × Gemini Nano</div>
        <div class="subtitle">Vue 3 + Vite + Chrome LanguageModel API</div>
      </div>
      <div class="status" :class="`status-${availability}`">
        <span class="dot" />
        {{ availability === "checking" ? "Checking model…" : availability }}
      </div>
    </header>

    <section class="workspace">
      <article class="chatPane">
        <div class="sectionHeader">
          <div>
            <h1>Chat</h1>
            <p>Streaming through LangChain, with tools and context memory orchestrated by the Harness.</p>
          </div>
          <div class="headerBadges">
            <span class="contextUsageLabel">{{ contextUsageLabel }}</span>
            <span class="step">v5 · context memory · {{ historySize }} msgs</span>
          </div>
        </div>

        <div ref="messagesEl" class="messages">
          <div v-if="messages.length === 0" class="empty">
            <div class="emptyMark">⌁</div>
            <strong>Keep chatting and watch the context meter grow.</strong>
            <span>At 70%, the Harness summarizes older messages and keeps the latest 6 verbatim.</span>
          </div>

          <div
            v-for="(message, index) in messages"
            :key="`${message.role}-${index}`"
            class="message"
            :class="message.role"
          >
            <span class="messageRole">
              {{ message.role === "assistant" ? "Nano" : message.role }}
            </span>
            <p>{{ message.content || (busy && index === messages.length - 1 ? "…" : "") }}</p>
          </div>
        </div>

        <div v-if="!ready && availability !== 'checking'" class="notice">
          This browser does not currently expose a usable LanguageModel session.
          Open the site in a supported Chrome configuration to run Gemini Nano.
        </div>

        <form class="composer" @submit.prevent="sendMessage">
          <textarea
            v-model="input"
            rows="3"
            placeholder="Ask Gemini Nano…"
            @keydown="onComposerKeydown"
          />
          <button :disabled="busy || !input.trim()" type="submit">
            {{ busy ? "Streaming…" : "Send" }}
          </button>
        </form>
      </article>

      <aside class="codePane">
        <div class="sideTabs">
          <button :class="{ active: activeTab === 'code' }" @click="activeTab = 'code'">Code</button>
          <button :class="{ active: activeTab === 'debug' }" @click="activeTab = 'debug'">Debug</button>
        </div>

        <template v-if="activeTab === 'code'">
          <div class="sectionHeader codeHeading">
            <div>
              <h2>Code</h2>
              <p>v5 keeps durable history separate from the smaller context sent to Nano.</p>
            </div>
          </div>

          <section class="codeBlock">
            <div class="codeBar">1 · Adapter · LangChain-native streaming</div>
            <pre><code>{{ adapterCode }}</code></pre>
          </section>

          <section class="codeBlock">
            <div class="codeBar">2 · ChatHarness · memory + bounded tool loop</div>
            <pre><code>{{ harnessCode }}</code></pre>
          </section>

          <div class="nextSteps">
            <span>Context policy</span>
            <strong>{{ Math.round(CONTEXT_COMPACTION_THRESHOLD * 100) }}% threshold · keep {{ RECENT_MESSAGES_TO_KEEP }} recent messages</strong>
          </div>
        </template>

        <template v-else>
          <div class="sectionHeader codeHeading debugHeader">
            <div>
              <h2>Debug</h2>
              <p>Agent calls, summary calls, tools, and compacted memory are visible here.</p>
            </div>
            <button class="clearButton" :disabled="debugEvents.length === 0" @click="clearDebug">Clear</button>
          </div>

          <div class="debugFeed">
            <section class="debugCard systemCard">
              <div class="debugMeta">
                <strong>Adapter system prompt</strong>
                <span>Chrome session initialPrompts</span>
              </div>
              <pre>{{ SYSTEM_PROMPT }}</pre>
            </section>

            <section class="debugCard">
              <div class="debugMeta">
                <strong>Context memory</strong>
                <span>{{ summarizedMessageCount }} summarized · {{ recentMessageCount }} recent</span>
              </div>
              <pre>{{ memorySummary || `No summary yet. Compaction starts at ${Math.round(CONTEXT_COMPACTION_THRESHOLD * 100)}% context.` }}</pre>
            </section>

            <section
              v-for="(event, index) in compactionEvents"
              :key="`compaction-${index}-${event.timestamp}`"
              class="debugCard"
            >
              <div class="debugMeta">
                <strong>Context compacted</strong>
                <span>{{ event.summarizedMessageCount }} messages · {{ eventTime(event) }}</span>
              </div>
              <pre>{{ event.summary }}</pre>
            </section>

            <section class="debugCard">
              <div class="debugMeta">
                <strong>LanguageModel.params()</strong>
                <span>{{ modelParamsStatus }}</span>
              </div>
              <pre>{{ modelParamsText }}</pre>
            </section>

            <div v-if="debugCalls.length === 0" class="debugEmpty">
              No model calls yet. Send a chat message to populate the trace.
            </div>

            <details
              v-for="call in debugCalls"
              :key="call.callId"
              class="debugCard"
              open
            >
              <summary class="debugMeta">
                <strong>{{ call.start?.kind === "summary" ? "Summary" : "LLM" }} Call #{{ call.callId }}</strong>
                <span>
                  {{ call.error ? "error" : call.end ? "complete" : "running" }}
                  · {{ call.start ? eventTime(call.start) : "" }}
                </span>
              </summary>

              <div v-if="call.start" class="debugMessages">
                <div class="debugMeta">
                  <strong>Input messages</strong>
                  <span>{{ call.start.messages.length }} messages</span>
                </div>
                <div
                  v-for="(message, messageIndex) in call.start.messages"
                  :key="messageIndex"
                  class="debugMessage"
                >
                  <span>{{ message.role }}</span>
                  <pre>{{ message.content }}</pre>
                </div>
              </div>

              <div v-if="call.end" class="debugMessage">
                <span>final {{ call.end.message.role }}</span>
                <pre>{{ call.end.message.content }}</pre>
              </div>

              <div v-if="call.toolStart" class="debugMessage">
                <span>tool · {{ call.toolStart.tool }} · args</span>
                <pre>{{ JSON.stringify(call.toolStart.args, null, 2) }}</pre>
              </div>

              <div v-if="call.toolEnd" class="debugMessage">
                <span>tool · {{ call.toolEnd.tool }} · result</span>
                <pre>{{ call.toolEnd.result }}</pre>
              </div>

              <pre v-if="call.error" class="errorText">{{ call.error.error }}</pre>
            </details>
          </div>
        </template>
      </aside>
    </section>
  </main>
</template>
