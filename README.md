# jev-mcp — browser automation MCP server powered by JEV

**jev-mcp** is a [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server that lets **Claude Code, Codex and any MCP-capable AI agent drive a real Chrome browser** using **JEV**, [TypeSafe AI](https://typesafe.ai)'s *System One* decision model. JEV answers typed questions such as "which element is the departure-city input?" or "did that click work?" in about 100 ms. Each answer comes with a **calibrated confidence**, so the tool acts on its own when it is sure and asks your agent when it is not.

> Your agent plans. JEV executes: fast, cheap and transparent. Every decision is traced and can be replayed.

<p>
  <a href="#quick-start">Quick start</a> ·
  <a href="#mcp-tools">MCP tools</a> ·
  <a href="#how-it-works">How it works</a> ·
  <a href="#confidence-and-human-in-the-loop">Confidence</a> ·
  <a href="#safety">Safety</a> ·
  <a href="#debugging-and-observability">Debugging</a> ·
  <a href="#faq">FAQ</a>
</p>

---

## Why JEV for browser agents

Usual LLM browser agents send a screenshot or a huge DOM dump to a frontier model on every step. That is slow and expensive, and the model still guesses. JEV is different:

| | Frontier LLM agent | jev-mcp with JEV |
|---|---|---|
| Decision latency | 2–20 s per step | **~100 ms** per decision |
| Cost | cents per step | **$0.042 per million input tokens**, output free |
| Output | free text you have to parse | **typed** choice / score / yes-no, never malformed |
| Uncertainty | overconfident | **calibrated probabilities** that drive act / verify / ask |
| Your agent's context | fills up with HTML and screenshots | compact, filtered page views |

JEV does not write text or plan, and that is the point. **Your agent (Claude, GPT, Codex) stays the planner.** jev-mcp turns the page into a clean model, and JEV makes the many small decisions: which element, which autocomplete suggestion, whether a cookie wall blocks the page, whether a step succeeded.

### Real run: "cheapest flight Almaty → Antalya in October"

The end-to-end test on a local airline-search site (Russian UI, consent wall, autocomplete, low-fare calendar, "show more" pagination):

```
step 1 dismiss_overlay   accepted the cookie consent wall
step 2 fill_param(from)  typed "Алматы", picked suggestion "Алматы, Казахстан ALA"
step 3 fill_param(to)    typed "Анталия", picked suggestion "Анталия, Турция AYT"
step 4 pick_date         navigated to October, chose the cheapest day in range (code computes the minimum)
step 5 submit            safety check, then "Найти билеты"
step 6-8 extract         read 30 results across "show more" pages, selected min(price) = 38 900 ₸
= 8 steps · 24 JEV calls · 0 questions to the agent · $0.0019 · 19 s
```

## Features

- **MCP server for Claude Code, Codex, Cursor and other clients.** Async tasks that never block your agent.
- **Two browser modes on one CDP engine:**
  - **your own Chrome** through the jev Chrome extension (`chrome.debugger`), with your logins and a side panel;
  - **jev's own Chrome/Chromium profile**, headful or headless, for background jobs and CI.
- **Page understanding built for decision models:**
  - DOM snapshot, accessibility tree, layout and paint order;
  - regions: forms, lists, overlays, popups, dialogs;
  - stable element refs (`e12`) across re-renders;
  - element names from labels, placeholders and nearby text, which fixes unlabeled React inputs;
  - occlusion detection (`[covered]`, `[BLOCKING]`);
  - shadow DOM and cross-origin iframes.
- **Autonomous task loop:**
  - dismisses consent and promo overlays;
  - fills fields from your params and picks autocomplete suggestions;
  - handles date pickers, including low-fare calendars;
  - submits, paginates and extracts results to your schema with `min/max/first/all`.
- **Human-in-the-loop by confidence.** When JEV is unsure, the agent gets a question with the candidates and their probabilities. The question arrives through Claude Code channels, `jev watch`, an appendix to every tool result, or `jev_wait`.
- **Fully configurable confidence thresholds:** global, per domain, per task and live. Presets or exact values; `escalate: 0` means "never ask on low confidence".
- **Safety:**
  - irreversible actions (pay, order, send, delete) always need confirmation;
  - secret params never reach the model;
  - hidden text and prompt-injection bait are dropped from the page model;
  - domain allow-lists and budgets.
- **Observability:**
  - every step, JEV request, probability distribution and timing lands in a local SQLite trace;
  - one-click "open this decision in the TypeSafe playground";
  - calibration reports that recommend thresholds.
- **Site memory.** The tool learns which element serves which purpose on each site, so repeat runs are faster and more confident.
- **Providers:** [OpenRouter](https://openrouter.ai/typesafe/jev-1.13) (`typesafe/jev-1.13`) or the official TypeSafe API (`jev-latest`), with optional failover.

## Quick start

Requirements: Node.js ≥ 22.18, Google Chrome (or Chromium), and an OpenRouter or TypeSafe API key.

```bash
git clone https://github.com/legostin/jev-mcp.git
cd jev-mcp
npm install
node bin/jev.mjs install                                   # registers the MCP server in Claude Code / Codex, links the skill and the `jev` CLI
jev settings set providers.openrouter.apiKey -             # paste your key on stdin; stored in ~/.config/jev-browser/config.json (0600)
jev doctor                                                 # checks the key, JEV latency, Chrome and the extension
```

Using the official TypeSafe API instead:

```bash
jev settings set provider typesafe
jev settings set providers.typesafe.apiKey -
```

### Use with Claude Code

`jev install` runs `claude mcp add -s user jev-browser -- node <repo>/bin/jev.mjs mcp` for you. Then ask Claude:

> Find the cheapest flight from Almaty to Antalya in October on aviasales.kz

Claude calls `jev_task` and keeps working while JEV runs. Questions from JEV reach Claude in one of these ways:
- as `<channel>` events, if you start Claude Code with `--dangerously-load-development-channels server:jev-browser`;
- from `jev watch <task>` running in the background;
- appended to any jev tool result.

### Use with Codex and other MCP clients

`jev install` adds `[mcp_servers.jev-browser]` to `~/.codex/config.toml`. Any other client can run `node <repo>/bin/jev.mjs mcp` over stdio.

### Drive your own Chrome (extension)

1. `npm run build:web`, then load `dist/extension` as an unpacked extension in `chrome://extensions` (Developer mode).
2. Run `jev pair` and enter the 6-digit code in the JEV side panel.
3. Tasks and tools can now use `driver: "extension"`. The side panel shows tasks and pending questions, and has pause, take-over and a live confidence slider.

## MCP tools

| Tool | What it does |
|---|---|
| `jev_task` | Starts an autonomous browser task: goal, site, params, result schema, policy. Returns immediately. |
| `jev_status` · `jev_wait` · `jev_result` | Follow a task: progress, the next question or completion, extracted items. |
| `jev_answer` | Resolves a JEV question: `pick`, `hint`, `set_param`, `thresholds`, `continue`, `skip`, `abort`; `remember` saves it to site memory. |
| `jev_control` | Pause, resume, cancel, or update params, hints and thresholds of a running task. |
| `jev_observe` | Compact page view: region overview, one region, one element, diff since the last look. |
| `jev_find` | Free-text element search ranked by JEV, with probabilities and an "exists at all?" score. |
| `jev_ask` | Your own typed JEV questions (noul / choice / score) about the current page. |
| `jev_act` | One trusted action (click, type, select, check, press, scroll, navigate…) by ref or by intent. |
| `jev_tabs` · `jev_screenshot` | Tab management and vision fallback. |
| `jev_trace` | Why JEV did what it did: steps, calls, answers, costs, playground links. |
| `jev_settings` · `jev_doctor` | Settings (keys are write-only) and diagnostics. |

Example task:

```json
{
  "goal": "Find the cheapest flight ticket from Almaty to Antalya departing in October 2026",
  "site": "https://www.aviasales.kz",
  "params": {
    "from":   { "value": "Алматы",  "about": "departure city" },
    "to":     { "value": "Анталия", "about": "destination city" },
    "period": { "value": { "from": "2026-10-01", "to": "2026-10-31" }, "about": "departure date" }
  },
  "result": { "schema": { "price": "money", "airline": "string", "depart": "time", "url": "url" }, "select": "min(price)" },
  "policy": { "confidence": { "preset": "balanced" }, "irreversible": "ask" }
}
```

## How it works

```
Claude Code / Codex ──stdio──▶ jev mcp            (thin proxy, one per agent session)
                                  │ JSON-RPC over a 0600 unix socket
                                  ▼
                        jevd — one daemon per machine
   task runner · perception engine · JEV client · site memory · trace store · debug UI
                                  │ Chrome DevTools Protocol (flat sessions)
                   ┌──────────────┴──────────────┐
          extension driver                chromium driver
      (your Chrome, side panel)     (own profile, headless/headful)
```

Each task step:

1. **Observe.** The page settles (DOM quiet, network idle, pending timers done). Then a snapshot of DOM, accessibility tree and paint order is turned into a page model with regions and stable refs.
2. **Assess.** One batched JEV call answers: page kind, overlay kinds, goal reached, results present, validation errors, missing required fields.
3. **Decide.** Code rules pick the sub-intent: dismiss overlay, fill param, pick suggestion, pick date, submit, extract, load more. JEV chooses only when the rules cannot.
4. **Ground.** Hierarchical element selection (region, then element), an "exists?" check, and a second look at the top candidates when confidence is mid-range. Site memory offers a fast path.
5. **Safety gate.** Code rules and JEV classify the action; irreversible steps ask first.
6. **Act and verify.** Trusted CDP input, deterministic checks and a JEV verification.

Everything numeric is computed in code: prices, date ranges, minima. JEV's weak spots (arithmetic, counting, dates) are [documented by TypeSafe](https://docs.typesafe.ai/model-jaggedness/jev-1.13), so JEV only makes semantic judgments.

## Confidence and human in the loop

Every JEV decision has a calibrated confidence. For each decision kind (`assess`, `subintent`, `ground`, `verify`, `extract`) there are two thresholds:
- **`act`:** at or above it, jev-mcp acts;
- **`escalate`:** below it, jev-mcp asks your agent.

In between, it takes a second, independent look.

| Preset | choice act / escalate | noul yes / no |
|---|---|---|
| `cautious` | 0.90 / 0.70 (+ margin 0.30) | 0.85 / 0.15 |
| `balanced` (default) | 0.85 / 0.55 | 0.80 / 0.20 |
| `autonomous` | 0.60 / 0.20 | 0.65 / 0.35 |

Thresholds can be set at four levels, each overriding the previous:
1. globally (`jev settings set confidence.preset autonomous`);
2. per domain (`domains.<host>.confidence`);
3. per task (`policy.confidence`);
4. live, while a task runs (`jev_control update`, a `thresholds` answer, or the side-panel slider).

Any value from 0 to 1 is allowed; `escalate: 0` disables confidence-driven questions. `jev calibrate` shows how accurate JEV was at each confidence level on your own traces and suggests thresholds.

## Safety

- **Irreversible actions ask first.** This covers pay, buy, order, book, send, subscribe, delete, publish and forms that collect card details, detected by code rules in English and Russian plus JEV. It applies at any confidence unless you set `policy.irreversible: "allow"`.
- **Secrets stay local.** Params marked `secret: true` are typed by code and masked everywhere. JEV sees only `[secret]`. The trace store refuses anything that looks like an API key.
- **Prompt-injection hygiene.** Hidden and `aria-hidden` text never enters the page model. Page text lives only in the JEV *state*, never in question instructions.
- **Local-only services.** The unix socket has 0600 permissions. The UI binds to 127.0.0.1 and needs a token. The extension WebSocket checks the `Origin` and requires a one-time pairing.
- **Budgets and limits** apply per task and per day: cost, steps and time.

## Debugging and observability

- `jev_trace` / `jev ui` shows a timeline of every step with its timings and each JEV call: state, questions, probability bars against your thresholds, model version, cost.
- An **"Open in TypeSafe Playground"** link for any decision replays it in the [TypeSafe console](https://console.typesafe.ai).
- The **replay** view edits a question or the state and re-runs it against JEV.
- **Calibration** shows reliability per template, estimated from verified steps and agent answers.
- `jev observe`, `jev find "<query>"` and `jev tabs` work from the terminal.

## Development

```bash
npm test                 # unit + integration tests (headless Chrome, local fixture sites, offline JEV)
npm run test:live        # live tests against JEV (needs a key)
npm run eval             # decision-quality evals: accuracy and calibration per question template
npm run typecheck
node scripts/observe-fixture.ts flights.html   # print the perception output for a fixture page
```

The code is TypeScript and runs natively on Node's type stripping, so the daemon, MCP server and CLI need no build step. Fixture sites in `fixtures/sites/` imitate real-world difficulties: Russian labels, unlabeled inputs, consent walls, autocomplete, calendars, shadow DOM, cross-origin iframes, pagination.

## FAQ

**What is JEV?** JEV is TypeSafe AI's first *System One* model. It returns typed decisions (choice, score, yes/no) with calibrated probabilities instead of generating text. See the [TypeSafe docs](https://docs.typesafe.ai/introduction) and the [OpenRouter guide](https://openrouter.ai/docs/guides/community/jev).

**Does it replace Playwright MCP or browser-use?** Those give an LLM low-level browser control, and every decision goes through the LLM. jev-mcp moves the many small decisions to JEV, 100× cheaper and faster, and keeps your agent for planning and ambiguity. You still get direct control through `jev_observe` / `jev_act`.

**Can it use my logged-in browser?** Yes, through the extension driver. Otherwise it uses its own persistent Chrome profile.

**Which languages?** Any. JEV is most accurate in English, so write goals and hints in English. Page text and param values stay as they are.

**How much does it cost?** JEV input costs $0.042 per million tokens and output is free. A typical multi-step task costs a fraction of a cent.

## Status and roadmap

jev-mcp is under active development. The core, the task loop, the MCP tools and the tests are in place. Work continues on the extension side panel, the debug UI and calibration tooling. Issues and PRs are welcome.

## License

[MIT](LICENSE). JEV and TypeSafe are trademarks of TypeSafe AI. This project is an independent, community-built integration.

<!-- Keywords: MCP server, Model Context Protocol, browser automation, AI browser agent, Claude Code browser, Codex browser tool, Chrome automation, Chrome extension, Chrome DevTools Protocol, CDP, headless Chrome, web automation, web scraping, form filling, JEV, TypeSafe AI, System One model, OpenRouter, calibrated confidence, human-in-the-loop, agentic AI -->
