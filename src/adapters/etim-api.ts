/* ETIM API 2.0 → etim-json.
 *
 * Two halves, split so the pure half is fully testable:
 *
 *   modelFromApiClasses() — a pure transform from API response objects to the
 *   canonical model. Coded to the public contract at
 *   https://etimapi.etim-international.com/swagger/v2/swagger.json and tested
 *   against fixtures shaped exactly by that contract.
 *
 *   fetchModel() — the network half: OAuth2 client-credentials, paged
 *   Class/Search, polite pacing. Requires credentials issued by ETIM
 *   International, so CI cannot exercise it live; it is deliberately thin so
 *   everything that can go subtly wrong lives in the tested pure half.
 *
 * The API embeds vocabulary (feature/value/unit descriptions) inside every
 * class. Lifting them into global dictionaries assumes the API is consistent
 * with itself; where it is not, the first-seen entry wins and the conflict is
 * reported rather than silently overwritten.
 */

import {
  FORMAT_VERSION,
  odcByAttribution,
  type EtimModel,
  type FeatureType,
  type LanguageCode,
} from "../model.js";

/* ---- API shapes, as published (subset we consume) ------------------------ */

export interface ApiTranslation {
  languagecode?: string | null;
  description?: string | null;
}
export interface ApiClassTranslation extends ApiTranslation {
  synonyms?: string[] | null;
}
export interface ApiUnitTranslation extends ApiTranslation {
  abbreviation?: string | null;
}
export interface ApiUnit {
  code?: string | null;
  deprecated?: boolean | null;
  description?: string | null;
  descriptionEn?: string | null;
  abbreviation?: string | null;
  abbreviationEn?: string | null;
  translations?: ApiUnitTranslation[] | null;
}
export interface ApiClassFeatureValue {
  code?: string | null;
  deprecated?: boolean | null;
  description?: string | null;
  descriptionEn?: string | null;
  translations?: ApiTranslation[] | null;
  orderNumber?: number;
}
export interface ApiClassFeature {
  code?: string | null;
  type?: string | null;
  deprecated?: boolean | null;
  description?: string | null;
  descriptionEn?: string | null;
  translations?: ApiTranslation[] | null;
  orderNumber?: number;
  unit?: ApiUnit | null;
  unitImperial?: ApiUnit | null;
  values?: ApiClassFeatureValue[] | null;
}
export interface ApiGroup {
  code?: string | null;
  description?: string | null;
  descriptionEn?: string | null;
  translations?: ApiTranslation[] | null;
}
export interface ApiClass {
  code?: string | null;
  version?: number;
  descriptionEn?: string | null;
  description?: string | null;
  synonyms?: string[] | null;
  group?: ApiGroup | null;
  features?: ApiClassFeature[] | null;
  translations?: ApiClassTranslation[] | null;
  sectors?: string[] | null;
}

export interface TransformResult {
  model: EtimModel;
  /** Consistency findings from lifting embedded vocabulary. */
  warnings: string[];
}

export interface TransformOptions {
  /** Release label to stamp, e.g. "ETIM-10.0" or "DYNAMIC". */
  release: string;
  /** Languages the classes were fetched with (translations included). */
  languages?: LanguageCode[];
  retrievedAt?: string;
}

const FEATURE_TYPES = new Set(["A", "L", "N", "R"]);

