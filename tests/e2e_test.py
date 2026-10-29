"""Headless end-to-end test with a mocked xAI API (no real key, no network calls to x.ai).

Run from the repo root:
    python -m http.server 8765 &      # serve the static site
    python tests/e2e_test.py          # needs: pip install playwright; a Chromium/Chrome install
Optional: SOURCE_REPO=/path/to/playtest-feedback-synthesizer compares the downloads byte-for-byte with
the Streamlit app's build_markdown / to_csv run on the same mocked LLM responses.
"""
import csv
import io
import json
import os
import sys

from playwright.sync_api import sync_playwright

BASE = os.environ.get("BASE_URL", "http://localhost:8765/")
CHROME = os.environ.get("CHROME_PATH")  # e.g. /usr/bin/google-chrome
SHOT = os.environ.get("SCREENSHOT", "screenshot.png")
HERE = os.path.dirname(os.path.abspath(__file__))
SAMPLE = os.path.join(HERE, "..", "sample_feedback.csv")
FAKE_KEY = "xai-FAKE-test-key-0123456789abcdefXYZ"

# Same deterministic fake model as the Streamlit repo's tests/test_pipeline.py
RULES = [("camera", "Camera issues", "Controls", 4), ("warden", "Boss difficulty", "Difficulty", 4),
         ("difficult", "Difficulty spike", "Difficulty", 4), ("crash", "Level 2 crash", "Performance/Bugs", 5),
         ("objective", "Unclear objective", "Onboarding", 3), ("where to go", "Lost / no direction", "Onboarding", 3)]
FABRICATED = "This quote was invented by the model."


class FakeLLM:
    def __init__(self):
        self.calls, self.bad_once = [], True

    def reply(self, body):
        system, user = body["messages"][0]["content"], body["messages"][1]["content"]
        self.calls.append({"system": system[:20], "temperature": body["temperature"], "model": body["model"],
                           "messages": [dict(role=m["role"], content=m["content"]) for m in body["messages"]]})
        if self.bad_once:  # first response is broken JSON -> exercises the retry path
            self.bad_once = False
            return "not json {"
        if "You tag" in system:
            items = []
            for c in json.loads(user):
                low = c["comment"].lower()
                label, cat, sev = next(((l, k, s) for key, l, k, s in RULES if key in low), ("General feedback", "Other", 2))
                items.append({"id": c["id"], "theme_label": label, "category": cat,
                              "sentiment": -1 if sev > 2 else 1, "severity": sev, "is_bug": "crash" in low})
            out = {"items": items}
        elif "You merge" in system:
            merge = {"Boss difficulty": "Difficulty spike", "Lost / no direction": "Unclear objective"}
            out = {"mapping": {l: merge.get(l, l) for l in json.loads(user)}}
        else:  # summarize: one real quote + one fabricated quote per theme
            out = {"themes": [{"theme": t["theme"], "summary": f"Testers flag {t['theme']}.",
                               "quotes": [t["comments"][0], FABRICATED],
                               "next_step": "Investigate."} for t in json.loads(user)]}
        return "```json\n" + json.dumps(out) + "\n```"  # fenced, like a sloppy model


