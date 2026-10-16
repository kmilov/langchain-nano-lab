<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from "vue";
import {
  ChromeLanguageModelAdapter,
  SYSTEM_PROMPT,
  type ChromeAvailability,
} from "./adapters/ChromeLanguageModelAdapter";
import { ChatHarness, type HarnessEvent } from "./harness";

type Availability = "checking" | "unsupported" | ChromeAvailability;
type ChatMessage = {
  role: "user" | "assistant" | "error";
  content: string;
};
type SideTab = "code" | "debug";

const model = new ChromeLanguageModelAdapter({});
const harness = new ChatHarness(model);

const availability = ref<Availability>("checking");
const input = ref("");
const busy = ref(false);
const messages = ref<ChatMessage[]>([]);
const historySize = ref(0);
const messagesEl = ref<HTMLElement | null>(null);
const activeTab = ref<SideTab>("code");
const debugEvents = ref<HarnessEvent[]>([]);

harness.subscribe((event) => {
  if (event.type !== "llm_chunk") {
    debugEvents.value.push(event);
  }
});

const ready = computed(() =>
  ["available", "downloadable", "downloading"].includes(availability.value),
);

const adapterCode = `async *_streamResponseChunks(messages) {
  const session = await this.createSession();

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

const harnessCode = `this.emit({
  type: "llm_start",
  callId,
  messages: nextMessages.map(snapshot),
});

const stream = await this.model.stream(nextMessages);
let output = "";

for await (const chunk of stream) {
  output += chunk.content.toString();
}

this.emit({
  type: "llm_end",
  callId,
  message: finalMessage,
});`;

function eventTitle(event: HarnessEvent) {
  if (event.type === "llm_start") return `LLM Call #${event.callId}`;
  if (event.type === "llm_end") return `LLM Response #${event.callId}`;
  return `LLM Error #${event.callId}`;
}

function eventTime(event: HarnessEvent) {
  return new Date(event.timestamp).toLocaleTimeString();
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

    historySize.value = harness.history().length;
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
            <p>Streaming through LangChain, with model calls and final responses mirrored into Debug.</p>
          </div>
          <span class="step">v2.5 · debug · {{ historySize }} msgs</span>
        </div>

        <div ref="messagesEl" class="messages">
          <div v-if="messages.length === 0" class="empty">
            <div class="emptyMark">⌁</div>
            <strong>Send a message, then open Debug.</strong>
            <span>You’ll see the exact LangChain message history and the final model response.</span>
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
              <p>v2.5 keeps streaming live while Debug records only meaningful execution boundaries.</p>
            </div>
          </div>

          <section class="codeBlock">
            <div class="codeBar">1 · Adapter · LangChain-native streaming</div>
            <pre><code>{{ adapterCode }}</code></pre>
          </section>

          <section class="codeBlock">
            <div class="codeBar">2 · ChatHarness · emit call + final response</div>
            <pre><code>{{ harnessCode }}</code></pre>
          </section>

          <div class="nextSteps">
            <span>Next</span>
            <strong>One tool → tool loop</strong>
          </div>
        </template>

        <template v-else>
          <div class="sectionHeader codeHeading debugHeader">
            <div>
              <h2>Debug</h2>
              <p>What LangChain sends, what Chrome injects, and the final answer that comes back.</p>
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

            <div v-if="debugEvents.length === 0" class="debugEmpty">
              No model calls yet. Send a chat message to populate the trace.
            </div>

            <section
              v-for="(event, index) in debugEvents"
              :key="`${event.type}-${event.callId}-${index}`"
              class="debugCard"
              :class="`debug-${event.type}`"
            >
              <div class="debugMeta">
                <strong>{{ eventTitle(event) }}</strong>
                <span>{{ eventTime(event) }}</span>
              </div>

              <div v-if="event.type === 'llm_start'" class="debugMessages">
                <div v-for="(message, messageIndex) in event.messages" :key="messageIndex" class="debugMessage">
                  <span>{{ message.role }}</span>
                  <pre>{{ message.content }}</pre>
                </div>
              </div>

              <div v-else-if="event.type === 'llm_end'" class="debugMessage">
                <span>{{ event.message.role }}</span>
                <pre>{{ event.message.content }}</pre>
              </div>

              <pre v-else class="errorText">{{ event.error }}</pre>
            </section>
          </div>
        </template>
      </aside>
    </section>
  </main>
</template>
