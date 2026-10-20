# AGENTS.md

## Project purpose

`langchain-nano-lab` is a small learning lab for understanding how an agent runtime is built from first principles using:

- Vue 3 + Vite for the UI
- `@langchain/core` for model/message/tool abstractions
- Chrome's browser-native `LanguageModel` API for on-device inference
- Gemini Nano / Chrome built-in AI as the local model runtime

The long-term learning goal is to build a tiny agent runtime conceptually similar to the minimum building blocks behind tools such as Pi / Codex / Claude Code. We are intentionally building this incrementally instead of jumping directly to a full agent framework.

The conceptual layers are:

```text
UI / I/O
  ↓
ChatHarness / orchestration
  ↓
LangChain BaseChatModel + Tool APIs
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

The project is currently at **v3: one tool**.

Learning progression so far:

```text
v0  basic invoke()
v1  explicit conversation history
v2  streaming
v2.5 debug / observability UI
v3  one tool       ← complete
v4  tool loop      ← next major milestone
```

Do not skip directly to a large agent abstraction. The value of this repo is that each stage exposes one new mechanism clearly.

---

## Current architecture

### `src/App.vue`

Responsible for presentation only:

- chat UI
- streaming text rendering
- model availability status
- context-window usage label surfaced by the harness
- Code / Debug tabs
- debug timeline display, including tool execution events
- runtime inspection of `LanguageModel.params()`

The UI should not talk directly to Chrome model sessions for normal chat execution or context usage. `LanguageModel.params()` remains a small explicit runtime-inspection exception in the Debug UI.

The app wires the current v3 calculator tool into the harness:

```ts
const harness = new ChatHarness(model, calculatorTool);
```

### `src/harness.ts`

`ChatHarness` is the orchestration layer and owns canonical conversation state.

It currently:

- stores `BaseMessage[]` history
- supports `run()` for non-streaming execution
- supports `stream()` for streaming execution
- creates `HumanMessage`, intermediate `AIMessage`, `ToolMessage`, and final `AIMessage`
- commits completed execution state to explicit history
- surfaces the latest provider-reported context usage through `contextUsage()`
- accepts one optional LangChain tool
- detects the tiny v3 structured tool-call protocol
- executes that tool
- performs one follow-up model call with the tool result
- emits debug events such as:
  - `llm_start`
  - `llm_end`
  - `llm_error`
  - `tool_start`
  - `tool_end`

Streaming chunks are rendered by the UI callback but are intentionally **not logged individually** in the Debug timeline.

The harness accepts a LangChain `BaseChatModel` plus optional provider-neutral capabilities rather than depending directly on the Chrome adapter type. Provider-specific information should cross this boundary through small capabilities such as `ContextUsageProvider`.

The harness is now visibly becoming the tiny agent engine:

```text
LLM = decides
Harness = orchestrates / acts
Tool = performs deterministic work
```

Future responsibilities may include:

- multiple tools
- repeated model/tool loops
- retries
- context trimming/summarization
- persistence
- richer execution events

### `src/model/capabilities.ts`

Contains small provider-neutral optional capabilities that are not part of LangChain's generic chat-model contract.

Current capability:

```text
ContextUsageProvider.getContextUsage()
→ { usedTokens, maxTokens } | null
```

Keep capability types provider-neutral. Chrome-specific field names and session details belong in the adapter.

### `src/adapters/ChromeLanguageModelAdapter/`

The Chrome adapter extends LangChain's `BaseChatModel`.

Responsibilities:

- translate LangChain messages into Chrome Prompt API messages
- create/destroy browser `LanguageModel` sessions
- expose availability
- implement non-streaming LangChain generation via `_generate()`
- implement LangChain-native streaming via `_streamResponseChunks()`
- translate LangChain `SystemMessage`s into Chrome `initialPrompts`
- translate `ToolMessage` into a normal Chrome user message because Chrome has no native tool role
- read Chrome session `contextUsage` / `contextWindow` after completed calls
- translate that provider-specific data into the provider-neutral context-usage capability

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

## v3 one-tool architecture

Chrome's current public Prompt API does not provide a native tool/function-calling parameter in the path used by this project, so v3 uses a deliberately tiny explicit protocol.

Current tool:

```text
calculator
  a: number
  b: number
  operation: add | subtract | multiply | divide
```

The calculator is a LangChain tool defined in:

```text
src/tools/calculator.ts
```

The model/tool protocol lives separately in:

```text
src/tools/protocol.ts
```

The model is instructed to emit a tool request like:

```json
{
  "type": "tool_call",
  "tool": "calculator",
  "args": {
    "a": 37,
    "b": 19,
    "operation": "multiply"
  }
}
```

The harness owns interpretation and execution. The calculator knows nothing about LLM prompting, and the Chrome adapter knows nothing about calculator semantics.

Current v3 flow:

```text
user
  ↓
model call #1
  ↓
structured tool request
  ↓
harness executes calculator
  ↓
ToolMessage(result)
  ↓
model call #2
  ↓
