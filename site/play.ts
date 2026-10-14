// The playground: the real engine, in the browser. Definitions on the left, data on the right; the output
// shows the JSON form, the canonical text, or what the Dictionary level says about each value.

import { canonical, checkPackage, checkRecord, CrubalError, foldRecord, printText, readDefinitions, readText } from "../packages/crubal/src/browser.ts";

const DEFS = `// Definitions: a kind, some facets, a class.
kind: item
  levels: product, unit
title$80 ~name
format{DVD~"DVD Video"|Blu-ray~BD|4K}
releaseDate@ym
runtime#min 1..600 accepts: h
genres{Comedy|Holiday|Drama|...}*
condition{NM|VG|G|F|P} ranked
price#USD

class: OpticalDisc
  facets:
    !title
    format{DVD|Blu-ray|4K}
    runtime
    unit::condition
`;

const DATA = `crubal: 2
owner: shop.example

product: P-1 [origin: declared, via: L-1]
  crubal:wears: OpticalDisc
  name: National Lampoon's Christmas Vacation
  format: dvd video
  releaseDate: 1989-12
  runtime: 1.6h
  genres: Comedy, Holiday, Western

unit: U-1 of P-1 [origin: observed, via: L-2]
  condition: VG
  price: 12.50USD
`;

const $ = (id: string) => document.getElementById(id) as HTMLElement;
const defsEl = $("defs") as HTMLTextAreaElement;
const dataEl = $("data") as HTMLTextAreaElement;
const out = $("out");
let mode = "json";

function render() {
  out.classList.remove("err");
  try {
    const dict = readDefinitions(defsEl.value);
    const warnings = checkPackage(dict);
    const wrapper = readText(dataEl.value, dict);
    wrapper.records = wrapper.records.map((r) => foldRecord(r, dict));
    if (mode === "json") out.textContent = JSON.stringify(JSON.parse(canonical(wrapper, dict)), null, 2);
    else if (mode === "text") out.textContent = printText(wrapper, dict, "full");
    else {
      const lines: string[] = warnings.map((w) => `warning, line ${w.line}: ${w.message}`);
      for (const r of wrapper.records) {
        const { outcomes, summary } = checkRecord(r, dict);
        lines.push(`${r.id}: ${summary.outcome}${Array.isArray(summary.missing) ? `, missing ${summary.missing.join(", ")}` : ""}`);
        for (const o of outcomes) {
          const extra = o.flag ? ` (${o.flag})` : o.cites ? ` (cites ${JSON.stringify(o.cites)})` : "";
          lines.push(`  ${o.address}: ${o.outcome}${extra}`);
        }
      }
      out.textContent = lines.join("\n");
    }
  } catch (e) {
    out.classList.add("err");
    out.textContent = e instanceof CrubalError ? e.message : String(e);
  }
}

defsEl.value = DEFS;
dataEl.value = DATA;
for (const el of [defsEl, dataEl]) el.addEventListener("input", render);
for (const b of document.querySelectorAll<HTMLButtonElement>("[data-mode]")) {
  b.addEventListener("click", () => {
    mode = b.dataset.mode as string;
    for (const x of document.querySelectorAll("[data-mode]")) x.setAttribute("aria-pressed", String(x === b));
    render();
  });
}
render();
