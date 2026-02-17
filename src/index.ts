/**
 * Minimal reproduction: Provider-executed tool parallel call bugs in @mastra/core
 *
 * This reproduces two bugs when Anthropic's web_search_20250305 (a provider-executed
 * tool) is called in parallel with a regular createTool:
 *
 * Bug 1 — Stream bail: The agentic loop terminates prematurely because
 *   toolCallStep returns undefined for provider-executed tools, causing
 *   llmExecutionMappingStep to bail the entire stream.
 *
 * Bug 2 — Web search results lost: Even after the bail fix, the model re-calls
 *   web_search in step 2 because the sanitization filter strips server_tool_use
 *   content blocks from the assistant message, so the API never sees the deferred
 *   search results.
 *
 * Requires: ANTHROPIC_API_KEY env var
 * Run: npx tsx src/index.ts
 */
import { Agent } from "@mastra/core/agent";
import { createTool } from "@mastra/core/tools";
import { anthropic } from "@ai-sdk/anthropic";
import { z } from "zod";

const agent = new Agent({
  id: "repro",
  name: "repro",
  model: anthropic("claude-sonnet-4-5-20250929"),
  instructions:
    "ALWAYS call BOTH web_search_20250305 AND get_company_info in parallel. " +
    "After getting results, write a response that includes SPECIFIC FACTS from the web search.",
  tools: {
    web_search_20250305: anthropic.tools.webSearch_20250305({ maxUses: 3 }),
    get_company_info: createTool({
      id: "get_company_info",
      description: "Get basic info about a company",
      inputSchema: z.object({ companyName: z.string() }),
      execute: async ({ companyName }) => ({
        name: companyName,
        founded: 2021,
        hq: "San Francisco, CA",
      }),
    }),
  },
});


const response = await agent.stream(
  "Tell me about Anthropic. Use both tools in parallel. Include specific facts from the web search.",
  { maxSteps: 5 },
);

let currentStep = 0;
let fullText = "";
const toolCallsByStep = new Map<number, string[]>();
const toolResultsByStep = new Map<number, string[]>();

for await (const chunk of response.fullStream) {
  const c = chunk as { type: string; payload?: Record<string, unknown> };

  if (c.type === "step-start") {
    currentStep++;
    toolCallsByStep.set(currentStep, []);
    toolResultsByStep.set(currentStep, []);
  }

  if (c.type === "tool-call") {
    const p = c.payload as { toolName?: string };
    toolCallsByStep.get(currentStep)?.push(p?.toolName ?? "unknown");
  }

  if (c.type === "tool-result") {
    const p = c.payload as {
      toolName?: string;
      providerExecuted?: boolean;
      result?: unknown;
    };
    const preview = JSON.stringify(p?.result)?.slice(0, 150) ?? "";
    toolResultsByStep
      .get(currentStep)
      ?.push(
        `${p?.toolName} (providerExecuted=${p?.providerExecuted}): ${preview}`,
      );
  }

  if (c.type === "text-delta") {
    fullText += (c.payload as { text?: string })?.text ?? "";
  }
}


console.log(`\n=== Provider-Executed Tool Parallel Call Reproduction ===`);
console.log(`Total steps: ${currentStep}`);

for (let step = 1; step <= currentStep; step++) {
  const calls = toolCallsByStep.get(step) ?? [];
  const results = toolResultsByStep.get(step) ?? [];
  console.log(`\nStep ${step}:`);
  console.log(`  tool-calls:   [${calls.join(", ")}]`);
  for (const r of results) {
    console.log(`  tool-result:  ${r}`);
  }
  if (!calls.length && !results.length) {
    console.log(`  (text generation only)`);
  }
}

console.log(`\nText length: ${fullText.length} chars`);
console.log(`Text preview: ${fullText.slice(0, 400)}`);


console.log("\n--- Checks ---");
let failed = false;

const totalToolResults = Array.from(toolResultsByStep.values()).flat().length;
if (totalToolResults === 0) {
  console.log("FAIL [Bug 1] Stream bailed: 0 tool-result chunks received");
  failed = true;
} else {
  console.log(`PASS [Bug 1] Stream completed: ${totalToolResults} tool-result chunk(s)`);
}

const webSearchRecalls: number[] = [];
for (let step = 2; step <= currentStep; step++) {
  const calls = toolCallsByStep.get(step) ?? [];
  if (calls.some((name) => name.includes("web_search"))) {
    webSearchRecalls.push(step);
  }
}
if (webSearchRecalls.length > 0) {
  console.log(
    `FAIL [Bug 2] web_search re-called in step(s) ${webSearchRecalls.join(", ")} ` +
      `(deferred search results were lost, model had to retry)`,
  );
  failed = true;
} else if (totalToolResults > 0) {
  console.log("PASS [Bug 2] web_search not re-called (deferred search results preserved)");
}

process.exit(failed ? 1 : 0);
