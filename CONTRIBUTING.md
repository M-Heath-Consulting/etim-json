# Contributing

Small tool, small rules.

- `npm run verify` must pass — typecheck, all 54+ tests, build. CI runs the
  same on Node 20/22/24.
- **Never commit ETIM model data** — not as a fixture, not as an example. The
  model is ETIM International's to distribute (ODC-BY). Test fixtures are
  synthetic, in the `EC99xxxx` code range, with "demo"/"fixture" in every
  description.
- New behaviour lands with a test; hostile-input behaviour lands with a test
  in `test/adversarial.test.ts`.
- The transform is built against the public ETIM API 2.0 swagger contract. If
  the live API disagrees with the contract, open an issue with a **redacted**
  response — we fix against evidence, not memory.

Most useful contributions right now, in order:

1. A real-world `fetch` report (does the live API match the contract?).
2. The IXF importer — built from ETIM's format description document, with
   synthetic fixtures.
3. Release diffing via `Class/DetailsDiff`.
