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
  type ChatHarnessState,
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
type PersistedAppState = {
  version: 1;
  harness: ChatHarnessState;
  messages: ChatMessage[];
};
type SideTab = "code" | "debug" | "test";
type TestStatus = "idle" | "running" | "pass" | "fail" | "error";
type TestCase = {
  id: number;
  prompt: string;
  expected: string;
  expectedExecutionStatus: "" | "SUCCESS" | "EMPTY" | "PLAN_INVALID" | "PLAN_REJECTED";
  requiredTools: string;
  forbiddenTools: string;
  status: TestStatus;
  actual: string;
  detail: string;
};
type ModelParamsStatus = "loading" | "available" | "unsupported" | "error";
type DebugCall = {
  callId: number;
  start?: Extract<HarnessEvent, { type: "llm_start" }>;
  end?: Extract<HarnessEvent, { type: "llm_end" }>;
  error?: Extract<HarnessEvent, { type: "llm_error" }>;
  toolStart?: Extract<HarnessEvent, { type: "tool_start" }>;
  toolEnd?: Extract<HarnessEvent, { type: "tool_end" }>;
};

const STORAGE_KEY = "langchain-nano-lab:v6";
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
const testRunning = ref(false);
const testCases = ref<TestCase[]>([
  {
    id: 1,
    prompt: "What is 14 + 6, and what is 30 - 11?",
    expected: "20",
    expectedExecutionStatus: "SUCCESS",
    requiredTools: "calculator",
    forbiddenTools: "",
    status: "idle",
    actual: "",
    detail: "Expected answer must contain this text.",
  },
  {
    id: 2,
    prompt: 'Count the words in "the quick brown fox jumps over the lazy dog".',
    expected: "9",
    expectedExecutionStatus: "SUCCESS",
    requiredTools: "word_count",
    forbiddenTools: "",
    status: "idle",
    actual: "",
    detail: "Expected answer must contain this text.",
  },
  {
    id: 3,
    prompt: "How many letters are in the word banana?",
    expected: "six",
    expectedExecutionStatus: "EMPTY",
    requiredTools: "",
    forbiddenTools: "word_count",
    status: "idle",
    actual: "",
    detail: "Correct answer, while avoiding the word_count tool.",
  },
]);

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

