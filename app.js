/* Playtest Feedback Synthesizer (browser edition).
 * Faithful port of app.py: same 6-step pipeline, prompts, temperature (0.2), JSON retry,
 * deterministic scoring, quote verification, Markdown + CSV downloads.
 * Your xAI key lives only in memory (and optionally sessionStorage for this tab). It is sent
 * only to https://api.x.ai in the Authorization header and is never logged.
 */
(() => {
  "use strict";

  const API_URL = "https://api.x.ai/v1/chat/completions";
  const CATEGORIES = ["Gameplay", "Controls", "Difficulty", "UI/UX", "Performance/Bugs",
    "Art/Audio", "Narrative", "Onboarding", "Other"];
  const BATCH_SIZE = 50;
  const TOP_N = 8; // themes that get an LLM summary
  const SESSION_KEY = "pfs_xai_key";
  // pandas.read_csv default NA strings (so CSV cleaning matches app.py)
  const PANDAS_NA = new Set(["", "#N/A", "#N/A N/A", "#NA", "-1.#IND", "-1.#QNAN", "-NaN", "-nan",
    "1.#IND", "1.#QNAN", "<NA>", "N/A", "NA", "NULL", "NaN", "None", "n/a", "nan", "null"]);

  class LLMError extends Error {}

  // ---------- helpers mirroring Python semantics ----------
  const $ = (id) => document.getElementById(id);

  // Python round(): half-to-even on ties.
  function pyRound(x, nd = 0) {
    const f = 10 ** nd, m = x * f;
    let r = Math.round(m);
    if (Math.abs(m % 1) === 0.5) r = 2 * Math.round(m / 2);
    return r / f + 0; // +0 normalises -0
  }
  // How Python prints a float in an f-string (4.0 not 4).
  const pyFloat = (v) => (Number.isInteger(v) ? v.toFixed(1) : String(v));

  // json.dumps(obj, ensure_ascii=False) formatting: ", " and ": " separators.
  function pyDumps(v) {
    if (Array.isArray(v)) return "[" + v.map(pyDumps).join(", ") + "]";
    if (v && typeof v === "object")
      return "{" + Object.keys(v).map((k) => JSON.stringify(k) + ": " + pyDumps(v[k])).join(", ") + "}";
    return JSON.stringify(v);
  }

  let apiKey = "";
  const redact = (s) => (apiKey ? String(s).split(apiKey).join("[redacted]") : String(s));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---------- LLM plumbing ----------
  async function chatCompletion(model, messages, temperature) {
    // Like the OpenAI SDK: up to 2 automatic retries on connection errors, 408/409/429/5xx.
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) await sleep(500 * 2 ** (attempt - 1));
      let resp;
      try {
        resp = await fetch(API_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": "Bearer " + apiKey },
          body: JSON.stringify({ model, messages, temperature }),
          credentials: "omit",
          referrerPolicy: "no-referrer",
        });
      } catch (e) {
        lastErr = new Error("Connection error: " + e.message);
        continue;
      }
      if (resp.ok) {
        const data = await resp.json();
        return data.choices[0].message.content;
      }
      const body = await resp.text().catch(() => "");
      lastErr = new Error(`Error code: ${resp.status} - ${body.slice(0, 500)}`);
      if (![408, 409, 429].includes(resp.status) && resp.status < 500) break;
    }
    throw lastErr;
  }

  async function callLlmJson(system, user, temperature = 0.2) {
    if (!apiKey) throw new LLMError("No API key set. Paste your xAI API key above.");
    const model = ($("model").value || "").trim() || "grok-4.3";
    const messages = [
      { role: "system", content: system + "\nRespond with strict JSON only. No prose, no code fences." },
      { role: "user", content: user },
    ];
    let lastErr = null;
    for (let i = 0; i < 2; i++) { // first try + one retry
      let text;
      try {
        text = ((await chatCompletion(model, messages, temperature)) || "").trim();
      } catch (e) {
        lastErr = `API error: ${redact(e.message)}`;
        continue;
      }
      text = text.replace(/^```(?:json)?\s*|\s*```$/g, ""); // tolerate stray fences
      try {
        return JSON.parse(text);
      } catch (e) {
        lastErr = `invalid JSON from model (${e.message})`;
        messages.push({ role: "user", content: "That was not valid JSON. Reply again with strict JSON only." });
      }
    }
    throw new LLMError(lastErr);
  }

  // ---------- 1. Load & clean ----------
  function findCol(columns, ...names) {
    for (const c of columns) if (names.includes(String(c).trim().toLowerCase())) return c;
    return null;
  }

  // raw = {columns: [...], rows: [{col: value}]}
  function cleanComments(raw, textCol) {
    const s = (v) => (v === undefined || v === null ? "" : String(v).trim());
    const meta = {
      tester_id: findCol(raw.columns, "tester_id", "tester", "tester id"),
      build: findCol(raw.columns, "build", "version", "build/version"),
      source: findCol(raw.columns, "source"),
    };
    const seen = new Set(), out = [];
    for (const r of raw.rows) {
      const comment = s(r[textCol]);
      if (comment === "" || seen.has(comment)) continue;
      seen.add(comment);
      const row = { id: "", comment };
      for (const k of ["tester_id", "build", "source"]) row[k] = meta[k] !== null ? s(r[meta[k]]) : "";
      out.push(row);
    }
    out.forEach((r, i) => (r.id = "C" + String(i + 1).padStart(3, "0")));
    return out;
  }

  function parsePasted(text) {
    return { columns: ["feedback"], rows: text.split(/\r\n|\r|\n/).map((l) => ({ feedback: l })) };
  }

  function parseCsvText(text) {
    const res = Papa.parse(text, { header: true, skipEmptyLines: true, dynamicTyping: false });
    const columns = res.meta.fields || [];
    if (!columns.length) throw new Error("no columns found");
    const tooMany = res.errors.find((e) => e.code === "TooManyFields");
    if (tooMany) throw new Error(`row ${tooMany.row + 2} has more fields than the header`);
    const rows = res.data.map((r) => {
      const o = {};
      for (const c of columns) o[c] = r[c] === undefined || PANDAS_NA.has(r[c]) ? "" : r[c];
      return o;
    });
    return { columns, rows };
  }

  // ---------- 2-3. Batch & extract ----------
  function batches(items, size = BATCH_SIZE) {
    const out = [];
    for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
    return out;
  }

  const EXTRACT_SYS = "You tag video game playtest feedback. For EVERY comment return an object " +
    '{"id", "theme_label" (short 2-5 word issue name), "category" (one of: ' + CATEGORIES.join(", ") +
    '), "sentiment" (int -2..2), "severity" (int 1-5, 5 = blocks play), "is_bug" (bool)}. ' +
    'Return {"items": [...]}.';

  function clamp(v, lo, hi, dflt) {
    let x;
    if (typeof v === "number") x = v;
    else if (typeof v === "boolean") x = Number(v);
    else if (typeof v === "string" && v.trim() !== "") x = Number(v.trim());
    else return dflt;
    if (!Number.isFinite(x)) return dflt;
    return Math.max(lo, Math.min(hi, pyRound(x)));
  }

  async function extractTags(comments, progress) {
    const rows = new Map();
    const chunks = batches(comments.map((c) => ({ id: c.id, comment: c.comment })));
    for (let n = 1; n <= chunks.length; n++) {
      const data = await callLlmJson(EXTRACT_SYS, pyDumps(chunks[n - 1]), 0.2);
      const items = data && !Array.isArray(data) && typeof data === "object" ? (data.items ?? []) : data;
      for (const it of Array.isArray(items) ? items : []) {
        if (!it || typeof it !== "object" || Array.isArray(it) || !("id" in it)) continue;
        rows.set(String(it.id), {
          theme_label: String(it.theme_label || "Unlabeled").trim(),
          category: CATEGORIES.includes(it.category) ? it.category : "Other",
          sentiment: clamp(it.sentiment, -2, 2, 0),
          severity: clamp(it.severity, 1, 5, 3),
          is_bug: String(it.is_bug).toLowerCase() === "true",
        });
      }
      if (progress) progress(n / chunks.length, `Tagged batch ${n}/${chunks.length}`);
    }
    // Comments the model skipped still count, tagged as untriaged.
    const fallback = { theme_label: "Untagged", category: "Other", sentiment: 0, severity: 1, is_bug: false };
    return comments.map((c) => ({ ...c, ...(rows.get(c.id) || fallback) }));
  }

  // ---------- 4. Theme merge ----------
  const MERGE_SYS = "You merge near-duplicate playtest theme labels into 5-15 final themes with clear, specific names. " +
    'Return {"mapping": {"<original label>": "<final theme>", ...}} covering every original label.';

  async function mergeThemes(labels) {
    labels = [...new Set(labels)].sort();
    const data = await callLlmJson(MERGE_SYS, pyDumps(labels), 0.2);
    const mapping = data && typeof data === "object" && !Array.isArray(data) && data.mapping && typeof data.mapping === "object"
      ? data.mapping : {};
    const out = {};
    for (const l of labels) out[l] = String(mapping[l] || l).trim(); // unmapped labels keep their name
    return out;
  }

  // ---------- 5. Score (deterministic) ----------
  function scoreThemes(tagged) {
    const hasTesters = tagged.some((r) => r.tester_id !== "");
    const unit = (r) => (hasTesters && r.tester_id !== "" ? r.tester_id : r.id);
    const total = new Set(tagged.map(unit)).size || 1;
    const groups = new Map();
    for (const r of tagged) {
      if (!groups.has(r.theme)) groups.set(r.theme, []);
      groups.get(r.theme).push(r);
    }
    const rows = [...groups.keys()].sort().map((theme) => {
      const g = groups.get(theme);
      const counts = {};
      for (const r of g) counts[r.category] = (counts[r.category] || 0) + 1;
      const max = Math.max(...Object.values(counts));
      const category = Object.keys(counts).filter((k) => counts[k] === max).sort()[0]; // pandas mode()
      const mean = (k) => g.reduce((a, r) => a + r[k], 0) / g.length;
      return {
        theme, category, mentions: g.length,
        pct_testers: pyRound(100 * new Set(g.map(unit)).size / total, 1),
        avg_severity: pyRound(mean("severity"), 2),
        avg_sentiment: pyRound(mean("sentiment"), 2),
      };
    });
    for (const r of rows) r.priority = pyRound(r.mentions * r.avg_severity, 1);
    return rows.sort((a, b) => b.priority - a.priority || b.mentions - a.mentions); // stable
  }

  // ---------- 6. Summarize + quote verification ----------
  const SUM_SYS = "You are a game production analyst. For each theme write a 1-sentence summary, pick 2-3 representative " +
    "quotes copied WORD FOR WORD from its comments (never paraphrase), and one actionable next step. " +
    'Return {"themes": [{"theme", "summary", "quotes": [..], "next_step"}]}.';

  function verifyQuotes(quotes, comments) {
    // Keep only quotes that are exact substrings of a source comment.
    return quotes.filter((q) => typeof q === "string" && q.trim() && comments.some((c) => c.includes(q)));
  }

  async function summarize(themes, tagged, topN = TOP_N) {
    const commentsFor = (t) => tagged.filter((r) => r.theme === t).map((r) => r.comment);
    const payload = themes.slice(0, topN).map((t) => ({ theme: t.theme, comments: commentsFor(t.theme).slice(0, 25) }));
    const data = await callLlmJson(SUM_SYS, pyDumps(payload), 0.2);
    const names = new Set(themes.map((t) => t.theme));
    const out = new Map();
    const list = data && typeof data === "object" && !Array.isArray(data) && Array.isArray(data.themes) ? data.themes : [];
    for (const it of list) {
      const t = it && typeof it === "object" ? it.theme : null;
      if (!names.has(t)) continue;
      const src = commentsFor(t);
      const quotes = Array.isArray(it.quotes) ? it.quotes : [];
      const ok = verifyQuotes(quotes, src);
      out.set(t, { summary: String(it.summary ?? ""), quotes: ok.slice(0, 3),
        next_step: String(it.next_step ?? ""), dropped: quotes.length - ok.length });
    }
    return out;
  }

  // ---------- Full pipeline ----------
  async function runPipeline(comments, progress, warn) {
    const tagged = await extractTags(comments, progress);
    progress(1, "Merging themes...");
    const mapping = await mergeThemes(tagged.map((r) => r.theme_label));
    for (const r of tagged) r.theme = mapping[r.theme_label];
    const themes = scoreThemes(tagged);
    progress(1, "Writing summaries...");
    let summaries;
    try {
      summaries = await summarize(themes, tagged);
    } catch (e) { // rankings are still useful without summaries
      if (!(e instanceof LLMError)) throw e;
      warn(`Summaries unavailable: ${e.message}`);
      summaries = new Map();
    }
    return { tagged, themes, summaries };
  }

  function headline(tagged) {
    const hasTesters = tagged.some((r) => r.tester_id !== "");
    return {
      comments: tagged.length,
      testers: hasTesters ? new Set(tagged.filter((r) => r.tester_id !== "").map((r) => r.tester_id)).size : null,
      sentiment: tagged.length ? pyRound(tagged.reduce((a, r) => a + r.sentiment, 0) / tagged.length, 2) : 0.0,
    };
  }

  const sortedBugs = (tagged) => tagged.filter((r) => r.is_bug).sort((a, b) => b.severity - a.severity);

  function buildMarkdown(tagged, themes, summaries) {
    const h = headline(tagged);
    const lines = ["# Playtest Feedback Report", "",
      `- Comments: ${h.comments}`, `- Testers: ${h.testers !== null ? h.testers : "n/a"}`,
      `- Overall sentiment (-2..2): ${pyFloat(h.sentiment)}`, "", "## Ranked themes", "",
      "| # | Theme | Category | Mentions | % Testers | Avg Severity | Priority |", "|---|---|---|---|---|---|---|"];
    themes.forEach((r, i) => lines.push(
      `| ${i + 1} | ${r.theme} | ${r.category} | ${r.mentions} | ${pyFloat(r.pct_testers)}% | ${pyFloat(r.avg_severity)} | ${pyFloat(r.priority)} |`));
    for (const [t, s] of summaries)
      lines.push("", `### ${t}`, "", s.summary, "", ...s.quotes.map((q) => `> ${q}`), "", `**Next step:** ${s.next_step}`);
    lines.push("", "## Bugs", "", ...sortedBugs(tagged).map(
      (r) => `- [${r.id}] (sev ${r.severity}, build ${r.build || "n/a"}) ${r.comment}`));
    return lines.join("\n") + "\n";
  }

  // Same columns/format as pandas DataFrame.to_csv(index=False).
  const CSV_COLS = ["id", "comment", "tester_id", "build", "source", "theme_label", "category",
    "sentiment", "severity", "is_bug", "theme"];
  function buildCsv(tagged) {
    const cell = (v) => {
      const s = typeof v === "boolean" ? (v ? "True" : "False") : String(v ?? "");
      return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    return [CSV_COLS.join(","), ...tagged.map((r) => CSV_COLS.map((c) => cell(r[c])).join(","))].join("\n") + "\n";
  }

  // ---------- UI ----------
  let raw = null, textCol = null, result = null;

  function mode() { return document.querySelector('input[name="mode"]:checked').value; }

  function message(kind, text) {
    const d = document.createElement("div");
    d.className = "msg " + kind;
    d.textContent = text;
    $("messages").appendChild(d);
  }

  function updateRunEnabled() {
    if (mode() === "paste") {
      const t = $("pasteText").value;
      raw = t.trim() ? parsePasted(t) : null;
      textCol = "feedback";
    }
    $("runBtn").disabled = raw === null;
  }

  function setCsv(parsed, label) {
    raw = parsed;
    const cols = parsed.columns;
    const guess = findCol(cols, "feedback", "comment", "comments", "text");
    const sel = $("colPicker");
    sel.replaceChildren(...cols.map((c) => { const o = document.createElement("option"); o.value = c; o.textContent = c; return o; }));
    sel.value = guess !== null ? guess : cols[0];
    textCol = sel.value;
    $("colPickerWrap").hidden = false;
    $("csvInfo").textContent = `${label}: ${parsed.rows.length} rows, ${cols.length} columns`;
    updateRunEnabled();
  }

  function loadCsvText(text, label) {
    $("messages").replaceChildren();
    try {
      setCsv(parseCsvText(text), label);
    } catch (e) {
      raw = null;
      $("colPickerWrap").hidden = true;
      message("error", `Could not read CSV: ${e.message}`);
      updateRunEnabled();
    }
  }

  function switchMode() {
    const m = mode();
    $("csvMode").hidden = m !== "csv";
    $("pasteMode").hidden = m !== "paste";
    if (m === "csv") {
      raw = null;
      const f = $("csvFile").files[0];
      if (f) f.text().then((t) => loadCsvText(t, f.name));
      else if ($("csvInfo").dataset.sample) loadSample();
      else { $("colPickerWrap").hidden = true; updateRunEnabled(); }
    } else updateRunEnabled();
  }

  async function loadSample() {
    document.querySelector('input[name="mode"][value="csv"]').checked = true;
    $("csvMode").hidden = false; $("pasteMode").hidden = true;
    $("csvFile").value = "";
    const resp = await fetch("sample_feedback.csv");
    $("csvInfo").dataset.sample = "1";
    loadCsvText(await resp.text(), "sample_feedback.csv");
  }

  function td(text, cls) { const c = document.createElement("td"); c.textContent = text; if (cls) c.className = cls; return c; }
  function table(el, headers, rows) {
    const thead = document.createElement("thead"), tr = document.createElement("tr");
    for (const h of headers) { const th = document.createElement("th"); th.textContent = h; tr.appendChild(th); }
    thead.appendChild(tr);
    const tbody = document.createElement("tbody");
    for (const cells of rows) { const r = document.createElement("tr"); r.append(...cells); tbody.appendChild(r); }
    el.replaceChildren(thead, tbody);
  }
  function sevBadge(v, text) {
    const c = document.createElement("td"), s = document.createElement("span");
    s.className = "sev s" + Math.min(5, Math.max(1, Math.round(v)));
    s.textContent = text; c.className = "num"; c.appendChild(s); return c;
  }

  function render({ tagged, themes, summaries }) {
    const h = headline(tagged);
    $("mComments").textContent = h.comments;
    $("mTesters").textContent = h.testers !== null ? h.testers : "n/a";
    $("mSentiment").textContent = pyFloat(h.sentiment);

    table($("themesTable"), ["#", "theme", "category", "mentions", "pct_testers", "avg_severity", "priority"],
      themes.map((t, i) => [td(i + 1, "num"), td(t.theme), td(t.category), td(t.mentions, "num"),
        td(pyFloat(t.pct_testers), "num"), sevBadge(t.avg_severity, pyFloat(t.avg_severity)), td(pyFloat(t.priority), "num")]));

    const cards = themes.map((t) => {
      const d = document.createElement("details"), sm = document.createElement("summary");
      sm.textContent = t.theme; d.appendChild(sm);
      const s = summaries.get(t.theme);
      const p = (text, cls) => { const e = document.createElement("p"); e.textContent = text; if (cls) e.className = cls; return e; };
      if (!s) { d.appendChild(p("No summary (outside top themes or unavailable).", "note")); return d; }
      d.appendChild(p(s.summary));
      for (const q of s.quotes) { const b = document.createElement("blockquote"); b.className = "quote"; b.textContent = q; d.appendChild(b); }
      if (s.dropped) d.appendChild(p(`${s.dropped} quote(s) dropped: not found verbatim in source comments.`, "note dropped"));
      const ns = document.createElement("p"), strong = document.createElement("strong");
      strong.textContent = "Next step:"; ns.append(strong, " " + s.next_step); ns.className = "next-step";
      d.appendChild(ns);
      return d;
    });
    $("themeCards").replaceChildren(...cards);

    table($("bugsTable"), ["id", "comment", "severity", "build", "tester_id", "theme"],
      sortedBugs(tagged).map((r) => [td(r.id), td(r.comment), sevBadge(r.severity, r.severity), td(r.build), td(r.tester_id), td(r.theme)]));

    const counts = {};
    for (const r of tagged) counts[r.category] = (counts[r.category] || 0) + 1;
    const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    const max = Math.max(1, ...entries.map((e) => e[1]));
    $("categoryChart").replaceChildren(...entries.map(([k, v]) => {
      const row = document.createElement("div"); row.className = "bar-row";
      const l = document.createElement("span"); l.className = "bar-label"; l.textContent = k;
      const b = document.createElement("span"); b.className = "bar"; b.style.width = (300 * v / max) + "px";
      row.append(l, b, String(v)); return row;
    }));
    $("results").hidden = false;
  }

  function download(content, filename, mime) {
    const url = URL.createObjectURL(new Blob([content], { type: mime + ";charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function run() {
    $("messages").replaceChildren();
    if (mode() === "csv") textCol = $("colPicker").value;
    const comments = cleanComments(raw, textCol);
    if (!comments.length) { message("warning", "No non-empty comments found."); return; }
    $("runBtn").disabled = true;
    $("progressWrap").hidden = false;
    $("progress").value = 0; $("progressMsg").textContent = "Tagging comments...";
    const progress = (p, m) => { $("progress").value = p; $("progressMsg").textContent = m; };
    try {
      result = await runPipeline(comments, progress, (w) => message("warning", w));
      render(result);
    } catch (e) {
      message("error", e instanceof LLMError ? `LLM step failed: ${e.message}` : `Unexpected error: ${redact(e.message)}`);
    } finally {
      $("progressWrap").hidden = true;
      updateRunEnabled();
    }
  }

  function init() {
    // Key: memory by default; sessionStorage only if the user opts in. Never localStorage.
    const saved = sessionStorage.getItem(SESSION_KEY);
    if (saved) { apiKey = saved; $("apiKey").value = saved; $("rememberKey").checked = true; }
    const syncKey = () => {
      apiKey = $("apiKey").value.trim();
      if ($("rememberKey").checked && apiKey) sessionStorage.setItem(SESSION_KEY, apiKey);
      else sessionStorage.removeItem(SESSION_KEY);
    };
    $("apiKey").addEventListener("input", syncKey);
    $("rememberKey").addEventListener("change", syncKey);

    document.querySelectorAll('input[name="mode"]').forEach((r) => r.addEventListener("change", switchMode));
    $("csvFile").addEventListener("change", async () => {
      const f = $("csvFile").files[0];
      delete $("csvInfo").dataset.sample;
      if (f) loadCsvText(await f.text(), f.name);
    });
    $("colPicker").addEventListener("change", () => (textCol = $("colPicker").value));
    $("pasteText").addEventListener("input", updateRunEnabled);
    $("loadSample").addEventListener("click", loadSample);
    $("runBtn").addEventListener("click", run);
    $("dlMd").addEventListener("click", () => result && download(buildMarkdown(result.tagged, result.themes, result.summaries), "playtest_report.md", "text/markdown"));
    $("dlCsv").addEventListener("click", () => result && download(buildCsv(result.tagged), "tagged_comments.csv", "text/csv"));
  }

  // Exposed for tests only (no key material).
  window.PFS = { cleanComments, parseCsvText, parsePasted, scoreThemes, verifyQuotes, buildMarkdown, buildCsv, pyRound, pyDumps };
  init();
})();
