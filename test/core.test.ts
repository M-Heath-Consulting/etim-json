import { describe, expect, it } from "vitest";
import { demoModel } from "../src/demo.js";
import { parseModelJson, serializeModel, MAX_MODEL_BYTES } from "../src/model.js";
import { validateModel, assertModel } from "../src/validate.js";
import { fold, getClass, kindOfCode, lookupCode, modelStats, searchClasses } from "../src/search.js";
import { generateTypes } from "../src/typegen.js";

describe("model serialisation", () => {
  it("round-trips the demo model byte-identically", () => {
    const a = serializeModel(demoModel());
    const b = serializeModel(assertModel(parseModelJson(a)));
    expect(b).toBe(a);
  });

  it("is deterministic regardless of key insertion order", () => {
    const m1 = demoModel();
    const m2 = demoModel();
    // Recreate the classes dictionary in reverse insertion order.
    (m2 as { classes: unknown }).classes = Object.fromEntries(Object.entries(m2.classes).reverse());
    expect(serializeModel(m2)).toBe(serializeModel(m1));
  });

  it("strips a UTF-8 BOM", () => {
    const text = "﻿" + serializeModel(demoModel());
    expect(() => parseModelJson(text)).not.toThrow();
  });

  it("rejects files over the byte ceiling", () => {
    const fake = { length: MAX_MODEL_BYTES + 1 } as unknown as string;
    // A real half-GB string would slow the suite; length is what the guard reads.
    expect(() => parseModelJson(fake)).toThrow(/ceiling/);
  });
});

describe("validation", () => {
  it("accepts the demo model with no errors", () => {
    const res = validateModel(demoModel());
    expect(res.errors).toEqual([]);
    expect(res.ok).toBe(true);
    expect(res.counts.classes).toBe(3);
  });

  it("flags a dangling group reference with a precise path", () => {
    const m = demoModel();
    m.classes["EC990001"]!.groupCode = "EG999999";
    const res = validateModel(m);
    expect(res.ok).toBe(false);
    expect(res.errors.some((e) => e.path === '$.classes["EC990001"].groupCode')).toBe(true);
  });

  it("flags dangling feature, unit and value references", () => {
    const m = demoModel();
    m.classes["EC990002"]!.features.push({ code: "EF000000", orderNumber: 9 });
    m.classes["EC990001"]!.features[0]!.unitCode = "EU111111";
    m.classes["EC990001"]!.features[1]!.valueCodes = ["EV777777"];
    const res = validateModel(m);
    const paths = res.errors.map((e) => e.path).join("\n");
    expect(paths).toContain('$.classes["EC990002"].features[3].code');
    expect(paths).toContain('$.classes["EC990001"].features[0].unitCode');
    expect(paths).toContain('$.classes["EC990001"].features[1].valueCodes');
  });

  it("flags duplicate feature bindings", () => {
    const m = demoModel();
    const first = m.classes["EC990003"]!.features[0]!;
    m.classes["EC990003"]!.features.push({ ...first, orderNumber: 5 });
    const res = validateModel(m);
    expect(res.errors.some((e) => e.message.includes("twice"))).toBe(true);
  });

  it("warns, not errors, on type/binding surprises", () => {
    const m = demoModel();
    // Logical feature with a unit — surprising but not fatal.
    m.classes["EC990001"]!.features[2]!.unitCode = "EU990001";
    const res = validateModel(m);
    expect(res.ok).toBe(true);
    expect(res.warnings.some((w) => w.message.includes("Logical"))).toBe(true);
  });

  it("rejects non-object input without throwing", () => {
    for (const bad of [null, [], "x", 42, undefined]) {
      const res = validateModel(bad);
      expect(res.ok).toBe(false);
    }
  });
});

