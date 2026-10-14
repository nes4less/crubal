// Builds crubal.com from the repo: the spec (one page per chapter), the corpus index, the playground and
// the home page. Everything is generated from spec/ and corpus/, so the site can't drift from them.

import { build as bundle } from "esbuild";
import { marked } from "marked";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const out = join(here, "dist");
const REPO = "https://github.com/nes4less/crubal";
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const NAV = [
  ["/", "Home"],
  ["/spec/", "Spec"],
  ["/corpus/", "Corpus"],
  ["/play/", "Playground"],
  [REPO, "GitHub"],
];

function page(path, title, body, description = "CRUBAL: a language and engine for data about any kind of thing.") {
  const nav = NAV.map(([href, label]) => `<a href="${href}"${href !== "/" && path.startsWith(href) ? ' aria-current="page"' : path === href ? ' aria-current="page"' : ""}>${label}</a>`).join("");
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600&family=Public+Sans:wght@400;600;700&family=Source+Serif+4:opsz,wght@8..60,600;8..60,700&display=swap">
<link rel="stylesheet" href="/site.css">
</head>
<body>
<header class="site"><div class="wrap"><a class="brand" href="/">CRUBAL</a><nav class="top">${nav}</nav></div></header>
<main><div class="wrap">${body}</div></main>
<footer class="site"><div class="wrap">CRUBAL 2, working draft. Spec and corpus CC-BY-4.0; code Apache-2.0. <a href="${REPO}">Source</a>.</div></footer>
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
page("/spec/", "CRUBAL 2: the specification", `<div class="layout">${toc("")}<article class="prose">${links(marked.parse(specReadme))}</article></div>`);
for (const c of chapters) {
  page(`/spec/${c.slug}/`, `${c.title} · CRUBAL 2`, `<div class="layout">${toc(c.slug)}<article class="prose">${links(marked.parse(c.md))}<p><a href="${REPO}/blob/main/spec/${c.file}">Edit on GitHub</a></p></article></div>`);
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
  "The CRUBAL test corpus",
  `<article class="prose" style="max-width:none"><h1>The test corpus</h1><p class="lede">${total} cases. A conformance claim is proven by passing a level's folders; the corpus is part of the spec.</p>
<table><thead><tr><th>Folder</th><th>Cases</th><th>Cases</th></tr></thead><tbody>${rows}</tbody></table>
${links(marked.parse(readFileSync(join(corpusDir, "README.md"), "utf8")).replace(/<h1>.*?<\/h1>/, ""))}</article>`,
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
<p>Read the <a href="/spec/">specification</a>, try the <a href="/play/">playground</a>, or read the <a href="${REPO}">source</a>. <span class="pill">Working draft</span></p>`,
);

page("/404/", "Not found · CRUBAL", `<h1>Not found</h1><p>That page doesn't exist. Try the <a href="/spec/">spec</a> or the <a href="/">home page</a>.</p>`);
cpSync(join(here, "static"), out, { recursive: true });
if (existsSync(join(out, "404", "index.html"))) cpSync(join(out, "404", "index.html"), join(out, "404.html"));
console.log(`built ${chapters.length} chapters, ${total} corpus cases, playground → site/dist`);
