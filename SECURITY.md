# Security

## Reporting

Email **security@partsgraph.ai**. You will get a human reply within 72
hours. Please include a reproduction; please do not open a public issue for
anything exploitable before we have shipped a fix.

## Threat model

The attack surface is deliberately small, and the claims below are enforced
by tests in [`test/adversarial.test.ts`](https://github.com/M-Heath-Consulting/etim-json/blob/main/test/adversarial.test.ts):

**The MCP server**

- Read-only by construction: no tool mutates anything, and the annotations
  say so (`readOnlyHint: true`, `openWorldHint: false`).
- No tool accepts a filesystem path, URL, or credential. The dataset is
  chosen by the operator at process start (`--model`/`ETIM_JSON_MODEL`/
  `--demo`); an agent can query it, never redirect it.
- No network access at serve time. The only networked code path is the
  explicit `fetch` CLI command, which talks to the ETIM API with credentials
  the operator supplies.
- All tool arguments are schema-validated (bounded lengths, bounded limits,
  anchored code patterns); all structured outputs are validated against the
  declared output schema before returning.
- A malformed frame on stdin is discarded by the transport; the server keeps
  serving (tested with a real child process and a hostile pipe).

**Model files (untrusted input)**

- Prototype-chain keys (`__proto__`, `constructor`, `prototype`) are refused
  at parse time, anywhere in the document.
- Input size is bounded (512 MB) before parse; UTF-8 BOM tolerated.
- Referential integrity is validated before serving; the server will not
  start on a model that fails.
- Search treats queries as literal text — no regex construction from input —
  and stays linear-time on pathological lengths.

**The API fetcher**

- Sequential, paced requests with a bounded page count and a hard class
  ceiling; one backoff retry on 429/5xx. Credentials come from flags or
  environment, are used for the token exchange only, and are never written
  to disk or embedded in output files.

**Supply chain**

- Two runtime dependencies: `@modelcontextprotocol/sdk` and `zod`.
- CI runs typecheck, the full suite (including the adversarial suite) and a
  pack inspection on Node 20/22/24.

## Out of scope

- The confidentiality of an ETIM model file on the operator's own disk —
  file permissions are the operating system's job.
- Denial of service by the operator against their own process (e.g. pointing
  `--model` at `/dev/zero` — the size ceiling refuses it, but resource
  limits are the operator's).
