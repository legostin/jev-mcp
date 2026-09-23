# JEV Browser Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the JEV Browser MCP tool described in `docs/superpowers/specs/2026-09-23-jev-browser-design.md`. All five stages are in scope.

**Architecture:** A single-machine daemon (`jevd`) owns the browser drivers, perception engine, JEV client, task runner, trace store and HTTP UI. A thin stdio MCP proxy (`jev mcp`) runs per agent session and talks to the daemon over a unix socket using newline-delimited JSON-RPC. Two drivers produce the same flat-session CDP connection:
- **chromium:** launches Chrome and connects over a CDP WebSocket.
- **extension:** MV3 `chrome.debugger` relay over a WebSocket to the daemon.

**Tech Stack:**
- Node ≥ 22.18, run as TypeScript source through Node's native type stripping (no build step for Node code).
- TypeScript 7 (`tsc --noEmit`) for type checking; vitest for tests.
- `@modelcontextprotocol/sdk`, `zod`, `ws`, `node:sqlite`.
- esbuild bundles the extension and the Preact UI; `lz-string` builds playground links.

## Global Constraints

- All code, identifiers, comments, UI text, CLI output, errors, MCP tool descriptions, escalation summaries, skill and README: **English only**. User data is never translated.
- TypeScript source uses **erasable syntax only**: no `enum`, `namespace`, parameter properties or decorators. Relative imports use `.ts` extensions.
- Confidence thresholds are **never hardcoded** in decision code. They are always resolved through `resolveThresholds()` (config → domain → task → live override).
- API keys and `secret: true` param values never appear in JEV requests, traces, tool outputs or logs. Keys are stored only in `~/.config/jev-browser/config.json` (mode `0600`) or the environment.
- Irreversible actions escalate (`risk_confirm`) regardless of confidence unless the policy explicitly sets `irreversible: "allow"`.
- The JEV state for one question stays under 32k tokens minus the longest question. The target comes from `limits.stateTokenTarget` (default 6000).
- Daemon listens on a `0600` unix socket and on `127.0.0.1` only. The extension WebSocket requires `Origin: chrome-extension://…` plus a pairing token.
- Default models: OpenRouter `typesafe/jev-1.13`, TypeSafe `jev-latest`. Endpoint path `/systemone` on the provider base URL.
- Live JEV tests run only when `JEV_LIVE=1`. They read the key from config or env and must never print it.

## File Structure

