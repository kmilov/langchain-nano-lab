# AGENTS.md

## Project purpose

`langchain-nano-lab` is a small learning lab for understanding how an agent runtime is built from first principles using:

- Vue 3 + Vite for the UI
- `@langchain/core` for model/message/tool abstractions
- Chrome's browser-native `LanguageModel` API for on-device inference
- Gemini Nano / Chrome built-in AI as the local model runtime

Conceptual layers:

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

The project is currently at **v4: tool loop**.

```text
v0    basic invoke()
v1    explicit conversation history
v2    streaming
v2.5  debug / observability UI
v3    one tool
v4    multiple tools + bounded tool loop  ← complete
```

Do not jump directly to LangGraph or another full agent abstraction. The purpose of this repository is to keep the mechanics visible.

---

## Current architecture

### `src/App.vue`

Presentation responsibilities:

- chat UI
- streaming text rendering
- model availability status
- context-window usage label
- Code / Debug tabs
- debug timeline
- runtime inspection of `LanguageModel.params()`

The app currently configures two LangChain tools:

```ts
const harness = new ChatHarness(model, [
  calculatorTool,
  wordCountTool,
]);
```

The UI should not own canonical model history or tool orchestration.

### `src/harness.ts`

`ChatHarness` is the tiny agent engine and owns canonical conversation state.

Responsibilities:

- store explicit `BaseMessage[]` history
- expose `run()` and `stream()`
- add dynamic tool instructions through `SystemMessage`
- inspect model output for tool requests
- route requests to a configured tool by name
- execute tools
- append intermediate `AIMessage` + `ToolMessage` state
- call the model again
- repeat until the model returns a normal answer
- stop after `MAX_TOOL_STEPS = 5`
- expose provider-neutral context usage
- emit debug events (`llm_start`, `llm_end`, `llm_error`, `tool_start`, `tool_end`)

Ownership model:

```text
LLM     = decides what should happen next
Harness = validates, orchestrates, and acts
Tool    = performs deterministic work
```

The current loop is intentionally explicit:

```text
workingMessages = history + user

while true:
  model response
    ↓
  tool request?
    ├─ no  → persist final response and return
    └─ yes → route tool by name
              ↓
            execute tool
              ↓
            append AI tool request + ToolMessage
              ↓
            repeat
```

`streamModel()` contains the repeated streaming/event/context plumbing so `stream()` can remain focused on the agent loop.

### `src/tools/`

Current deterministic tools:

```text
calculator
  a: number
  b: number
  operation: add | subtract | multiply | divide

word_count
  text: string
```

Files:

```text
src/tools/calculator.ts
src/tools/wordCount.ts
src/tools/protocol.ts
```

Tools are defined with LangChain's `tool()` helper and satisfy `StructuredToolInterface`.

Tool implementations know nothing about Chrome, the UI, conversation history, or agent orchestration.

### `src/tools/protocol.ts`

Chrome's Prompt API path used by this project does not provide native function calling, so the project uses a small explicit JSON protocol.

Nano is instructed to request one tool at a time:

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

After receiving a tool result, Nano may either request another tool or return the final answer.

`parseToolCall()` accepts raw JSON and an optional Markdown JSON fence because Nano may ignore the no-Markdown instruction.

This protocol is a learning-oriented bridge, not a general-purpose tool-calling standard.

### `src/adapters/ChromeLanguageModelAdapter/`

The adapter extends LangChain's `BaseChatModel`.

Responsibilities:

- translate LangChain messages into Chrome Prompt API messages
- create/destroy a fresh Chrome `LanguageModel` session per invocation
- expose availability
- implement `_generate()`
- implement `_streamResponseChunks()`
- merge the base prompt and dynamic LangChain system instructions into one first Chrome `system` prompt
- translate `ToolMessage` into a Chrome user message (`Tool result: ...`) because Chrome has no native tool role
- capture `contextUsage` / `contextWindow`
- expose that information through `ContextUsageProvider`

The adapter does **not** decide which tool to use or execute tools.

---

## Tool-loop streaming behavior

Every model stage may be either a hidden tool request or a user-visible answer.

The harness uses a two-stage decision:

```text
stream-time heuristic
→ does the beginning look like raw/fenced JSON?
→ if yes, buffer temporarily

parseToolCall()
→ after the model stage finishes, confirm whether it is a valid tool request
```

Normal prose streams to Vue immediately.

Possible tool JSON stays hidden from the normal chat UI. If parsing fails, the buffered response is released to the UI. If parsing succeeds, the tool runs and the loop continues.

The stream heuristic deliberately handles split Markdown fence chunks such as:

```text
chunk 1: `
chunk 2: ``json
```

so hidden tool requests are not leaked into the chat UI.

Important conceptual split:

```text
stream chunks = transient execution
AIMessage / ToolMessage = durable execution state
```

---

## Conversation state decision

The harness owns conversation history. Chrome sessions are stateless transports for one invocation.

```text
ChatHarness history = source of truth
Chrome session       = one-call transport
```

Every invocation creates a new Chrome session, sends explicit history, captures provider metadata, then destroys the session.

Do not casually switch to persistent Chrome sessions; doing so risks duplicating context because both the harness and provider session would remember prior turns.

---

## System prompt flow

The model receives one Chrome system message containing the conceptual combination of:

```text
Adapter base SYSTEM_PROMPT
+
Harness dynamic tool instructions
```

Chrome requires the `system` role message to be first, so multiple LangChain system messages must be merged before creating the session.

The normal conversation and intermediate execution state then follow as user/assistant messages translated by the adapter.

---

## Context usage

Provider-specific source:

```text
session.contextUsage
session.contextWindow
```

Flow:

```text
Chrome session
→ ChromeLanguageModelAdapter
→ ContextUsageProvider
→ ChatHarness.contextUsage()
→ Vue label
```

If unsupported, the capability returns `null`; the UI currently maps that to a `0% context` display fallback.

Do not confuse context-window occupancy with LangChain per-call token accounting.

---

## Debug UI

The Debug tab shows:

1. adapter system prompt
2. `LanguageModel.params()` when exposed
3. one fold per LLM call
4. input messages
5. final model output or error
6. tool args/result associated with the model call that requested the tool

With v4, a request may produce several folds:

```text
LLM Call #1
  tool: calculator

LLM Call #2
  tool: word_count

LLM Call #3
  final answer
```

Streaming chunks are intentionally not logged individually.

---

## Repository structure

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
    wordCount.ts
    protocol.ts
  App.vue
  harness.ts
  main.ts
  styles.css
```

---

## Tech stack

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

`npm run build` uses `vite build`; there is currently no `vue-tsc` build step.

---

## Git workflow

Every logical change should be committed separately.

If one logical change spans multiple files, commit those files atomically in one commit.

Default branch: `main`

Repository:

```text
kmilov/langchain-nano-lab
```

---

## Deployment

The repo is linked to Vercel. Pushes to `main` normally trigger production deployment.

Production alias:

```text
https://langchain-nano-lab.vercel.app
```

Normal flow:

```text
commit/push to main
→ GitHub
→ Vercel build
→ production
```

Do not create an extra manual deployment unless needed.

---

## Development style

This is a learning project. Prefer:

- small changes
- explicit state
- visible causal relationships
- first-principles explanations
- readable TypeScript
- minimal abstractions until repetition justifies them
- provider-neutral boundaries

Avoid:

- premature LangGraph/full-agent-framework adoption
- hiding the core model → tool → model loop
- giant refactors
- mixing UI state with canonical conversation state
- leaking Chrome-specific APIs into the harness

When adding a feature, ask: **what new agent concept is this version teaching?**
