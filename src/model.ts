/* The etim-json canonical model.
 *
 * A normalised, versioned JSON representation of one ETIM release. The shape
 * mirrors how ETIM itself is structured — features (EF), values (EV), units
 * (EU) and groups (EG) are global vocabularies, and a class (EC) *selects*
 * from them, binding a feature to a class-specific unit and value list. The
 * ETIM API embeds those vocabularies into every class it returns; this format
 * lifts them out, so a model file is smaller, diffable, and its referential
 * integrity is checkable.
 *
 * Field names and semantics follow the public ETIM API 2.0 contract
 * (https://etimapi.etim-international.com/swagger/v2/swagger.json), which is
 * the authoritative machine-readable description of the model this format
 * round-trips. Nothing here is invented; anything we could not verify is
 * omitted rather than guessed.
 *
 * The format is deliberately conservative about meaning. It records what ETIM
 * publishes and does not editorialise: sector letters stay letters, feature
 * types stay their single-character codes, and deprecation is carried, not
 * filtered.
 */

/** Format identifier — bump only on breaking changes to this shape. */
export const FORMAT_VERSION = 1 as const;

/** ETIM feature types, per the ETIM classification guidelines:
 *  A = alphanumeric (value from a class-specific list)
 *  L = logical (true/false)
 *  N = numeric (single value, with unit where defined)
 *  R = range (two numerics, with unit where defined) */
export type FeatureType = "A" | "L" | "N" | "R";
export const FEATURE_TYPES: readonly FeatureType[] = ["A", "L", "N", "R"];

/** Code shapes as issued by ETIM. Two letters, then digits.
 *  EC class · EG group · EF feature · EV value · EU unit.
 *  Width is validated loosely (6–8 digits) rather than pinned at six: the
 *  published model uses six today, and a format that hard-fails on a future
 *  seventh digit would rot silently. */
export const CODE_SHAPE: Record<EntityKind, RegExp> = {
  class: /^EC\d{6,8}$/,
  group: /^EG\d{6,8}$/,
  feature: /^EF\d{6,8}$/,
  value: /^EV\d{6,8}$/,
  unit: /^EU\d{6,8}$/,
};

export type EntityKind = "class" | "group" | "feature" | "value" | "unit";

/** Uppercase ISO-ish language codes as the API issues them ("EN", "de-DE"
 *  style regional forms appear in some tools; we keep whatever the source
 *  said, uppercased, and treat it as an opaque key). */
export type LanguageCode = string;

/** A description in one or more languages. `en` is promoted to its own field
 *  because the API guarantees `descriptionEn`; other languages live in
 *  `translations`, keyed by language code. */
export interface Described {
  /** English description as published (`descriptionEn` in the API). */
  description: string;
  /** Other languages, keyed by language code. Absent when not requested. */
  translations?: Record<LanguageCode, string>;
}

export interface EtimGroupEntry extends Described {}

export interface EtimFeatureEntry extends Described {
  /** A | L | N | R — see FeatureType. */
  type: FeatureType;
  deprecated?: boolean;
}

export interface EtimValueEntry extends Described {
  deprecated?: boolean;
}

export interface EtimUnitEntry extends Described {
  /** Printable abbreviation, e.g. "mm" — `abbreviationEn` in the API. */
  abbreviation: string;
  /** Abbreviations in other languages, where they differ. */
  abbreviationTranslations?: Record<LanguageCode, string>;
  deprecated?: boolean;
}

/** One feature as bound to one class: the feature code plus the
 *  class-specific unit and value list. Mirrors `EtimClassFeature` with the
 *  vocabulary entries lifted to the top-level dictionaries. */
export interface ClassFeatureBinding {
  /** EF code — must exist in `features`. */
  code: string;
  /** Position within the class, as published (1-based). */
  orderNumber: number;
  /** EU code — must exist in `units`. Only for N/R features that carry one. */
  unitCode?: string;
  /** Imperial counterpart, where the model defines one (IXF 2.0 addition). */
  unitImperialCode?: string;
  /** EV codes — must all exist in `values`. Only for A features. */
  valueCodes?: string[];
  deprecated?: boolean;
}

export interface EtimClassEntry extends Described {
  /** Class version as published (classes are versioned individually). */
  version: number;
  /** EG code — must exist in `groups`. */
  groupCode: string;
  /** Search synonyms, English, as published. */
  synonyms?: string[];
  /** Synonyms in other languages, keyed by language code. */
  synonymTranslations?: Record<LanguageCode, string[]>;
  /** Sector letters exactly as issued by ETIM (e.g. "E"). Letters are not
   *  expanded to names here: the mapping is ETIM's to define. */
  sectors?: string[];
  features: ClassFeatureBinding[];
}

