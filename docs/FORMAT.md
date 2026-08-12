# The etim-json model format — specification

**formatVersion: 1** · media type `application/json` · UTF-8 · one release
per file.

This is the normative description of the format the tool reads and writes.
The reference implementation is [`src/model.ts`](https://github.com/M-Heath-Consulting/etim-json/blob/main/src/model.ts) (shape) and
[`src/validate.ts`](https://github.com/M-Heath-Consulting/etim-json/blob/main/src/validate.ts) (rules); where prose and code
disagree, the code is the spec and the disagreement is a bug worth reporting.

## Design intent

Faithful, normalised, checkable:

- **Faithful** — field semantics follow the public ETIM API 2.0 contract.
  Sector letters stay letters, feature types stay `A`/`L`/`N`/`R`, versions
  and deprecations are carried, not interpreted. Nothing is editorialised.
- **Normalised** — features, values, units and groups are global
  vocabularies, exactly as ETIM defines them; classes *bind* them. Each
  entity is stated once.
- **Checkable** — every cross-reference is by code into a dictionary, so
  integrity is mechanically verifiable (`etim-json validate`).

## Top level

| Field | Type | Req | Description |
| --- | --- | --- | --- |
| `formatVersion` | `1` | ✓ | Breaking changes bump it; readers must refuse versions they don't know |
| `kind` | `"etim-model"` | ✓ | File-type discriminator |
| `release` | `string` | ✓ | As issued: `"ETIM-10.0"`, or `"DYNAMIC"` for the continuously-published model |
| `languages` | `string[]` | ✓ | Translation languages actually present in this file, uppercased, sorted — **derived from the retained data, not from what was requested**. Regional forms appear as issued (`DE-DE`). English is the base text and is never listed |
| `source` | `object` | ✓ | `{ type: "etim-api" \| "demo" \| "custom", retrievedAt?, apiVersion? }` |
| `attribution` | `object` | ✓ | `{ licence, licenceUrl, statement }` — see Licensing below |
| `synthetic` | `boolean` | – | `true` only for invented data; consumers must surface it |
| `groups` | `record` | ✓ | key `EG\d{6,8}` → group entry |
| `features` | `record` | ✓ | key `EF\d{6,8}` → feature entry |
| `values` | `record` | ✓ | key `EV\d{6,8}` → value entry |
| `units` | `record` | ✓ | key `EU\d{6,8}` → unit entry |
| `classes` | `record` | ✓ | key `EC\d{6,8}` → class entry |

Code widths are validated 6–8 digits: the published model uses six today, and
a format that hard-fails on a future seventh digit would rot silently.

## Entries

Common shape (`Described`): every entry has `description` (English, required,
non-empty) and optional `translations: { [LANG]: string }`.

**Group** — `Described` only.

**Feature** — adds `type: "A" | "L" | "N" | "R"` and optional
`deprecated: true`.

| Type | Meaning | Typical binding |
| --- | --- | --- |
| `A` | Alphanumeric — pick from a class-specific value list | `valueCodes` |
| `L` | Logical — true/false | none |
| `N` | Numeric — one value | `unitCode` where defined |
| `R` | Range — two numerics | `unitCode` where defined |

**Value** — `Described` plus optional `deprecated`.

**Unit** — `Described` plus required `abbreviation` (may be empty string,
must exist), optional `abbreviationTranslations`, optional `deprecated`.

**Class**

| Field | Type | Req | Notes |
| --- | --- | --- | --- |
| `version` | positive integer | ✓ | Classes are versioned individually by ETIM |
| `groupCode` | `string` | ✓ | Must exist in `groups` |
| `description` | `string` | ✓ | English |
| `translations` | record | – | Per language |
| `synonyms` | `string[]` | – | English search synonyms as published |
| `synonymTranslations` | record of `string[]` | – | Per language |
| `sectors` | `string[]` | – | Sector letters exactly as issued (e.g. `"E"`). The letter→name mapping is ETIM's to define, so this format does not embed one |
| `features` | array | ✓ | Bindings, below. May be empty (warned, not refused) |

**Feature binding** (inside `classes[*].features[]`)

| Field | Type | Req | Notes |
| --- | --- | --- | --- |
| `code` | `string` | ✓ | Must exist in `features`; unique within the class |
| `orderNumber` | positive integer | ✓ | Published order; duplicates warn |
| `unitCode` | `string` | – | Must exist in `units` |
| `unitImperialCode` | `string` | – | Must exist in `units` |
| `valueCodes` | `string[]` | – | Every entry must exist in `values`; order is data |
| `deprecated` | `boolean` | – | |

## Validation contract

`etim-json validate` distinguishes:

- **Errors** (exit 1): wrong shapes, malformed codes, dangling references,
  duplicate bindings, missing attribution. The file is not a usable model.
- **Warnings** (exit 0, or 1 under `--strict`): empty classes, repeated
  order numbers, type/binding surprises (an `A` feature with no values, an
  `L` feature with a unit), unreferenced vocabulary. The published model has
  legitimate exceptions; a validator that hard-fails on the real world
  teaches people to skip it.

Every finding carries a JSON-path location (`$.classes["EC000034"].features[2].unitCode`).

## Serialisation

Canonical: dictionary keys sorted, arrays in published order (order is data —
feature sequence and value lists), two-space indent, LF, trailing newline.
Two conversions of the same release are byte-identical, so `diff` and
`git log` on model files mean something.

## Parsing rules for readers

Implementations reading this format should:

1. Refuse unknown `formatVersion`s.
2. Reject the prototype-chain keys `__proto__`, `constructor`, `prototype`
   anywhere in the document (this implementation refuses at parse).
3. Tolerate a UTF-8 BOM.
4. Bound input size before parsing (this implementation: 512 MB).
5. Treat unknown *additional* fields as ignorable — minor versions may add
   fields without bumping `formatVersion`.

## Licensing

`attribution` is a required, load-bearing field. The ETIM model is published
by ETIM International under
[ODC-BY 1.0](https://opendatacommons.org/licenses/by/1-0/), which requires
attribution and keeping notices intact when the data is shared. Embedding the
notice in the file is how a converted model cannot silently lose it. Files
with `source.type: "demo"` carry a statement identifying the content as
synthetic instead.
