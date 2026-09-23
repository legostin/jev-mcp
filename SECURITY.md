# Security policy

jev-mcp drives a real browser, so we take safety seriously:

- API keys live only in `~/.config/jev-browser/config.json` (mode 0600) or the environment; tools never return them and the trace store refuses to persist anything that looks like a key.
- Params marked `secret: true` are typed by code and never sent to JEV.
- The daemon listens on a 0600 unix socket and on 127.0.0.1 only; the Chrome extension must be paired with a one-time code.
- Irreversible actions (payments, orders, messages, deletions) always require confirmation unless explicitly allowed.

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub's "Report a vulnerability" (Security → Advisories) on this repository rather than in a public issue. You will get a response within a few days.
