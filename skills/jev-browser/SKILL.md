---
name: jev-browser
description: Drive a real Chrome browser through JEV (TypeSafe's fast decision model) with the jev-browser MCP tools - hand off multi-step web tasks (search, fill forms, compare offers, extract results), inspect pages cheaply, and answer JEV's questions when it is unsure. Use when the user asks to do something on a website, to use JEV, or to automate or debug browser work.
---

# JEV Browser

JEV is a *System One* model: it makes typed decisions (which element, which option, did it work) in ~100 ms for fractions of a cent,
with calibrated confidence. It **does not write text or plan**. You plan and supply data; JEV executes and asks you when unsure.

## Choose the tool

| Need | Tool |
|---|---|
| A multi-step goal (search, book up to payment, compare, collect data) | `jev_task`, then wait for events |
| See what is on a page | `jev_observe` (overview → region → element); never ask for raw HTML |
| Find an element by description | `jev_find` ("the departure city input") |
| Your own quick judgment about a page | `jev_ask` with noul/choice/score questions |
| One precise action | `jev_act` with a ref from observe/find, or an intent |
| Vision (canvas, images, charts) | `jev_screenshot` |
| Why JEV did something | `jev_trace` (links to the debug UI and the TypeSafe playground) |

## Writing a task

```json
{
  "goal": "Find the cheapest flight ticket from Almaty to Antalya departing in October 2026",
  "site": "https://www.aviasales.kz",
  "params": {
    "from":   { "value": "Алматы",  "about": "departure city" },
    "to":     { "value": "Анталия", "about": "destination city" },
    "period": { "value": { "from": "2026-10-01", "to": "2026-10-31" }, "about": "departure date" }
  },
  "result": { "schema": { "price": "money", "airline": "string", "depart": "time", "url": "url" }, "select": "min(price)" }
}
```

- `goal`, `about` and `hints` in **English** (JEV is most accurate in English). Param **values exactly as the site expects** (`"Алматы"`).
- Dates as `YYYY-MM-DD` or a `{from,to}` range; booleans for checkboxes.
- Put credentials in params with `"secret": true` — JEV never sees their values; never put secrets in goal or hints.
- `result.schema` field types: string, number, money, datetime, date, time, duration, url, boolean. `select`: all | first | min(f) | max(f).
  Minimums, dates and parsing are done in code, so they are exact.
- Useful `policy`: `confidence` (see below), `irreversible: "ask" | "allow"`, `allowed_domains`, `max_steps`, `budget_usd`, `max_items`.

## While a task runs

The task never blocks you. Questions reach you through:

1. `<channel source="jev-browser" task_id=… question_id=…>` events (Claude Code started with channels);
2. the block "JEV is waiting for your answer" appended to **every** jev tool result;
3. `jev_wait {task_id}` (up to 55 s);
4. in Claude Code: run `jev watch <task_id>` **in the background**; it exits on the next question or when the task ends, which wakes you.

Answer with `jev_answer`:

| Question kind | Typical answer |
|---|---|
| `ground` (which element?) | `pick` a candidate ref; add `remember: true` if it will recur on this site |
| `subintent` (what next?) | `pick` a step id, or `hint` |
| `missing_param` | `set_param` with key/value/about, or ask the user first |
| `risk_confirm` (pay, send, delete…) | `continue` only if the user asked for it; otherwise `skip` or `abort` |
| `blocker` (captcha, login wall) | ask the user to solve it in the browser, then `continue` |
| `stuck` | look with `jev_observe`/`jev_screenshot`, then `hint`, act yourself with `jev_act` and `continue`, or `abort` |

If JEV keeps asking about things it gets right, lower thresholds (`thresholds` answer or `jev_control update confidence`);
if it acts wrongly, raise them. `escalate: 0` means "never ask just because of low confidence".

## Confidence settings

Layers, lowest to highest precedence: global (`jev_settings confidence.*`), per domain (`domains.<host>.confidence`), per task
(`policy.confidence`), live (answer `thresholds` or `jev_control update`). Presets: `cautious`, `balanced` (default), `autonomous`.
Per decision kind: `overrides: {"ground.choice": {"act": 0.7, "escalate": 0.3}}` (kinds: assess, subintent, ground, verify, extract).

## Direct control tips

- Refs (`e12`) are stable across observations while the element exists; regions are `r3`.
- `[BLOCKING]` regions (consent walls, promos) must be dismissed first; covered elements report `occluded`.
- For autocompletes type with `options.mode: "keys"`, then `jev_observe view:"diff"` to see the suggestion popup.
- `jev_ask` state is built from the visible page; reference data as `` `page.elements.e12` `` / `` `page.regions.r3` ``.
  One judgment per question; JEV cannot count, compare numbers or dates, or generate text.

## Setup and troubleshooting

- `jev doctor` checks the key, JEV latency, Chrome and the extension. Keys: `jev settings set providers.openrouter.apiKey -` (stdin).
- Provider: `provider` = `openrouter` (model `typesafe/jev-1.13`) or `typesafe` (official API, `jev-latest`).
- Your own Chrome: load the extension (`jev install` prints the path), then `jev pair`. Otherwise jev uses its own Chrome profile.
- Debug UI: `jev ui`.
