/* Structural and referential validation of an etim-json model.
 *
 * Two severities, deliberately:
 *
 *   error — the file is not a usable model. Wrong shapes, dangling
 *           references, duplicate or malformed codes.
 *   warn  — the file is usable but says something surprising: a numeric
 *           feature bound with a value list, an alphanumeric one without,
 *           an empty class. The published model has legitimate exceptions,
 *           so surprises are reported, never fatal — a validator that
 *           hard-fails on the real world teaches people to skip it.
 *
 * Every finding carries a JSON-path-ish location so a 40 MB file is fixable
 * without a treasure hunt.
 */

import {
  CODE_SHAPE,
  FEATURE_TYPES,
  FORMAT_VERSION,
  type EtimModel,
  type FeatureType,
} from "./model.js";

export interface Finding {
  severity: "error" | "warn";
  path: string;
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  errors: Finding[];
  warnings: Finding[];
  /** Entity counts, for `stats` and for sanity-checking a conversion. */
  counts: { classes: number; groups: number; features: number; values: number; units: number };
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const isStr = (v: unknown): v is string => typeof v === "string";

/** True only for a *dense* array of strings, inspected by index.
 *
 *  `Array.prototype.every` skips holes, so a sparse array — `new Array(1)`, or
 *  `["a", , "c"]` — satisfied `arr.every(isStr)` and was then asserted as
 *  `string[]`. Two things followed: `serializeModel` writes a hole as `null`,
 *  so the file it produced failed validation when read back; and the asserted
 *  type promised `string` while handing a consumer `undefined`.
 *
 *  The obvious repair, `Array.from(v).every(isStr)`, trades that for something
 *  worse, because `Array.from` runs the value's `Symbol.iterator` — which the
 *  caller controls. An iterator that throws takes validateModel with it, and
 *  this function's contract is that it never throws. An iterator that lies is
 *  quieter and worse: `[42]` with an iterator yielding `"ok"` validates as a
 *  string array, and then `searchClasses` reads index 0 and gets the number.
 *
 *  So read the indices, which is the same thing every consumer does. */
const isStrArray = (v: unknown): v is string[] => {
  if (!Array.isArray(v)) return false;
  for (let i = 0; i < v.length; i++) {
    const slot = Object.getOwnPropertyDescriptor(v, i);
    /* undefined descriptor means a hole — absent, not present-and-undefined. */
    if (slot === undefined) return false;
    /* An accessor is refused rather than read. Reading it runs caller code,
       which can throw; and a stateful getter can answer "widget" here and 42
       to the consumer that reads it next, so the value validated would not be
       the value used. Taking .value off the descriptor also means the slot is
       read exactly once, so there is no gap to be stateful across. */
    if (!("value" in slot)) return false;
    if (typeof slot.value !== "string") return false;
  }
  return true;
};

/** Walk a caller-supplied array by index, yielding each slot.
 *
 *  `for...of` and spread both run the value's `Symbol.iterator`, and the caller
 *  owns that: it can throw — which validateModel must not do — or yield values
 *  that differ from the indexed elements every consumer actually reads, so a
 *  fabricated code could validate while `getClass` resolved the real one.
 *  Holes yield `undefined`, which every call site already rejects. */
function* byIndex(v: unknown): Generator<unknown> {
  if (!Array.isArray(v)) return;
  for (let i = 0; i < v.length; i++) {
    const slot = Object.getOwnPropertyDescriptor(v, i);
    /* Holes and accessors both yield undefined, which every call site already
       rejects — an accessor is not read, for the reasons in isStrArray. */
    yield slot !== undefined && "value" in slot ? slot.value : undefined;
  }
}

/** True only for a real ISO-8601 instant.
 *
 *  `Date.parse` is the wrong tool for a format contract: it accepts
 *  implementation-defined shapes like `12/31/2025`, and it silently rolls
 *  impossible calendar dates over — `2025-02-31` becomes 3 March and parses
 *  fine. Either way provenance ended up claiming a timestamp the format does
 *  not define, or a different date than the one written.
 *
 *  So check the structure explicitly, then confirm the calendar accepted the
 *  date unchanged by round-tripping the parsed components. */
const isIsoTimestamp = (v: string): boolean => {
  const m =
    /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(?:[Zz]|([+-])(\d{2}):(\d{2}))$/.exec(v);
  if (!m) return false;
  const [, y, mo, d, h, mi, s, frac, , offH, offM] = m;
  const year = Number(y), month = Number(mo), day = Number(d);
  const hour = Number(h), minute = Number(mi), second = s === undefined ? 0 : Number(s);
  if (month < 1 || month > 12 || day < 1) return false;
  /* Leap years included: day 0 of the next month is the last day of this one. */
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (day > daysInMonth) return false;
  /* 24:00 is legal in ISO-8601 but only as exactly 24:00:00. The fraction has
     to be captured to say that: matching it as a non-capturing (?:\.\d+)? left
     the hour === 24 test looking at a zero second while .123 sat in the string,
     so 24:00:00.123 — an instant past the end of the day — validated. */
  const fracZero = frac === undefined || /^0+$/.test(frac);
  if (hour > 24 || (hour === 24 && (minute !== 0 || second !== 0 || !fracZero))) return false;
  /* Second 60 is refused outright rather than allowed at its one legal
     position. A leap second only ever falls at the end of a UTC day, so
     12:34:60 was never an instant to begin with — but the reason not to bother
     validating placement is that JavaScript cannot represent a leap second at
     all: V8 returns Invalid Date for `new Date("2016-12-31T23:59:60Z")`, even
     though that one is real. Accepting it would hand consumers provenance that
     yields NaN the moment they parse it, so the stricter bound is also the more
     useful one. Nothing here emits a 60 either — every timestamp the library
     generates comes from toISOString(). */
  if (minute > 59 || second > 59) return false;
  /* The offset needs the same treatment as the clock. Matching [+-]\d{2}:\d{2}
     as one opaque blob accepted +99:99, which is not a timestamp any parser
     agrees on. RFC 3339 bounds each part separately — hour 00-23, minute 00-59
     — and that is the grammar to enforce, not the narrower range of offsets
     that happen to be in real-world use, which would reject valid input. */
  if (offH !== undefined && (Number(offH) > 23 || Number(offM) > 59)) return false;
  return true;
};

/** JSON.stringify throws on BigInt and on cyclic objects, and validateModel's
 *  contract is that it never throws — a library caller may hand us anything.
 *  This formats for a message and cannot fail. */
function fmt(v: unknown): string {
  if (typeof v === "bigint") return `${v}n`;
  if (typeof v === "symbol") return v.toString();
  if (typeof v === "function") return "[function]";
  try {
    const out = JSON.stringify(v);
    return out === undefined ? String(v) : out;
  } catch {
    return Array.isArray(v) ? "[array]" : v === null ? "null" : `[${typeof v}]`;
  }
}

/** Describe a thrown value without trusting it.
 *
 *  The catch that guarantees this module never throws could itself throw,
 *  because every ordinary way of inspecting an exception runs code the thrower
 *  controls: `instanceof` walks the prototype chain, which a revoked Proxy
 *  refuses; `.message` may be a getter; and `String()` calls toString or
 *  Symbol.toPrimitive, which a null-prototype object does not have at all.
 *
 *  So each attempt is isolated and any failure falls through to a fixed
 *  string, which cannot fail. */
function describeThrown(e: unknown): string {
  /* typeof never throws, so the common case costs nothing. */
  if (typeof e === "string") return e;
  try {
    if (e instanceof Error) {
      const m: unknown = e.message;
      if (typeof m === "string") return m;
    }
  } catch {
    /* prototype chain or message getter refused — try the next form */
  }
  try {
    const s: unknown = String(e);
    if (typeof s === "string") return s;
  } catch {
    /* no usable string conversion */
  }
  return "a value that could not itself be described";
}

/** Validate an unknown parsed value as an EtimModel. Never throws.
 *
 *  That promise cannot be kept by defensive reads alone. A Proxy whose target
 *  is an array satisfies `Array.isArray`, and its traps intercept every way of
 *  looking at it — `p[0]`, `Object.getOwnPropertyDescriptor(p, 0)` and
 *  `Object.hasOwn(p, 0)` can each be made to throw. Each new guard would move
 *  the throw rather than remove it, so the guarantee is enforced here instead:
 *  anything that escapes becomes a finding, and callers still get a result. */
export function validateModel(input: unknown): ValidationResult {
  try {
    return validateModelUnguarded(input);
  } catch (e) {
    const detail = describeThrown(e);
    return {
      ok: false,
      errors: [
        {
          severity: "error",
          path: "$",
          message: `Model could not be inspected: reading it raised ${fmt(detail)}. This usually means a property accessor or Proxy trap on the input, which a data file cannot contain.`,
        },
      ],
      warnings: [],
      counts: { classes: 0, groups: 0, features: 0, values: 0, units: 0 },
    };
  }
}

function validateModelUnguarded(input: unknown): ValidationResult {
  const errors: Finding[] = [];
  const warnings: Finding[] = [];
  const err = (path: string, message: string) => errors.push({ severity: "error", path, message });
  const warn = (path: string, message: string) => warnings.push({ severity: "warn", path, message });

  /* Every Described entry's translation record is a documented shape, and an
     unchecked one reaches consumers typed as Record<string,string> while
     holding anything at all. */
  const checkTranslations = (v: unknown, path: string, arrays = false) => {
    if (v === undefined) return;
    if (!isRecord(v)) {
      err(path, `${arrays ? "synonymTranslations" : "translations"} must be an object keyed by language code.`);
      return;
    }
    for (const [lang, text] of Object.entries(v)) {
      /* The key's own casing is part of the format, not an incidental detail.
         `languages` is derived by uppercasing these keys, so a record written
         as `{ de: … }` alongside `languages: ["DE"]` used to agree with itself
         and validate — while the key stayed lowercase through serialization,
         leaving a consumer that indexes by the declared "DE" with nothing.
         Checking the key here keeps the two in step at the source. */
      if (lang === "") {
        err(path, "A translation is keyed by an empty language code.");
      } else if (lang !== lang.toUpperCase()) {
        err(
          `${path}["${lang}"]`,
          `Language codes are uppercase in this format — write ${fmt(lang.toUpperCase())}, not ${fmt(lang)}. Regional forms keep their issued shape (DE-DE).`,
        );
      }
      if (arrays) {
        if (!isStrArray(text)) {
          err(`${path}["${lang}"]`, "Synonym translations must be an array of strings.");
        }
      } else if (!isStr(text)) {
        err(`${path}["${lang}"]`, "Translation must be a string.");
      }
    }
  };

  const empty = { classes: 0, groups: 0, features: 0, values: 0, units: 0 };

  if (!isRecord(input)) {
    err("$", `Model must be a JSON object, got ${Array.isArray(input) ? "array" : typeof input}.`);
    return { ok: false, errors, warnings, counts: empty };
  }

  if (input.kind !== "etim-model") {
    err("$.kind", `Expected "etim-model", got ${fmt(input.kind)}.`);
  }
  if (input.formatVersion !== FORMAT_VERSION) {
    err(
      "$.formatVersion",
      `Expected ${FORMAT_VERSION}, got ${fmt(input.formatVersion)}. ` +
        "A newer format needs a newer etim-json.",
    );
  }
  if (!isStr(input.release) || input.release.trim() === "") {
    err("$.release", "Release label is required (e.g. \"ETIM-10.0\" or \"DYNAMIC\").");
  }
  if (!isStrArray(input.languages)) {
    err("$.languages", "languages must be an array of language-code strings (may be empty).");
  }
  /* All three attribution fields, all non-empty: the package's promise is
     that converted data keeps its ODC-BY notice, and `{ statement: "" }`
     silently defeated it. */
  if (!isRecord(input.attribution)) {
    err("$.attribution", "attribution is required — ODC-BY says keep notices intact.");
  } else {
    for (const field of ["licence", "licenceUrl", "statement"] as const) {
      const v = (input.attribution as Record<string, unknown>)[field];
      if (!isStr(v) || v.trim() === "") {
        err(`$.attribution.${field}`, `attribution.${field} is required and must be non-empty.`);
      }
    }
  }
  const SOURCE_TYPES = ["etim-api", "demo", "custom"] as const;
  if (!isRecord(input.source) || !isStr((input.source as Record<string, unknown>).type)) {
    err("$.source", "source.type is required (etim-api | demo | custom).");
  } else if ((SOURCE_TYPES as readonly string[]).includes(input.source.type as string)) {
    /* Both optional fields are declared as strings and callers read them off
       the validated object; unchecked, `retrievedAt: 42` survived the cast. */
    const src = input.source as Record<string, unknown>;
    if (src.retrievedAt !== undefined && !isStr(src.retrievedAt)) {
      err("$.source.retrievedAt", `retrievedAt must be an ISO timestamp string, got ${fmt(src.retrievedAt)}.`);
    } else if (isStr(src.retrievedAt) && !isIsoTimestamp(src.retrievedAt)) {
      err(
        "$.source.retrievedAt",
        `retrievedAt must be an ISO-8601 timestamp (e.g. 2026-08-12T09:30:00Z), got ${fmt(src.retrievedAt)}.`,
      );
    }
    if (src.apiVersion !== undefined && !isStr(src.apiVersion)) {
      err("$.source.apiVersion", `apiVersion must be a string, got ${fmt(src.apiVersion)}.`);
    }
  } else {
    /* Callers rely on the provenance type after validation, so it must be
       one of the documented values rather than any non-empty string. */
    err(
      "$.source.type",
      `source.type must be one of ${SOURCE_TYPES.join(" | ")}, got ${fmt(input.source.type)}.`,
    );
  }
  /* JSON.parse cannot produce an accessor, so one here means this object did
     not come from a model file — and the validate-then-trust contract depends
     on a consumer reading what the validator read. `synthetic` is the sharpest
     case: a getter returning true during these checks and false afterwards
     passes the demo-provenance rule, then buildServer sees false and drops the
     synthetic-data warning, serving invented classification as real.
     `source.type` carries the other half of that same invariant, so both the
     root and source are required to be plain data. */
  for (const [obj, where] of [
    [input, "$"],
    [isRecord(input.source) ? input.source : undefined, "$.source"],
  ] as const) {
    if (!isRecord(obj)) continue;
    /* Reflect.ownKeys, not Object.keys: a non-enumerable getter is invisible
       to Object.keys, so the previous scan could be stepped around simply by
       declaring `synthetic` non-enumerable. Symbols are included for the same
       reason — completeness costs nothing on a handful of keys. */
    for (const key of Reflect.ownKeys(obj)) {
      const slot = Object.getOwnPropertyDescriptor(obj, key);
      if (slot !== undefined && !("value" in slot)) {
        err(
          `${where}.${String(key)}`,
          `${String(key)} is a property accessor; a model is plain data, and a value that can change between validation and use is not provenance.`,
        );
      }
    }
  }

  /* Provenance must be unambiguous: a string "false" here reads as truthy in
     the MCP server (which would stamp every response synthetic) and as false
     in modelStats — the same model described two ways. */
  if (input.synthetic !== undefined && typeof input.synthetic !== "boolean") {
    err("$.synthetic", `synthetic must be a boolean when present, got ${fmt(input.synthetic)}.`);
  }
  if (input.synthetic === true && isRecord(input.source) && input.source.type !== "demo") {
    warn("$.synthetic", "Model is marked synthetic but source.type is not \"demo\" — double-check provenance.");
  }
  /* The converse is an error, not a warning: a demo model without the marker
     is served by the MCP server WITHOUT the synthetic warning, which is
     invented data presented as ETIM classification. */
  if (isRecord(input.source) && input.source.type === "demo" && input.synthetic !== true) {
    err(
      "$.synthetic",
      'A model with source.type "demo" must set synthetic: true — otherwise invented data is served as real classification.',
    );
  }

  // ---- dictionaries -------------------------------------------------------
  const dicts = [
    ["groups", "group"],
    ["features", "feature"],
    ["values", "value"],
    ["units", "unit"],
    ["classes", "class"],
  ] as const;

  for (const [field, kind] of dicts) {
    const dict = input[field];
    if (!isRecord(dict)) {
      err(`$.${field}`, `${field} must be an object keyed by ${kind} code.`);
      continue;
    }
    for (const code of Object.keys(dict)) {
      if (!CODE_SHAPE[kind].test(code)) {
        err(`$.${field}["${code}"]`, `Key does not look like a ${kind} code (${CODE_SHAPE[kind]}).`);
      }
      const entry = dict[code];
      if (!isRecord(entry)) {
        err(`$.${field}["${code}"]`, "Entry must be an object.");
        continue;
      }
      if (!isStr(entry.description) || entry.description.trim() === "") {
        err(`$.${field}["${code}"].description`, "English description is required.");
      }
    }
  }

  if (errors.length > 0) {
    // Shape is broken; referential checks over broken shapes produce noise,
    // not signal. Report what we have.
    return { ok: false, errors, warnings, counts: countsOf(input) };
  }

  const model = input as unknown as EtimModel;

  // ---- entry-level shape --------------------------------------------------
  for (const [code, f] of Object.entries(model.features)) {
    if (!FEATURE_TYPES.includes(f.type as FeatureType)) {
      err(`$.features["${code}"].type`, `Feature type must be one of ${FEATURE_TYPES.join("/")}, got ${fmt(f.type)}.`);
    }
  }
  for (const [code, u] of Object.entries(model.units)) {
    if (!isStr(u.abbreviation)) {
      err(`$.units["${code}"].abbreviation`, "Unit abbreviation is required (may be empty string, must exist).");
    }
  }

  /* `deprecated` is read as a plain truthiness test downstream, so the string
     "false" would mark an entry deprecated. Any present flag must be a real
     boolean. */
  const checkDeprecated = (v: unknown, path: string) => {
    if (v !== undefined && typeof v !== "boolean") {
      err(path, `deprecated must be a boolean when present, got ${fmt(v)}.`);
    }
  };
  for (const [code, f] of Object.entries(model.features)) {
    checkDeprecated(f.deprecated, `$.features["${code}"].deprecated`);
  }
  for (const [code, v] of Object.entries(model.values)) {
    checkDeprecated(v.deprecated, `$.values["${code}"].deprecated`);
  }
  for (const [code, u] of Object.entries(model.units)) {
    checkDeprecated(u.deprecated, `$.units["${code}"].deprecated`);
  }

  // ---- classes: shape + referential integrity -----------------------------
  for (const [code, c] of Object.entries(model.classes)) {
    const at = `$.classes["${code}"]`;
    if (typeof c.version !== "number" || !Number.isInteger(c.version) || c.version < 1) {
      err(`${at}.version`, `Class version must be a positive integer, got ${fmt(c.version)}.`);
    }
    if (!isStr(c.groupCode) || !Object.hasOwn(model.groups, c.groupCode)) {
      err(`${at}.groupCode`, `References group ${fmt(c.groupCode)} which is not in $.groups.`);
    }
    /* The optional search fields are documented shapes, and searchClasses
       calls .some()/.includes() on them — an unvalidated string here passed
       assertModel and then crashed the search. */
    if (c.synonyms !== undefined && !isStrArray(c.synonyms)) {
      err(`${at}.synonyms`, "synonyms must be an array of strings.");
    }
    if (c.sectors !== undefined && !isStrArray(c.sectors)) {
      err(`${at}.sectors`, "sectors must be an array of strings.");
    }
    checkTranslations(c.translations, `${at}.translations`);
    checkTranslations(c.synonymTranslations, `${at}.synonymTranslations`, true);

    if (!Array.isArray(c.features)) {
      err(`${at}.features`, "features must be an array (may be empty).");
      continue;
    }
    if (c.features.length === 0) {
      warn(at, "Class has no features — legal, but unusual in a published release.");
    }

    const seenFeature = new Set<string>();
    const seenOrder = new Set<number>();
    for (let i = 0; i < c.features.length; i++) {
      const bAt = `${at}.features[${i}]`;
      /* Bindings get the same descriptor treatment as string arrays. Reading
         c.features[i] directly ran a caller's accessor, and search.ts copies
         the array again with .slice() — so a stateful slot could hand the
         validator one binding and getClass another. Only string arrays were
         covered before; the shape that carries the actual semantics was not. */
      const slot = Object.getOwnPropertyDescriptor(c.features, i);
      if (slot === undefined) {
        err(bAt, "Binding is a hole — the features array must be dense.");
        continue;
      }
      if (!("value" in slot)) {
        err(bAt, "Binding is a property accessor; features must be plain data.");
        continue;
      }
      const b: unknown = slot.value;

      /* The binding itself is untrusted: a parsed model can put null, a
         number or a string here, and dereferencing before checking turned
         findings into a TypeError. (Found by review, kept by test.) */
      if (!isRecord(b)) {
        err(bAt, `Binding must be an object, got ${b === null ? "null" : Array.isArray(b) ? "array" : typeof b}.`);
        continue;
      }

      if (!isStr(b.code) || !Object.hasOwn(model.features, b.code)) {
        err(`${bAt}.code`, `References feature ${fmt(b.code)} which is not in $.features.`);
        continue;
      }
      if (seenFeature.has(b.code)) {
        err(`${bAt}.code`, `Feature ${b.code} is bound to this class twice.`);
      }
      seenFeature.add(b.code);

      if (typeof b.orderNumber !== "number" || !Number.isInteger(b.orderNumber) || b.orderNumber < 1) {
        err(`${bAt}.orderNumber`, `orderNumber must be a positive integer, got ${fmt(b.orderNumber)}.`);
      } else if (seenOrder.has(b.orderNumber)) {
        warn(`${bAt}.orderNumber`, `orderNumber ${b.orderNumber} repeats within the class.`);
      } else {
        seenOrder.add(b.orderNumber);
      }

      if (b.unitCode !== undefined && !(isStr(b.unitCode) && Object.hasOwn(model.units, b.unitCode))) {
        err(`${bAt}.unitCode`, `References unit ${fmt(b.unitCode)} which is not in $.units.`);
      }
      if (b.unitImperialCode !== undefined && !(isStr(b.unitImperialCode) && Object.hasOwn(model.units, b.unitImperialCode))) {
        err(`${bAt}.unitImperialCode`, `References unit ${fmt(b.unitImperialCode)} which is not in $.units.`);
      }
      checkDeprecated(b.deprecated, `${bAt}.deprecated`);
      if (b.valueCodes !== undefined && !Array.isArray(b.valueCodes)) {
        err(`${bAt}.valueCodes`, `valueCodes must be an array of value codes, got ${typeof b.valueCodes}.`);
      }
      for (const v of byIndex(b.valueCodes)) {
        if (!(isStr(v) && Object.hasOwn(model.values, v))) {
          err(`${bAt}.valueCodes`, `References value ${fmt(v)} which is not in $.values.`);
        }
      }

      // Type/binding coherence — surprising, not fatal (see header).
      const ftype = model.features[b.code]?.type;
      const hasValues = Array.isArray(b.valueCodes) && b.valueCodes.length > 0;
      if (ftype === "A" && !hasValues) {
        warn(bAt, `Alphanumeric feature ${b.code} bound with no value list.`);
      }
      if ((ftype === "N" || ftype === "R" || ftype === "L") && hasValues) {
        warn(bAt, `${ftype} feature ${b.code} bound with a value list — value lists belong to A features.`);
      }
      /* Units belong to numeric and range features only. This checked one
         field on one type, so a unit bound to an alphanumeric feature, or an
         imperial unit bound to a logical one, passed even under --strict and
         was served as a coherent class. Both fields, both types. */
      if (ftype === "A" || ftype === "L") {
        const bound = [
          b.unitCode !== undefined ? "unitCode" : null,
          b.unitImperialCode !== undefined ? "unitImperialCode" : null,
        ].filter(Boolean) as string[];
        if (bound.length > 0) {
          const label = ftype === "L" ? "Logical" : "Alphanumeric";
          warn(
            bAt,
            `${label} feature ${b.code} bound with ${bound.join(" and ")} — units belong to N and R features.`,
          );
        }
      }
    }
  }

  for (const [code, g] of Object.entries(model.groups)) {
    checkTranslations(g.translations, `$.groups["${code}"].translations`);
  }
  for (const [code, f] of Object.entries(model.features)) {
    checkTranslations(f.translations, `$.features["${code}"].translations`);
  }
  for (const [code, v] of Object.entries(model.values)) {
    checkTranslations(v.translations, `$.values["${code}"].translations`);
  }
  for (const [code, u] of Object.entries(model.units)) {
    checkTranslations(u.translations, `$.units["${code}"].translations`);
    checkTranslations(u.abbreviationTranslations, `$.units["${code}"].abbreviationTranslations`);
  }

  /* `languages` is defined as derived from the data, so a hand-built or
     tampered file claiming a language it does not carry would make stats and
     etim_model_info lie about the model. Check it against reality. */
  const retainedLangs = new Set<string>();
  const collectLangs = (r: unknown) => {
    if (isRecord(r)) for (const k of Object.keys(r)) retainedLangs.add(k.toUpperCase());
  };
  for (const c of Object.values(model.classes)) {
    collectLangs(c.translations);
    collectLangs(c.synonymTranslations);
  }
  for (const g of Object.values(model.groups)) collectLangs(g.translations);
  for (const f of Object.values(model.features)) collectLangs(f.translations);
  for (const v of Object.values(model.values)) collectLangs(v.translations);
  for (const u of Object.values(model.units)) {
    collectLangs(u.translations);
    collectLangs(u.abbreviationTranslations);
  }
  /* Compared as the exact array, not a normalised set: modelStats and
     etim_model_info hand the raw array to callers, so lowercase, duplicated
     or unsorted entries would survive validation and be published as-is. */
  /* Checked BEFORE the fast path: if a hand-built model carries an EN
     translation and dutifully declares EN, the two lists match and the
     English rule would never run. English lives in base fields, always. */
  for (const l of retainedLangs) {
    if (l.split(/[-_]/)[0] === "EN") {
      err(
        "$.languages",
        `English is the base text of the format: entries must not carry ${fmt(l)} translations, and ${fmt(l)} must not be declared.`,
      );
    }
  }
  const canonical = [...retainedLangs].sort().filter((l) => l.split(/[-_]/)[0] !== "EN");
  const declaredList = model.languages;
  const sameList =
    declaredList.length === canonical.length && declaredList.every((l, i) => l === canonical[i]);
  if (!sameList) {
    const declaredUp = new Set(declaredList.map((l) => l.toUpperCase()));
    for (const l of declaredUp) {
      if (l.split(/[-_]/)[0] === "EN") {
        err("$.languages", `English is the base text of the format and is never a translation language; remove ${fmt(l)}.`);
      } else if (!retainedLangs.has(l)) {
        err("$.languages", `Declares ${fmt(l)} but no entry carries a ${l} translation.`);
      }
    }
    for (const l of retainedLangs) {
      if (!declaredUp.has(l)) {
        err("$.languages", `Translations for ${fmt(l)} are present but ${l} is not declared in $.languages.`);
      }
    }
    if (errors.every((e) => e.path !== "$.languages")) {
      /* Same members, wrong form — casing, duplicates or order. */
      err(
        "$.languages",
        `languages must be uppercase, unique and sorted; expected ${fmt(canonical)}, got ${fmt(declaredList)}.`,
      );
    }
  }

  // ---- orphan vocabulary — warn only: a partial conversion is legitimate --
  const usedFeatures = new Set<string>();
  const usedValues = new Set<string>();
  const usedUnits = new Set<string>();
  const usedGroups = new Set<string>();
  /* Same discipline as the class loop above: a malformed model reaches here
     too (findings are collected, not thrown), so the sweep must skip what the
     shape checks already reported rather than crash on it. */
  for (const c of Object.values(model.classes)) {
    if (isStr(c.groupCode)) usedGroups.add(c.groupCode);
    if (!Array.isArray(c.features)) continue;
    for (const b of byIndex(c.features)) {
      if (!isRecord(b)) continue;
      if (isStr(b.code)) usedFeatures.add(b.code);
      if (isStr(b.unitCode)) usedUnits.add(b.unitCode);
      if (isStr(b.unitImperialCode)) usedUnits.add(b.unitImperialCode);
      for (const v of byIndex(b.valueCodes)) {
        if (isStr(v)) usedValues.add(v);
      }
    }
  }
  const orphans = (dict: Record<string, unknown>, used: Set<string>) =>
    Object.keys(dict).filter((k) => !used.has(k)).length;
  const oF = orphans(model.features, usedFeatures);
  const oV = orphans(model.values, usedValues);
  const oU = orphans(model.units, usedUnits);
  const oG = orphans(model.groups, usedGroups);
  if (oF + oV + oU + oG > 0) {
    warn(
      "$",
      `Unreferenced vocabulary entries: ${oG} groups, ${oF} features, ${oV} values, ${oU} units. ` +
        "Fine for a partial conversion; a full release conversion should reference everything.",
    );
  }

  return { ok: errors.length === 0, errors, warnings, counts: countsOf(model) };
}

function countsOf(m: unknown): ValidationResult["counts"] {
  const size = (v: unknown) => (isRecord(v) ? Object.keys(v).length : 0);
  const r = isRecord(m) ? m : {};
  return {
    classes: size(r.classes),
    groups: size(r.groups),
    features: size(r.features),
    values: size(r.values),
    units: size(r.units),
  };
}

/** Load + parse + validate in one step; throws with readable detail on error. */
export function assertModel(input: unknown): EtimModel {
  const result = validateModel(input);
  if (!result.ok) {
    const head = result.errors
      .slice(0, 5)
      .map((e) => `  ${e.path}: ${e.message}`)
      .join("\n");
    const more = result.errors.length > 5 ? `\n  … and ${result.errors.length - 5} more` : "";
    throw new Error(`Not a valid etim-json model:\n${head}${more}`);
  }
  return input as EtimModel;
}
