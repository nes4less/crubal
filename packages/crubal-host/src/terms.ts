// terms.ts: a package's terms per audience (spec 12.5.1) turned into what crawlers and agents read: robots
// rules for the bots that train, a machine-readable terms file, and response headers. CRUBAL states the
// terms; the host turns them into these. Nothing here is a visibility decision: that stayed in the views.

export type Terms = { [audience: string]: { [use: string]: boolean } };

/** `search yes, answer yes, train no` → `{search: true, answer: true, train: false}`. */
export function readTerms(text: { [audience: string]: string }): Terms {
  const out: Terms = {};
  for (const [audience, line] of Object.entries(text)) {
    const uses: { [use: string]: boolean } = {};
    for (const piece of line.split(",")) {
      const [use, yn] = piece.trim().split(/\s+/);
      if (use) uses[use] = yn !== "no";
    }
    out[audience] = uses;
  }
  return out;
}

/** The user agents that fetch pages to train models, as they name themselves. */
export const TRAINING_BOTS = ["GPTBot", "ChatGPT-User", "CCBot", "Google-Extended", "anthropic-ai", "ClaudeBot", "Claude-Web", "Bytespider", "Applebot-Extended", "cohere-ai", "PerplexityBot", "Meta-ExternalAgent", "Amazonbot"];

/** robots.txt for an owner's public terms. */
export function robotsTxt(terms: Terms, prefix = "/"): string {
  const pub = terms.public ?? {};
  const lines: string[] = [];
  if (pub.search === false) {
    lines.push("User-agent: *", `Disallow: ${prefix}`, "");
  } else {
    if (pub.train === false) for (const bot of TRAINING_BOTS) lines.push(`User-agent: ${bot}`, `Disallow: ${prefix}`, "");
    lines.push("User-agent: *", "Allow: /", "");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

/** Response headers for a public page under these terms. */
export function termsHeaders(terms: Terms): { [header: string]: string } {
  const pub = terms.public ?? {};
  const robots: string[] = [];
  if (pub.search === false) robots.push("noindex");
  if (pub.answer === false) robots.push("nosnippet");
  if (pub.train === false) robots.push("noai", "noimageai");
  const out: { [header: string]: string } = {};
  if (robots.length) out["x-robots-tag"] = robots.join(", ");
  out["x-crubal-terms"] = Object.entries(pub).map(([u, ok]) => `${u}=${ok ? "yes" : "no"}`).join("; ") || "search=yes; answer=yes; train=yes";
  return out;
}

/** The machine-readable terms file, by audience. */
export function termsJson(owner: string, terms: Terms): { [k: string]: unknown } {
  return { crubal: "2", owner, terms: Object.keys(terms).length ? terms : { public: { search: true, answer: true, train: true } } };
}
