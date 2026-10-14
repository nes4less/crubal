// Routing middleware for crubal.com: counts AI crawlers. Web Analytics leaves bots out on purpose, so
// each request from a known AI crawler is recorded as a server-side custom event ("ai_crawler") instead.
// It never changes the response, and the event is sent after the response, so pages aren't slowed.

import { track } from "@vercel/analytics/server";
import { waitUntil } from "@vercel/functions";

// User-agent token → who runs it. Training crawlers and answer-time fetchers are both listed.
const BOTS = [
  ["GPTBot", "OpenAI"], ["OAI-SearchBot", "OpenAI"], ["ChatGPT-User", "OpenAI"],
  ["ClaudeBot", "Anthropic"], ["Claude-User", "Anthropic"], ["Claude-SearchBot", "Anthropic"], ["anthropic-ai", "Anthropic"],
  ["PerplexityBot", "Perplexity"], ["Perplexity-User", "Perplexity"],
  ["Google-Extended", "Google"], ["Google-CloudVertexBot", "Google"],
  ["Applebot-Extended", "Apple"], ["Bytespider", "ByteDance"], ["CCBot", "Common Crawl"],
  ["meta-externalagent", "Meta"], ["Amazonbot", "Amazon"], ["cohere-ai", "Cohere"], ["DuckAssistBot", "DuckDuckGo"],
  ["MistralAI-User", "Mistral"], ["YouBot", "You.com"],
];

export const config = { matcher: ["/((?!_vercel|brand/|play/play\\.js|site\\.css|og\\.png).*)"] };

export default function middleware(request) {
  const ua = request.headers.get("user-agent") ?? "";
  const hit = BOTS.find(([token]) => ua.includes(token));
  if (hit) {
    const path = new URL(request.url).pathname;
    waitUntil(track("ai_crawler", { bot: hit[0], operator: hit[1], path }, { headers: request.headers }).catch(() => {}));
  }
}