describe("search", () => {
  const m = demoModel();

  it("matches an exact code at rank zero", () => {
    const hits = searchClasses(m, "ec990002");
    expect(hits[0]?.code).toBe("EC990002");
    expect(hits[0]?.matched).toBe("code");
  });

  it("folds case and diacritics", () => {
    expect(fold("Kabelverschraubung")).toBe(fold("KABELVERSCHRAUBUNG"));
    expect(fold("Außendurchmesser")).toBe("aussendurchmesser"); // ß folds to ss deliberately
    const hits = searchClasses(m, "verschraubung", { language: "DE" });
    expect(hits.some((h) => h.code === "EC990003")).toBe(true);
  });

  it("finds synonyms and ranks them below descriptions", () => {
    const hits = searchClasses(m, "MCB");
    expect(hits[0]?.code).toBe("EC990002");
    expect(hits[0]?.matched).toBe("synonym");
  });

  it("restricts by group", () => {
    const hits = searchClasses(m, "demo", { groupCode: "EG990002" });
    expect(hits.every((h) => h.groupCode === "EG990002")).toBe(true);
  });

  it("returns empty for empty or whitespace queries", () => {
    expect(searchClasses(m, "")).toEqual([]);
    expect(searchClasses(m, "   ")).toEqual([]);
  });

  it("clamps absurd limits", () => {
    expect(searchClasses(m, "demo", { limit: 1e9 }).length).toBeLessThanOrEqual(100);
    expect(searchClasses(m, "demo", { limit: -5 }).length).toBeGreaterThan(0);
  });
});

describe("class resolution and lookup", () => {
  const m = demoModel();

  it("resolves a class with features in published order", () => {
    const c = getClass(m, "ec990001");
    expect(c).not.toBeNull();
    expect(c!.features.map((f) => f.orderNumber)).toEqual([1, 2, 3, 4]);
    expect(c!.features[0]!.unit?.abbreviation).toBe("mm");
    expect(c!.features[0]!.unitImperial?.abbreviation).toBe("in");
    expect(c!.features[1]!.values?.length).toBe(3);
  });

  it("identifies every code kind", () => {
    expect(kindOfCode("EC990001")).toBe("class");
    expect(kindOfCode("EG990001")).toBe("group");
    expect(kindOfCode("EF990001")).toBe("feature");
    expect(kindOfCode("EV990001")).toBe("value");
    expect(kindOfCode("EU990001")).toBe("unit");
    expect(kindOfCode("XX123456")).toBeNull();
    expect(kindOfCode("EC12")).toBeNull();
  });

  it("lookup returns usage detail for features", () => {
    const hit = lookupCode(m, "EF990003");
    expect(hit?.kind).toBe("feature");
    expect(hit?.detail?.usedByClassCount).toBe(3);
  });

  it("returns null, never throws, for unknown codes", () => {
    expect(getClass(m, "EC000001")).toBeNull();
    expect(lookupCode(m, "EV999999")).toBeNull();
  });

  it("stats reflect the demo model and its synthetic flag", () => {
    const s = modelStats(m);
    expect(s.synthetic).toBe(true);
    expect(s.counts).toEqual({ classes: 3, groups: 2, features: 6, values: 5, units: 4 });
    expect(s.featureTypes).toEqual({ N: 2, A: 2, L: 1, R: 1 });
  });
});