const testSummary = computed(() => {
  const finished = testCases.value.filter((test) =>
    ["pass", "fail", "error"].includes(test.status),
  );
  const passed = finished.filter((test) => test.status === "pass").length;
  return {
    passed,
    failed: finished.length - passed,
    total: testCases.value.length,
    finished: finished.length,
  };
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

const routingCode = `for (const registered of registeredTools) {
  if (registered.routing?.mode !== "required") continue;

  const args = registered.routing.route(input);
  if (args) {
    await executeTool({
      type: "tool_call",
      tool: registered.tool.name,
      args,
    });
  }
}`;

const plannerCode = `const plan = await planTools(input, workingMessages);

if (plan?.steps.length) {
  workingMessages = await executePlan(plan.steps, workingMessages);
} else {
  // v7 safety net
  workingMessages =
    await executeRequiredTool(input, workingMessages)
    ?? workingMessages;
}`;

const persistenceCode = `const saved = localStorage.getItem(STORAGE_KEY);
if (saved) {
  const state = JSON.parse(saved);
  harness.importState(state.harness);
  messages.value = state.messages;
}

localStorage.setItem(STORAGE_KEY, JSON.stringify({
  version: 1,
  harness: harness.exportState(),
  messages: messages.value,
}));`;

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

function saveAppState() {
  const state: PersistedAppState = {
    version: 1,
    harness: harness.exportState(),
    messages: messages.value,
  };

  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function restoreAppState() {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (!saved) return;

  try {
    const state = JSON.parse(saved) as PersistedAppState;
    if (state.version !== 1 || !state.harness || !Array.isArray(state.messages)) {
      throw new Error("Unsupported persisted app state.");
    }

    harness.importState(state.harness);
    messages.value = state.messages
      .filter(
        (message) =>
          message &&
          ["user", "assistant", "error"].includes(message.role) &&
          typeof message.content === "string",
      )
      .map((message) => ({
        ...message,
        content: message.role === "assistant" ? message.content.trimEnd() : message.content,
      }));
    refreshHarnessState();
  } catch {
    localStorage.removeItem(STORAGE_KEY);
    harness.clear();
    messages.value = [];
    refreshHarnessState();
  }
}

function clearConversation() {
  harness.clear();
  messages.value = [];
  debugEvents.value = [];
  localStorage.removeItem(STORAGE_KEY);
  refreshHarnessState();
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

    messages.value[assistantIndex].content = messages.value[assistantIndex].content.trimEnd();
    refreshHarnessState();
    saveAppState();
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

function normalizeEvalText(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function parseToolList(value: string) {
  return value
    .split(",")
    .map((tool) => tool.trim())
    .filter(Boolean);
}

function executionStatusFromEvents(events: HarnessEvent[]) {
  const finalizerStart = [...events]
    .reverse()
    .find(
      (event): event is Extract<HarnessEvent, { type: "llm_start" }> =>
        event.type === "llm_start" && event.kind === "finalizer",
    );

  const report = finalizerStart?.messages.find(
    (message) =>
      message.role === "system" &&
      message.content.startsWith("Execution status:"),
  );

  return report?.content.match(/Execution status:\s*(\S+)/)?.[1] ?? "";
}

function evaluateTest(test: TestCase, events: HarnessEvent[]) {
  const assertions: Array<{ pass: boolean; detail: string }> = [];
  const expectedText = test.expected.trim();

  if (expectedText) {
    const pass = normalizeEvalText(test.actual).includes(
      normalizeEvalText(expectedText),
    );
    assertions.push({
      pass,
      detail: pass
        ? `Answer contains "${expectedText}".`
        : `Answer does not contain "${expectedText}".`,
    });
  }

  const actualExecutionStatus = executionStatusFromEvents(events);
  if (test.expectedExecutionStatus) {
    const pass = actualExecutionStatus === test.expectedExecutionStatus;
    assertions.push({
      pass,
      detail: pass
        ? `Execution status is ${actualExecutionStatus}.`
        : `Expected execution status ${test.expectedExecutionStatus}, got ${actualExecutionStatus || "unknown"}.`,
    });
  }

  const calledTools = events
    .filter(
      (event): event is Extract<HarnessEvent, { type: "tool_start" }> =>
        event.type === "tool_start",
    )
    .map((event) => event.tool);

  for (const tool of parseToolList(test.requiredTools)) {
    const pass = calledTools.includes(tool);
    assertions.push({
      pass,
      detail: pass
        ? `Required tool "${tool}" was called.`
        : `Required tool "${tool}" was not called.`,
    });
  }

  for (const tool of parseToolList(test.forbiddenTools)) {
    const pass = !calledTools.includes(tool);
    assertions.push({
      pass,
      detail: pass
        ? `Forbidden tool "${tool}" was not called.`
        : `Forbidden tool "${tool}" was called.`,
    });
  }

  if (assertions.length === 0) {
    return {
      pass: false,
      detail: "Add at least one assertion before running this eval.",
    };
  }

  return {
    pass: assertions.every((assertion) => assertion.pass),
    detail: assertions
      .map((assertion) => `${assertion.pass ? "✓" : "✗"} ${assertion.detail}`)
      .join("\n"),
  };
}

function resetTests() {
  for (const test of testCases.value) {
    test.status = "idle";
    test.actual = "";
    test.detail = "Not run yet.";
  }
}

function addTestCase() {
  const nextId = Math.max(0, ...testCases.value.map((test) => test.id)) + 1;
  testCases.value.push({
    id: nextId,
    prompt: "",
    expected: "",
    expectedExecutionStatus: "",
    requiredTools: "",
    forbiddenTools: "",
    status: "idle",
    actual: "",
    detail: "Not run yet.",
  });
}

function removeTestCase(id: number) {
  if (testRunning.value) return;
  testCases.value = testCases.value.filter((test) => test.id !== id);
}

async function runTestSuite() {
  if (testRunning.value || !ready.value) return;

  testRunning.value = true;
  resetTests();
  harness.clear();
  messages.value = [];
  debugEvents.value = [];
  refreshHarnessState();
  await scrollToBottom();

  for (const test of testCases.value) {
    const prompt = test.prompt.trim();

    if (!prompt) {
      test.status = "error";
      test.detail = "Prompt is required.";
      continue;
    }

    const evalHarness = new ChatHarness(model, [calculatorTool, wordCountTool]);
    const evalEvents: HarnessEvent[] = [];
    evalHarness.subscribe((event) => {
      if (event.type !== "llm_chunk") {
        evalEvents.push(event);
        debugEvents.value.push(event);
      }
    });

    test.status = "running";
    test.actual = "";
    test.detail = "Waiting for Nano…";

    messages.value.push({ role: "user", content: prompt });
    const assistantIndex =
      messages.value.push({ role: "assistant", content: "" }) - 1;
    await scrollToBottom();

    try {
      const response = await evalHarness.stream(prompt, (chunk) => {
        test.actual += chunk;
        messages.value[assistantIndex].content += chunk;
        void scrollToBottom();
      });

      test.actual = response.content.toString().trimEnd();
      messages.value[assistantIndex].content = test.actual;

      const evaluation = evaluateTest(test, evalEvents);
      test.status = evaluation.pass ? "pass" : "fail";
      test.detail = evaluation.detail;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      test.status = "error";
      test.actual = detail;
      test.detail = `Test execution failed: ${detail}`;
      messages.value[assistantIndex] = { role: "error", content: detail };
    }

    await scrollToBottom();
  }

  testRunning.value = false;
}

function onComposerKeydown(event: KeyboardEvent) {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    void sendMessage();
  }
}

onMounted(async () => {
  restoreAppState();
  void scrollToBottom();
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
            <p>Streaming through LangChain, with tools, context memory, and browser persistence.</p>
          </div>
          <div class="headerBadges">
            <span class="contextUsageLabel">{{ contextUsageLabel }}</span>
            <span class="step">v8 · planner + executor · {{ historySize }} msgs</span>
            <button v-if="messages.length > 0" class="clearButton" @click="clearConversation">Clear chat</button>
          </div>
        </div>

        <div ref="messagesEl" class="messages">
          <div v-if="messages.length === 0" class="empty">
            <div class="emptyMark">⌁</div>
            <strong>Your agent state now survives a page refresh.</strong>
            <span>At 30%, the Harness still summarizes older messages and keeps the latest 6 verbatim.</span>
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
          <button :class="{ active: activeTab === 'test' }" @click="activeTab = 'test'">Test</button>
        </div>

        <template v-if="activeTab === 'code'">
          <div class="sectionHeader codeHeading">
            <div>
              <h2>Code</h2>
              <p>v8 adds a Planner → Executor → Finalizer flow for multi-step and dependent tool use.</p>
            </div>
          </div>

          <section class="codeBlock">
            <div class="codeBar">1 · Adapter · LangChain-native streaming</div>
            <pre><code>{{ adapterCode }}</code></pre>
          </section>

          <section class="codeBlock">
            <div class="codeBar">2 · Tool routing · v7 deterministic fallback</div>
            <pre><code>{{ routingCode }}</code></pre>
          </section>

          <section class="codeBlock">
            <div class="codeBar">3 · Planner · whole-turn decomposition</div>
            <pre><code>{{ plannerCode }}</code></pre>
          </section>

          <section class="codeBlock">
            <div class="codeBar">4 · Persistence · export / restore Harness state</div>
            <pre><code>{{ persistenceCode }}</code></pre>
          </section>

          <div class="nextSteps">
            <span>v8 execution model</span>
            <strong>planner understands the whole turn · executor runs ordered tool steps · Nano finalizes the answer</strong>
          </div>
        </template>

        <template v-else-if="activeTab === 'debug'">
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
                <strong>Persistent Harness state</strong>
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
              No model calls in this page session yet. Restored conversation state is still available to the Harness.
            </div>

            <details
              v-for="call in debugCalls"
              :key="call.callId"
              class="debugCard"
              open
            >
              <summary class="debugMeta">
                <strong>{{ call.start?.kind === "summary" ? "Summary" : call.start?.kind === "planner" ? "Planner" : "LLM" }} Call #{{ call.callId }}</strong>
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

        <template v-else>
          <div class="sectionHeader codeHeading debugHeader">
            <div>
              <h2>Test</h2>
              <p>Run repeatable prompts against Nano and compare each response with an expected result.</p>
            </div>
            <div class="testActions">
              <button class="clearButton" :disabled="testRunning" @click="addTestCase">Add case</button>
              <button class="testRunButton" :disabled="testRunning || !ready || testCases.length === 0" @click="runTestSuite">
                {{ testRunning ? "Running…" : "Run tests" }}
              </button>
            </div>
          </div>

          <div class="testSummary">
            <div>
              <span>Passed</span>
              <strong>{{ testSummary.passed }}</strong>
            </div>
            <div>
              <span>Failed</span>
              <strong>{{ testSummary.failed }}</strong>
            </div>
            <div>
              <span>Completed</span>
              <strong>{{ testSummary.finished }}/{{ testSummary.total }}</strong>
            </div>
          </div>

          <div class="testFeed">
            <section
              v-for="(test, index) in testCases"
              :key="test.id"
              class="testCard"
              :class="`test-${test.status}`"
            >
              <div class="testCardHeader">
                <strong>Eval {{ index + 1 }}</strong>
                <div class="testCardMeta">
                  <span class="testStatus">{{ test.status }}</span>
                  <button
                    class="testRemoveButton"
                    :disabled="testRunning"
                    title="Remove test"
                    @click="removeTestCase(test.id)"
                  >
                    ×
                  </button>
                </div>
              </div>

              <label class="testField">
                <span>Prompt</span>
                <textarea v-model="test.prompt" rows="3" :disabled="testRunning" />
              </label>

              <div class="testAssertionGrid">
                <label class="testField">
                  <span>Answer contains</span>
                  <input v-model="test.expected" :disabled="testRunning" placeholder="Optional text assertion" />
                </label>

                <label class="testField">
                  <span>Execution status</span>
                  <select v-model="test.expectedExecutionStatus" :disabled="testRunning">
                    <option value="">Any</option>
                    <option value="SUCCESS">SUCCESS</option>
                    <option value="EMPTY">EMPTY</option>
                    <option value="PLAN_INVALID">PLAN_INVALID</option>
                    <option value="PLAN_REJECTED">PLAN_REJECTED</option>
                  </select>
                </label>

                <label class="testField">
                  <span>Required tools</span>
                  <input v-model="test.requiredTools" :disabled="testRunning" placeholder="calculator, word_count" />
                </label>

                <label class="testField">
                  <span>Forbidden tools</span>
                  <input v-model="test.forbiddenTools" :disabled="testRunning" placeholder="word_count" />
                </label>
              </div>

              <div v-if="test.status !== 'idle'" class="testResult">
                <span>Actual output</span>
                <pre>{{ test.actual || "Waiting…" }}</pre>
                <p class="testDetails">{{ test.detail }}</p>
              </div>
            </section>
          </div>
        </template>
      </aside>
    </section>
  </main>
</template>
