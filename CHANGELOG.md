# Changelog

## 0.1.1 — 2026-08-12

- Added `mcpName` to `package.json`, matching the server name in `server.json`
  (`ai.partsgraph/etim-json`). The Official MCP Registry verifies npm package
  ownership through this field; without it, publication is rejected. No code or
  behaviour changes.

## 0.1.0 — 2026-08-12

Initial release.

- Canonical `etim-json` model format (formatVersion 1): normalised
  vocabularies, class-centric feature bindings, embedded ODC-BY attribution,
  canonical serialisation.
- Validator: referential integrity as errors, model surprises as warnings,
  JSON-path locations on every finding.
- ETIM API 2.0 adapter: OAuth2 client-credentials fetch with polite paging,
  and a pure transform tested against the public swagger contract
  (fetched 2026-08-12).
- Synthetic demo model (`--demo`) — clearly marked, never real classification.
- TypeScript declaration generation with capped literal unions.
- Search: case- and diacritic-folded (ß→ss), synonym- and translation-aware,
  rank-stable.
- MCP server (stdio): five read-only tools with annotations and structured
  content; synthetic data flagged in every response.
- 142 tests including an adversarial suite (prototype-pollution smuggling,
  dangling references, regex injection, hostile stdio frames against the
  built binary).

Hardened before release against input that is structurally plausible, passes
validation, and then means something different downstream:

- Provenance is checked, not assumed: `retrievedAt` must be a real ISO-8601
  instant — calendar-valid, offset in range, no fractional seconds past
  24:00:00, no leap second JavaScript cannot represent.
- A model must be plain data. Sparse arrays, custom iterators, index accessors
  and non-enumerable getters could each show the validator one value and a
  consumer another; all are refused. `validateModel` never throws, enforced at
  the boundary because a Proxy over an array can trap every form of reflection.
- The adapter refuses what it cannot convert faithfully: code-less permitted
  values, unit objects without codes, classes repeated across pages, and
  pagination totals inconsistent with the cursor.
- Translation handling keeps every English record rather than the first, and
  language keys keep their canonical casing.
- The CLI enforces its size ceiling before materialising a file and while
  streaming a pipe, and composes with process substitution again.

Planned: IXF (ETIM XML release format) importer · CMT CSV importer ·
`DetailsDiff`-based release diffing.