final answer
```

Intermediate tool-call and tool-result messages are model-visible execution state but are hidden from the normal chat UI. Debug exposes them.

Streaming behavior in v3:

- normal prose responses stream immediately
- responses that begin with `{` are buffered temporarily so the harness can decide whether they are hidden tool requests
- final post-tool responses stream normally

This JSON buffering is a learning-oriented bridge, not a final general-purpose agent protocol.

---

## Context usage

Chrome's current Prompt API exposes context fill on a `LanguageModel` session through:

```text
session.contextUsage
session.contextWindow
```

Read these after a completed prompt/stream and before destroying the ephemeral session.

Because this project deliberately creates a fresh Chrome session for every model call and sends the complete explicit conversation history, the captured usage represents the context for that invocation, including the provider session's system prompt and conversation input/output as counted by Chrome.

Do **not** have Vue reach into `LanguageModel` sessions to read these values. The flow is:

```text
Chrome session contextUsage/contextWindow
→ ChromeLanguageModelAdapter
→ ContextUsageProvider
→ ChatHarness.contextUsage()
→ Vue label
```

The label updates after the model response completes. If the browser build does not expose the fields, the capability returns `null`; the UI currently displays a `0% context` fallback.

`@langchain/core` 1.2.13 has generic token-usage metadata (`usage_metadata` / token usage) and model-context-size helpers for known hosted models, but it does not provide a generic live-session "used X of Y context window" contract. Do not conflate per-call token accounting with current context-window occupancy.

---

## Conversation state decision

A deliberate architectural decision was made in v1:

**The harness owns conversation history. The Chrome model session does not.**

Every invocation creates a fresh Chrome `LanguageModel` session, sends the complete explicit conversation history, receives a result, captures any provider usage metadata needed by capabilities, and destroys the session.

Why:

If both the harness and a persistent Chrome session remember previous turns, the effective context can be duplicated.

Chosen model:

```text
ChatHarness history = source of truth
Chrome session       = stateless transport for one invocation
```

This also makes agent features easier because tool calls, tool results, summaries, retries, branches, and persistence need explicit state outside the model provider.

Do not casually change this to a persistent Chrome session without reconsidering that tradeoff.

---

## Streaming model

LangChain streaming uses `ChatGenerationChunk` / `AIMessageChunk` internally.

Important conceptual split:

```text
stream chunks = transient execution
final AIMessage = durable conversation state
```

The UI may receive many chunks during generation, but the harness stores one final assistant message for each completed model stage. Tool-call and tool-result records are explicit intermediate execution state.

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
4. Tool arguments/results associated with the originating model call

Each call fold may group:

- input messages sent through LangChain
- final assistant response, or error
- tool request arguments
- tool execution result
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

## System prompts

The adapter injects the base system prompt when it creates the Chrome session using `initialPrompts`.

The adapter also forwards dynamic LangChain `SystemMessage`s into `initialPrompts`. v3 uses this to provide the tool description and structured response protocol.

The current model input therefore has multiple conceptual sources:

```text
Chrome adapter base system prompt
  → general assistant behavior

Harness dynamic SystemMessage
  → tool description + tool-call protocol

ChatHarness history
  → human + assistant + tool execution messages
```

The Debug UI intentionally exposes these boundaries through model-call inputs and execution events.

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

`contextUsage` and `contextWindow` are also typed defensively because Chrome's built-in AI API is evolving. The adapter validates both values before exposing them to the rest of the app.

When working on Chrome Prompt API details, check current official Chrome documentation before making assumptions because this API is evolving.

---

## Tooling direction: next milestone

The next major milestone is **v4: tool loop**.

v3 is intentionally constrained to one tool and at most one tool execution before a final model response.

v4 should generalize this:

```text
user
  ↓
model
  ↓
zero or more:
  tool request
    ↓
  harness executes tool
    ↓
  tool result returns to model
  ↓
final answer
```

Keep the conceptual ownership:

```text
LLM     = decides
Harness = orchestrates / acts
Tool    = performs deterministic work
```

Likely v4 work:

- accept multiple tools
- serialize all tool descriptions
- route by tool name
- repeat until the model returns a normal answer
- add a maximum iteration guard
- keep tool execution visible in Debug

Do not hide this behind LangGraph yet. The learning goal is to see the loop directly.

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
  model/
    capabilities.ts
  tools/
    calculator.ts
    protocol.ts
  App.vue
  harness.ts
  main.ts
  styles.css
```

Keep Chrome-specific types and logic inside the adapter folder where possible. Cross-provider optional model capabilities belong in `src/model/`, not in Vue or a provider adapter folder. Tool implementations and the temporary v3 tool protocol belong in `src/tools/`.

---

## Git workflow

Important project preference:

**Every logical change should be committed separately.**

Use short, descriptive commits such as:

```text
Add v2 streaming
Use LangChain native streaming API
Add v2.5 debug timeline
Add calculator tool
Add one-tool calling protocol
Add one-tool execution flow
Emit tool execution events
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
- giving Chrome-specific APIs to the harness when LangChain or a tiny provider-neutral capability provides the boundary
- giant refactors that make it hard to see what changed conceptually

When adding a new feature, ask: **what new agent concept is this version teaching?**