export function modelFromApiClasses(classes: ApiClass[], opts: TransformOptions): TransformResult {
  const warnings: string[] = [];
  const model: EtimModel = {
    formatVersion: FORMAT_VERSION,
    kind: "etim-model",
    release: opts.release,
    /* Placeholder — replaced at the end with the languages actually retained. */
    languages: [],
    source: {
      type: "etim-api",
      apiVersion: "ETIM API 2.0",
      ...(opts.retrievedAt !== undefined ? { retrievedAt: opts.retrievedAt } : {}),
    },
    attribution: odcByAttribution(),
    /* Null-prototype dictionaries: assigning a key of "__proto__" to a plain
       object invokes the prototype setter and the entity vanishes silently,
       so a conversion could report success while dropping a class. With no
       prototype the key becomes an own property and validation rejects it
       loudly for not being an ETIM code. */
    groups: Object.create(null) as EtimModel["groups"],
    features: Object.create(null) as EtimModel["features"],
    values: Object.create(null) as EtimModel["values"],
    units: Object.create(null) as EtimModel["units"],
    classes: Object.create(null) as EtimModel["classes"],
  };

  /** A language code that lower-cases to a prototype-chain name is not a
   *  language; it is an attack, and it is dropped rather than uppercased into
   *  harmlessness by accident. */
  const hostileKey = (k: string) =>
    ["__proto__", "constructor", "prototype"].includes(k.toLowerCase());

  /* One rule for every translation-record builder: prototype-chain names are
     attacks, and English is the base text of the format — it must never
     appear as a translation key, or the languages metadata stops describing
     the data (second-pass review finding). */
  /* English detection uses the primary subtag like everything else here:
     EN-GB is English, and treating it as a foreign language both listed it
     among translations and blocked it from promotion into the base fields. */
  const isEnglish = (k: string) => k.toUpperCase().split(/[-_]/)[0] === "EN";
  const skipLang = (k: string) => hostileKey(k) || isEnglish(k);

  /* English found inside a translations array is promoted to the base fields
     when descriptionEn is absent — filtering it out without promotion would
     delete the only English text and mislabel localized text as the base
     (third-pass review finding). */
  /* Every English record contributes, not just the first.
     A payload may split English across tags — `EN` carrying the description
     while `EN-GB` carries synonyms or the abbreviation. Returning on the first
     match promoted only that record's fields, and because every English record
     is then filtered out of `translations`, the rest were not merely
     unpromoted: they were deleted, and any localized synonyms could end up
     labelled as the English base.

     So accumulate across all of them, first value winning per field, which
     keeps the earlier record authoritative where the two disagree. */
  const enOf = (
    ts: (ApiClassTranslation | ApiUnitTranslation | null | undefined)[] | null | undefined,
  ): { description?: string; synonyms?: string[]; abbreviation?: string } => {
    const out: { description?: string; synonyms?: string[]; abbreviation?: string } = {};
    for (const t of ts ?? []) {
      if (!t?.languagecode || !isEnglish(t.languagecode)) continue;
      if (out.description === undefined && typeof t.description === "string") {
        out.description = t.description;
      }
      if (
        out.synonyms === undefined &&
        "synonyms" in (t as ApiClassTranslation) &&
        Array.isArray((t as ApiClassTranslation).synonyms)
      ) {
        out.synonyms = (t as ApiClassTranslation).synonyms!;
      }
      if (
        out.abbreviation === undefined &&
        "abbreviation" in (t as ApiUnitTranslation) &&
        typeof (t as ApiUnitTranslation).abbreviation === "string"
      ) {
        out.abbreviation = (t as ApiUnitTranslation).abbreviation!;
      }
    }
    return out;
  };

  /* Only languages the caller asked for are retained. The API's `include`
     flag is a boolean — it cannot say WHICH languages — so a request for DE
     and one for FR send identical payloads and may both come back with
     everything. Filtering here is what makes `model.languages` true. */
  /* Matched on the primary subtag: the API issues regional forms like
     "de-DE", and a request for "DE" plainly means that. Comparing whole tags
     silently dropped every regional translation. */
  const primary = (l: string) => l.toUpperCase().split(/[-_]/)[0] ?? "";
  /* A bare request ("DE") means any German; a regional one ("DE-AT") means
     that locale specifically. Collapsing both to the primary subtag let a
     request for Austrian German quietly accept DE-DE as well. */
  const wanted = (opts.languages ?? [])
    .map((l) => l.toUpperCase())
    .filter((l) => primary(l) !== "EN" && l !== "");
  const wantedBare = new Set(wanted.filter((l) => l === primary(l)));
  const wantedExact = new Set(wanted.filter((l) => l !== primary(l)));
  const satisfies = (key: string) => {
    const k = key.toUpperCase();
    return wantedExact.has(k) || wantedBare.has(primary(k));
  };
  /* "No filter supplied" and "English only, please" are different requests
     that both leave `wanted` empty. Only the former keeps whatever arrives;
     an explicit English-only request must not silently acquire the
     translations a chatty server threw in. */
  const filtering = opts.languages !== undefined;
  const keepLang = (k: string) => !skipLang(k) && (filtering ? satisfies(k) : true);

  const translationsToRecord = (
    ts: (ApiTranslation | null | undefined)[] | null | undefined,
  ): Record<string, string> | undefined => {
    if (!ts) return undefined;
    const out: Record<string, string> = {};
    for (const t of ts) {
      if (t?.languagecode && typeof t.description === "string" && keepLang(t.languagecode)) {
        out[t.languagecode.toUpperCase()] = t.description;
      }
    }
    return Object.keys(out).length > 0 ? out : undefined;
  };

  /** First entry wins; later disagreement is reported, not applied.
   *  `semantic` names the fields that actually carry meaning for this entity
   *  — comparing description alone let two classes disagree about a feature's
   *  TYPE in silence, which corrupts the second class's semantics. */
  const lift = <T extends { description: string }>(
    dict: Record<string, T>,
    code: string,
    entry: T,
    where: string,
    semantic: readonly (keyof T)[] = ["description" as keyof T],
  ) => {
    const existing = dict[code];
    if (!existing) {
      dict[code] = entry;
      return;
    }
    /* Translations MERGE rather than compete. The API embeds vocabulary per
       class, and the first class carrying a feature may not carry every
       language for it — treating that as a conflict lost localized text
       permanently. Existing entries win on collision; missing ones are added. */
    for (const key of ["translations", "abbreviationTranslations"] as const) {
      const incoming = (entry as Record<string, unknown>)[key] as
        | Record<string, string>
        | undefined;
      if (!incoming) continue;
      const current = (existing as Record<string, unknown>)[key] as
        | Record<string, string>
        | undefined;
      if (!current) {
        (existing as Record<string, unknown>)[key] = { ...incoming };
        continue;
      }
      for (const [lang, text] of Object.entries(incoming)) {
        if (!(lang in current)) current[lang] = text;
        else if (current[lang] !== text) {
          warnings.push(
            `${code}: ${lang} ${key === "translations" ? "translation" : "abbreviation"} differs between classes at ${where}; kept the first.`,
          );
        }
      }
    }
    for (const field of semantic) {
      if (existing[field] !== entry[field]) {
        warnings.push(
          `${code}: ${String(field)} differs between classes (${JSON.stringify(existing[field])} vs ${JSON.stringify(entry[field])} at ${where}); kept the first.`,
        );
      }
    }
  };

  const liftUnit = (u: ApiUnit | null | undefined, where: string): string | undefined => {
    const code = u?.code ?? undefined;
    /* No unit at all is legitimate — numeric and range features may be
       dimensionless. A unit OBJECT with no code is not: it means the API sent
       us a unit and we could not identify it. Treating the two the same
       discarded the object's metadata and produced a dimensionless feature
       that still validated, so the loss was undetectable downstream. */
    if (u && !code) {
      throw new Error(
        `${where}: a unit object was supplied with no code ` +
          `(${JSON.stringify(u).slice(0, 120)}). Refusing to convert — treating ` +
          `it as absent would emit a dimensionless feature that passes validation.`,
      );
    }
    if (!u || !code) return undefined;
    const abbrTranslations: Record<string, string> = {};
    for (const t of u.translations ?? []) {
      if (t?.languagecode && typeof t.abbreviation === "string" && keepLang(t.languagecode)) {
        abbrTranslations[t.languagecode.toUpperCase()] = t.abbreviation;
      }
    }
    const uEn = enOf(u.translations);
    lift(
      model.units,
      code,
      {
        description: u.descriptionEn ?? uEn.description ?? u.description ?? code,
        abbreviation: u.abbreviationEn ?? uEn.abbreviation ?? u.abbreviation ?? "",
        ...(translationsToRecord(u.translations) ? { translations: translationsToRecord(u.translations)! } : {}),
        ...(Object.keys(abbrTranslations).length > 0 ? { abbreviationTranslations: abbrTranslations } : {}),
        ...(u.deprecated ? { deprecated: true } : {}),
      },
      where,
      ["description", "abbreviation", "deprecated"],
    );
    return code;
  };

  for (const c of classes) {
    const code = c.code ?? undefined;
    if (!code) {
      warnings.push("Skipped a class with no code — the API should never emit one; check the fetch.");
      continue;
    }
    /* Assigning by code means a repeat silently replaces its predecessor.
       The fetch loop refuses duplicates outright, because there they mean the
       release changed mid-pagination and the whole run is suspect — but
       modelFromApiClasses is exported and can be handed rows from anywhere,
       so it reports the loss on its own warnings channel rather than
       discarding a class without a word. */
    if (Object.hasOwn(model.classes, code)) {
      warnings.push(
        `Class ${code} appeared more than once; kept the first and discarded a later row. ` +
          "The input carries fewer distinct classes than rows.",
      );
      continue;
    }

    const where = `class ${code}`;

    const groupCode = c.group?.code ?? undefined;
    if (groupCode) {
      lift(
        model.groups,
        groupCode,
        {
          description:
            c.group?.descriptionEn ?? enOf(c.group?.translations).description ?? c.group?.description ?? groupCode,
          ...(translationsToRecord(c.group?.translations)
            ? { translations: translationsToRecord(c.group?.translations)! }
            : {}),
        },
        where,
      );
    } else {
      warnings.push(`${where}: no group on the API response — groupCode left dangling will fail validation.`);
    }

    const bindings = [];
    for (const f of c.features ?? []) {
      const fCode = f.code ?? undefined;
      if (!fCode) {
        warnings.push(`${where}: skipped a feature with no code.`);
        continue;
      }
      const rawType = (f.type ?? "").toUpperCase();
      if (!FEATURE_TYPES.has(rawType)) {
        warnings.push(
          `${where}: feature ${fCode} has unknown type ${JSON.stringify(f.type)}; kept verbatim — validation will reject it rather than this adapter inventing a meaning.`,
        );
      }
      lift(
        model.features,
        fCode,
        {
          description: f.descriptionEn ?? enOf(f.translations).description ?? f.description ?? fCode,
          /* Verbatim, even when unknown: the cast is deliberately unsound at
             this boundary so the validator refuses the model loudly instead of
             this adapter relabelling an unknown type as alphanumeric. */
          type: rawType as FeatureType,
          ...(translationsToRecord(f.translations) ? { translations: translationsToRecord(f.translations)! } : {}),
          ...(f.deprecated ? { deprecated: true } : {}),
        },
        where,
        ["description", "type", "deprecated"],
      );

      const valueCodes: string[] = [];
      for (const v of f.values ?? []) {
        const vCode = v.code ?? undefined;
        /* A permitted value with no code is malformed input, not an absent
           value. Skipping it produced a model that was still structurally
           valid — the alphanumeric binding simply had one fewer choice — so
           nothing downstream could ever detect the loss: `fetch` wrote the
           file and validation passed. Refuse the conversion instead. */
        if (!vCode) {
          throw new Error(
            `${where} feature ${fCode}: a permitted value has no code. ` +
              `Refusing to convert — dropping it would silently write a class ` +
              `whose value list is incomplete but still passes validation.`,
          );
        }
        lift(
          model.values,
          vCode,
          {
            description: v.descriptionEn ?? enOf(v.translations).description ?? v.description ?? vCode,
            ...(translationsToRecord(v.translations) ? { translations: translationsToRecord(v.translations)! } : {}),
            ...(v.deprecated ? { deprecated: true } : {}),
          },
          `${where} feature ${fCode}`,
          ["description", "deprecated"],
        );
        valueCodes.push(vCode);
      }

      const unitCode = liftUnit(f.unit, `${where} feature ${fCode}`);
      const unitImperialCode = liftUnit(f.unitImperial, `${where} feature ${fCode} (imperial)`);

      bindings.push({
        code: fCode,
        orderNumber: f.orderNumber ?? bindings.length + 1,
        ...(unitCode !== undefined ? { unitCode } : {}),
        ...(unitImperialCode !== undefined ? { unitImperialCode } : {}),
        ...(valueCodes.length > 0 ? { valueCodes } : {}),
        ...(f.deprecated ? { deprecated: true } : {}),
      });
    }

    const classTranslations: Record<string, string> = {};
    const synonymTranslations: Record<string, string[]> = {};
    for (const t of c.translations ?? []) {
      if (t?.languagecode && !keepLang(t.languagecode)) continue;
      if (t?.languagecode && typeof t.description === "string") {
        classTranslations[t.languagecode.toUpperCase()] = t.description;
      }
      if (t?.languagecode && Array.isArray(t.synonyms) && t.synonyms.length > 0) {
        synonymTranslations[t.languagecode.toUpperCase()] = t.synonyms;
      }
    }

    const cEn = enOf(c.translations);
    /* Precedence mirrors the description chain: text that is definitively
       English (the EN translation entry) beats the top-level field, which is
       in the PRIMARY language of the request and only happens to be English
       when English was primary (fifth-pass review finding). */
    /* `undefined` means "no English source"; `[]` means "English says there
       are none" — and the second is authoritative, not a fallback trigger.
       Falling through on empty put the primary language's synonyms into the
       English-only field. */
    const baseSynonyms = cEn.synonyms !== undefined ? cEn.synonyms : c.synonyms;
    /* orderNumber IS the published order, and the format defines the array's
       order as data — so the file must carry it, not merely resolve to it in
       getClass(). Stable within equal order numbers, preserving response
       order as the tie-break. */
    bindings.sort((a, b) => a.orderNumber - b.orderNumber);

    model.classes[code] = {
      version: c.version ?? 1,
      description: c.descriptionEn ?? cEn.description ?? c.description ?? code,
      groupCode: groupCode ?? "EG000000",
      ...(baseSynonyms && baseSynonyms.length > 0 ? { synonyms: baseSynonyms } : {}),
      ...(Object.keys(classTranslations).length > 0 ? { translations: classTranslations } : {}),
      ...(Object.keys(synonymTranslations).length > 0 ? { synonymTranslations } : {}),
      ...(c.sectors && c.sectors.length > 0 ? { sectors: c.sectors } : {}),
      features: bindings,
    };
  }

  /* Declared languages are DERIVED from what was retained, never from what
     was asked for — the two diverge whenever the API returns a different set
     than requested. */
  const retained = new Set<string>();
  const collect = (r?: Record<string, unknown>) => {
    for (const k of Object.keys(r ?? {})) retained.add(k);
  };
  for (const c of Object.values(model.classes)) {
    collect(c.translations);
    collect(c.synonymTranslations);
  }
  for (const g of Object.values(model.groups)) collect(g.translations);
  for (const f of Object.values(model.features)) collect(f.translations);
  for (const v of Object.values(model.values)) collect(v.translations);
  for (const u of Object.values(model.units)) {
    collect(u.translations);
    collect(u.abbreviationTranslations);
  }
  model.languages = [...retained].sort();

  /* A bare request is satisfied by any regional variant of it; a regional
     request only by itself. */
  const retainedUpper = [...retained].map((l) => l.toUpperCase());
  const missing = wanted.filter((l) =>
    wantedExact.has(l)
      ? !retainedUpper.includes(l)
      : !retainedUpper.some((r) => primary(r) === l),
  );
  if (missing.length > 0) {
    warnings.push(
      `Requested ${missing.join(", ")} but the response carried no translations for ${missing.length > 1 ? "them" : "it"}; languages reflects what was actually retained.`,
    );
  }

  return { model, warnings };
}

