# T12 — unmodified MCP client against the local router

**Date:** 2026-07-29 (overnight session)
**Result: Claude Code cannot be driven against this router today.** Claude Code
2.1.220's MCP client speaks protocol version `2025-11-25` and does not attempt
the `server/discover` upgrade to `2026-07-28`. The handshake fails before any
tool is listed. The PRD says to state this plainly rather than substitute the
scripted client and call it done — this document is that statement, with the
evidence, plus where the requestState-echo proof actually stands.

## Setup

- The real router, served over Streamable HTTP on `127.0.0.1:4409/mcp`
  (`t12-server.mjs`: settlement mocked, index/gateway/upstream legs
  fixture-backed so the protocol proof spends nothing; the client↔router wire
  is fully real, `legacy: 'reject'` per the PRD — `supportedVersions:
  ["2026-07-28"]` only).
- Client: stock Claude Code 2.1.220 (`claude --version`), headless
  (`claude -p`), the router registered via `claude mcp add --transport http`.
  No modifications of any kind.

## What happened, verbatim

Claude Code's own `claude mcp list` output for the server:

```
router-poc: http://127.0.0.1:4409/mcp (HTTP) - ✘ Failed to connect — HTTP 400:
{"code":-32022,"message":"Unsupported protocol version: 2025-11-25",
 "data":{"supported":["2026-07-28"],"requested":"2025-11-25"}}
```

The headless session reported (its own words): "My client advertises MCP
protocol version `2025-11-25`; the server accepts only `2026-07-28`. Since the
connection dies at `initialize`, no tool list is ever exchanged, so `invoke` is
never registered. … Interruptions / approval prompts encountered: zero."

Three registration routes were tried first (project-scope `.mcp.json`,
`--mcp-config` with relative and absolute paths); all reached the same
handshake and the same `-32022`. The router's rejection is the spec-correct
answer from a modern-strict server; the client never sends `server/discover`.

## Why this is a version gap, not a router bug

The 2026-07-28 revision and its SDK were published on 2026-07-27/28 — the day
before this session. Client-side negotiation in the v2 SDK is opt-in
(`versionNegotiation`, default `'legacy'`); Claude Code has not yet opted in.
The scripted SDK v2 client in this repo needed the same explicit
`versionNegotiation: { mode: { pin: '2026-07-28' } }` to connect (see
`test/t1-discover.test.js`) — an unpinned SDK v2 client behaves exactly like
Claude Code does here.

## Where the requestState-echo proof stands instead

The load-bearing claim — an opaque `requestState` blob carried through a
client and echoed back verbatim — is proven at the wire level, not by Claude
Code:

- `test/t1-discover.test.js`: a stock `@modelcontextprotocol/client@2.0.0`
  (unmodified, version-pinned) completes `server/discover` and lists tools.
- `test/t7-invoke.test.js` / `t8` / `t9`: the full MRTR loop over raw
  Streamable HTTP requests speaking the PRD section 7 wire shapes byte for
  byte — cold call → `input_required` + blob, retry with the blob echoed
  verbatim → settle → capture → receipt; tampered, replayed, wrong-principal,
  and declined variants all refused.

What is missing is only the "big-name client" form of the demo. To re-run it
when Claude Code ships 2026-07-28 support:

```
node <scratch>/t12/t12-server.mjs            # or rebuild the rig from this doc
claude mcp add --transport http router-poc http://127.0.0.1:4409/mcp
claude -p "Call invoke on router-poc with capability='llm-completion
claude-fable', input='...', max_price_usd=1.0; approve any price ≤ $1."
```
