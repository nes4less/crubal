// Builds crubal.com from the repo: the spec (one page per chapter), the corpus index, the playground and
// the home page. Everything is generated from spec/ and corpus/, so the site can't drift from them.

import { build as bundle } from "esbuild";
import { marked } from "marked";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { readTree } from "../packages/crubal/src/tree.ts";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const out = join(here, "dist");
const REPO = "https://github.com/nes4less/crubal";
const ORIGIN = "https://crubal.com";
const RAW = "https://raw.githubusercontent.com/nes4less/crubal/main";
const STEWARD = { "@type": "Organization", name: "Infinite Token", description: "A development company. We design and build software." };
const pages = [];

// Headings get ids and a link mark, so a section like 6.3 can be linked to.
const slugify = (t) => t.toLowerCase().replace(/<[^>]+>/g, "").replace(/&[a-z]+;/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
marked.use({
  renderer: {
    heading({ tokens, depth }) {
      const text = this.parser.parseInline(tokens);
      const id = slugify(text);
      return depth === 1 ? `<h1 id="${id}">${text}</h1>\n` : `<h${depth} id="${id}">${text} <a class="anchor" href="#${id}" aria-label="Link to this section">#</a></h${depth}>\n`;
    },
  },
});

/** A description from a page's own opening: its first real paragraph, trimmed. */
function describe(md) {
  const para = md.split(/\n{2,}/).map((p) => p.trim()).find((p) => p && !/^(#|\||```|-|\*\*Status)/.test(p)) ?? "";
  const plain = para.replace(/`([^`]*)`/g, "$1").replace(/\*\*([^*]+)\*\*/g, "$1").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/\s+/g, " ");
  return plain.length > 158 ? `${plain.slice(0, 155).replace(/\s+\S*$/, "")}…` : plain;
}
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const NAV = [
  ["/", "Home"],
  ["/spec/", "Spec"],
  ["/registry/", "Packages"],
  ["/corpus/", "Corpus"],
  ["/play/", "Playground"],
  [REPO, "GitHub"],
];

function page(path, title, body, description = "CRUBAL: a language and engine for data about any kind of thing.", ld = null) {
  const url = `${ORIGIN}${path}`;
  if (!path.startsWith("/404")) pages.push(url);
  const jsonld = ld ? `<script type="application/ld+json">${JSON.stringify(ld).replace(/</g, "\\u003c")}</script>` : "";
  const nav = NAV.map(([href, label]) => `<a href="${href}"${href !== "/" && path.startsWith(href) ? ' aria-current="page"' : path === href ? ' aria-current="page"' : ""}>${label}</a>`).join("");
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${url}">
<meta property="og:type" content="${path === "/" ? "website" : "article"}">
<meta property="og:site_name" content="CRUBAL">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${url}">
<meta property="og:image" content="${ORIGIN}/og.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(description)}">
<meta name="twitter:image" content="${ORIGIN}/og.png">
<meta name="theme-color" content="#f6f7f9" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#0e131a" media="(prefers-color-scheme: dark)">
<link rel="alternate" type="text/plain" href="/llms.txt" title="llms.txt">${jsonld}
<script>window.va = window.va || function () { (window.vaq = window.vaq || []).push(arguments); };</script>
<script defer src="/_vercel/insights/script.js"></script>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600&family=Instrument+Sans:wght@500;600&family=Public+Sans:wght@400;600;700&family=Source+Serif+4:opsz,wght@8..60,600;8..60,700&display=swap">
<link rel="stylesheet" href="/site.css">
</head>
<body>
<header class="site"><div class="wrap"><a class="brand" href="/">CRUBAL</a><nav class="top">${nav}</nav></div></header>
<main><div class="wrap">${body}</div></main>
<footer class="site"><div class="wrap foot">
  <div class="steward"><span class="it-mark" aria-hidden="true"></span><span class="it-line">A project of <strong>Infinite Token</strong>, development company</span></div>
  <div>CRUBAL 2, working draft. Spec and corpus CC-BY-4.0; code Apache-2.0. <a href="${REPO}">Source</a>.</div>
</div></footer>
</body>
</html>
`;
  const file = join(out, path, path.endsWith("/") ? "index.html" : "");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, html);
}

// ─── The spec ────────────────────────────────────────────────────────────────

const chapters = readdirSync(join(root, "spec"))
  .filter((f) => /^\d\d-.*\.md$/.test(f))
  .sort()
  .map((f) => {
    const md = readFileSync(join(root, "spec", f), "utf8");
    const title = md.match(/^# (.+)$/m)?.[1] ?? f;
    return { file: f, slug: f.replace(/\.md$/, ""), title, md };
  });

function links(html) {
  return html
    .replace(/href="(\d\d-[\w-]+)\.md(#[^"]*)?"/g, (_, slug, hash = "") => `href="/spec/${slug}/${hash}"`)
    .replace(/href="\.\.\/corpus\/README\.md"/g, 'href="/corpus/"')
    .replace(/href="corpus\/README\.md"/g, 'href="/corpus/"');
}

const toc = (current) =>
  `<nav class="toc" aria-label="Chapters"><ol><li><a href="/spec/"${current === "" ? ' aria-current="page"' : ""}>Overview</a></li>${chapters
    .map((c) => `<li><a href="/spec/${c.slug}/"${current === c.slug ? ' aria-current="page"' : ""}>${esc(c.title)}</a></li>`)
    .join("")}</ol></nav>`;

const specReadme = readFileSync(join(root, "spec", "README.md"), "utf8");
const specLd = (name, description, path) => ({
  "@context": "https://schema.org",
  "@type": "TechArticle",
  headline: name,
  description,
  url: `${ORIGIN}${path}`,
  isPartOf: { "@type": "CreativeWork", name: "CRUBAL 2: the specification", url: `${ORIGIN}/spec/` },
  license: "https://creativecommons.org/licenses/by/4.0/",
  publisher: STEWARD,
  inLanguage: "en",
});
const specDesc = "The CRUBAL 2 specification: data and values, the text and JSON forms, facets, classes, rules, contracts, provenance, intake, migrations, packages, views and conformance.";
page("/spec/", "CRUBAL 2: the specification", `<div class="layout">${toc("")}<article class="prose">${links(marked.parse(specReadme))}</article></div>`, specDesc, specLd("CRUBAL 2: the specification", specDesc, "/spec/"));
for (const c of chapters) {
  const d = describe(c.md);
  page(
    `/spec/${c.slug}/`,
    `${c.title.replace(/^\d+\.\s*/, "")} · CRUBAL 2 spec, chapter ${Number(c.slug.slice(0, 2))}`,
    `<div class="layout">${toc(c.slug)}<article class="prose">${links(marked.parse(c.md))}<p><a href="${REPO}/blob/main/spec/${c.file}">Edit on GitHub</a> · <a href="${RAW}/spec/${c.file}">Markdown</a></p></article></div>`,
    d,
    specLd(c.title, d, `/spec/${c.slug}/`),
  );
}

// ─── The corpus ──────────────────────────────────────────────────────────────

const corpusDir = join(root, "corpus");
const folders = readdirSync(corpusDir).filter((f) => statSync(join(corpusDir, f)).isDirectory() && f !== "tools").sort();
const order = ["reader", "dictionary", "rules", "store", "exchange", "views", "package"];
folders.sort((a, b) => order.indexOf(a.split("-")[0]) - order.indexOf(b.split("-")[0]) || a.localeCompare(b));
const rows = folders
  .map((f) => {
    const cases = readdirSync(join(corpusDir, f)).filter((c) => !c.startsWith("_") && statSync(join(corpusDir, f, c)).isDirectory());
    const items = cases.map((c) => `<a href="${REPO}/tree/main/corpus/${f}/${c}"><code>${esc(c)}</code></a>`).join(" ");
    return `<tr><td><code>${f}/</code></td><td>${cases.length}</td><td>${items}</td></tr>`;
  })
  .join("");
const total = folders.reduce((n, f) => n + readdirSync(join(corpusDir, f)).filter((c) => !c.startsWith("_") && statSync(join(corpusDir, f, c)).isDirectory()).length, 0);
page(
  "/corpus/",
  "The CRUBAL conformance test corpus",
  `<article class="prose" style="max-width:none"><h1>The test corpus</h1><p class="lede">${total} cases. A conformance claim is proven by passing a level's folders; the corpus is part of the spec.</p>
<table><thead><tr><th>Folder</th><th>Cases</th><th>Cases</th></tr></thead><tbody>${rows}</tbody></table>
${links(marked.parse(readFileSync(join(corpusDir, "README.md"), "utf8")).replace(/<h1[^>]*>.*?<\/h1>/, ""))}</article>`,
  `${total} conformance cases for CRUBAL implementations, level by level: Reader, Dictionary, Rules, Store, Exchange and Views.`,
);

// ─── The playground ──────────────────────────────────────────────────────────

await bundle({ entryPoints: [join(here, "play.ts")], bundle: true, format: "esm", minify: true, outfile: join(out, "play", "play.js"), target: "es2022" });
page(
  "/play/",
  "CRUBAL playground",
  `<h1>Playground</h1>
<p class="lede">The reference engine, running in your browser. Change the definitions or the data; the output follows as you type.</p>
<div class="play">
  <div><label for="defs">Definitions</label><textarea id="defs" spellcheck="false"></textarea>
       <label for="data" style="margin-top:14px">Data</label><textarea id="data" spellcheck="false"></textarea></div>
  <div><div class="tabs" role="group" aria-label="Output">
         <button type="button" data-mode="json" aria-pressed="true">JSON</button>
         <button type="button" data-mode="text" aria-pressed="false">Canonical text</button>
         <button type="button" data-mode="check" aria-pressed="false">Checks</button></div>
       <pre id="out" aria-live="polite"></pre></div>
</div>
<p>Aliases fold (<code>name</code> → <code>title</code>, <code>dvd video</code> → <code>DVD</code>), accepted units convert (<code>1.6h</code> → <code>96min</code>), and the checks show what the Dictionary level says about each value.</p>
<script type="module" src="/play/play.js"></script>`,
  "Try CRUBAL in your browser: write facet definitions and data, and see the JSON form, the canonical text and every value check, as you type.",
);

// ─── Home ────────────────────────────────────────────────────────────────────

const example = `product: P-1 [origin: declared, via: L-1]
  crubal:wears: OpticalDisc
  title: National Lampoon's Christmas Vacation
  format: DVD
  runtime: 97min [origin: observed, via: L-7]
  videoCodec: _
  hdrFormats: -
  genres: Comedy, Holiday

unit: U-1 of P-1
  condition: VG
  price: 12.50USD`;

page(
  "/",
  "CRUBAL: a language and engine for data about any kind of thing",
  `<h1>CRUBAL</h1>
<p class="lede">A language and engine for data about any kind of thing. Everything is a key and a value: records are pairs, a facet's definition is pairs about a key, and rules, contracts, views and packages are pairs too.</p>
<pre><code>${esc(example)}</code></pre>
<div class="cards">
  <div class="card"><h3>Facets</h3><p>What a key means: type, how many values, choices, units, other names, version.</p></div>
  <div class="card"><h3>Rules</h3><p>What must, should or probably is true, and what follows. Pure: they decide, never act.</p></div>
  <div class="card"><h3>Provenance</h3><p>Every value carries where it came from, in hash-linked, signed logs. No global ledger.</p></div>
  <div class="card"><h3>Contracts</h3><p>The borders where values cross: systems, people, other owners. Ten systems need ten maps.</p></div>
</div>
<h2>Conformance</h2>
<p>An implementation claims a level, and proves it by passing that level's folders of the <a href="/corpus/">test corpus</a>. The reference implementation passes all of them.</p>
<ol class="levels">
  <li><strong>Reader</strong>: the text and JSON forms, both ways, without losing a pair.</li>
  <li><strong>Dictionary</strong>: facets and classes, aliases, value checks.</li>
  <li><strong>Rules</strong>: strengths, fills and derivations, contradiction checks.</li>
  <li><strong>Store</strong>: sources and signed logs, intake with raw bytes, migrations.</li>
  <li><strong>Exchange</strong>: contracts, offer and take, signatures across owners.</li>
  <li><strong>Views</strong>: shapes, filters, audiences and roles, stored projections.</li>
</ol>
<h2>Use it</h2>
<pre><code>npm install @cruba/crubal</code></pre>
<p>Read the <a href="/spec/">specification</a>, try the <a href="/play/">playground</a>, or read the <a href="${REPO}">source</a>. <span class="pill">Working draft</span></p>
<h2>Who's behind it</h2>
<p>CRUBAL is an open specification, stewarded by <strong>Infinite Token</strong>, a development company. The spec, the corpus and the reference implementation are open to anyone to read, implement and build on.</p>`,
  "CRUBAL is an open language and engine for data about any kind of thing: facets, rules, provenance and contracts, with a conformance test corpus and a reference implementation.",
  {
    "@context": "https://schema.org",
    "@graph": [
      { "@type": "WebSite", name: "CRUBAL", url: `${ORIGIN}/`, publisher: STEWARD },
      {
        "@type": "SoftwareSourceCode",
        name: "@cruba/crubal",
        description: "The CRUBAL reference implementation: read, print, check and run CRUBAL.",
        codeRepository: REPO,
        programmingLanguage: "TypeScript",
        license: "https://www.apache.org/licenses/LICENSE-2.0",
        author: STEWARD,
      },
    ],
  },
);

page("/404/", "Not found · CRUBAL", `<h1>Not found</h1><p>That page doesn't exist. Try the <a href="/spec/">spec</a> or the <a href="/">home page</a>.</p>`);
cpSync(join(here, "static"), out, { recursive: true });
if (existsSync(join(out, "404", "index.html"))) cpSync(join(out, "404", "index.html"), join(out, "404.html"));
// ─── Standard packages, the registry and the well-known file (chapter 11.7) ──

const crubal = await import(join(root, "packages", "crubal", "src", "index.ts"));
// crubal.com's signing key (8.5, 11.7): the public half here and in the well-known file; the private half only in the build's environment.
const SIGNING_PUBLIC = "ZdAEPbw_CMLYZIjYM-xXBRF2tSu0Wb5aO76ebEqi4Do";
const STD = ["core", "units", "party"];
const stdPackages = [];


const facetSummary = (f) => {
  if (f.type === "choice") return `${(f.values ?? []).slice(0, 8).map((v) => v.value).join(", ")}${(f.values ?? []).length > 8 ? ", …" : ""}${f.open ? " (open)" : f.fixed ? " (fixed)" : ""}`;
  if (f.type === "number") return f.unit ? `unit ${f.unit}${f.accepts.length ? `, accepts ${f.accepts.join(", ")}` : ""}` : "";
  if (f.type === "date") return f.precision && f.precision !== "any" ? `${f.precision} precision` : "any precision";
  if (f.type === "link") return f.to ? `to ${f.to}` : "";
  if (f.type === "compound") return `${[...(f.children ?? new Map()).keys()].join(", ")}${f.identity ? `; rows by ${f.identity}` : ""}`;
  if (f.type === "text") return f.length ? `up to ${f.length} characters` : "";
  return "";
};

for (const name of STD) {
  const dir = join(root, "std", name);
  const src = readFileSync(join(dir, "package.crubal"), "utf8");
  const [info] = crubal.readPackages(src);
  const dict = crubal.readDefinitions(src);
  const rules = crubal.readRules(src);
  const facets = [...dict.facets.values()].filter((f) => !f.key.startsWith("crubal:"));
  const recordsFile = readdirSync(dir).find((f) => f !== "package.crubal" && f.endsWith(".crubal"));
  const records = recordsFile ? crubal.readText(readFileSync(join(dir, recordsFile), "utf8"), dict).records : [];
  const id = `${info.owner}/${info.name}`;
  const kinds = [...new Set(dict.levels.values())].map((k) => ({ kind: k, levels: [...dict.levels].filter(([, kk]) => kk === k).map(([l]) => l) }));
  const head = readTree(src).find((n) => n.key === "package");
  const label = head?.children.find((c) => c.key === "label")?.value ?? info.name;
  const intro = src.split("\n").filter((l) => l.startsWith("//")).map((l) => l.replace(/^\/\/\s?/, "")).join(" ");
  // The bundle as docs/design/publishing.md defines it: every member in its JSON form, the members list, the
  // reference records, the hash, and the signature when the publisher's key is in the environment.
  const key = process.env.CRUBAL_SIGNING_KEY ? { d: process.env.CRUBAL_SIGNING_KEY, x: SIGNING_PUBLIC } : undefined;
  const { bundle } = crubal.publish(src, { date: info.version.split(".")[0], ...(records.length ? { records } : {}), ...(key ? { key } : {}) });
  bundle.version = info.version;
  if (!key) console.warn(`  ${name}: unsigned (CRUBAL_SIGNING_KEY not set)`);
  for (const at of [`/${name}/`, `/${name}/${info.version}/`]) {
    mkdirSync(join(out, at), { recursive: true });
    writeFileSync(join(out, at, "package.crubal"), src);
    writeFileSync(join(out, at, "package.json"), `${JSON.stringify(bundle, null, 2)}\n`);
  }
  stdPackages.push({ name, id, version: info.version, label, intro, facets: facets.length, classes: dict.classes.size });

  const row = (cells) => `<tr>${cells.map((c) => `<td>${c}</td>`).join("")}</tr>`;
  const table = (heads, rows) => (rows.length ? `<table><thead><tr>${heads.map((h) => `<th>${h}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table>` : "");
  const body = `<h1>${esc(label)}</h1>
<p class="lede">${esc(intro)}</p>
<table><tbody>
${row(["Identity", `<code>${esc(id)}</code>`])}
${row(["Version", `<code>${esc(info.version)}</code>`])}
${info.extends.length ? row(["Extends", info.extends.map((e) => `<code>${esc(e.name)} /${esc(e.version)}</code>`).join(", ")]) : ""}
${row(["Licence", "CC-BY-4.0"])}
${row(["Files", `<a href="/${name}/package.crubal">package.crubal</a> · <a href="/${name}/package.json">package.json</a> · <a href="/${name}/${info.version}/package.json">${info.version}/package.json</a>`])}
</tbody></table>
${kinds.length ? `<h2>Kinds</h2>${table(["Kind", "Levels"], kinds.map((k) => row([`<code>${esc(k.kind)}</code>`, esc(k.levels.join(" > "))])))}` : ""}
<h2>Facets</h2>
${table(["Key", "Type", "How many", "Values and settings", "Same as"], facets.map((f) => row([`<code>${esc(f.key)}</code>`, f.type, f.many ? (f.pick === "any" ? "any" : `up to ${f.pick}`) : "one", esc(facetSummary(f)), esc(f.sameAs.join(", "))])))}
${dict.classes.size ? `<h2>Classes</h2>${[...dict.classes.values()].map((c) => `<h3>${esc(c.label ?? c.name)} <code>${esc(c.name)}</code></h3><p>For ${esc(c.for.join(", ") || "every kind")}.${c.uses.length ? ` Uses ${esc(c.uses.join(", "))}.` : ""}</p>${table(["Facet", "Asked", "Narrowed to", "Level"], c.lines.map((l) => row([`<code>${esc(l.facet)}</code>`, l.required ? "required" : l.when ? `when ${esc(l.when)}` : "", esc((l.values ?? []).join(", ")), esc(l.level ?? "")])))}${c.parts.length ? table(["Part slot", "Wears", "How many", ""], c.parts.map((p) => row([`<code>${esc(p.slot)}</code>`, esc(p.wears), p.many ? "any" : "one", p.fungible ? "fungible" : "itemized"]))) : ""}`).join("")}` : ""}
${rules.length ? `<h2>Rules</h2>${table(["Rule", "When", "Then", "Strength"], rules.map((r) => row([`<code>${esc(r.name)}</code>`, esc(r.whenText), esc(r.thenText), r.strength])))}` : ""}
${records.length ? `<h2>Records</h2>${table(["ID", "Kind", "Values"], records.map((r) => row([`<code>${esc(r.id)}</code>`, r.kind, esc(Object.entries(r.values).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : typeof v === "object" ? JSON.stringify(v) : v}`).join(" · "))])))}` : ""}
<h2>Use it</h2>
<pre><code>package: mine /2026-10-14
  owner: example.com
  extends: ${esc(id)} /${esc(info.version)}
  prefixes:
    ${esc(name)}: ${esc(id)}</code></pre>`;
  page(`/${name}/`, `${label} · ${id}`, body, `${label}: the standard CRUBAL package ${id}. ${intro}`.slice(0, 158), {
    "@context": "https://schema.org",
    "@type": "Dataset",
    name: `${label} (${id})`,
    description: intro,
    url: `${ORIGIN}/${name}/`,
    license: "https://creativecommons.org/licenses/by/4.0/",
    publisher: STEWARD,
    distribution: [{ "@type": "DataDownload", encodingFormat: "application/json", contentUrl: `${ORIGIN}/${name}/package.json` }],
  });
}