/* ---- network half -------------------------------------------------------- */

export interface FetchOptions {
  clientId: string;
  clientSecret: string;
  /** e.g. "ETIM-10.0"; omit for the dynamic (latest) model. */
  release?: string;
  /** Language for `description` fields and translations, e.g. ["EN","DE"]. */
  languages?: string[];
  /** Page size for Class/Search (API max applies). */
  pageSize?: number;
  /** Hard ceiling on classes fetched — a fetch that runs away stops itself. */
  maxClasses?: number;
  /** Base URL — overridable for tests only. */
  baseUrl?: string;
  authUrl?: string;
  onProgress?: (fetched: number, total: number) => void;
}

const API_BASE = "https://etimapi.etim-international.com";
const AUTH_URL = "https://etimauth.etim-international.com/connect/token";

/** Fetch classes for a release and transform to a model.
 *
 *  Live behaviour is deliberately gentle: sequential pages, a pause between
 *  them, one retry with backoff on 429/5xx. The measured lesson behind that
 *  politeness: parallel bursts from one origin look like an attack to small
 *  hosts, and a tool that gets its users' credentials rate-banned is worse
 *  than a slow one. */
export async function fetchModel(opts: FetchOptions): Promise<TransformResult> {
  const base = opts.baseUrl ?? API_BASE;
  const pageSize = Math.min(Math.max(opts.pageSize ?? 100, 1), 1000);
  const maxClasses = opts.maxClasses ?? 10_000;
  /* NaN made every comparison false — the loop never ran and an empty model
     came back reported as a success. Infinity quietly removed the ceiling
     the option exists to enforce. */
  if (!Number.isSafeInteger(maxClasses) || maxClasses < 1) {
    throw new Error(
      `maxClasses must be a positive whole number, got ${String(maxClasses)}. ` +
        "It is a hard ceiling, so it cannot be Infinity or NaN.",
    );
  }
  const languages = opts.languages ?? ["EN"];
  /* English is the format's base text, so it is ALWAYS the primary request
     language — asking for DE as primary returned German in `description`,
     which the transform then discarded in favour of descriptionEn, leaving a
     model that claimed DE and contained none. Everything non-English is
     requested as translations. */
  const extraLanguages = languages.filter((l) => l.toUpperCase() !== "EN");

  const token = await getToken(opts);

  const post = async <T>(path: string, body: unknown): Promise<T> => {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(base + path, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60_000),
      });
      if (res.ok) return (await res.json()) as T;
      const retryable = res.status === 429 || res.status >= 500;
      if (retryable && attempt === 0) {
        await sleep(res.status === 429 ? 10_000 : 3_000);
        continue;
      }
      throw new Error(`ETIM API ${path} → HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
  };

  interface SearchOut {
    total: number;
    classes?: ApiClass[] | null;
  }

  const all: ApiClass[] = [];
  let from = 0;
  let total = Infinity;
  const seenClassCodes = new Set<string>();
  while (from < total && all.length < maxClasses) {
    /* Never ask for more than the remaining allowance: a 100-row page against
       a maxClasses of 10 used to be appended whole. */
    const room = maxClasses - all.length;
    const out = await post<SearchOut>("/api/v2/Class/Search", {
      from,
      size: Math.min(pageSize, room),
      languagecode: "EN",
      searchString: "",
      include: {
        descriptions: true,
        translations: extraLanguages.length > 0,
        fields: ["features", "translations"],
      },
      ...(opts.release ? { filters: [{ code: "release", values: [opts.release] }] } : {}),
    });
    /* Pagination is driven entirely by `total`; a missing or junk value made
       `from < total` false after the first page and returned it as a complete
       model. There is no way to detect that absence downstream. */
    if (!Number.isSafeInteger(out.total) || (out.total as number) < 0) {
      throw new Error(
        `ETIM API returned an unusable pagination total (${String(out.total)}); refusing to guess how many classes exist.`,
      );
    }
    /* `total` is re-read every page because a DYNAMIC release can change size
       mid-fetch, but it has to stay consistent with how far we have already
       walked. If the model shrinks below the cursor, the rows in hand are from
       a snapshot that no longer exists: two rows collected under total: 4,
       then an offset-2 page reporting total: 1, would hit the empty-page
       branch, look complete, and be written as a whole model. */
    if (out.total < from) {
      throw new Error(
        `ETIM API reported ${out.total} classes at offset ${from} — fewer than already fetched. ` +
          "The release is changing mid-fetch; retry, or pin a release rather than DYNAMIC. " +
          "Refusing to continue — the rows in hand are from a snapshot that no longer exists.",
      );
    }
    total = out.total;
    const returned = out.classes ?? [];
    if (!Array.isArray(returned)) {
      throw new Error(`ETIM API returned a non-array classes page at offset ${from}; refusing to continue.`);
    }
    /* A code-less entry is skipped downstream with only a warning, so a page
       of them would advance the cursor and yield an empty model reported as
       complete. Reject the page instead — the count must mean something. */
    const unusable = returned.filter((c) => !c || typeof c.code !== "string" || c.code === "").length;
    if (unusable > 0) {
      throw new Error(
        `ETIM API returned ${unusable} class entr${unusable === 1 ? "y" : "ies"} without a code at offset ${from}; refusing to save an incomplete model.`,
      );
    }
    if (returned.length === 0) {
      /* An empty page while the server still reports classes outstanding
         yields a structurally valid model that is quietly missing data —
         validation cannot see an absence. Fail instead. */
      if (from < total) {
        throw new Error(
          `ETIM API returned an empty page at offset ${from} of ${total}; refusing to save a partial model.`,
        );
      }
      break;
    }
    /* A server that ignores `size` is the dangerous case: trimming its page
       and advancing the cursor by the full length would satisfy `from >=
       total` and hand back a silently truncated model. Refuse instead — a
       missing ETIM class looks exactly like one that does not exist. */
    if (returned.length > room) {
      throw new Error(
        `ETIM API returned ${returned.length} classes for a requested ${room}; refusing to truncate. ` +
          `Raise maxClasses (currently ${maxClasses}) deliberately if this release is really that large.`,
      );
    }
    /* Offset pagination over a model the server may be changing underneath
       us: a class can arrive on two pages. Both rows were appended and `from`
       advanced by both, so the loop satisfied `from >= total` while
       modelFromApiClasses — which assigns by code — kept only one of each.
       The result reported `total` classes and contained fewer, with no
       indication which were lost. Refuse, rather than hand back a model whose
       own count is wrong. */
    for (const c of returned) {
      const dupe = c?.code ?? undefined;
      if (dupe === undefined) continue;
      if (seenClassCodes.has(dupe)) {
        throw new Error(
          `ETIM API returned class ${dupe} on more than one page (at offset ${from}). ` +
            "The release is probably changing mid-fetch; retry, or pin a release rather " +
            "than DYNAMIC. Refusing to continue — the model would report more classes than it holds.",
        );
      }
      seenClassCodes.add(dupe);
    }
    /* A page that runs past the reported total is the same inconsistency seen
       from the other side, and it would leave `from` beyond `total` — ending
       the loop with a model whose own count disagrees with the server's. */
    if (from + returned.length > total) {
      throw new Error(
        `ETIM API returned ${returned.length} classes at offset ${from} against a reported total of ${total}; ` +
          "the page runs past the end it declared. Refusing to continue.",
      );
    }
    all.push(...returned);
    from += returned.length;
    opts.onProgress?.(all.length, total);
    if (from < total) await sleep(400);
  }

  if (all.length >= maxClasses && from < total) {
    throw new Error(
      `Stopped at the ${maxClasses}-class ceiling with ${total} reported — raise maxClasses deliberately if this release is really that large.`,
    );
  }

  return modelFromApiClasses(all, {
    release: opts.release ?? "DYNAMIC",
    languages,
    retrievedAt: new Date().toISOString(),
  });
}

async function getToken(opts: FetchOptions): Promise<string> {
  const res = await fetch(opts.authUrl ?? AUTH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: opts.clientId,
      client_secret: opts.clientSecret,
      scope: "EtimApi",
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    throw new Error(
      `ETIM auth failed (HTTP ${res.status}). Credentials are issued by ETIM International — see https://etimapi.etim-international.com/`,
    );
  }
  const data = (await res.json()) as { access_token?: string };
  if (!data.access_token) throw new Error("ETIM auth returned no access_token.");
  return data.access_token;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