export interface ModelSource {
  /** Where this model came from. `demo` is the bundled synthetic dataset. */
  type: "etim-api" | "demo" | "custom";
  /** ISO timestamp of retrieval/generation. */
  retrievedAt?: string;
  /** e.g. "ETIM API 2.0" — recorded so a file is traceable to its contract. */
  apiVersion?: string;
}

export interface Attribution {
  licence: string;
  licenceUrl: string;
  /** The human-readable statement redistribution must keep intact. */
  statement: string;
}

export interface EtimModel {
  formatVersion: typeof FORMAT_VERSION;
  kind: "etim-model";
  /** Release label as issued, e.g. "ETIM-10.0", or "DYNAMIC" for the
   *  continuously-published model. */
  release: string;
  /** Language codes present in translations, uppercased. English is implicit
   *  (the `description` fields) and not listed. */
  languages: LanguageCode[];
  source: ModelSource;
  attribution: Attribution;
  /** True only for the bundled demo — data is invented and MUST NOT be used
   *  as classification. Consumers should surface this loudly. */
  synthetic?: boolean;
  groups: Record<string, EtimGroupEntry>;
  features: Record<string, EtimFeatureEntry>;
  values: Record<string, EtimValueEntry>;
  units: Record<string, EtimUnitEntry>;
  classes: Record<string, EtimClassEntry>;
}

/** The attribution every model derived from real ETIM data must carry.
 *  ODC-BY requires attribution and keeping notices intact; baking the notice
 *  into the format is how a converted file cannot silently lose it. */
export function odcByAttribution(): Attribution {
  return {
    licence: "ODC-BY 1.0",
    licenceUrl: "https://opendatacommons.org/licenses/by/1-0/",
    statement:
      "Contains information from the ETIM classification model, which is made " +
      "available by ETIM International (https://www.etim-international.com) " +
      "under the Open Data Commons Attribution License (ODC-BY) v1.0.",
  };
}

/** Canonical JSON: stable key order, LF, trailing newline — so two
 *  conversions of the same release diff clean. Dictionary keys are sorted;
 *  arrays keep their published order (order is data in ETIM: feature
 *  orderNumber, value lists). */
export function serializeModel(model: EtimModel): string {
  return JSON.stringify(sortDeep(model), null, 2) + "\n";
}

function sortDeep(v: unknown, key?: string): unknown {
  /* `languages` is unordered metadata, so its order must not change the
     bytes — two models differing only in ["FR","DE"] vs ["DE","FR"] are the
     same model. Every other array is ordered DATA (feature sequence, value
     lists) and is left exactly as published. */
  if (Array.isArray(v)) {
    const mapped = v.map((x) => sortDeep(x));
    return key === "languages"
      ? [...new Set(mapped.map((x) => (typeof x === "string" ? x.toUpperCase() : x)))].sort()
      : mapped;
  }
  if (v !== null && typeof v === "object") {
    /* Null-prototype for the same reason the adapter uses one: a "__proto__"
       key assigned to a plain object is swallowed by the setter. */
    const out: Record<string, unknown> = Object.create(null);
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      out[k] = sortDeep((v as Record<string, unknown>)[k], k);
    }
    return out;
  }
  return v;
}

/** Byte ceiling for model files we will load. The full ETIM model in this
 *  format is tens of MB; half a GB is nothing an ETIM release could be, so
 *  treat it as hostile input rather than letting JSON.parse eat the heap. */
export const MAX_MODEL_BYTES = 512 * 1024 * 1024;

/** Parse a model file's text. Validation is separate (`validateModel`) —
 *  this only gets the JSON in safely.
 *
 *  `JSON.parse` never invokes setters, but a later naive deep-merge of a
 *  parsed `__proto__` key would pollute. We reject those keys at the door so
 *  nothing downstream needs to remember. */
export function parseModelJson(text: string, opts: { maxBytes?: number } = {}): unknown {
  const max = opts.maxBytes ?? MAX_MODEL_BYTES;
  /* NaN makes every comparison false, which would disable the very guard
     this function exists to apply. */
  if (!Number.isFinite(max) || max <= 0) {
    throw new Error(`maxBytes must be a positive finite number, got ${String(max)}.`);
  }
  /* Measured in UTF-8 bytes, not UTF-16 code units — .length undercounts
     multibyte text by up to 3x, which is exactly the file that needs the
     ceiling. The cheap pre-check on .length short-circuits the common case
     so Buffer.byteLength only runs near the boundary. */
  const bytes = text.length > max ? text.length : Buffer.byteLength(text, "utf8");
  if (bytes > max) {
    throw new Error(
      `Model file is ${bytes} bytes — over the ${max} byte ceiling. ` +
        "If this is a legitimate ETIM conversion, raise the ceiling deliberately.",
    );
  }
  // Strip a UTF-8 BOM: Windows tooling adds one and JSON.parse refuses it.
  const clean = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  return JSON.parse(clean, (key, value) => {
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
      throw new Error(`Refusing to parse: hostile key "${key}" in model JSON.`);
    }
    return value;
  });
}
