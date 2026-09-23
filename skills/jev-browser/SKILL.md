---
name: jev-browser
description: Drive a real Chrome browser through JEV (TypeSafe's fast decision model) with the jev-browser MCP tools - hand off multi-step web tasks (search, fill forms, compare offers, extract results), inspect pages cheaply, and answer JEV's questions when it is unsure. Use when the user asks to do something on a website, to use JEV, or to automate or debug browser work.
---

# JEV Browser

JEV is a *System One* model. It makes typed decisions (which element, which option, did it work) in ~100 ms for fractions of a cent, and each decision comes with calibrated confidence. It **does not write text or plan**. You plan and supply the data; JEV executes and asks you when it is unsure.

## Choose the tool

| Need | Tool |
|---|---|
| A multi-step goal: search, fill a form, compare, collect data, book up to payment | `jev_task`, then follow its events |
| See what is on a page | `jev_observe` (overview → region → element → diff); never ask for raw HTML |
| Find an element by description | `jev_find` ("the departure city input") |
| A quick judgment about the page | `jev_ask` with noul / choice / score questions |
| One precise action | `jev_act` with a ref from observe/find, or with an intent |
| Vision: canvas, images, charts, or showing the user something | `jev_screenshot` |
| Why JEV did something | `jev_trace` (links to the debug UI and the TypeSafe playground) |
| Setup problems | `jev_doctor`, `jev_settings` |

## Choose the browser

- `driver: "extension"` is the user's own Chrome, with their logins, through the jev extension. Prefer it for sites with accounts, bot checks or CAPTCHAs (travel, shopping, banking), and whenever the user may need to step in.
- `driver: "chromium"` is jev's own Chrome profile. A headless profile cannot show a CAPTCHA to anyone, so do not use headless for sites with bot protection.
- The default `auto` uses the extension when it is connected. `jev_tabs` shows whether it is. If the user needs the extension and it is not connected, tell them to load it and run `jev pair`.

## Write a task

```json
{
  "goal": "Find the cheapest flight ticket from Almaty to Antalya departing in October 2026",
  "site": "https://flights.example.com",
  "params": {
    "from":   { "value": "Алматы",  "about": "departure city" },
    "to":     { "value": "Анталья", "about": "destination city" },
    "period": { "value": { "from": "2026-10-01", "to": "2026-10-31" }, "about": "departure date" }
  },
  "result": { "select": "min(price)" }
}
```

- Write `goal`, `about` and `hints` in **English**: JEV is most accurate in English. Give param **values exactly as the site expects them**: `"Алматы"`, not a translation.
- Dates go as `YYYY-MM-DD` or a `{from,to}` range. A range lets JEV pick the cheapest or earliest day in a low-fare calendar; code does the date math.
- Use booleans for checkboxes.
- Credentials go into params with `"secret": true`. JEV never sees those values. Never put secrets in goal or hints.
- `result` makes the task end on the results. With `select: "min(price)"` or `"max(stars)"` JEV first sorts the list on the site. Then **you get the results list**: one line per item (title, price, short texts, link). Read it and pick the answer yourself: skip accessories, spare parts, sponsored or unrelated items, and report the chosen item with its link. `result.pages` (default 1) reads more pages or "show more" loads first.
- `result.extract: "code"` parses items in code by `result.schema` (field types: string, number, money, datetime, date, time, duration, url, boolean) and applies `select`. Use it for bulk collection over many pages, where the text list would be too long.
- Useful `policy` fields: `confidence` (see below), `irreversible: "ask" | "allow"`, `allowed_domains`, `max_steps`, `budget_usd`, `max_items`.
- The task handles common site behaviour on its own:
  - consent banners;
  - fields the site prefilled;
  - autocomplete suggestions;
  - results that open in a new tab (JEV picks the tab and the task moves there);
  - "show more" pagination.

## While a task runs

`jev_task` returns immediately, and the task never blocks you. Questions reach you through:

1. `<channel source="jev-browser" task_id=… question_id=…>` events, when Claude Code runs with channels;
2. the block "JEV is waiting for your answer" appended to **every** jev tool result;
3. `jev_wait {task_id}`, which waits up to 55 s;
4. in Claude Code, **`jev watch <task_id>` run in the background** (Bash with `run_in_background`). It prints the event as JSON and exits on the next question or when the task ends, and that exit wakes you. After you answer, start it again.

Answer with `jev_answer`. Look first (`jev_observe`, `jev_screenshot`) when the question is not obvious.

| Question kind | Typical answer |
|---|---|
| `ground` (which element?) | `pick` a candidate ref, with `remember: true` if it will recur on this site. If the target is not on the page (for example it sits behind "advanced search"), answer `none` and add a `hint` with `scope: "domain"` in a later answer if the site needs one. If the summary says "Already tried and rolled back", those elements did not work: pick another one or give a hint. |
| `subintent` (what next?) | `pick` a step id, or give a `hint` |
| `missing_param` | `set_param` with key, value and about. Ask the user first if you do not know the value. |
| `risk_confirm` (pay, order, send, delete…) | `continue` only if the user explicitly asked for this action; otherwise `skip` or `abort` |
| `blocker`: CAPTCHA or bot check | Ask the user to solve it in the visible browser, then answer `continue`. If the context says `headless: true`, nobody can solve it: `abort` and rerun the task with `driver: "extension"`, or with jev's Chrome after `jev_settings set driver.chromium.headless false`. |
| `blocker`: login wall | Ask the user to sign in in that tab (or pass credentials as secret params in a new task), then `continue` |
| `stuck` | Observe or take a screenshot, then send a `hint`; or act yourself with `jev_act` and answer `continue`; or `abort` |

Do not answer `continue` to a blocker you have not resolved: the task will only ask again.

When the task ends, report the result with its evidence URL. `jev_result` gives the full item list.

## Confidence settings

Every JEV decision has a confidence. Above `act` the task acts on its own; below `escalate` it asks you; in between it takes a second look.

The settings stack in layers, from lowest to highest precedence:
1. global: `jev_settings confidence.*`;
2. per domain: `domains.<host>.confidence`;
3. per task: `policy.confidence`;
4. live: a `thresholds` answer or `jev_control update`.

- Presets: `cautious`, `balanced` (default), `autonomous`.
- Per decision kind: `overrides: {"ground.choice": {"act": 0.7, "escalate": 0.3}}`. The kinds are assess, subintent, ground, verify, extract.
- `escalate: 0` means "never ask just because confidence is low".
- Trials: reversible steps (fields, chips, dropdowns, date pickers, "more filters", sorting, overlays) act on the best candidate down to `trial.floor` (default 0.25), verify the effect, roll back and try the next, up to `trial.tries` (default 2). You are asked only after that, and the question lists what was tried. Set `policy.confidence.trial` (`enabled`, `floor`, `tries`) to change it; submits never use trials.
- A hint you give in answer to a question about one step is bound to that step's param, so it will not confuse other steps. Put hints that apply everywhere into the task's `hints`.
- If JEV keeps asking about things it gets right, lower the thresholds. If it acts wrongly, raise them. `jev calibrate` in a terminal suggests values based on past decisions.

## Direct control tips

- Refs (`e12`) stay stable across observations while the element exists. Regions are `r3`.
- A `[BLOCKING]` region (consent wall, modal) must be dismissed first. Clicking a covered element returns `occluded`; `options.force` clicks anyway.
- For autocompletes, type with `options.mode: "keys"`, then run `jev_observe view:"diff"` to see the suggestion popup.
- `jev_ask` builds its state from the visible page. Reference data as `` `page.elements.e12` `` or `` `page.regions.r3` ``. Ask one judgment per question. JEV cannot count, compare numbers or dates, or generate text; do that yourself.

## Setup and troubleshooting

- `jev_doctor` checks the key, JEV latency, Chrome and the extension. Keys are set in a terminal: `jev settings set providers.openrouter.apiKey -` (reads stdin).
- Provider: `provider` = `openrouter` (model `typesafe/jev-1.13`) or `typesafe` (official API, `jev-latest`).
- Extension: load `dist/extension` unpacked in `chrome://extensions` (Developer mode), then run `jev pair` and enter the code in the side panel.
- Debug UI: `jev ui` prints a local link that shows every step, JEV's probabilities, screenshots and replay.
