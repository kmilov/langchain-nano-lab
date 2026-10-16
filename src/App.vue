<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from "vue";
import {
  ChromeLanguageModelAdapter,
  type ChromeAvailability,
} from "./adapters/ChromeLanguageModelAdapter";
import { ChatHarness } from "./harness";

type Availability = "checking" | "unsupported" | ChromeAvailability;
type ChatMessage = {
  role: "user" | "assistant" | "error";
  content: string;
};

const model = new ChromeLanguageModelAdapter({});
const harness = new ChatHarness(model);

const availability = ref<Availability>("checking");
const input = ref("");
const busy = ref(false);
const messages = ref<ChatMessage[]>([]);
const historySize = ref(0);
const messagesEl = ref<HTMLElement | null>(null);

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

const harnessCode = `async stream(input, onChunk) {
  const nextMessages = [
    ...this.messages,
    new HumanMessage(input),
  ];

  // Public LangChain API — no Chrome-specific call here.
  const stream = await this.model.stream(nextMessages);
  let output = "";

  for await (const chunk of stream) {
    const text = chunk.content.toString();
    output += text;
    onChunk(text);
  }

  const response = new AIMessage(output);
  this.messages = [...nextMessages, response];

  return response;
}`;

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
            <p>Streaming now flows through LangChain's public model API.</p>
          </div>
          <span class="step">v2 · streaming · {{ historySize }} msgs</span>
        </div>

        <div ref="messagesEl" class="messages">
          <div v-if="messages.length === 0" class="empty">
            <div class="emptyMark">⌁</div>
            <strong>Watch Nano answer live.</strong>
            <span>Try a prompt that needs a few sentences so the stream is easy to see.</span>
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
        <div class="sectionHeader codeHeading">
          <div>
            <h2>Code</h2>
            <p>v2 now stays inside the LangChain BaseChatModel abstraction.</p>
          </div>
        </div>

        <section class="codeBlock">
          <div class="codeBar">1 · Adapter · implement LangChain streaming</div>
          <pre><code>{{ adapterCode }}</code></pre>
        </section>

        <section class="codeBlock">
          <div class="codeBar">2 · ChatHarness · consume model.stream()</div>
          <pre><code>{{ harnessCode }}</code></pre>
        </section>

        <div class="nextSteps">
          <span>Next</span>
          <strong>One tool → tool loop</strong>
        </div>
      </aside>
    </section>
  </main>
</template>
