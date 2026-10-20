# AGENTS.md

## Project purpose

`langchain-nano-lab` is a small learning lab for understanding how an agent runtime is built from first principles using:

- Vue 3 + Vite for the UI
- `@langchain/core` for model/message abstractions
- Chrome's browser-native `LanguageModel` API for on-device inference
- Gemini Nano / Chrome built-in AI as the local model runtime

The long-term learning goal is to build a tiny agent runtime conceptually similar to the minimum building blocks behind tools such as Pi / Codex / Claude Code. We are intentionally building this incrementally instead of jumping directly to a full agent framework.

The conceptual layers are:

```text
UI / I/O
  ↓
ChatHarness / orchestration
  ↓
LangChain BaseChatModel API
  ↓
ChromeLanguageModelAdapter
  ↓
Chrome LanguageModel API
  ↓
on-device model
```

Keep these boundaries clear.

---

## Current milestone

The project is currently around **v2.5**.

Learning progression so far:

```text
v0  basic invoke()
v1  explicit conversation history
v2  streaming
v2.5 debug / observability UI
v3  one tool       ← next major milestone
v4  tool loop
```

Do not skip directly to a large agent abstraction. The value of this repo is that each stage exposes one new mechanism clearly.

---

## Current architecture

### `src/App.vue`

Responsible for presentation only:

- chat UI
- streaming text rendering
- model availability status
- Code / Debug tabs
- debug timeline display
- runtime inspection of `LanguageModel.params()`

The UI should not talk directly to Chrome model sessions for normal chat execution.

### `src/harness.ts`

`ChatHarness` is the orchestration layer and owns canonical conversation state.

It currently:

- stores `BaseMessage[]` history
- supports `run()` for non-streaming execution
- supports `stream()` for streaming execution
- creates `HumanMessage` / final `AIMessage`
- commits only completed responses to durable history
- emits debug events such as:
  - `llm_start`
  - `llm_end`
  - `llm_error`

Streaming chunks are rendered by the UI callback but are intentionally **not logged individually** in the Debug timeline.

This class is expected to become the tiny agent runtime later, so future responsibilities may include:

- tools
- tool execution
- repeated model/tool loops
- retries
- context trimming/summarization
- persistence
- richer execution events

### `src/adapters/ChromeLanguageModelAdapter/`

The Chrome adapter extends LangChain's `BaseChatModel`.

Responsibilities:

- translate LangChain messages into Chrome Prompt API messages
- create/destroy browser `LanguageModel` sessions
- expose availability
- implement non-streaming LangChain generation via `_generate()`
- implement LangChain-native streaming via `_streamResponseChunks()`

Important: the harness should depend on LangChain's public model API (`invoke()`, `stream()`), not Chrome-specific helper methods.

Expected execution paths:

```text
harness.run()
→ model.invoke()
→ adapter._generate()
→ session.prompt(...)
```

and:

```text
harness.stream()
→ model.stream()
→ adapter._streamResponseChunks()
→ session.promptStreaming(...)
```

Do not reintroduce a custom `adapter.streamResponse()` path unless there is a very strong reason.

---

## Conversation state decision

A deliberate architectural decision was made in v1:

**The harness owns conversation history. The Chrome model session does not.**

Every invocation creates a fresh Chrome `LanguageModel` session, sends the complete explicit conversation history, receives a result, and destroys the session.

Why:

If both the harness and a persistent Chrome session remember previous turns, the effective context can be duplicated.

Chosen model:

```text
ChatHarness history = source of truth
Chrome session       = stateless transport for one invocation
```

This also makes later agent features easier because tool calls, summaries, retries, branches, and persistence need explicit state outside the model provider.

Do not casually change this to a persistent Chrome session without reconsidering that tradeoff.

---

## Streaming model

LangChain streaming uses `ChatGenerationChunk` / `AIMessageChunk` internally.

Important conceptual split:

```text
stream chunks = transient execution
final AIMessage = durable conversation state
```

The UI may receive many chunks during generation, but the harness stores one final assistant message.

This distinction is important for the upcoming tool implementation because tool calls and tool results are also execution events that should not be confused with final user-visible state.

---

## Debug UI

The right-side panel has two tabs:

```text
Code | Debug
```

The Debug tab currently shows:

1. Adapter system prompt
2. `LanguageModel.params()` runtime output when exposed by the current Chrome build
3. One foldable section per LLM call

Each call fold groups:

- input messages sent through LangChain
- final assistant response, or error
- status / timestamp

Do not log every streaming chunk in Debug; that was intentionally removed because it made the trace noisy.

The debug folds use native `<details>/<summary>`.

The Debug feed CSS must keep rows content-sized. In particular:

```css
.debugFeed {
  align-content: start;
  grid-auto-rows: max-content;
}
```

Without that, collapsed grid rows stretch vertically and appear broken.

---

## System prompt

