# mastra-provider-tool-bail-repro

Minimal reproduction for two bugs in `@mastra/core` when **provider-executed tools** (e.g. Anthropic's `web_search_20250305`) are called in parallel with regular tools.

## The Bugs

### Bug 1: Stream bail

When a provider-executed tool runs alongside a `createTool` in the same step, the agentic loop terminates after one step with zero tool results.

**Root cause:** `toolCallStep` returns `result: inputData.output` which is `undefined` for provider-executed tools (the `output` field is not carried through the transform). `llmExecutionMappingStep` sees `hasUndefinedResult = true` and calls `bail()`, terminating the entire stream.

**Symptom:** Two `tool-call` chunks, zero `tool-result` chunks. Process exits immediately.

### Bug 2: Web search results not delivered

Even after the bail fix, the model re-calls `web_search` in step 2 because the deferred search results are lost.

**Root cause:** The `sanitizeMessages` filter strips `server_tool_use` content blocks from assistant messages. When the Anthropic API defers a web search (parallel call), it returns a `server_tool_use` block that represents the deferred execution. Stripping this block means the continuation request is missing context, so the model thinks the search never happened and retries it.

**Symptom:** `web_search` appears in step 2 tool-calls even though it was already called in step 1.

## Reproduce

```bash
git clone https://github.com/kaikloepfer/mastra-provider-tool-bail-repro.git
cd mastra-provider-tool-bail-repro
npm install   # or pnpm install

# Set your API key
export ANTHROPIC_API_KEY=sk-ant-...

# Run the reproduction
npx tsx src/index.ts
```

### Expected (after both fixes)

```
Step 1:
  tool-calls:   [web_search_20250305, get_company_info]
  tool-result:  get_company_info (providerExecuted=undefined): ...
  tool-result:  web_search_20250305 (providerExecuted=true): ...

Step 2:
  (text generation only)

PASS [Bug 1] Stream completed: 2 tool-result chunk(s)
PASS [Bug 2] web_search not re-called (deferred search results preserved)
```

### Actual (before fixes)

Bug 1 manifests as:
```
Step 1:
  tool-calls:   [web_search_20250305, get_company_info]
  (no tool-results — stream bailed)

FAIL [Bug 1] Stream bailed: 0 tool-result chunks received
```

Bug 2 manifests as (with bail fix applied, but not sanitization fix):
```
Step 1:
  tool-calls:   [web_search_20250305, get_company_info]
  tool-result:  ...

Step 2:
  tool-calls:   [web_search_20250305]   <-- model retries search
  tool-result:  ...

FAIL [Bug 2] web_search re-called in step(s) 2
```

## Versions

- `@mastra/core`: ^1.4.0
- `@ai-sdk/anthropic`: ^3.0.0
- Node: 20+