def completion(text):
    return {"id": "chatcmpl-mock", "object": "chat.completion", "model": "grok-4.3",
            "choices": [{"index": 0, "message": {"role": "assistant", "content": text}, "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}}


def main():
    fake, requests, leaks, failures = FakeLLM(), [], [], []
    cors = {"Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "*"}

    def check(cond, msg):
        print(("PASS " if cond else "FAIL ") + msg)
        if not cond:
            failures.append(msg)

    def on_api(route):
        req = route.request
        if req.method == "OPTIONS":
            return route.fulfill(status=204, headers=cors)
        body = json.loads(req.post_data)
        route.fulfill(status=200, headers={**cors, "Content-Type": "application/json"},
                      body=json.dumps(completion(fake.reply(body))))

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, **({"executable_path": CHROME} if CHROME else {}))
        ctx = browser.new_context(accept_downloads=True, viewport={"width": 1280, "height": 900})
        page = ctx.new_page()
        console = []
        page.on("console", lambda m: console.append(m.text))

        def on_request(req):
            requests.append(req)
            hdrs = req.headers
            auth = hdrs.get("authorization", "")
            for k, v in hdrs.items():
                if FAKE_KEY in v and not (k == "authorization" and req.url.startswith("https://api.x.ai/")):
                    leaks.append(f"header {k} on {req.url}")
            if FAKE_KEY in req.url or FAKE_KEY in (req.post_data or ""):
                leaks.append(f"url/body of {req.url}")
            if req.url.startswith("https://api.x.ai/") and req.method == "POST" and auth != f"Bearer {FAKE_KEY}":
                leaks.append(f"missing/odd auth on {req.url}")
        page.on("request", on_request)
        ctx.route("https://api.x.ai/**", on_api)
        # Block every other external host so nothing can escape the box during the test.
        ctx.route(lambda url: not url.startswith(BASE) and not url.startswith("https://api.x.ai/"),
                  lambda route: (leaks.append(f"unexpected external request {route.request.url}"), route.abort()))

        page.goto(BASE)
        check(page.title() == "Playtest Feedback Synthesizer", "page loads")
        check(page.locator("#apiKey").get_attribute("type") == "password", "key field is password-type")
        check(page.locator("#model").input_value() == "grok-4.3", "model defaults to grok-4.3")
        page.fill("#apiKey", FAKE_KEY)

        # CSV upload via the file input
        page.set_input_files("#csvFile", SAMPLE)
        page.wait_for_selector("#colPickerWrap:not([hidden])")
        opts = page.eval_on_selector_all("#colPicker option", "els => els.map(e => e.value)")
        check(opts == ["tester_id", "build", "source", "feedback"], f"column picker populated: {opts}")
        check(page.input_value("#colPicker") == "feedback", "feedback column auto-selected")
        check("60 rows" in page.text_content("#csvInfo"), "CSV row count shown (60)")

        # Paste mode sanity (one comment per line), then back to CSV via the sample button
        page.check('input[name="mode"][value="paste"]')
        page.fill("#pasteText", "line one\nline two")
        check(page.is_enabled("#runBtn"), "paste mode enables Synthesize")
        page.click("#loadSample")
        page.wait_for_function("document.querySelector('#csvInfo').textContent.includes('sample_feedback.csv')")
        check(page.input_value("#colPicker") == "feedback", "Load sample data works")

        page.click("#runBtn")
        page.wait_for_selector("#results:not([hidden])", timeout=20000)
        errs = page.locator(".msg.error").all_text_contents()
        check(not errs, f"no error messages {errs}")

        check(len(fake.calls) == 5, f"5 API calls (1 bad JSON + retry, 2 extract batches, merge, summarize): {len(fake.calls)}")
        check(all(c["temperature"] == 0.2 for c in fake.calls), "temperature 0.2 on every call")
        check(all(c["model"] == "grok-4.3" for c in fake.calls), "model grok-4.3 sent")
        check(page.text_content("#mComments") == "60" and page.text_content("#mTesters") == "18", "headline 60 comments / 18 testers")

        rows = page.eval_on_selector_all("#themesTable tbody tr", "rs => rs.map(r => [...r.cells].map(c => c.textContent))")
        check(len(rows) >= 4, f"theme table rendered with {len(rows)} rows")
        pr = [float(r[6]) for r in rows]
        check(pr == sorted(pr, reverse=True), "themes ranked by priority desc")
        check(all(abs(float(r[6]) - round(int(r[3]) * float(r[5]), 1)) < 1e-9 for r in rows), "priority = mentions x avg_severity")
        print("  theme table:", rows)

        sample_comments = [r["feedback"].strip() for r in csv.DictReader(open(SAMPLE, encoding="utf-8"))]
        quotes = page.locator("blockquote.quote").all_text_contents()
        check(len(quotes) > 0, f"{len(quotes)} quotes rendered")
        check(all(any(q in c for c in sample_comments) for q in quotes), "every quote is an exact substring of the input")
        check(FABRICATED not in page.content(), "fabricated quote dropped")
        check(page.locator(".dropped").count() == len(quotes), "dropped-quote note shown per summarized theme")
        check(page.locator("#bugsTable tbody tr").count() == 8, "bug list has 8 rows")

        with page.expect_download() as d:
            page.click("#dlMd")
        md_dl = d.value
        md = open(md_dl.path(), encoding="utf-8").read()
        with page.expect_download() as d:
            page.click("#dlCsv")
        csv_dl = d.value
        csv_text = open(csv_dl.path(), encoding="utf-8").read()
        check(md_dl.suggested_filename == "playtest_report.md" and csv_dl.suggested_filename == "tagged_comments.csv", "download filenames")
        check(md.startswith("# Playtest Feedback Report") and "## Ranked themes" in md and "## Bugs" in md and FABRICATED not in md, "markdown content")
        parsed = list(csv.DictReader(io.StringIO(csv_text)))
        check(csv_text.splitlines()[0] == "id,comment,tester_id,build,source,theme_label,category,sentiment,severity,is_bug,theme", "CSV header")
        check(len(parsed) == 60 and [r["comment"] for r in parsed] == sample_comments, "CSV has 60 rows, comments verbatim")
        open(os.path.join(HERE, "..", "out_report.md"), "w").write(md) if os.environ.get("KEEP_OUTPUTS") else None

        src = os.environ.get("SOURCE_REPO")
        if src:
            sys.path.insert(0, src)
            from types import SimpleNamespace
            import pandas as pd
            import app as pyapp
            ref = FakeLLM()

            class Completions:
                def create(self, model, messages, temperature):
                    txt = ref.reply({"messages": messages, "temperature": temperature, "model": model})
                    return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content=txt))])
            pyapp.get_client = lambda: SimpleNamespace(chat=SimpleNamespace(completions=Completions()))
            comments = pyapp.clean_comments(pd.read_csv(SAMPLE), "feedback")
            tagged, themes, summaries = pyapp.run_pipeline(comments)
            ref_md = pyapp.build_markdown(tagged, themes, summaries)
            ref_csv = tagged.to_csv(index=False)
            check(md == ref_md, "Markdown identical to Streamlit app.build_markdown output")
            check(csv_text == ref_csv, "CSV identical to Streamlit app tagged.to_csv output")
            check([c["messages"] for c in fake.calls] == [c["messages"] for c in ref.calls],
                  "prompts + payloads sent to the API identical to the Streamlit app (all 5 calls)")

        # Key hygiene
        ls = page.evaluate("JSON.stringify(Object.assign({}, localStorage))")
        ss = page.evaluate("JSON.stringify(Object.assign({}, sessionStorage))")
        check(FAKE_KEY not in ls and ls == "{}", f"localStorage empty: {ls}")
        check(FAKE_KEY not in ss, "sessionStorage has no key when 'keep for tab' unchecked")
        check(not any(FAKE_KEY in m for m in console), "key never in console output")
        check(FAKE_KEY not in md and FAKE_KEY not in csv_text, "key not in downloads")
        api_posts = [r for r in requests if r.url.startswith("https://api.x.ai/") and r.method == "POST"]
        check(len(api_posts) == 5 and all(r.url == "https://api.x.ai/v1/chat/completions" for r in api_posts), "all API calls go to api.x.ai/v1/chat/completions")
        check(not leaks, f"key appears only in Authorization header to api.x.ai; leaks={leaks}")
        cookies = ctx.cookies()
        check(not any(FAKE_KEY in c["value"] for c in cookies), "key not in cookies")

        page.locator("#themeCards details").first.evaluate("e => e.open = true")
        page.locator("#settings").evaluate("e => e.scrollIntoView()")
        page.screenshot(path=SHOT, full_page=True)
        print("screenshot:", SHOT)

        # Opt-in sessionStorage: stored there, still never in localStorage
        page.check("#rememberKey")
        ss2 = page.evaluate("sessionStorage.getItem('pfs_xai_key')")
        check(ss2 == FAKE_KEY and page.evaluate("localStorage.length") == 0, "opt-in keeps key in sessionStorage only")
        page.uncheck("#rememberKey")
        check(page.evaluate("sessionStorage.getItem('pfs_xai_key')") is None, "unchecking clears sessionStorage")
        browser.close()

    print("\nALL PASSED" if not failures else f"\n{len(failures)} FAILED")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
