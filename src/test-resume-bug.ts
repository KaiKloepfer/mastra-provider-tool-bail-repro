/**
 * Integration test: Provider-executed tool results not persisted → resume fails
 *
 * RED test — should FAIL against current @mastra/core (linked from ../mastra).
 *
 * Requires: ANTHROPIC_API_KEY env var
 * Run: npx tsx src/test-resume-bug.ts
 */
import { Agent } from "@mastra/core/agent";
import { createTool } from "@mastra/core/tools";
import { anthropic } from "@ai-sdk/anthropic";
import { z } from "zod";

const agent = new Agent({
  id: "resume-test",
  name: "resume-test",
  model: anthropic("claude-sonnet-4-5-20250929"),
  instructions:
    "ALWAYS call BOTH web_search_20250305 AND get_company_info in parallel on the first message. " +
    "After getting results, write a brief response with facts from the search.",
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

interface TestResult {
  name: string;
  pass: boolean;
  detail: string;
}

const results: TestResult[] = [];

function assert(name: string, pass: boolean, detail: string) {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} ${name}: ${detail}`);
}


console.log(
  "=== Step 1: Run agent (triggers web_search + get_company_info in parallel) ===\n",
);

const response = await agent.stream(
  "Tell me about Anthropic. Use both tools in parallel.",
  { maxSteps: 5 },
);

let fullText = "";
let currentStep = 0;
const toolCallsByStep = new Map<number, string[]>();

for await (const chunk of response.fullStream) {
  const c = chunk as { type: string; payload?: Record<string, unknown> };

  if (c.type === "step-start") {
    currentStep++;
    toolCallsByStep.set(currentStep, []);
  }

  if (c.type === "tool-call") {
    const p = c.payload as { toolName?: string };
    toolCallsByStep.get(currentStep)?.push(p?.toolName ?? "unknown");
  }

  if (c.type === "text-delta") {
    fullText += (c.payload as { text?: string })?.text ?? "";
  }
}

console.log(
  `\nCompleted in ${currentStep} step(s), text length: ${fullText.length}`,
);
assert(
  "stream-completes",
  currentStep >= 1 && fullText.length > 0,
  `${currentStep} steps, ${fullText.length} chars`,
);


console.log("\n=== Step 2: Inspect DB messages for tool invocation state ===\n");

const dbMessages = response.messageList.get.all.db();

console.log(`Total DB messages: ${dbMessages.length}`);
for (const msg of dbMessages) {
  console.log(`\n  [${msg.role}] id=${msg.id}`);
  if (!Array.isArray(msg.content?.parts)) {
    console.log(`    content: ${JSON.stringify(msg.content)?.slice(0, 200)}`);
    continue;
  }
  for (const [i, part] of msg.content.parts.entries()) {
    const p = part as Record<string, unknown>;
    if (p.type === "tool-invocation") {
      const inv = p.toolInvocation as Record<string, unknown>;
      console.log(
        `    part[${i}]: tool-invocation ` +
          `toolName=${inv?.toolName} state=${inv?.state} ` +
          `providerExecuted=${p.providerExecuted} ` +
          `hasResult=${inv?.result != null}`,
      );
      const partKeys = Object.keys(p);
      console.log(`      part keys: [${partKeys.join(", ")}]`);
    } else if (p.type === "source") {
      console.log(`    part[${i}]: source`);
    } else if (p.type === "text") {
      const text = (p.text as string) ?? "";
      console.log(`    part[${i}]: text (${text.length} chars)`);
    } else if (p.type === "reasoning") {
      console.log(`    part[${i}]: reasoning`);
    } else if (p.type === "step-start") {
      console.log(`    part[${i}]: step-start`);
    } else {
      console.log(`    part[${i}]: ${p.type}`);
    }
  }
}

let foundProviderExecutedCall = false;
let providerExecutedState = "not found";
let providerExecutedHasResult = false;
let providerExecutedToolCallId = "";

for (const msg of dbMessages) {
  if (msg.role !== "assistant") continue;
  if (!Array.isArray(msg.content?.parts)) continue;

  for (const part of msg.content.parts) {
    if (part.type !== "tool-invocation") continue;
    const p = part as Record<string, unknown>;
    const inv = p.toolInvocation as Record<string, unknown>;

    const isProviderExecuted = p.providerExecuted === true;
    const toolName = String(inv?.toolName ?? "");
    const isWebSearch = toolName.includes("web_search");

    if (isProviderExecuted || isWebSearch) {
      foundProviderExecutedCall = true;
      providerExecutedState = String(inv?.state);
      providerExecutedHasResult = inv?.state === "result" && inv?.result != null;
      providerExecutedToolCallId = String(inv?.toolCallId);
      console.log(`\n  >>> Found web_search tool:`);
      console.log(`      providerExecuted flag: ${p.providerExecuted}`);
      console.log(`      state: ${inv?.state}`);
      console.log(`      hasResult: ${inv?.result != null}`);
      console.log(
        `      result preview: ${JSON.stringify(inv?.result)?.slice(0, 200)}`,
      );
    }
  }
}

assert(
  "provider-executed-tool-found",
  foundProviderExecutedCall,
  foundProviderExecutedCall
    ? `Found provider-executed tool (${providerExecutedToolCallId})`
    : "No provider-executed/web_search tool found in messageList",
);

assert(
  "provider-executed-tool-has-result",
  providerExecutedHasResult,
  `State: "${providerExecutedState}", hasResult: ${providerExecutedHasResult}`,
);


console.log("\n=== Step 3: Simulate resume (send follow-up message) ===\n");

const uiMessages = response.messageList.get.all.aiV5.ui();

console.log(`  UI message history: ${uiMessages.length} messages`);
for (const msg of uiMessages) {
  const toolParts = msg.parts.filter(
    (p) => typeof p.type === "string" && p.type.startsWith("tool-"),
  );
  if (toolParts.length > 0) {
    console.log(`    ${msg.role}: ${toolParts.length} tool part(s)`);
    for (const tp of toolParts) {
      const t = tp as Record<string, unknown>;
      console.log(
        `      ${String(t.type)} state=${String(t.state)} providerExecuted=${t.providerExecuted}`,
      );
    }
  }
}

const resumeAgent = new Agent({
  id: "resume-test-2",
  name: "resume-test-2",
  model: anthropic("claude-sonnet-4-5-20250929"),
  instructions:
    "Answer the user's follow-up question using context from the conversation.",
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

let resumeError: Error | null = null;
let resumeText = "";

try {
  const resumeResponse = await resumeAgent.stream(
    [
      ...uiMessages,
      {
        id: "follow-up",
        role: "user" as const,
        parts: [
          {
            type: "text" as const,
            text: "What year was Anthropic founded?",
          },
        ],
      },
    ],
    { maxSteps: 3 },
  );

  for await (const chunk of resumeResponse.fullStream) {
    const c = chunk as { type: string; payload?: Record<string, unknown> };
    if (c.type === "text-delta") {
      resumeText += (c.payload as { text?: string })?.text ?? "";
    }
  }
} catch (err) {
  resumeError = err as Error;
}

assert(
  "resume-no-error",
  resumeError === null,
  resumeError
    ? `Resume failed: ${resumeError.message.slice(0, 300)}`
    : `Resume succeeded, ${resumeText.length} chars`,
);

assert(
  "resume-has-text",
  resumeText.length > 0,
  `Resume text length: ${resumeText.length}`,
);


console.log("\n=== Summary ===\n");
const passed = results.filter((r) => r.pass).length;
const failed = results.filter((r) => !r.pass).length;
console.log(
  `${passed} passed, ${failed} failed out of ${results.length} tests`,
);

if (failed > 0) {
  console.log("\nFailed tests:");
  for (const r of results.filter((r) => !r.pass)) {
    console.log(`  - ${r.name}: ${r.detail}`);
  }
}

process.exit(failed > 0 ? 1 : 0);