A single npm package (a simplification of the spec's multi-package layout; the component boundaries are the same folders).

```
package.json, tsconfig.json, tsconfig.web.json, vitest.config.ts, .gitignore, README.md
bin/jev.mjs                        entry: runs src/cli/main.ts
src/core/util/        paths.ts ids.ts tokens.ts log.ts json.ts events.ts
src/core/config/      schema.ts store.ts thresholds.ts
src/core/jev/         types.ts errors.ts client.ts rate-limit.ts playground.ts
src/core/cdp/         connection.ts ws-connection.ts driver.ts chromium.ts page.ts input.ts init-script.ts
src/core/perception/  types.ts capture.ts elements.ts naming.ts regions.ts repeated.ts signature.ts diff.ts render.ts model.ts calendar.ts
src/core/questions/   state.ts run.ts templates/{assess,decide,ground,widget,extract,safety,verify,find}.ts
src/core/decide/      gating.ts
src/core/safety/      rules.ts classify.ts secrets.ts
src/core/extract/     parse.ts extract.ts
src/core/runner/      types.ts task.ts step.ts subintents.ts escalation.ts progress.ts widgets.ts
src/core/memory/      store.ts
src/core/trace/       store.ts
src/daemon/           main.ts rpc.ts protocol.ts sessions.ts browsers.ts tabs.ts tasks.ts ext-bridge.ts http.ts lifecycle.ts api.ts
src/mcp/              main.ts tools.ts client.ts channel.ts
src/cli/              main.ts install.ts commands.ts
extension/            manifest.json sidepanel.html sidepanel.css src/{worker.ts,sidepanel.ts,protocol.ts}
ui/                   index.html src/{main.tsx,api.ts,views/*.tsx,styles.css}
scripts/              build-web.mjs
fixtures/sites/       *.html, server.ts
evals/                cases/*.json run.ts
skills/jev-browser/SKILL.md
test/                 mirrors src/ (unit), test/integration/ (headless Chrome), test/live/ (JEV_LIVE)
```

## Core Interfaces (shared by all tasks)

```ts
// src/core/jev/types.ts
export type Json = string | number | boolean | null | Json[] | { [k: string]: Json };
export type NoulQuestion = { type: 'noul'; instructions: Json; criteria?: { true?: Json; false?: Json } };
export type ChoiceQuestion = { type: 'choice'; instructions: Json; criteria: Record<string, Json | null> };
export type ScoreQuestion = { type: 'score'; instructions: Json; criteria: Json[] };
export type Question = NoulQuestion | ChoiceQuestion | ScoreQuestion;
export type NoulAnswer = { type: 'noul'; noul: number };
export type ChoiceAnswer = { type: 'choice'; choice: string; probabilities: Record<string, number>; confidence: number };
export type ScoreAnswer = { type: 'score'; score: number; probabilities: Record<string, number>; legend: Record<string, string>; confidence: number };
export type Answer = NoulAnswer | ChoiceAnswer | ScoreAnswer;
export type ProviderName = 'openrouter' | 'typesafe';
export interface EvaluateRequest { state: Json; questions: Record<string, Question> }
export interface EvaluateResult {
  model: string; provider: ProviderName; answers: Record<string, Answer>;
  usage: { inputTokens: number; outputTokens: number; costUsd: number };
  latencyMs: number; requestId?: string;
}
export interface JevClient { evaluate(req: EvaluateRequest, opts?: { signal?: AbortSignal }): Promise<EvaluateResult> }

// src/core/cdp/connection.ts
export interface CdpConnection {
  send<T = any>(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<T>;
  on(listener: (method: string, params: any, sessionId?: string) => void): () => void;
  onClose(listener: (reason: string) => void): () => void;
  close(): Promise<void>;
}
// src/core/cdp/driver.ts
export interface TabInfo { id: string; url: string; title: string; driver: DriverKind }
export type DriverKind = 'chromium' | 'extension';
export interface BrowserDriver {
  readonly kind: DriverKind;
  listTabs(): Promise<TabInfo[]>;
  openTab(url?: string): Promise<TabInfo>;
  closeTab(tabId: string): Promise<void>;
  attach(tabId: string): Promise<{ conn: CdpConnection; sessionId?: string }>;  // page-level session
  close(): Promise<void>;
  onDisconnect(listener: () => void): () => void;
}

// src/core/perception/types.ts
export interface Rect { x: number; y: number; w: number; h: number }
export type ElementKind = 'link' | 'button' | 'textbox' | 'combobox' | 'select' | 'checkbox' | 'radio' | 'slider'
  | 'option' | 'tab' | 'menuitem' | 'clickable' | 'heading' | 'text' | 'image' | 'file' | 'other';
export interface ElementNode {
  ref: string; sig: string; kind: ElementKind; role: string; tag: string;
  name: string; nameSource: 'aria' | 'label' | 'placeholder' | 'title' | 'content' | 'nearby' | 'none';
  value?: string; placeholder?: string; inputType?: string; href?: string; text?: string;
  options?: { value: string; label: string; selected: boolean }[];
  states: { disabled?: boolean; checked?: boolean; expanded?: boolean; selected?: boolean; required?: boolean; invalid?: boolean; focused?: boolean; readonly?: boolean };
  interactive: boolean; visible: boolean; inViewport: boolean; occluded: boolean;
  rect: Rect; regionId: string; backendNodeId: number; frameSessionId?: string;
  attrs: Record<string, string>; context?: string;   // nearby text / container heading
}
export type RegionKind = 'header' | 'nav' | 'main' | 'aside' | 'footer' | 'form' | 'dialog' | 'overlay' | 'popup' | 'list' | 'section' | 'page';
export interface Region { id: string; kind: RegionKind; label: string; refs: string[]; rect: Rect; blocking: boolean; items?: string[][] }
export interface PageModel {
  url: string; title: string; lang: string; viewport: { w: number; h: number }; scroll: { y: number; maxY: number };
  elements: Map<string, ElementNode>; regions: Region[]; signature: string; capturedAt: number;
}
export interface PageDiff { urlChanged: boolean; added: string[]; removed: string[]; changed: string[]; newRegions: string[]; goneRegions: string[]; focusChanged: boolean }
```

---

## Stage 1 — Core

### Task 1: Project scaffold

**Files:** Create `package.json`, `tsconfig.json`, `tsconfig.web.json`, `vitest.config.ts`, `.gitignore`, `bin/jev.mjs`, `src/core/util/{paths,ids,tokens,log,json,events}.ts`, `test/core/util.test.ts`.

- [ ] Write `package.json`:
  - `"type": "module"`, `"bin": { "jev": "bin/jev.mjs" }`, `engines.node >=22.18`;
  - deps: `@modelcontextprotocol/sdk`, `zod`, `ws`, `lz-string`, `preact`;
  - devDeps: `typescript`, `vitest`, `esbuild`, `@types/ws`, `@types/node`, `@types/chrome`;
  - scripts: `test`, `test:live`, `typecheck`, `build:web`, `eval`.
- [ ] Write `tsconfig.json`: `strict`, `noEmit`, `allowImportingTsExtensions`, `erasableSyntaxOnly`, `module: nodenext`, `target: es2023`, `include: [src, test, fixtures, evals, scripts]`. Write `tsconfig.web.json` with DOM lib for `extension/` and `ui/`.
- [ ] Utilities:
  - `paths.ts`: `configDir()`, `dataDir()`, `socketPath()`, `endpointFile()`, `profileDir()`, `tracesDir()`, honouring `JEV_HOME` for tests.
  - `ids.ts`: `newId(prefix)`.
  - `tokens.ts`: `estimateTokens(value)` returns `ceil(chars/3.5)` of the JSON text.
  - `log.ts`: leveled stderr logger that never logs objects containing the `apiKey` field.
  - `events.ts`: typed `Emitter`.
- [ ] Test `estimateTokens` and `newId` uniqueness. Run `npx vitest run test/core/util.test.ts` → PASS. Run `npm run typecheck` → no errors.
- [ ] Commit `chore: scaffold project`.

### Task 2: Config store and threshold resolution

**Files:** `src/core/config/{schema,store,thresholds}.ts`, `test/core/config.test.ts`

**Produces:**
- `loadConfig(): Config`
- `saveConfig(cfg)`, which writes mode `0600`
- `getPath(cfg, 'a.b')`
- `setPath(cfg, 'a.b', value): Config`, validated by zod
- `redactConfig(cfg)`: keys become `sk-or-…<last4>`
- `resolveApiKey(cfg, provider)`: env `OPENROUTER_API_KEY` / `TYPESAFE_API_KEY` wins
- `PRESETS`
- `resolveThresholds({cfg, domain, task, live}): Thresholds`
- `type Thresholds = Record<'assess'|'subintent'|'ground'|'verify'|'extract', { choice: { act: number; escalate: number; margin: number | null }; noul: { actYes: number; actNo: number; escalateOnUnsure: boolean } }>`

- [ ] Tests:
  - defaults load with an empty file;
  - `setPath('providers.openrouter.apiKey')` persists with mode 0600;
  - invalid value (`confidence.preset = 'x'`) throws;
  - env key overrides file key;
  - `redactConfig` hides keys;
  - preset `autonomous` → `ground.choice.act === 0.6`;
  - override key `ground.choice` merges over the preset;
  - task-level `escalate: 0` wins over domain and global;
  - the live override wins over the task.
- [ ] Implement exactly the spec §10 shape and the §5.3 preset table. Override keys have the form `<kind>.<primitive>`.
- [ ] Run tests → PASS. Commit `feat(config): settings store and layered thresholds`.

### Task 3: JEV client

**Files:** `src/core/jev/{types,errors,client,rate-limit,playground}.ts`, `test/core/jev.test.ts`, `test/live/jev.live.test.ts`

**Produces:**
- `createJevClient(cfg: Config, deps?: { fetch?: typeof fetch; sleep?: (ms) => Promise<void> }): JevClient`
- `JevError { kind: 'auth'|'validation'|'rate_limit'|'overloaded'|'network'|'timeout'|'server'|'config'; status?: number; body?: string }`
- `playgroundUrl(state, questions): string`

- [ ] Tests with a fake `fetch`:
  - POST goes to `${baseUrl}/systemone` with a Bearer key and body `{model, state, questions}`;
  - parses answers and usage; the OpenRouter `usage.cost` is used when present, otherwise `inputTokens * 0.042e-6`;
  - `429` with `retry-after: 1` retries after 1000 ms (fake sleep) and succeeds on the second try;
  - `401` → `JevError('auth')` without retry;
  - `422` → `JevError('validation')` with the body;
  - 5 consecutive `529` → `JevError('overloaded')`;
  - `failover: true` switches to the other provider when the primary fails with `overloaded`/`network` and both keys exist;
  - missing key → `JevError('config')`;
  - the rate limiter delays the 3rd request when `requestsPerMinute = 2`.
- [ ] `playgroundUrl` returns `https://console.typesafe.ai/decode#share/` + `LZString.compressToEncodedURIComponent(JSON.stringify({apiVersion:'v1', documentText, promptsText, selectedModels:['jev-latest']}))`. Test that decoding round-trips.
- [ ] Live test (`JEV_LIVE=1`): one choice + one noul against the configured provider; assert types and that `model` starts with `typesafe/jev` or `jev`.
- [ ] Commit `feat(jev): System One client with retries, rate limit, failover`.

### Task 4: CDP connection and chromium driver

**Files:** `src/core/cdp/{connection,ws-connection,driver,chromium}.ts`, `test/integration/chromium.test.ts`

**Produces:**
- `WsCdpConnection.connect(wsUrl): Promise<CdpConnection>`, using the global `WebSocket`
- `ChromiumDriver.launch({ headless, executable?, profileDir? }): Promise<ChromiumDriver>`, implementing `BrowserDriver`
- `findChrome(): string | null`

Mechanics:
- **Launch:** start Chrome with `--remote-debugging-port=0 --user-data-dir=<profile> --no-first-run --no-default-browser-check [--headless]`, then poll `<profile>/DevToolsActivePort` for the port and the browser WS path.
- **Tabs:** `Target.getTargets` filtered by `type==='page'`; `openTab` → `Target.createTarget`.
- **Attach:** `attach` → `Target.attachToTarget({targetId, flatten:true})` returns the `sessionId`.
- [ ] Integration test: launch headless, open `data:text/html,<title>x</title>`, attach, `Runtime.evaluate('document.title')` returns `x`, `listTabs` contains the tab, close.
- [ ] Commit `feat(cdp): websocket CDP connection and chromium driver`.

### Task 5: Page session: frames, init script, settle, input

**Files:** `src/core/cdp/{page,input,init-script}.ts`, `test/integration/page.test.ts`

**Produces:** `class PageSession` with:
- `static open(driver, tabId)`
- `navigate(url)`, `back()`
- `waitForSettle(opts?: { maxMs?: number; quietMs?: number; networkQuietMs?: number }): Promise<{ settled: boolean; ms: number }>`
- `frames(): FrameInfo[]`, where `FrameInfo = { sessionId?: string; frameId: string; url: string; offset: {x,y} }`
- `click(backendNodeId, frameSessionId?)`
- `type(backendNodeId, text, { mode: 'insert'|'keys', clear: boolean, frameSessionId? })`
- `press(key)`, `selectOption(backendNodeId, value, frameSessionId?)`, `scrollIntoView(backendNodeId, frameSessionId?)`
- `scroll(dy)`, `hover(backendNodeId, frameSessionId?)`, `setFiles(backendNodeId, files, frameSessionId?)`
- `screenshot({ clip? }): Promise<Buffer>`
- `evaluate(expr, sessionId?)`
- `inputWindows`: timestamps of our own dispatched input, used for takeover detection
- `onEvent(fn)`, `close()`

Mechanics:
- The init script (`addScriptToEvaluateOnNewDocument` + evaluate on the current document) patches `EventTarget.prototype.addEventListener` so that elements with click/mousedown/pointerdown/touchstart listeners get `data-jev-l="1"` set lazily. It also counts mutations into `window.__jev.lastMutation` and tracks user input (`isTrusted` pointer/key events → `window.__jev.lastUserInput`).
- Settle: poll every 100 ms until `now - lastMutation ≥ quietMs` (300 ms) and inflight network requests (Network domain, ignoring WebSocket/EventSource/long polls older than 5 s) have been 0 for `networkQuietMs` (500 ms), or until `maxMs`.
- Clicks: `DOM.getBoxModel` → pick the center, or the first unoccluded point from a 3×3 grid via `DOM.getNodeForLocation` → `Input.dispatchMouseEvent` pressed/released.
- Typing: focus through `DOM.focus`; clear with Cmd/Ctrl+A + Backspace; then `Input.insertText` (mode `insert`) or per-character `Input.dispatchKeyEvent` keyDown/char/keyUp (mode `keys`).
- OOPIF: `Target.setAutoAttach({autoAttach:true, flatten:true, waitForDebuggerOnStart:false})` on the page session, recursively on child sessions. Frame offsets come from the owner iframe's box model.
- [ ] Integration tests on inline fixture HTML:
  - a click increments a counter;
  - `type` in `keys` mode fires `input` events per char;
  - `selectOption` changes the value;
  - settle waits for a `setTimeout`-injected DOM change;
  - `data-jev-l` is present on a div with a click listener;
  - the cross-origin iframe session appears in `frames()` (via the fixture server on two ports).
- [ ] Commit `feat(cdp): page session with frames, settle detection and trusted input`.

### Task 6: Fixture sites

**Files:** `fixtures/sites/{server.ts,flights.html,results.html,cookie.html,modal.html,iframe-outer.html,iframe-inner.html,shadow.html,login.html,checkout.html,calendar.html,autocomplete.html,labels.html}`, `test/integration/fixtures.test.ts`

- [ ] `server.ts`: `startFixtureServer(): Promise<{ url(path): string; crossUrl(path): string; close() }>` serves `fixtures/sites` on two random ports (the second is "cross-origin"). Also `/api/suggest?q=` (city autocomplete JSON with 150 ms delay) and `/api/flights?from&to&month` (deterministic 30 results, paginated by 10 with a "Show more" button).
- [ ] `flights.html`: a Russian-labelled search form mimicking aviasales:
  - fields «Откуда»/«Куда» as custom comboboxes with an autocomplete popup (no labels, placeholder only on one, nearby text on the other);
  - a date field opening a custom calendar grid (buttons with `aria-label="14 октября 2026"`) with month navigation;
  - a passengers popover; a «Найти билеты» button;
  - a cookie banner (fixed bottom, blocks clicks with an overlay);
  - a newsletter form with a «Город» textbox as a distractor;
  - submit navigates to `results.html?from=…&to=…&date=…`.
- [ ] `results.html`: renders result cards (price «41 230 ₸», airline, times, «Выбрать» button), a sort control, «Показать ещё».
- [ ] The other fixture pages cover:
  - `modal.html`: a promo modal;
  - `labels.html`: every naming source;
  - `shadow.html`: an open shadow root with inputs;
  - `login.html`;
  - `checkout.html`: «Оплатить 41 230 ₸», with `autocomplete="cc-number"`.
- [ ] Test: the server serves both origins; `/api/flights` returns 10 items per page.
- [ ] Commit `test: fixture sites for perception and task e2e`.

### Task 7: Perception engine

**Files:** `src/core/perception/{types,capture,elements,naming,regions,repeated,signature,diff,render,model,calendar}.ts`, `test/integration/perception.test.ts`, `test/core/perception-unit.test.ts`

**Produces:**
- `capturePage(page: PageSession): Promise<RawCapture>`: per frame, `DOMSnapshot.captureSnapshot({computedStyles:[display,visibility,opacity,cursor,pointer-events,position,z-index], includeDOMRects:true, includePaintOrder:true})` plus `Accessibility.getFullAXTree`, merged by `backendNodeId`.
- `buildPageModel(raw, prev?: PageModel): PageModel`
- `diffModels(prev, next): PageDiff`
- `renderOverview(model, budget)`, `renderRegion(model, regionId, budget)`, `renderElement(model, ref)`, `renderDiff(diff, model)`: English labels, original page text.
- `describeElement(el): string`, for example `textbox "Откуда" value="" placeholder="…" [required] {in r3 form "Поиск"}`
- `parseCalendarCells(model): { ref: string; date: string /*YYYY-MM-DD*/ }[]`

Rules:
- **Interactive** when any of these holds:
  - the tag is a/button/input/select/textarea/summary or has `contenteditable`;
  - the AX role is in the widget set;
  - `data-jev-l`, or `cursor:pointer` without an interactive ancestor already counted;
  - `tabindex≥0`.
- **Visible** unless `display:none`, `visibility:hidden`, opacity 0, zero size, `aria-hidden` ancestor, or fully clipped.
- **Occluded:** the paint-order hit test at the center (and 4 quadrants) belongs to a node outside this element's subtree.
- **Naming order:**
  1. AX name;
  2. associated label;
  3. `aria-label`/`aria-labelledby`;
  4. placeholder;
  5. title;
  6. own text (≤ 80 chars);
  7. nearby text: the nearest visible text node left (same row ±10 px) or above (≤ 40 px) inside the same container;
  8. `none`.

  `context` = nearest container heading or legend.
- **Signature:** a stable hash of `kind|role|normalized name|tag|name attr|id (with digit runs and hex-ish suffixes stripped)|data-testid|type|autocomplete|region kind+label`. Refs are reused from `prev` when signatures match (ties broken by rect proximity); new elements get the next free `eN`.
- **Regions:**
  - landmark roles/tags;
  - `role=dialog`/`aria-modal`;
  - **overlays**: position fixed/sticky/absolute with z-index ≥ 10 covering ≥ 20% of the viewport width, or occluding other interactive elements;
  - **popups**: `role=listbox|menu`, or a container referenced by `aria-controls` of an expanded element;
  - **lists**: `repeated.ts` groups siblings under the same parent with the same tag-path shape (≥ 3 siblings, ≥ 2 leaf texts each);
  - the remainder goes into `main`/`page`.

  Each element belongs to the innermost region. `blocking` = an overlay that occludes ≥ 1 interactive element of another region.
- **Budget:** renders cut elements by priority (in viewport > visible > interactive > text) and report `+N more`.
- [ ] Integration tests on fixtures:
  - `labels.html`: every input gets the expected name and `nameSource`;
  - `cookie.html`: an overlay region with `blocking=true`, and the main-form elements `occluded`;
  - `flights.html`: the «Откуда» box named via placeholder, «Куда» via nearby text; after typing «Алм», the diff shows a new popup region with ≥ 1 option containing «Алматы»;
  - `results.html`: a list region with 10 items and 4+ leaves each; after «Показать ещё», 20 items with refs of the first 10 unchanged;
  - `shadow.html`: shadow inputs present;
  - iframe fixture: cross-origin input present with `frameSessionId`;
  - `calendar.html`: `parseCalendarCells` returns ISO dates for visible cells;
  - the rendered overview stays under 1500 tokens for `flights.html`.
- [ ] Unit tests for the signature normalizer, the naming order, and budget cutting.
- [ ] Commit `feat(perception): page model with naming, regions, signatures and diff`.

### Task 8: Trace store

**Files:** `src/core/trace/store.ts`, `test/core/trace.test.ts`

**Produces:** `TraceStore.open(dir)` with:
- `recordTask(task)`, `updateTask(id, patch)`
- `recordStep(step: StepRecord)`
- `recordJevCall(call: JevCallRecord)`
- `saveBlob(taskId, name, data): string`
- `listTasks({limit})`, `getTask(id)`, `getSteps(taskId)`, `getJevCalls({taskId?, stepId?, template?})`
- `labelCall(callId, correct: boolean)`
- `prune({retentionDays, maxMb})`

Built on `node:sqlite` with the ExperimentalWarning suppressed for that module only. Every JSON field is stored with secrets already masked; the store asserts that no string containing `sk-or-` or `apiKey` is written.
- [ ] Tests: CRUD round-trip; pruning deletes old rows and blobs; writing an object containing `sk-or-v1-…` throws.
- [ ] Commit `feat(trace): sqlite trace store`.

### Task 9: State builder, question runner, find/ground templates, gating

**Files:** `src/core/questions/{state.ts,run.ts,templates/ground.ts,templates/find.ts}`, `src/core/decide/gating.ts`, `test/core/questions.test.ts`, `test/core/gating.test.ts`

**Produces:**
- `buildState(parts: { goal?, params?, hints?, progress?, page?: object, recent?: string[], extra?: object }, budgetTokens): Json`: param values with `secret` are replaced by `"[secret]"`.
- `runQuestions(ctx: QuestionContext, set: QuestionSet): Promise<QuestionSetResult>`. It sends one JEV request, records a `JevCallRecord` with the template names, and returns typed answers.
- `QuestionContext = { jev: JevClient; trace?: TraceStore; taskId?: string; stepId?: string }`
- `QuestionSet = { template: string; state: Json; questions: Record<string, Question> }`
- **Ground helpers:**
  - `groundByIntent(ctx, model, intent: { description: string; kinds?: ElementKind[]; regionHint?: string }, th: Thresholds): Promise<GroundResult>`
  - `GroundResult = { ref: string | null; confidence: number; exists: number; candidates: {ref,p,desc}[]; stage: 'direct'|'region'|'rerank'; decision: 'act'|'escalate' }`
  - Steps:
    1. filter by kinds and visibility;
    2. BM25 over name+context vs the description;
    3. if ≤ 60 candidates, a direct choice;
    4. otherwise a region choice with top-3 beam, then an element choice over ≤ 255;
    5. `ground.exists` noul in the same request;
    6. a rerank of the top-3 with `renderElement` when between thresholds.
- **Gating:** `gateChoice(ans, th.choice) → 'act'|'uncertain'|'escalate'`, `gateNoul(v, th.noul) → 'yes'|'no'|'unsure'`, `topMargin(probabilities)`.
- `findElements(ctx, model, query, k)` returns the top-k with probabilities.
- [ ] Unit tests with a fake JevClient:
  - `buildState` masks secrets and respects the budget by trimming `page.elements`;
  - gating boundaries (`act` exactly at the threshold → act; `escalate: 0` never escalates);
  - `groundByIntent` sends the region stage when there are > 60 candidates;
  - the rerank stage fires for confidence between the thresholds;
  - a `JevCallRecord` is written with the template name.
- [ ] Live test (`JEV_LIVE=1`) on `flights.html`: `groundByIntent('departure city input')` → the «Откуда» element with decision `act` under `balanced`.
- [ ] Commit `feat(questions): state builder, question runner, grounding and gating`.

### Task 10: Daemon core, RPC and browser management

**Files:** `src/daemon/{main,rpc,protocol,sessions,browsers,tabs,lifecycle,api}.ts`, `test/integration/daemon.test.ts`

**Produces:**
- **Protocol:** newline-delimited JSON-RPC 2.0 over a unix socket; server→client notifications `event` with `{sessionId, event}`.
- **Server:** `startDaemon({ home }): Promise<{ close() }>`
- **Client:** `connectDaemon({ autostart: boolean }): Promise<DaemonClient>`, where `DaemonClient.call(method, params)` and `onEvent(fn)`.
- **Methods (stage 1):**
  - `session.hello {client, pid} → {sessionId}`
  - `tabs.list/open/close/select {driver?}`
  - `page.observe {tab?, view, target?, budget?}`, `page.find {tab?, query, k?}`, `page.ask {tab?, questions, region?}`
  - `page.act {tab?, action, ref?, intent?, value?, options?}`, `page.screenshot {tab?, ref?}`
  - `settings.get {path?}`, `settings.set {path, value}`
  - `doctor`, `daemon.info`
- **Browser manager:** lazily launches the chromium driver (config `driver.chromium`); keeps `PageSession` + last `PageModel` per tab; `currentTab` per session.
- **Lifecycle:** lock via exclusive `open(pidfile,'wx')` + stale pid check; writes `jevd.json {pid, socket, httpPort, extensionPort, version}`; idle exit after 30 min without clients or tasks.
- [ ] Integration test:
  - start the daemon with a temp `JEV_HOME` and a headless chromium;
  - a client hello;
  - `tabs.open` the fixture URL; `page.observe overview` contains «Найти билеты»;
  - `page.act click` by ref on the counter fixture changes state (the diff is reported);
  - `settings.set confidence.preset autonomous` persists;
  - a second daemon start fails with "already running";
  - `doctor` reports the driver ok.
- [ ] Commit `feat(daemon): rpc server, lifecycle, browser and tab management`.

### Task 11: MCP proxy (stage-1 tools) and CLI

**Files:** `src/mcp/{main,tools,client}.ts`, `src/cli/{main,install,commands}.ts`, `bin/jev.mjs`, `test/integration/mcp.test.ts`

**Produces:**
- MCP server `jev-browser` (stdio) with tools `jev_observe`, `jev_find`, `jev_ask`, `jev_act`, `jev_tabs`, `jev_screenshot`, `jev_settings`, `jev_doctor`. Zod input schemas, English descriptions; outputs are compact text plus `structuredContent`.
- CLI:
  - `jev mcp` — runs the proxy;
  - `jev daemon [--foreground]`;
  - `jev doctor`;
  - `jev settings get|set <path> [value]` (`set` for keys reads stdin when the value is `-`);
  - `jev install`: registers `claude mcp add -s user jev-browser -- node <repo>/bin/jev.mjs mcp` and the codex `[mcp_servers.jev-browser]` block; links the skill into `~/.claude/skills/jev-browser` and `~/.agents/skills/jev-browser`; prints extension load and pairing instructions;
  - `jev uninstall`;
  - `jev ui`: opens the UI URL;
  - `jev watch`: added in stage 2.
- [ ] Integration test: spawn `node bin/jev.mjs mcp` through the MCP SDK `Client` + `StdioClientTransport` with a temp `JEV_HOME`; `listTools` contains the 8 tools; `jev_tabs open` the fixture URL; `jev_observe` returns an overview; `jev_settings get` never returns a raw key.
- [ ] Commit `feat(mcp,cli): stage-1 MCP tools and jev CLI`.

### Task 12: Eval harness

**Files:** `evals/run.ts`, `evals/cases/{grounding,page-kind}.json`

- [ ] Case format: `{ fixture, setup?: Action[], intent: { description, kinds? } | { template, expect }, expectRef: { name, kind } }`.
- [ ] The runner (`npm run eval`) launches headless Chrome with fixtures, runs `groundByIntent` or the template, and prints a per-template table: accuracy overall, accuracy at `act`, share acted, reliability bins (0.1 width). It writes `evals/last-report.json` (git-ignored). Requires `JEV_LIVE=1`.
- [ ] ≥ 25 grounding cases across fixtures, including Russian labels, distractors and shadow/iframe.
- [ ] Commit `test(evals): decision-quality eval harness`.

## Stage 2 — Task loop

### Task 13: Question library

**Files:** `src/core/questions/templates/{assess,decide,widget,extract,safety,verify}.ts`, `test/core/templates.test.ts`

Each template exports `build(input) → QuestionSet` (question keys prefixed by template name) and `read(result) → typed output`. The instructions use backtick paths (`goal`, `params.from`, `page.elements`, `page.regions.r3`), English, one judgment each, with an `other`/`none` exit on every choice. Criteria texts follow spec §5.2.

- `assess.build({model, goal, params, progress, hints})`:
  - `page_kind` choice;
  - per overlay region: `overlay_blocks_<r>` noul + `overlay_kind_<r>` choice;
  - per param not decided by code: `param_reflected_<k>` noul;
  - `validation_error` noul, `goal_reached` noul;
  - per empty required field (≤ 8): `required_uncovered_<ref>` noul.
- `decide.build({candidates: Subintent[], ...})`: one choice over subintent ids with descriptions.
- `widget.suggestionPick`, `widget.optionPick`, `widget.calendarRole`.
- `extract.isItem(listRegion)`: nouls per list region.
- `extract.fields(items, schema)`: choice per item×field over leaf ids + `none`, chunked into ≤ 200 questions per request and a state ≤ budget.
- `safety.actionClass(el, model, goal)`: choice.
- `verify.effect(subintent, diff, before, after)`: noul.

- [ ] Tests with a fake client: correct question keys and types; secrets masked; `read` maps answers; extract chunking splits 38 items × 4 fields into ≤ 200-question requests.
- [ ] Commit `feat(questions): full decision template library`.

### Task 14: Safety

**Files:** `src/core/safety/{rules,classify,secrets}.ts`, `test/core/safety.test.ts`

**Produces:**
- `deterministicRisk(el, model): { irreversible: boolean; reasons: string[] }`. Rules: ru/en keyword regexes on name/text/value (pay/buy/purchase/place order/checkout/confirm order/delete/remove account/publish/send/transfer/оплатить/купить/оформить заказ/подтвердить/удалить/опубликовать/отправить/перевести); form action or href matching `/checkout|/payment|/pay\b|/order|/purchase`; the page contains `autocomplete^=cc-` fields and the element is a submit.
- `classifyAction(ctx, el, model, goal, th): Promise<{ cls, irreversible, reasons }>`: code rule OR (JEV `irreversible` class with p ≥ 0.5).
- `maskSecrets(obj, secretValues)`: deep replace.
- `domainAllowed(url, allowed)`.
- [ ] Tests: `checkout.html`'s «Оплатить» → irreversible; «Найти билеты» → not irreversible; `maskSecrets` replaces nested occurrences; subdomain matching for allowed domains.
- [ ] Commit `feat(safety): irreversible-action rules, secret masking, domain policy`.

### Task 15: Value parsing and extraction

**Files:** `src/core/extract/{parse,extract}.ts`, `test/core/parse.test.ts`, `test/integration/extract.test.ts`

**Produces:**
- `parseMoney('41 230 ₸') → {amount:41230, currency:'KZT'}`: handles ₸ ₽ $ € £ ₺, `KZT`/`RUB`/`USD`/`EUR`/`TRY`, NBSP/thin spaces, `1,234.56` vs `1 234,56`.
- `parseNumber`
- `parseDateTime(text, { refYear, refMonth })`: supports Russian and English month names, `14 окт`, `14.10`, `2026-10-14`, and `06:40`.
- `parseDuration('5ч 20м'|'5h 20m')` → minutes.
- `absUrl`.
- `extractResults(ctx, page, model, schema, select, opts): Promise<{ items: Record<string, unknown>[]; selected?: Record<string, unknown>; evidence }>`. Steps:
  1. candidate list regions;
  2. `extract.isItem`;
  3. leaves per item (text nodes and links, with leaf ids `iN_lM`);
  4. the `extract.fields` choice;
  5. parse by schema type;
  6. `select` (`min(field)`/`max(field)`/`first`/`all`);
  7. link url from the item's first link or button href.
- [ ] Unit tests for parsers (≥ 20 cases). Integration test (`JEV_LIVE=1`) on `results.html`: 10 items with a numeric price; `min(price)` equals the fixture's known minimum.
- [ ] Commit `feat(extract): value parsers and schema-driven extraction`.

### Task 16: Runner

**Files:** `src/core/runner/{types,task,step,subintents,escalation,progress,widgets}.ts`, `test/core/runner.test.ts`, `test/integration/task-e2e.test.ts`

**Produces:**
- `TaskSpec` (spec §6.1, zod-validated)
- `TaskState = 'queued'|'running'|'awaiting_input'|'paused'|'interrupted'|'done'|'failed'|'cancelled'`
- `Escalation` (spec §6.5)
- `AnswerInput = { type: 'pick', ref } | { type: 'set_param', key, value, about?, secret? } | { type: 'hint', text, scope? } | { type: 'continue' } | { type: 'thresholds', value } | { type: 'skip' } | { type: 'abort' }`, plus `remember?: boolean`
- `TaskResult` (spec §6.6)
- `class Task` extends `Emitter<{state, step, escalation, done}>` with:
  - constructor `(spec, deps: { page: PageSession, jev, trace, memory?, cfg, sessionId })`
  - `start()`, `pause(reason)`, `resume()`, `cancel()`
  - `answer(questionId, AnswerInput)`, `update(patch)`
  - `status()`, `result()`

**Step algorithm (spec §6.3).** Rule-based subintents are evaluated first; `decide.next_subintent` is the fallback. Subintent executors live in `widgets.ts`:
- **fill_param:** ground the input; type the value in `keys` mode for comboboxes and `insert` mode otherwise; wait for settle; if a popup appeared, `pick_suggestion` in the same step.
- **pick_date:**
  1. open the date control;
  2. `widget.calendarRole`;
  3. `parseCalendarCells`;
  4. filter by the param range in code;
  5. navigate months with next/prev (grounded) until matching cells appear;
  6. choose the earliest matching cell, or the cheapest if cells show prices (parsed in code).
- **set_option:** native select → `optionPick`; custom → click to open then `optionPick`.
- **dismiss_overlay:** ground an accept/close button inside the overlay region.
- **submit:** ground the primary submit button in the form region.
- **apply_sort:** ground the sort control matching the `select` field and direction; skipped when absent.
- **load_more** and **extract:** as in Task 15.
- **done** and **go_back.**

Other rules:
- Progress per param is computed in code: a text input whose value contains the normalized param value → `entered`. Otherwise the `assess.param_reflected` noul decides.
- Verification: deterministic checks plus `verify.effect`; retry the next candidate once; then escalate `stuck`.
- Loop detection: `(page signature, subintent, ref)` seen 3 times → `stuck`.
- Budgets: `max_steps`, `max_minutes`, `budget_usd` (sum of the call costs).
- Every JEV call and step is traced; screenshots are saved per step when `trace.screenshots` is on.
- Escalations carry the top-5 candidates with `describeElement` output, thresholds, page kind distribution, region list, recent steps, and `screenshot` for canvas-heavy pages or on request.
- Answers:
  - `pick` sets the ref for the pending subintent and continues;
  - `set_param` updates the params and re-plans;
  - `hint` appends to `hints` (the domain scope is stored in memory when `remember`);
  - `thresholds` sets the live override;
  - `skip` marks the subintent skipped;
  - `abort` cancels.
- Takeover: if `window.__jev.lastUserInput` is newer than our input windows by > 300 ms, the task pauses with the reason `user_takeover`.
- [ ] Unit tests with scripted fake JEV and a fake page: gating leads to an escalation of kind `ground` below `escalate`; `answer pick` resumes; the loop detector fires; the budget stops the task; irreversible actions escalate `risk_confirm` even at confidence 1.0; secrets never reach the fake JEV.
- [ ] E2E (`JEV_LIVE=1`, headless chromium, fixtures): the task from spec §6.1 against `flights.html` reaches `done` with `selected.price` equal to the fixture minimum for October, with ≤ 2 escalations auto-answered by the test via `pick` of the top candidate. A second task on `checkout.html` escalates `risk_confirm`.
- [ ] Commit `feat(runner): JEV-driven task loop with gating, escalation and verification`.

### Task 17: Task RPC, MCP task tools, event delivery, watch, skill

**Files:** `src/daemon/tasks.ts`, `src/mcp/channel.ts`, `src/mcp/tools.ts` (extend), `src/cli/commands.ts` (watch), `skills/jev-browser/SKILL.md`, `test/integration/mcp-tasks.test.ts`

**Produces:**
- RPC methods: `task.create`, `task.status`, `task.wait {taskId?, until, timeoutMs ≤ 55000}`, `task.answer`, `task.control {taskId, action: pause|resume|cancel|update, patch?}`, `task.result`, `task.trace`, `questions.pending {sessionId}`.
- Events `question`, `done`, `state` go to the owning session.
- MCP tools `jev_task`, `jev_status`, `jev_wait`, `jev_answer`, `jev_control`, `jev_result`, `jev_trace`. `jev_trace` returns the UI link and the playground links.
- Every tool response appends `pending_questions` (id, task, kind, one-line summary) when there are any.
- Channel: the proxy declares `capabilities.experimental['claude/channel'] = {}` and sends `notifications/claude/channel` with `content` (summary + answer instructions) and `meta {task_id, question_id, kind, status}` on the question and done events of its session. The `instructions` string explains the `<channel source="jev-browser">` events and all three delivery modes.
- `jev watch <taskId> [--until question|done|any] [--timeout s]` prints the event JSON and exits 0; exit code 2 on timeout.
- `SKILL.md` (English) covers:
  - when to use jev tools;
  - writing `goal`/`about`/`hints` in English and param values as they appear on the site;
  - the result schema and `select`;
  - reading escalations and choosing answers;
  - `remember`; threshold control;
  - starting `jev watch` in the background in Claude Code;
  - `jev_find`/`jev_ask`/`jev_observe` for cheap perception instead of screenshots;
  - never passing secrets without `secret: true`.
- [ ] Integration test (no live JEV, fake client injected via `JEV_FAKE=1` env which makes the daemon use a scripted client): create a task through MCP → an escalation arrives as `pending_questions` in the next tool response; `jev_answer` resumes; `jev_wait until done` returns the result; `jev watch` exits on the question event.
- [ ] Commit `feat(mcp): task tools, event delivery via channel/watch/piggyback, skill`.

## Stage 3 — Extension

### Task 18: Extension driver and bridge

**Files:** `extension/manifest.json`, `extension/src/{worker,protocol}.ts`, `src/daemon/ext-bridge.ts`, `scripts/build-web.mjs`, `test/integration/extension.test.ts`

**Produces:**
- Manifest MV3: `permissions: debugger, tabs, storage, sidePanel, alarms`; `host_permissions: <all_urls>`; `side_panel.default_path: sidepanel.html`; background service worker `worker.js` (module); fixed `key` in the manifest so the extension id is stable (id derived and printed by `jev install`).
- Worker:
  - connects to `ws://127.0.0.1:<port>/ext` with `{ type: 'hello', token, version }`; reconnects with backoff; a keepalive ping every 20 s;
  - pairing: when there is no token, it waits for the side panel to submit a pairing code → `{type:'pair', code}` → the daemon returns a token → stored in `chrome.storage.local`;
  - relays `listTabs`/`openTab`/`closeTab`/`attach`/`detach`/`send {tabId, sessionId?, method, params}` through `chrome.debugger` (flat sessions via `sessionId` in the DebuggerSession);
  - forwards `chrome.debugger.onEvent` and `onDetach`.
- Daemon bridge: a `ws` server on `extensionPort`, `verifyClient` checks that `Origin` starts with `chrome-extension://` and matches the allowed id; token auth; pairing codes are 6 digits, valid for 10 min, generated by `jev pair` / UI. `ExtensionDriver implements BrowserDriver` over the socket. An extension disconnect pauses its tasks; a reconnect resumes the page sessions (re-attach).
- `build-web.mjs`: esbuild bundles `extension/src/*.ts` → `dist/extension/`, copies the manifest/html/css, and bundles `ui/src/main.tsx` → `dist/ui/`.
- [ ] Integration test: download Chrome for Testing via `@puppeteer/browsers` (cached under `JEV_HOME/cft`), launch it with `--load-extension=dist/extension` in headless mode; pair using a code injected through `chrome.storage`; `tabs.open` via the extension driver; `page.observe` works; the extension disconnect event pauses a running fake task.
- [ ] Commit `feat(extension): chrome.debugger CDP relay driver with pairing`.

### Task 19: Side panel

**Files:** `extension/sidepanel.html`, `extension/sidepanel.css`, `extension/src/sidepanel.ts`

- [ ] The side panel (English) shows:
  - the connection status and pairing form;
  - tasks in this window: goal, state, step and subintent;
  - Pause/Resume/Take over/Cancel buttons;
  - pending questions with candidate buttons (`pick`), plus hint and skip inputs;
  - a threshold slider (the live override of `ground.choice.act`/`escalate` for the selected task);
  - a "Highlight" toggle that asks the daemon to overlay candidate boxes on the page (the daemon injects a highlight overlay via `Runtime.evaluate`).

  Data comes via the worker port → daemon `ext.*` RPC.
- [ ] Manual check via the integration harness screenshot of the side panel page opened as `chrome-extension://<id>/sidepanel.html`.
- [ ] Commit `feat(extension): side panel with task control and questions`.

## Stage 4 — Debug UI

### Task 20: HTTP API

**Files:** `src/daemon/http.ts`, `test/integration/http.test.ts`

- [ ] An HTTP server on `127.0.0.1:<httpPort>` (random unless configured). Auth: `?token=` on the first load sets an HttpOnly cookie; the API requires the cookie or a Bearer token. Static `dist/ui`.
- [ ] JSON API:
  - `GET /api/tasks`, `/api/tasks/:id`, `/api/tasks/:id/steps`, `/api/calls?taskId&stepId&template`;
  - `GET /api/blob/:taskId/:name`;
  - `POST /api/replay {callId, questions?, state?}` → a new JEV evaluation, not attached to a task;
  - `GET /api/playground/:callId` → URL;
  - `GET/POST /api/settings` (redacted); `GET /api/questions`; `POST /api/questions/:id/answer`;
  - `GET/DELETE/PATCH /api/memory`; `GET /api/calibration`; `GET /api/export/:taskId` (zip-free: a JSON bundle with base64 blobs);
  - `POST /api/highlight {tab, refs}`; SSE `GET /api/events`.
- [ ] Tests: no token → 401; with token → tasks list; replay with a fake client returns answers; settings responses never contain a raw key.
- [ ] Commit `feat(daemon): debug HTTP API with token auth and SSE`.

### Task 21: Debug UI SPA

**Files:** `ui/index.html`, `ui/src/{main.tsx,api.ts,styles.css}`, `ui/src/views/{Tasks.tsx,Timeline.tsx,Inspector.tsx,Replay.tsx,Inbox.tsx,Settings.tsx,Memory.tsx,Calibration.tsx}`

- [ ] A Preact SPA (English) with hash routing and light/dark support via CSS tokens:
  - **Tasks** list;
  - **Timeline** per task: steps with subintent, action, diff summary, timings, cost; each JEV call expands to show the state (pretty JSON with token count), questions, and answers as probability bars with `act`/`escalate` markers, the model version, the latency and a playground link;
  - **Inspector**: region tree + elements of the step's page model, click → highlight in the live tab;
  - **Replay**: edit questions/state JSON → run → compare answers;
  - **Inbox**: pending questions with an answer form;
  - **Settings**: provider, keys (write-only), model, presets and overrides, driver, budgets, trace retention;
  - **Memory**: table with delete/edit weight;
  - **Calibration**: reliability diagram per template, with a recommended `act` threshold for a target precision.
- [ ] Build with `npm run build:web`; the HTTP test asserts that `/` serves `index.html`. Manual check in Chrome via the chromium driver screenshot.
- [ ] Commit `feat(ui): debug UI`.

## Stage 5 — Site memory and calibration

### Task 22: Site memory

**Files:** `src/core/memory/store.ts`, runner integration in `src/core/runner/step.ts`, `test/core/memory.test.ts`, extended task e2e

**Produces:** `MemoryStore.open(db)` with:
- `lookup(domain, pageKind, key): MemoryEntry | null`
- `recordSuccess(domain, pageKind, key, sig)`
- `recordFailure(id)`
- `addHint(domain, text)`, `hints(domain)`
- `list()`, `remove(id)`, `setWeight(id, w)`

The weight starts at 1, +0.5 per success (max 5), −1 per failure; disabled after 2 consecutive failures.
- [ ] Runner:
  - before grounding: `lookup` → an element with a matching `sig` in the model → a `ground.memory_confirm` noul → act if `yes`;
  - after a successful verify: `recordSuccess`;
  - on a failed verify of a memory hit: `recordFailure`;
  - answers with `remember: true` store `pick` as the sig for the pending key and domain-scoped hints.
- [ ] Tests: lifecycle of weights; the e2e second run of the flights task uses memory hits (fewer `ground.element` calls than the first run, asserted from trace counts).
- [ ] Commit `feat(memory): per-domain site memory fast path`.

### Task 23: Calibration analytics

**Files:** `src/core/trace/calibration.ts`, `test/core/calibration.test.ts`, the CLI `jev calibrate`

**Produces:** `calibration(store, { template?, sinceDays? }) → { template, bins: { lo, hi, n, accuracy }[], ece, recommend: { targetPrecision, act } }[]`. Labels come from `labelCall`:
- the runner labels ground calls correct when verify passed and incorrect when verify failed or the agent picked a different ref;
- the eval harness labels its calls.
- [ ] Tests on synthetic labels: bins and ECE are computed correctly; the recommendation is the lowest threshold whose precision ≥ the target.
- [ ] Commit `feat(calibration): reliability bins and threshold recommendations`.

### Task 24: Install, live acceptance, docs

- [ ] `README.md` (English): install, the extension load plus pairing, settings, tools, delivery modes, debugging, the safety model, troubleshooting.
- [ ] Put the provided OpenRouter key into the user config via `jev settings set providers.openrouter.apiKey -` (stdin). Never commit it.
- [ ] Run `npm test`, `JEV_LIVE=1 npm run test:live`, `JEV_LIVE=1 npm run eval`; record the results.
- [ ] `jev install` for real; verify `claude mcp list` shows jev-browser connected; build the extension.
- [ ] Live acceptance: run the spec §1 aviasales task through the daemon with the chromium driver (headful); record the result, the escalations and the trace link.
- [ ] Commit `docs: README and acceptance notes`.

---

## Self-review notes

- Spec coverage:
  - §2 providers → T3; §3 components/daemon/drivers → T4, T5, T10, T18; §4 perception → T7;
  - §5 questions/thresholds → T2, T9, T13; §6 loop/extraction/escalation/result → T15, T16;
  - §7 safety → T14, T8, T16; §8 MCP/delivery → T11, T17; §9 UI/trace → T8, T20, T21;
  - §10 settings → T2; §11 memory → T22; §12 errors → T3, T5, T10, T16, T18;
  - §13 tests → every task plus T12; §14 stages → this plan.
- The spec's multi-package layout is simplified to a single package with the same component folders.