describe("typegen", () => {
  it("emits literal unions and a class map that compile", () => {
    const src = generateTypes(demoModel());
    expect(src).toContain('| "EC990001"');
    expect(src).toContain("export interface EtimClassMap");
    expect(src).toContain("SYNTHETIC DEMO DATA");
    // No unescaped comment-closer from descriptions.
    expect(src).not.toMatch(/\*\/ \(v\d/);
  });

  it("widens over the cap and says so", () => {
    const m = demoModel();
    const src = generateTypes(m, { unionCap: 2 });
    expect(src).toContain("string & {}");
    expect(src).toContain("union cap");
  });

  it("survives hostile descriptions", () => {
    const m = demoModel();
    m.classes["EC990001"]!.description = "evil */ comment ** breaker";
    const src = generateTypes(m);
    expect(src).toContain("*\\/");
  });
});

/* ── second external review: provenance and unit coherence ───────────────── */

/* Language codes are uppercase in this format, and `languages` is derived by
   uppercasing the translation keys — so a lowercase key used to agree with an
   uppercase declaration and validate, then serialize back out lowercase. */
/* `Array.prototype.every` skips holes, so a sparse array passed every
   `every(isStr)` guard in the validator and was asserted as string[]. */
describe("string arrays must be dense", () => {
  const clone = () => JSON.parse(JSON.stringify(demoModel()));

  it("rejects a hole wherever a string array is accepted", () => {
    const cases: [string, (m: any) => void][] = [
      ["synonymTranslations", (m) => {
        m.classes[Object.keys(m.classes)[0]!].synonymTranslations = { DE: new Array(1) };
        m.languages = ["DE"];
      }],
      ["synonyms", (m) => (m.classes[Object.keys(m.classes)[0]!].synonyms = new Array(1))],
      ["sectors", (m) => (m.classes[Object.keys(m.classes)[0]!].sectors = ["a", , "c"])],
      ["languages", (m) => (m.languages = new Array(1))],
    ];
    for (const [name, mutate] of cases) {
      const m = clone();
      mutate(m);
      expect(validateModel(m).ok, name).toBe(false);
    }
  });

  /* The obvious repair for the hole — Array.from(v).every(isStr) — runs the
     caller's Symbol.iterator. Read indices instead, as consumers do. */
  it("does not consult a caller-supplied iterator", () => {
    // an iterator that lies: index 0 is a number, the iterator yields a string
    const liar: unknown[] = [42];
    (liar as unknown as Record<symbol, unknown>)[Symbol.iterator] = function* () {
      yield "looks-like-a-string";
    };
    const m = clone();
    m.classes[Object.keys(m.classes)[0]!].synonyms = liar;
    expect(validateModel(m).ok).toBe(false);
  });

  it("survives an iterator that throws — validateModel never throws", () => {
    const bomb: unknown[] = ["a"];
    (bomb as unknown as Record<symbol, unknown>)[Symbol.iterator] = function* () {
      throw new Error("boom from user iterator");
    };
    const m = clone();
    m.classes[Object.keys(m.classes)[0]!].synonyms = bomb;
    // by index this is a legitimate dense string array, so it validates —
    // the point is that getting there does not detonate the iterator
    expect(() => validateModel(m)).not.toThrow();
    expect(validateModel(m).ok).toBe(true);
  });

  /* valueCodes and the orphan sweep's features walk were still consuming the
     caller's iterator after isStrArray stopped. Same two failure modes. */
  it("reads valueCodes and features by index too", () => {
    const withIter = (arr: unknown[], gen: () => Generator<unknown>) => {
      (arr as unknown as Record<symbol, unknown>)[Symbol.iterator] = gen;
      return arr;
    };

    // a lying valueCodes: the iterator yields a real code, index holds a fake
    const lying = clone();
    const lk = Object.keys(lying.classes)[0]!;
    lying.classes[lk].features[0].valueCodes = withIter(["EV000000"], function* () {
      yield "EV990001";
    });
    const r = validateModel(lying);
    expect(r.ok).toBe(false);
    // the message must name the indexed value, not the fabricated one
    expect(r.errors.some((e) => e.message.includes("EV000000"))).toBe(true);

    // throwing iterators, in the main pass and in the orphan sweep
    const boom = () => {
      throw new Error("boom from user iterator");
    };
    const a = clone();
    a.classes[Object.keys(a.classes)[0]!].features[0].valueCodes = withIter(
      ["EV990001"],
      boom as unknown as () => Generator<unknown>,
    );
    expect(() => validateModel(a)).not.toThrow();

    const b = clone();
    const bk = Object.keys(b.classes)[0]!;
    b.classes[bk].features = withIter(
      b.classes[bk].features.slice(),
      boom as unknown as () => Generator<unknown>,
    );
    expect(() => validateModel(b)).not.toThrow();
  });

  /* An index can be an accessor, and reading it runs caller code. Descriptors
     are read instead — and because a Proxy can trap descriptor reads too, the
     never-throws contract is backstopped rather than guarded site by site. */
  it("refuses accessor slots instead of invoking them", () => {
    const withGetter = (get: () => unknown) => {
      const a: unknown[] = [];
      Object.defineProperty(a, 0, { get, enumerable: true, configurable: true });
      Object.defineProperty(a, "length", { value: 1, writable: true });
      return a;
    };

    // a getter that throws must not escape validateModel
    const boom = clone();
    boom.classes[Object.keys(boom.classes)[0]!].synonyms = withGetter(() => {
      throw new Error("getter boom");
    });
    expect(() => validateModel(boom)).not.toThrow();
    expect(validateModel(boom).ok).toBe(false);

    // a stateful getter must not validate a value it will not keep
    let n = 0;
    const liar = clone();
    liar.classes[Object.keys(liar.classes)[0]!].synonyms = withGetter(() =>
      ++n === 1 ? "widget" : 42,
    );
    expect(validateModel(liar).ok).toBe(false);
  });

  it("survives a Proxy that traps every way of looking at it", () => {
    const hostile = clone();
    hostile.classes[Object.keys(hostile.classes)[0]!].synonyms = new Proxy(["a"], {
      get(t, k) {
        if (k === "0") throw new Error("proxy get boom");
        return Reflect.get(t, k);
      },
      getOwnPropertyDescriptor() {
        throw new Error("proxy descriptor boom");
      },
    });
    expect(() => validateModel(hostile)).not.toThrow();
    const r = validateModel(hostile);
    expect(r.ok).toBe(false);
    expect(r.errors[0]?.message).toMatch(/could not be inspected/);

    // and a Proxy on the model root itself
    const root = new Proxy(clone(), {
      get() {
        throw new Error("root proxy boom");
      },
    });
    expect(() => validateModel(root)).not.toThrow();
    expect(validateModel(root).ok).toBe(false);
  });

  /* The catch that guarantees never-throws could itself throw: instanceof
     walks a prototype chain a revoked Proxy refuses, .message may be a getter,
     and String() needs a toString a null-prototype object does not have. */
  it("describes even a hostile thrown value without throwing", () => {
    const hostiles: [string, () => unknown][] = [
      ["revoked Proxy", () => {
        const { proxy, revoke } = Proxy.revocable({}, {});
        revoke();
        return proxy;
      }],
      ["null-prototype object", () => Object.create(null)],
      ["throwing toString", () => ({ toString() { throw new Error("toString boom"); } })],
      ["throwing Symbol.toPrimitive", () => ({ [Symbol.toPrimitive]() { throw new Error("toPrimitive boom"); } })],
      ["Error with a throwing message", () => {
        const e = new Error("x");
        Object.defineProperty(e, "message", { get() { throw new Error("msg boom"); } });
        return e;
      }],
      ["ordinary Error", () => new Error("ordinary boom")],
      ["a symbol", () => Symbol("sym")],
    ];

    for (const [name, make] of hostiles) {
      const m = clone();
      /* A Proxy over an array passes Array.isArray and traps the descriptor
         read, so the throw genuinely reaches the outer guard — an accessor on
         a real array would be refused before it ever fired. */
      m.classes[Object.keys(m.classes)[0]!].synonyms = new Proxy(["a"], {
        getOwnPropertyDescriptor() { throw make(); },
        get(t, k) {
          if (k === "0") throw make();
          return Reflect.get(t, k);
        },
      });
      expect(() => validateModel(m), name).not.toThrow();
      const r = validateModel(m);
      expect(r.ok, name).toBe(false);
      expect(r.errors[0]?.message, name).toMatch(/could not be inspected/);
    }

    // an ordinary Error still has its message surfaced, not swallowed
    const ordinary = clone();
    ordinary.classes[Object.keys(ordinary.classes)[0]!].synonyms = new Proxy(["a"], {
      getOwnPropertyDescriptor() { throw new Error("ordinary boom"); },
    });
    expect(validateModel(ordinary).errors[0]?.message).toContain("ordinary boom");
  });

  /* Only string arrays got the descriptor treatment; feature bindings — the
     shape that carries the actual semantics — were still read with c.features[i],
     and search.ts copies the array again with .slice(). A stateful slot could
     hand the validator one binding and getClass another. */
  it("refuses accessor slots in feature bindings", () => {
    const m = clone();
    const k = Object.keys(m.classes)[0]!;
    const real = m.classes[k].features.slice();
    let n = 0;
    const arr: unknown[] = [];
    Object.defineProperty(arr, 0, {
      get() {
        return ++n === 1 ? real[0] : { code: "EF999999", orderNumber: 1 };
      },
      enumerable: true,
      configurable: true,
    });
    for (let i = 1; i < real.length; i++) arr[i] = real[i];
    Object.defineProperty(arr, "length", { value: real.length, writable: true });
    m.classes[k].features = arr;

    const r = validateModel(m);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => /property accessor/.test(e.message))).toBe(true);
  });

  /* JSON.parse cannot produce an accessor, so one on the model root means the
     validate-then-trust contract is void. synthetic is the sharpest case: true
     while validating, false afterwards, and the MCP server drops the
     synthetic-data warning while serving invented classification as real. */
  it("refuses accessors on the model root and on source", () => {
    const m = clone();
    m.source = { type: "demo" };
    let n = 0;
    Object.defineProperty(m, "synthetic", {
      get() {
        return ++n <= 3;
      },
      enumerable: true,
      configurable: true,
    });
    const r = validateModel(m);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => /property accessor/.test(e.message))).toBe(true);

    const src = clone();
    Object.defineProperty(src.source, "type", {
      get: () => "etim-api",
      enumerable: true,
      configurable: true,
    });
    expect(validateModel(src).ok).toBe(false);
  });

  /* Object.keys lists only enumerable own properties, so the first version of
     the guard above was stepped around by declaring the getter non-enumerable. */
  it("sees accessors Object.keys hides", () => {
    const hidden = clone();
    hidden.source = { type: "demo" };
    delete hidden.synthetic;
    let n = 0;
    Object.defineProperty(hidden, "synthetic", {
      get() {
        return ++n <= 3;
      },
      enumerable: false,
      configurable: true,
    });
    expect(Object.keys(hidden).includes("synthetic")).toBe(false);
    expect(validateModel(hidden).ok).toBe(false);

    const symbolled = clone();
    Object.defineProperty(symbolled, Symbol("evil"), {
      get: () => 1,
      enumerable: true,
      configurable: true,
    });
    expect(validateModel(symbolled).ok).toBe(false);
  });

  it("leaves dense arrays alone", () => {
    const m = clone();
    const k = Object.keys(m.classes)[0]!;
    m.classes[k].synonyms = ["MCB", "breaker"];
    m.classes[k].sectors = ["EL"];
    m.classes[k].synonymTranslations = { DE: ["Sicherung"] };
    m.languages = ["DE"];
    expect(validateModel(m).ok).toBe(true);
  });
});

