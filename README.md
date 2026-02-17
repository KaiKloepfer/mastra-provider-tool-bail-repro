# mastra-provider-tool-bail-repro

Minimal reproduction for a bug in `@mastra/core` where **provider-executed tools** (e.g. Anthropic's `web_search_20250305`) cause the agent stream to bail when called in parallel with regular tools.

## The Bug

When an Anthropic server-executed tool (`providerExecuted: true`) runs alongside a `createTool` in the same step, the stream terminates after 1 step with **zero tool results**. All successful tool results — including those from other tools that completed normally — are dropped.

## Root Cause

1. `transform.ts` drops the `output` field when converting AI SDK `tool-call` chunks to Mastra's internal format
2. `toolCallStep` returns `result: inputData.output` which is `undefined` for the provider-executed tool
3. `llmExecutionMappingStep` sees `hasUndefinedResult = true` and calls `bail()`, terminating the entire stream

## Reproduce

```bash
# Requires Node 20+, pnpm
git clone https://github.com/kaikloepfer/mastra-provider-tool-bail-repro.git
cd mastra-provider-tool-bail-repro
pnpm install
ANTHROPIC_API_KEY=sk-ant-... npx tsx src/index.ts
```

### Expected

Stream completes with `tool-result` chunks for both tools, then an assistant text response.

### Actual

```
chunk types: {
  start: 1,
  'step-start': 1,
  'tool-call-input-streaming-start': 2,
  'tool-call-delta': 4,
  'tool-call-input-streaming-end': 2,
  'tool-call': 2,
  'step-finish': 1,
  finish: 1
}
FAIL — 0 tool results (stream bailed)
```

Two `tool-call` chunks (model called both tools), zero `tool-result` chunks. Process exits with code 1.

## Versions

- `@mastra/core`: ^1.4.0
- `@ai-sdk/anthropic`: ^3.0.0
- Node: 20+