The adapter currently injects the system prompt when it creates the Chrome session using `initialPrompts`.

That means the current model input has two conceptual sources:

```text
Chrome session initialPrompts
  → system prompt

ChatHarness history
  → human + assistant conversation messages
```

The Debug UI intentionally exposes this distinction.

---

## Chrome `LanguageModel` API notes

This project uses the browser-native `LanguageModel` global.

The adapter guards for unsupported browsers.

Relevant states include:

```text
unsupported
unavailable
downloadable
downloading
available
```

Inference is intended to run through Chrome's local built-in model path rather than a Gemini cloud API. There is no API key or hosted Gemini SDK in this project.

`LanguageModel.params()` is treated as optional because support varies by Chrome build / exposure mode. The UI prints the actual runtime object instead of assuming a fixed schema.

When working on Chrome Prompt API details, check current official Chrome documentation before making assumptions because this API is evolving.

---

## Tooling direction: next milestone

The next major milestone is **v3: one tool**.

Keep the first implementation intentionally small.

Target conceptual flow:

```text
user
  ↓
model
  ↓
model requests one tool
  ↓
harness executes tool
  ↓
tool result goes back to model
  ↓
model returns final answer
```

Desired conceptual ownership:

```text
LLM     = decides
Harness = orchestrates / acts
Tool    = performs deterministic work
```

A simple deterministic tool such as a calculator or current-time tool is preferred for the first version because the learning goal is the control flow, not tool complexity.

Before implementing v3, verify the current capabilities of:

- Chrome Prompt API tool/function calling
- LangChain JS tool APIs for the installed version

Do not assume native tool calling exists in this browser API. If it does not, a small explicit structured protocol may be appropriate for learning purposes.

The harness debug event system should expand naturally with events such as:

```text
tool_start
tool_end
```

Then v4 can generalize the single-tool step into a repeated tool loop.

---

## UI / layout conventions

The desktop interface is full viewport height.

Expected behavior:

- top bar remains outside pane scrolling
- chat pane fills available height
- chat message area scrolls independently
- composer stays visible
- Code / Debug pane scrolls independently
- mobile/tablet falls back to normal page scrolling

Avoid reverting to a document-height layout unless intentionally redesigning the UI.

The UI is intentionally minimal and educational rather than polished product chrome.

---

## Code sidebar purpose

The Code tab is not decoration. It is part of the learning experience.

Its purpose is:

```text
left side  = observe behavior
right side = see the minimal code responsible
```

As milestones evolve, update the snippets so they reflect the architectural concept currently being taught.

Examples:

```text
v0 invoke
v1 history
v2 streaming
v2.5 observability
v3 one tool
v4 tool loop
```

Prefer small representative snippets over dumping entire source files into the sidebar.

---

## Tech stack

Current `package.json` essentials:

```text
Vue                3.5.13
@langchain/core    1.2.13
TypeScript         5.7.2
Vite               7.1.7
@vitejs/plugin-vue 6.0.1
```

Commands:

```bash
npm install
npm run dev
npm run build
npm run preview
```

`npm run build` currently runs `vite build`; there is no `vue-tsc` build step yet.

---

## Repository structure

Current important files:

```text
src/
  adapters/
    ChromeLanguageModelAdapter/
      ChromeLanguageModelAdapter.ts
      types.ts
      index.ts
  App.vue
  harness.ts
  main.ts
  styles.css
```

Keep Chrome-specific types and logic inside the adapter folder where possible.

---

## Git workflow

Important project preference:

**Every logical change should be committed separately.**

Use short, descriptive commits such as:

```text
Add v2 streaming
Use LangChain native streaming API
Add v2.5 debug timeline
Log only final LLM responses
Fix stretched debug fold rows
Show LanguageModel params in debug
```

Do not bundle unrelated refactors/features into one commit.

If a logical change touches multiple files, commit them together as one atomic commit.

Default branch is `main`.

Repository:

```text
kmilov/langchain-nano-lab
```

---

## Deployment

The repo is linked to Vercel and pushes to `main` automatically trigger production deployment.

Primary production alias:

```text
https://langchain-nano-lab.vercel.app
```

Normal flow:

```text
commit/push to main
→ GitHub
→ Vercel detects commit
→ production build/deploy
```

Do not trigger an extra manual deployment unless needed.

---

## Development style for this repository

This is a learning project. Prefer:

- small changes
- visible causal relationships
- first-principles explanations
- explicit state
- minimal abstractions until repetition justifies them
- readable TypeScript over cleverness
- provider boundaries that remain easy to inspect

Avoid:

- prematurely introducing LangGraph or a full agent framework
- hiding core agent mechanics behind utilities too early
- mixing UI state with canonical model state
- giving Chrome-specific APIs to the harness when LangChain already provides the abstraction
- giant refactors that make it hard to see what changed conceptually

When adding a new feature, ask: **what new agent concept is this version teaching?**