describe("translation keys carry their canonical casing", () => {
  const clone = () => JSON.parse(JSON.stringify(demoModel()));
  const miscased = (m: unknown) =>
    validateModel(m).errors.some((e) => /uppercase in this format/.test(e.message));

  it("rejects a lowercase key that the declared languages would have masked", () => {
    const m = clone();
    const k = Object.keys(m.classes)[0]!;
    m.classes[k].translations = { de: "Sicherung" };
    m.languages = ["DE"];
    expect(validateModel(m).ok).toBe(false);
    expect(miscased(m)).toBe(true);
  });

  /* Classes carried their own inline copy of this walk, so a check added to
     the shared helper alone would have covered every shape except classes. */
  it("covers all seven translation records, classes included", () => {
    const shapes: [string, (m: any) => void][] = [
      ["classes.translations", (m) => (m.classes[Object.keys(m.classes)[0]!].translations = { de: "x" })],
      ["classes.synonymTranslations", (m) => (m.classes[Object.keys(m.classes)[0]!].synonymTranslations = { de: ["x"] })],
      ["groups.translations", (m) => (m.groups[Object.keys(m.groups)[0]!].translations = { de: "x" })],
      ["features.translations", (m) => (m.features[Object.keys(m.features)[0]!].translations = { de: "x" })],
      ["values.translations", (m) => (m.values[Object.keys(m.values)[0]!].translations = { de: "x" })],
      ["units.translations", (m) => (m.units[Object.keys(m.units)[0]!].translations = { de: "x" })],
      ["units.abbreviationTranslations", (m) => (m.units[Object.keys(m.units)[0]!].abbreviationTranslations = { de: "x" })],
    ];
    for (const [name, mutate] of shapes) {
      const m = clone();
      mutate(m);
      expect(miscased(m), name).toBe(true);
    }
  });

  it("leaves canonical codes alone, regional and script subtags included", () => {
    for (const key of ["DE-DE", "FR", "PT-BR", "ZH-HANS"]) {
      const m = clone();
      const k = Object.keys(m.classes)[0]!;
      m.classes[k].translations = { ...m.classes[k].translations, [key]: "x" };
      m.languages = [...new Set([...m.languages, key])].sort();
      expect(validateModel(m).ok, key).toBe(true);
    }
  });

  it("rejects an empty language code", () => {
    const m = clone();
    m.classes[Object.keys(m.classes)[0]!].translations = { "": "x" };
    expect(validateModel(m).errors.some((e) => /empty language code/.test(e.message))).toBe(true);
  });
});