const listed = JSON.parse(readFileSync(join(root, "registry", "packages.json"), "utf8")).packages ?? [];
const registry = [
  ...stdPackages.map((p) => ({ package: p.id, latest: p.version, standard: true, url: `${ORIGIN}/${p.name}/` })),
  ...listed,
];
mkdirSync(join(out, "registry"), { recursive: true });
writeFileSync(join(out, "registry", "index.json"), `${JSON.stringify({ crubal: "2", packages: registry }, null, 2)}\n`);
page(
  "/registry/",
  "CRUBAL packages and registry",
  `<h1>Packages</h1>
<p class="lede">The standard packages anyone can extend, and the registry of packages from any domain. A package <code>domain/name</code> resolves through <code>https://domain/.well-known/crubal.json</code>; listing here never changes who owns it.</p>
<div class="cards">${stdPackages.map((p) => `<a class="card" href="/${p.name}/" style="text-decoration:none;color:inherit"><h3>${esc(p.label)}</h3><p><code>${esc(p.id)}</code> · ${p.facets} facets${p.classes ? `, ${p.classes} classes` : ""}</p></a>`).join("")}</div>
<h2>Listed packages</h2>
${listed.length ? `<ul>${listed.map((p) => `<li><code>${esc(p.package)}</code></li>`).join("")}</ul>` : `<p>None yet. Add yours with a pull request to <a href="${REPO}/blob/main/registry/packages.json"><code>registry/packages.json</code></a>.</p>`}
<p>As data: <a href="/registry/index.json"><code>/registry/index.json</code></a>.</p>`,
  "The standard CRUBAL packages (core, units, party) and the registry of packages from any domain.",
);
mkdirSync(join(out, ".well-known"), { recursive: true });
writeFileSync(
  join(out, ".well-known", "crubal.json"),
  `${JSON.stringify(
    {
      crubal: "2",
      owner: "crubal.com",
      // crubal.com's signing key (8.5, 11.7): the public half; the private half is in the publisher's key store.
      keys: { "crubal.com": { alg: "Ed25519", public: SIGNING_PUBLIC, from: "2026-10-15" } },
      packages: stdPackages.map((p) => ({ package: p.id, latest: p.version, versions: { [p.version]: `${ORIGIN}/${p.name}/${p.version}/package.json` } })),
    },
    null,
    2,
  )}\n`,
);

