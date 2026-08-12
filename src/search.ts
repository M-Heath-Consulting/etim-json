/* Search and lookup over a loaded model.
 *
 * Pure functions, shared verbatim by the CLI and the MCP server so the two
 * can never drift. Search is deliberately boring: exact code match first,
 * then case- and diacritic-insensitive substring over descriptions, synonyms
 * and translations, ranked by where and how the match landed. No fuzzy
 * scoring to tune, no index to build — an ETIM release is small enough that
 * a linear scan over pre-folded text answers in single-digit milliseconds.
 */

import type { EtimModel, EntityKind, LanguageCode } from "./model.js";
import { CODE_SHAPE } from "./model.js";

export interface ClassHit {
  code: string;
  description: string;
  groupCode: string;
  group: string;
  version: number;
  /** Which text matched: code | description | synonym | translation. */
  matched: "code" | "description" | "synonym" | "translation";
  /** 0 = exact code; larger = weaker. Stable across runs. */
  rank: number;
}

export interface ResolvedFeature {
  code: string;
  description: string;
  type: string;
  orderNumber: number;
  unit?: { code: string; abbreviation: string; description: string };
  unitImperial?: { code: string; abbreviation: string; description: string };
  values?: { code: string; description: string }[];
  deprecated?: boolean;
}

export interface ResolvedClass {
  code: string;
  version: number;
  description: string;
  group: { code: string; description: string };
  synonyms: string[];
  sectors: string[];
  translations?: Record<LanguageCode, string>;
  features: ResolvedFeature[];
}

/** Case/diacritic folding. NFKD then strip combining marks — "Gehäuse"
 *  matches "gehause". ETIM text is European-language heavy, so this is the
 *  fold that earns its keep. */
export function fold(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    // NFKD leaves ß intact; German searchers type "ss" as often as "ß".
    .replace(/ß/g, "ss");
}

/** Primary subtag of a language tag: "de-DE" → "DE". The adapter preserves
 *  regional keys exactly as the API issues them, so a documented request for
 *  "DE" has to resolve against a "DE-DE" key or translated search silently
 *  misses every ordinary API-converted model. */
const primaryTag = (l: string) => l.toUpperCase().split(/[-_]/)[0] ?? "";

/** Find the translation entry for a requested language, tolerating regional
 *  forms in either direction. Exact match wins; primary-subtag match follows. */
function resolveLangAll<T>(record: Record<string, T> | undefined, requested: string): T[] {
  if (!record) return [];
  const want = requested.toUpperCase();
  /* A regional request names one locale: only an exact key answers it, and
     German-for-Germany text would be a wrong answer to a DE-AT query. */
  if (want !== primaryTag(want)) {
    return Object.keys(record)
      .filter((k) => k.toUpperCase() === want)
      .map((k) => record[k]!);
  }
  /* A bare request means "any German" — so it covers the exact DE key AND
     every regional variant together. Short-circuiting on the exact key hid
     terms that exist only in DE-AT. */
  return Object.keys(record)
    .filter((k) => primaryTag(k) === want)
    .map((k) => record[k]!);
}

/** Identify what kind of entity a code names, if any. */
export function kindOfCode(code: string): EntityKind | null {
  const c = code.trim().toUpperCase();
  for (const [kind, re] of Object.entries(CODE_SHAPE) as [EntityKind, RegExp][]) {
    if (re.test(c)) return kind;
  }
  return null;
}

export interface SearchOptions {
  limit?: number;
  /** Restrict to one group. */
  groupCode?: string;
  /** Also search this language's translations (English always searched). */
  language?: LanguageCode;
}

export function searchClasses(model: EtimModel, query: string, opts: SearchOptions = {}): ClassHit[] {
  const limit = clampLimit(opts.limit);
  const q = query.trim();
  if (q === "") return [];
  const folded = fold(q);
  const asCode = q.toUpperCase();
  const lang = opts.language?.toUpperCase();

  const hits: ClassHit[] = [];
  for (const [code, c] of Object.entries(model.classes)) {
    if (opts.groupCode && c.groupCode !== opts.groupCode) continue;

    const push = (matched: ClassHit["matched"], rank: number) => {
      hits.push({
        code,
        description: c.description,
        groupCode: c.groupCode,
        group: model.groups[c.groupCode]?.description ?? c.groupCode,
        version: c.version,
        matched,
        rank,
      });
    };

    if (code === asCode) {
      push("code", 0);
      continue;
    }
    const desc = fold(c.description);
    if (desc === folded) {
      push("description", 1);
      continue;
    }
    if (desc.includes(folded)) {
      // Word-start matches read as better hits than mid-word ones.
      push("description", startsWord(desc, folded) ? 2 : 3);
      continue;
    }
    if ((c.synonyms ?? []).some((s) => fold(s).includes(folded))) {
      push("synonym", 4);
      continue;
    }
    if (lang) {
      const texts = resolveLangAll(c.translations, lang);
      if (texts.some((t) => fold(t).includes(folded))) {
        push("translation", 5);
        continue;
      }
      const synonymLists = resolveLangAll(c.synonymTranslations, lang);
      if (synonymLists.some((list) => list.some((s) => fold(s).includes(folded)))) {
        push("translation", 6);
      }
    }
  }

  hits.sort((a, b) => a.rank - b.rank || a.code.localeCompare(b.code));
  return hits.slice(0, limit);
}