describe("retrievedAt is a real ISO-8601 instant", () => {
  const withRetrievedAt = (v: string) => {
    const m = JSON.parse(JSON.stringify(demoModel()));
    m.source.retrievedAt = v;
    return validateModel(m);
  };
  const errored = (v: string) =>
    withRetrievedAt(v).errors.some((e) => e.path === "$.source.retrievedAt");

  it("accepts genuine ISO timestamps", () => {
    for (const ok of [
      "2026-08-12T09:30:00Z",
      "2026-08-12T09:30:00.123Z",
      "2026-08-12T09:30:00+01:00",
      "2026-08-12T24:00:00Z", // legal end-of-day
      "2024-02-29T00:00:00Z", // leap year
    ]) {
      expect(errored(ok), ok).toBe(false);
    }
  });

  it("rejects shapes Date.parse would have waved through", () => {
    for (const bad of [
      "12/31/2025", // parseable, not ISO
      "2025-02-31T00:00:00Z", // JS rolls this to 3 March
      "2025-02-29T00:00:00Z", // not a leap year
      "2026-13-01T00:00:00Z", // month 13
      "2026-08-12T24:00:01Z", // 24:00 must be exact
      "2026-08-12", // date only, no instant
      "not a date",
    ]) {
      expect(errored(bad), bad).toBe(true);
    }
  });

  /* 24:00 is the end of the day exactly. The fraction went uncaptured, so
     .123 sat in the string while the check read a zero second. */
  it("allows 24:00:00 only when the fraction is zero too", () => {
    for (const ok of ["2026-08-12T24:00:00Z", "2026-08-12T24:00:00.000Z", "2026-08-12T24:00:00.0Z"]) {
      expect(errored(ok), ok).toBe(false);
    }
    for (const bad of ["2026-08-12T24:00:00.123Z", "2026-08-12T24:00:00.5+01:00"]) {
      expect(errored(bad), bad).toBe(true);
    }
    /* A fraction anywhere else in the day is ordinary precision, not an overrun. */
    expect(errored("2026-08-12T23:59:59.999Z")).toBe(false);
    expect(errored("2026-08-12T09:30:00.123Z")).toBe(false);
  });

  /* Second 60 is a leap second, which only exists at the end of a UTC day —
     and which V8 cannot parse even when genuine, returning Invalid Date. */
  it("rejects second 60 outright", () => {
    for (const bad of [
      "2026-08-12T12:34:60Z", // never a leap-second position
      "2016-12-31T23:59:60Z", // a real leap second; still unparseable in JS
      "2026-08-12T23:59:60+00:00",
    ]) {
      expect(errored(bad), bad).toBe(true);
    }
    for (const ok of ["2026-08-12T23:59:59Z", "2026-08-12T23:59:59.999Z"]) {
      expect(errored(ok), ok).toBe(false);
    }
  });

  /* The offset is part of the instant. Matching it as one opaque [+-]\d{2}:\d{2}
     blob let +99:99 through — the clock was range-checked and the zone was not. */
  it("range-checks the UTC offset, not just the clock", () => {
    for (const ok of [
      "2026-08-12T09:30:00+00:00",
      "2026-08-12T09:30:00-00:00", // RFC 3339: offset unknown
      "2026-08-12T09:30:00+14:00", // real-world maximum
      "2026-08-12T09:30:00-12:00",
      "2026-08-12T09:30:00+23:59", // grammar's limit, still valid
    ]) {
      expect(errored(ok), ok).toBe(false);
    }
    for (const bad of [
      "2026-08-12T09:30:00+99:99",
      "2026-08-12T09:30:00+24:00", // offset hour tops out at 23
      "2026-08-12T09:30:00+05:60", // offset minute tops out at 59
      "2026-08-12T09:30:00+5:00", // must be two digits
      "2026-08-12T09:30:00", // an offset is not optional
    ]) {
      expect(errored(bad), bad).toBe(true);
    }
  });
});

describe("units belong to numeric and range features", () => {
  const bindUnit = (featureCode: string, field: "unitCode" | "unitImperialCode") => {
    const m = JSON.parse(JSON.stringify(demoModel()));
    const cls: any = Object.values(m.classes)[0];
    const binding = cls.features.find((b: any) => b.code === featureCode);
    binding[field] = Object.keys(m.units)[0];
    return validateModel(m).warnings.filter((w) => /units belong to N and R/.test(w.message));
  };

  /* EF990002 is alphanumeric, EF990003 logical. Before this, only unitCode on
     a logical feature warned — the other three combinations passed --strict. */
  it("warns for either unit field on either A or L features", () => {
    expect(bindUnit("EF990002", "unitCode")).toHaveLength(1);
    expect(bindUnit("EF990002", "unitImperialCode")).toHaveLength(1);
    expect(bindUnit("EF990003", "unitCode")).toHaveLength(1);
    expect(bindUnit("EF990003", "unitImperialCode")).toHaveLength(1);
  });

  it("stays quiet on a clean model", () => {
    expect(
      validateModel(demoModel()).warnings.filter((w) => /units belong to N and R/.test(w.message)),
    ).toHaveLength(0);
  });
});
