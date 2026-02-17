/**
 * Minimal repro: Provider-executed tool bail bug in @mastra/core
 *
 * When Anthropic's web_search (providerExecuted: true) runs in parallel
 * with a createTool, the stream bails with 0 tool results.
 *
 * Requires: ANTHROPIC_API_KEY env var
 *
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
    "ALWAYS call BOTH web_search_20250305 AND get_company_info in parallel.",
  tools: {
    web_search_20250305: anthropic.tools.webSearch_20250305({ maxUses: 3 }),
    get_company_info: createTool({
      id: "get_company_info",
      description: "Get basic info about a company",
      inputSchema: z.object({ companyName: z.string() }),
      execute: async ({ companyName }) => ({ name: companyName, founded: 2020 }),
    }),
  },
});

const response = await agent.stream(
  "Tell me about Anthropic. Use both tools in parallel.",
  { maxSteps: 5 },
);

const types: Record<string, number> = {};
for await (const chunk of response.fullStream) {
  types[(chunk as { type: string }).type] = (types[(chunk as { type: string }).type] || 0) + 1;
}

const toolResults = types["tool-result"] ?? 0;
console.log("chunk types:", types);
console.log(toolResults > 0
  ? "PASS — tool results received"
  : "FAIL — 0 tool results (stream bailed)");
process.exit(toolResults > 0 ? 0 : 1);