/** True if the query begins a word ANYWHERE in the text. Checking only the
 *  first occurrence ranked "Microfoo foo switch" as a mid-word match for
 *  "foo", pushing a genuinely better hit down the list or off the end. */
function startsWord(haystack: string, needle: string): boolean {
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + 1)) {
    if (i === 0 || /[\s,;(/-]/.test(haystack[i - 1] ?? "")) return true;
  }
  return false;
}

/** Resolve one class into a self-contained view — every code joined to its
 *  vocabulary entry, ready to print or return over MCP. */
export function getClass(model: EtimModel, code: string): ResolvedClass | null {
  const c = model.classes[code.trim().toUpperCase()];
  if (!c) return null;
  const classCode = code.trim().toUpperCase();

  const unitOf = (u?: string) =>
    u === undefined
      ? undefined
      : {
          code: u,
          abbreviation: model.units[u]?.abbreviation ?? "",
          description: model.units[u]?.description ?? u,
        };

  /* .slice() copies by index; spreading would run the array's
     Symbol.iterator, which a caller can make yield bindings the
     validator never saw. */
  const features: ResolvedFeature[] = c.features.slice()
    .sort((a, b) => a.orderNumber - b.orderNumber)
    .map((b) => {
      const f = model.features[b.code];
      const out: ResolvedFeature = {
        code: b.code,
        description: f?.description ?? b.code,
        type: f?.type ?? "?",
        orderNumber: b.orderNumber,
      };
      const unit = unitOf(b.unitCode);
      if (unit) out.unit = unit;
      const unitImperial = unitOf(b.unitImperialCode);
      if (unitImperial) out.unitImperial = unitImperial;
      if (b.valueCodes && b.valueCodes.length > 0) {
        out.values = b.valueCodes.map((v) => ({
          code: v,
          description: model.values[v]?.description ?? v,
        }));
      }
      if (b.deprecated || f?.deprecated) out.deprecated = true;
      return out;
    });

  const resolved: ResolvedClass = {
    code: classCode,
    version: c.version,
    description: c.description,
    group: {
      code: c.groupCode,
      description: model.groups[c.groupCode]?.description ?? c.groupCode,
    },
    synonyms: c.synonyms ?? [],
    sectors: c.sectors ?? [],
    features,
  };
  if (c.translations) resolved.translations = c.translations;
  return resolved;
}

export interface CodeLookup {
  kind: EntityKind;
  code: string;
  description: string;
  detail?: Record<string, unknown>;
}

/** Look up any ETIM code — class, group, feature, value or unit. */
export function lookupCode(model: EtimModel, raw: string): CodeLookup | null {
  const code = raw.trim().toUpperCase();
  const kind = kindOfCode(code);
  if (!kind) return null;

  switch (kind) {
    case "class": {
      const c = model.classes[code];
      return c
        ? { kind, code, description: c.description, detail: { version: c.version, groupCode: c.groupCode, featureCount: c.features.length } }
        : null;
    }
    case "group": {
      const g = model.groups[code];
      if (!g) return null;
      const members = Object.values(model.classes).filter((c) => c.groupCode === code).length;
      return { kind, code, description: g.description, detail: { classCount: members } };
    }
    case "feature": {
      const f = model.features[code];
      if (!f) return null;
      const usedBy = Object.entries(model.classes)
        .filter(([, c]) => c.features.some((b) => b.code === code))
        .map(([cc]) => cc);
      return {
        kind,
        code,
        description: f.description,
        detail: { type: f.type, usedByClassCount: usedBy.length, usedBy: usedBy.slice(0, 25) },
      };
    }
    case "value": {
      const v = model.values[code];
      return v ? { kind, code, description: v.description } : null;
    }
    case "unit": {
      const u = model.units[code];
      return u ? { kind, code, description: u.description, detail: { abbreviation: u.abbreviation } } : null;
    }
  }
}

export interface ModelStats {
  release: string;
  languages: string[];
  synthetic: boolean;
  counts: { classes: number; groups: number; features: number; values: number; units: number };
  featureTypes: Record<string, number>;
  attribution: string;
}

export function modelStats(model: EtimModel): ModelStats {
  const featureTypes: Record<string, number> = {};
  for (const f of Object.values(model.features)) {
    featureTypes[f.type] = (featureTypes[f.type] ?? 0) + 1;
  }
  return {
    release: model.release,
    languages: model.languages,
    synthetic: model.synthetic === true,
    counts: {
      classes: Object.keys(model.classes).length,
      groups: Object.keys(model.groups).length,
      features: Object.keys(model.features).length,
      values: Object.keys(model.values).length,
      units: Object.keys(model.units).length,
    },
    featureTypes,
    attribution: model.attribution.statement,
  };
}

const LIMIT_DEFAULT = 20;
const LIMIT_MAX = 100;
function clampLimit(n: number | undefined): number {
  if (n === undefined || !Number.isFinite(n)) return LIMIT_DEFAULT;
  return Math.max(1, Math.min(LIMIT_MAX, Math.floor(n)));
}