// ─── For crawlers and agents (chapter 12.5) ──────────────────────────────────

const today = new Date().toISOString().slice(0, 10);
writeFileSync(
  join(out, "sitemap.xml"),
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${pages.map((u) => `  <url><loc>${u}</loc><lastmod>${today}</lastmod></url>`).join("\n")}\n</urlset>\n`,
);
// The site's terms, as chapter 12.5.1 asks: search yes, answer yes, train yes for an open standard.
writeFileSync(join(out, "robots.txt"), `# terms: public: search yes, answer yes, train yes\nUser-agent: *\nAllow: /\n\nSitemap: ${ORIGIN}/sitemap.xml\n`);
writeFileSync(
  join(out, "llms.txt"),
  `# CRUBAL\n\n> An open language and engine for data about any kind of thing. Everything is a key and a value. Stewarded by Infinite Token.\n\nThe specification is CC-BY-4.0. Read the chapters as Markdown:\n\n${chapters.map((c) => `- [${c.title}](${RAW}/spec/${c.file})`).join("\n")}\n\n## Implementing it\n\n- [Conformance test corpus](${REPO}/tree/main/corpus): ${total} cases, level by level\n- [Reference implementation](${REPO}/tree/main/packages/crubal): npm \`@cruba/crubal\`\n\n## Standard packages\n\n${stdPackages.map((p) => `- [${p.label}](${ORIGIN}/${p.name}/package.json): \`${p.id}\``).join("\n")}\n`,
);
console.log(`built ${chapters.length} chapters, ${total} corpus cases, playground → site/dist`);
