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
const messagesEl = ref<HTMLElement | null>(null);

const ready = computed(() =>
  ["available", "downloadable", "downloading"].includes(availability.value),
);

const adapterCode = `export class ChromeLanguageModelAdapter extends BaseChatModel {
  async _generate(messages) {
    const session = await LanguageModel.create();
    const output = await session.prompt(messages);

    return {
      generations: [{
        text: output,
        message: new AIMessage(output),
      }],
    };
  }
}`;

const harnessCode = `export class ChatHarness {
  constructor(model) {
    this.model = model;
  }

  run(input) {
    return this.model.invoke([
      new HumanMessage(input),
    ]);
  }
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
  busy.value = true;
  await scrollToBottom();

  try {
    const result = await harness.run(prompt);
    messages.value.push({
      role: "assistant",
      content: result.content.toString(),
    });
  } catch (error) {
    messages.value.push({
      role: "error",
      content: error instanceof Error ? error.message : String(error),
    });
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
            <p>Chrome LanguageModel API → LangChain adapter → harness → Vue.</p>
          </div>
          <span class="step">v0 · invoke()</span>
        </div>

        <div ref="messagesEl" class="messages">
          <div v-if="messages.length === 0" class="empty">
            <div class="emptyMark">⌁</div>
            <strong>Start with one prompt.</strong>
            <span>Try: “Explain dependency inversion in one paragraph.”</span>
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
            <p>{{ message.content }}</p>
          </div>

          <div v-if="busy" class="message assistant pending">
            Nano is thinking locally…
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
            {{ busy ? "Running…" : "Send" }}
          </button>
        </form>
      </article>

      <aside class="codePane">
        <div class="sectionHeader codeHeading">
          <div>
            <h2>Code</h2>
            <p>The UI is compiled by Vite; LangChain is installed from npm.</p>
          </div>
        </div>

        <section class="codeBlock">
          <div class="codeBar">1 · ChromeLanguageModelAdapter</div>
          <pre><code>{{ adapterCode }}</code></pre>
        </section>

        <section class="codeBlock">
          <div class="codeBar">2 · harness.ts</div>
          <pre><code>{{ harnessCode }}</code></pre>
        </section>

        <div class="nextSteps">
          <span>Next</span>
          <strong>Conversation history → streaming → one tool → tool loop</strong>
        </div>
      </aside>
    </section>
  </main>
</template>
