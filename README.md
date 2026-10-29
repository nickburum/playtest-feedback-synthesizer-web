# Playtest Feedback Synthesizer (browser edition)

A static, browser-only port of the Streamlit [Playtest Feedback Synthesizer](https://github.com/nickburum/playtest-feedback-synthesizer).
Upload raw playtest feedback and get a ranked list of themes, each with a severity rating, verbatim
supporting quotes and a suggested next step. No server, no build step: plain `index.html` + `app.js` + `style.css`,
so it can be hosted on GitHub Pages.

## Bring your own key (BYO key)

You paste your own [xAI API key](https://console.x.ai/) into the page. The key:

- stays in your browser. It lives in page memory, and only goes into `sessionStorage` if you tick
  "Keep key for this browser tab only", which is cleared when the tab closes. It is never written to
  `localStorage`, cookies or the URL, and it is never logged.
- is sent **only** to `https://api.x.ai/v1/chat/completions`, in the `Authorization: Bearer` header. The page's
  Content-Security-Policy (`connect-src 'self' https://api.x.ai`) stops the browser from sending requests anywhere else.
- is never committed to this repo or sent to GitHub. GitHub Pages only serves the static files.

The xAI API allows cross-origin (CORS) browser requests, so no proxy is needed. API usage is billed to your xAI account.

## Use

1. Paste your xAI key. The model defaults to `grok-4.3`, and you can change it.
2. **Upload CSV** and pick the feedback column, **Paste text** with one comment per line, or click **Load sample data**
   (`sample_feedback.csv`: 60 fake comments from 18 testers). Optional CSV columns `tester_id`, `build`/`version` and
   `source` are picked up automatically.
3. Click **Synthesize**. You get headline stats, a ranked theme table, a card per theme with a summary, verbatim
   quotes and a next step, a bug list, and mentions by category.
4. Download the **Markdown report** (`playtest_report.md`) or the **tagged comments CSV** (`tagged_comments.csv`).

Run it locally with `python -m http.server 8000`, then open http://localhost:8000. Opening `file://` won't work because
the sample loader uses `fetch`.

## Pipeline (same as the Streamlit app)

1. **Clean**: trim, drop empty and duplicate comments, and assign IDs (`C001`...).
2. **Batch**: split comments into chunks of 50.
3. **Extract**: one LLM call per batch at temperature 0.2. Each comment gets `theme_label`, `category`, `sentiment` (-2..2),
   `severity` (1-5) and `is_bug`.
4. **Merge**: one LLM call that merges near-duplicate labels into 5-15 final themes.
5. **Score**: deterministic JavaScript, no LLM. It computes mentions, % of testers, average severity and average sentiment.
   **Priority = mentions × average severity.**
6. **Summarize**: one LLM call for the top 8 themes. It returns a 1-sentence summary, 2-3 quotes and a next step. Every
   quote must be an exact substring of a source comment, and quotes that fail the check are dropped and counted.

Every LLM call asks for strict JSON, is parsed with `JSON.parse` and is retried once on invalid JSON. The prompts are
copied verbatim from `app.py`.

## Tests

`tests/e2e_test.py` drives the page in headless Chromium with Playwright and mocks `api.x.ai`, so it needs no key.
It checks CSV upload, the column picker, the theme table, exact quotes, both downloads, and that the key never
leaves the `Authorization` header. If you set `SOURCE_REPO`, it also checks that the downloads and API payloads
are byte-identical to the Streamlit app's on the same mocked responses.

```bash
pip install playwright pandas   # plus the Streamlit repo's requirements if using SOURCE_REPO
python -m http.server 8799 --bind 127.0.0.1 &
BASE_URL=http://127.0.0.1:8799/ CHROME_PATH=/usr/bin/google-chrome python tests/e2e_test.py
```

Third-party code: [Papa Parse](https://www.papaparse.com/) 5.4.1, vendored in `vendor/` (MIT, see `vendor/PAPAPARSE-LICENSE`).
