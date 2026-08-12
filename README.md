# etim-json

**The [ETIM](https://www.etim-international.com/) classification model as clean JSON — convert, validate, generate TypeScript types, search, and serve to AI agents over [MCP](https://modelcontextprotocol.io/).**

ETIM is the open classification standard for technical products — the shared
language of electrical wholesale, HVAC, building products and industrial
supply across much of Europe and North America. It is published as API
responses and exchange files aimed at PIM systems. This tool turns a release
into one canonical, validated, diffable JSON file, and then makes that file
useful: typed for your compiler, searchable from your terminal, and queryable
by any MCP-capable AI assistant.

**This package ships no ETIM data.** The model belongs to ETIM International
and its community, published under
[ODC-BY 1.0](https://opendatacommons.org/licenses/by/1-0/) — free to use with
attribution. You convert the model you are licensed to download; the
attribution travels inside every file this tool writes.

## Try it in ten seconds

No credentials, no data, no config — a bundled **synthetic** demo model:

```bash
npx etim-json mcp --demo
```

Or in Claude Code:

```bash
claude mcp add etim-demo -- npx -y etim-json mcp --demo
```

Then ask: *"What features does an installation cable have in the ETIM demo
model?"* Every response is stamped `SYNTHETIC DEMO DATA` — the demo shows the
tool's shape, deliberately not the real classification.

## The real model

Request API credentials from
[ETIM International](https://etimapi.etim-international.com/) (free for
members; ETIM says non-members can ask their local country office), then:

```bash
export ETIM_CLIENT_ID=… ETIM_CLIENT_SECRET=…
npx etim-json fetch -o etim.json --release ETIM-10.0 --languages EN,DE
npx etim-json validate etim.json
npx etim-json stats etim.json
```

And serve it to your assistant:

```json
{
  "mcpServers": {
    "etim": {
      "command": "npx",
      "args": ["-y", "etim-json", "mcp", "--model", "/path/to/etim.json"]
    }
  }
}
```

That config works as-is in Claude Desktop, Claude Code (`claude mcp add etim
-- npx -y etim-json mcp --model /path/to/etim.json`), Cursor, and anything
else that speaks MCP over stdio.

## What the MCP server exposes

Five read-only tools over the loaded model — the server writes nothing,
reaches nothing over the network, and no tool accepts a filesystem path:

| Tool | Answers |
| --- | --- |
| `etim_model_info` | Which release am I querying, how big is it, whose data is it? |
| `etim_search_classes` | "Find the class for a residual current breaker" — by name, synonym, translation or code |
| `etim_get_class` | The full definition: features, types, units, permitted values |
| `etim_lookup` | Any code — `EC…`, `EG…`, `EF…`, `EV…`, `EU…` — identified and described |
| `etim_list_groups` | The top-level map of what the model covers |

Every tool declares `readOnlyHint` and returns structured content alongside
prose, so agents can consume results as data rather than re-parsing text.

## CLI

```
etim-json demo -o demo.json               synthetic demo model
etim-json fetch -o etim.json [options]    convert via the ETIM API
etim-json validate <model> [--strict]     exit 1 on errors (--strict: also warnings)
etim-json stats <model>                   counts, languages, provenance
etim-json search <model> <query>          find classes
etim-json class <model> EC003024          one class in full
etim-json lookup <model> EU570448         identify any code
etim-json types <model> -o etim.d.ts      TypeScript declarations
etim-json mcp --model <file> | --demo     serve over MCP (stdio)
```

Every command is quiet, composes with pipes, exits non-zero on failure, and
takes `--json` for machine-readable output.

## Generated types

```bash
npx etim-json types etim.json -o etim.d.ts
```

gives your compiler literal unions of the codes actually present in your
release:

```ts
import type { EtimClassCode, EtimClassMap } from "./etim.d.ts";

const cable: EtimClassCode = "EC000034"; // typo → compile error
```

Unions over 4,000 members widen to `string` with the cap noted in the emitted
comment — visible, not silent.

## The format

One JSON object per release. Vocabularies are global dictionaries; classes
bind features to class-specific units and value lists — the same shape ETIM
itself has:

```jsonc
{
  "formatVersion": 1,
  "kind": "etim-model",
  "release": "ETIM-10.0",
  "languages": ["DE"],
  "source": { "type": "etim-api", "apiVersion": "ETIM API 2.0", "retrievedAt": "…" },
  "attribution": { "licence": "ODC-BY 1.0", "statement": "Contains information from the ETIM classification model…" },
  "groups":   { "EG000017": { "description": "…" } },
  "features": { "EF000008": { "type": "N", "description": "…" } },
  "values":   { "EV000123": { "description": "…" } },
  "units":    { "EU570448": { "description": "…", "abbreviation": "mm" } },
  "classes":  {
    "EC000034": {
      "version": 9,
      "groupCode": "EG000017",
      "features": [{ "code": "EF000008", "orderNumber": 1, "unitCode": "EU570448" }]
    }
  }
}
```

Serialisation is canonical — sorted keys, stable arrays — so two conversions
of the same release diff clean, and a re-fetch shows you exactly what changed.

The validator enforces referential integrity (every `unitCode` resolves, no
class binds a feature twice) as **errors**, and flags surprises (an
alphanumeric feature with no value list) as **warnings** — because the
published model has legitimate exceptions, and a validator that cries wolf
teaches people to skip it.

## Library

Everything the CLI does is importable:

```ts
import { parseModelJson, assertModel, searchClasses, getClass } from "etim-json";
import { readFileSync } from "node:fs";

const model = assertModel(parseModelJson(readFileSync("etim.json", "utf8")));
const [hit] = searchClasses(model, "Leitungsschutzschalter", { language: "DE" });
const mcb = getClass(model, hit.code);
```

## What is verified, and what is not

Honesty section, in the spirit of the tool:

- **Verified:** the transform is built and tested against the
  [public ETIM API 2.0 contract](https://etimapi.etim-international.com/swagger/index.html)
  (fetched 2026-08-12), with fixtures shaped exactly by that contract. The MCP
  server is tested through a real client handshake and a real stdio
  child-process session, including hostile frames. 54 tests, including a
  dedicated adversarial suite (prototype-pollution smuggling, dangling
  references, regex injection, oversized inputs).
- **Not yet verified live:** an end-to-end `fetch` against the production API
  needs credentials we don't put in CI. If a page shape ever disagrees with
  the published contract, `validate` will catch the damage — please open an
  issue with the (redacted) response.
- **Not yet supported:** the IXF file format (ETIM's XML release format) and
  CMT CSV exports. Both are planned; both will be built against their format
  descriptions, not guesses.

## Security posture

- The MCP server holds one read-only dataset chosen by the operator at
  startup. No tool takes a path, URL or credential.
- Model files are parsed with a prototype-pollution guard, a size ceiling and
  BOM tolerance; hostile keys are rejected at the door.
- The API fetcher paces itself: sequential pages, a delay between them, one
  backoff retry. Tools that get their users rate-banned are worse than slow
  tools.
- Two runtime dependencies: the official MCP SDK and zod. No transitive
  surprises to audit.

## Licensing

- **This software:** MIT.
- **The ETIM model:** © ETIM International and its community, licensed
  [ODC-BY 1.0](https://opendatacommons.org/licenses/by/1-0/). Attribution is
  required for public use, and notices must stay intact — which is why every
  file this tool writes carries the attribution inside it. This project is not
  affiliated with or endorsed by ETIM International.
- **The bundled demo model:** synthetic, invented for this tool, and useless
  as classification. It exists so you can try the interface without touching
  licensed data.

## Documentation

- [`docs/TOOLS.md`](docs/TOOLS.md) — the complete MCP tool reference: schemas, annotations, worked request/response pairs, example prompts, error behaviour
- [`docs/FORMAT.md`](docs/FORMAT.md) — the normative etim-json format specification
- [`SECURITY.md`](SECURITY.md) — threat model and how to report
- [`CONTRIBUTING.md`](https://github.com/M-Heath-Consulting/etim-json/blob/main/CONTRIBUTING.md) · [`CODE_OF_CONDUCT.md`](https://github.com/M-Heath-Consulting/etim-json/blob/main/CODE_OF_CONDUCT.md) · [`CHANGELOG.md`](CHANGELOG.md)

## Why this exists

Built by [Partsgraph](https://partsgraph.ai) — we make manufacturer and
distributor catalogues readable to AI agents, and ETIM is the backbone
vocabulary of that work. We benchmarked 984 industrial catalogues on
AI-readability ([the data is public](https://partsgraph.ai/research/ai-visibility-benchmark-2026));
zero of them exposed a machine-readable classification interface. This is a
small tool against a large gap.
