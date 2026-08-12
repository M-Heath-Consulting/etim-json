/* The adversarial suite: inputs chosen to break the tool, not exercise it.
 *
 * Two layers. In-process attacks on the parser/validator/search, and a real
 * child-process attack on the built CLI + MCP stdio server — the binary a
 * user actually runs, framed messages over an actual pipe. */

import { describe, expect, it } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseModelJson, serializeModel } from "../src/model.js";
import { assertModel, validateModel } from "../src/validate.js";
import { searchClasses } from "../src/search.js";
import { demoModel } from "../src/demo.js";
import { generateTypes } from "../src/typegen.js";
import { fetchModel, modelFromApiClasses } from "../src/adapters/etim-api.js";

describe("hostile JSON", () => {
  it("refuses __proto__ smuggling at parse time", () => {
    expect(() => parseModelJson('{"kind":"etim-model","__proto__":{"polluted":true}}')).toThrow(/hostile/);
    expect(() => parseModelJson('{"a":{"b":{"constructor":{"x":1}}}}')).toThrow(/hostile/);
    // And the global prototype stayed clean even after the attempts.
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("rejects scalar, array and null roots with findings, not exceptions", () => {
    for (const raw of ["[]", "null", '"model"', "3"]) {
      const res = validateModel(JSON.parse(raw));
      expect(res.ok).toBe(false);
      expect(res.errors[0]?.path).toBe("$");
    }
  });

  it("reports malformed entries without crashing on garbage shapes", () => {
    const res = validateModel({
      kind: "etim-model",
      formatVersion: 1,
      release: "X",
      languages: ["EN"],
      source: { type: "custom" },
      attribution: { licence: "x", licenceUrl: "x", statement: "x" },
      groups: { EG000001: null },
      features: { "EF-BAD": { description: "d", type: "N" }, EF000001: 42 },
      values: [],
      units: { EU000001: { description: "", abbreviation: "m" } },
      classes: { EC000001: { version: -2, groupCode: 7, features: "nope" } },
    });
    expect(res.ok).toBe(false);
    const paths = res.errors.map((e) => e.path).join("\n");
    expect(paths).toContain('$.groups["EG000001"]');
    expect(paths).toContain('$.features["EF-BAD"]');
    expect(paths).toContain("$.values");
  });

  it("survives absurd numerics and unicode without misbehaving", () => {
    const m = demoModel();
    m.classes["EC990001"]!.version = Number.MAX_SAFE_INTEGER;
    m.classes["EC990001"]!.description = "﷽".repeat(1000) + "\u0000￿" + "🔌".repeat(500);
    const res = validateModel(m);
    expect(res.ok).toBe(true); // huge-but-integer version and odd text are data, not errors
    const hits = searchClasses(m, "🔌");
    expect(hits[0]?.code).toBe("EC990001");
  });
});

describe("hostile search input", () => {
  const m = demoModel();

  it("treats every regex metacharacter as literal text", () => {
    for (const q of [".*", "(", ")", "[", "]", "\\", "a{2,}", "^demo$", "?", "+"]) {
      expect(() => searchClasses(m, q)).not.toThrow();
    }
  });

  it("stays fast on pathological query lengths", () => {
    const q = "a".repeat(100_000);
    const t0 = performance.now();
    searchClasses(m, q);
    expect(performance.now() - t0).toBeLessThan(1000);
  });
});

describe("hostile API payloads through the adapter", () => {
  it("never lets embedded hostile keys reach the model", () => {
    const { model } = modelFromApiClasses(
      [
        {
          code: "EC990199",
          version: 1,
          descriptionEn: "hostile",
          group: { code: "EG990199", descriptionEn: "g" },
          features: [],
          translations: [
            { languagecode: "__proto__", description: "boom" },
            { languagecode: null, description: "no lang" },
          ],
        },
      ],
      { release: "T" },
    );
    // The hostile language code is dropped, not uppercased into harmlessness:
    // no prototype-chain key in any casing, a clean round-trip, and a clean
    // global prototype afterwards.
    const cls = model.classes["EC990199"];
    const keys = Object.keys(cls?.translations ?? {});
    expect(keys.filter((k) => /proto|constructor/i.test(k))).toEqual([]);
    expect(() => parseModelJson(serializeModel(model))).not.toThrow();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("handles nulls everywhere the contract marks nullable", () => {
    const { model, warnings } = modelFromApiClasses(
      [
        {
          code: "EC990198",
          version: 1,
          descriptionEn: null,
          description: null,
          synonyms: null,
          group: null,
          features: null,
          translations: null,
          sectors: null,
        },
      ],
      { release: "T" },
    );
    expect(model.classes["EC990198"]?.description).toBe("EC990198"); // code as last-resort description
    expect(warnings.some((w) => w.includes("no group"))).toBe(true);
    // And validation catches the dangling group placeholder rather than passing it.
    expect(validateModel(model).ok).toBe(false);
  });
});

/* ---- the built artefact, attacked over a real pipe ----------------------- */

const DIST = join(import.meta.dirname, "..", "dist", "cli.js");

describe.skipIf(!existsSync(DIST))("built CLI under attack", () => {
  const dir = mkdtempSync(join(tmpdir(), "etim-adv-"));

  const run = (args: string[], input?: string) => {
    try {
      return {
        code: 0,
        out: execFileSync("node", [DIST, ...args], {
          encoding: "utf8",
          ...(input !== undefined ? { input } : {}),
          timeout: 30_000,
        }),
      };
    } catch (e) {
      const err = e as { status?: number; stdout?: string; stderr?: string };
      return { code: err.status ?? 1, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
    }
  };

  it("validate exits 1 on a corrupt file and 0 on a clean one", () => {
    const good = join(dir, "good.json");
    writeFileSync(good, serializeModel(demoModel()));
    expect(run(["validate", good]).code).toBe(0);

    const bad = join(dir, "bad.json");
    writeFileSync(bad, '{"kind":"etim-model","classes":');
    expect(run(["validate", bad]).code).toBe(1);

    const hostile = join(dir, "hostile.json");
    writeFileSync(hostile, '{"kind":"etim-model","__proto__":{"x":1}}');
    const res = run(["validate", hostile]);
    expect(res.code).toBe(1);
    expect(res.out).toContain("hostile");
  });

  it("refuses unknown commands and missing files with exit 1, no stack trace", () => {
    const a = run(["frobnicate"]);
    expect(a.code).toBe(1);
    expect(a.out).not.toContain("at ");
    const b = run(["stats", join(dir, "missing.json")]);
    expect(b.code).toBe(1);
  });

  it("speaks real MCP over stdio: initialize → list → call → hostile call", async () => {
    const proc = spawn("node", [DIST, "mcp", "--demo"], { stdio: ["pipe", "pipe", "pipe"] });
    const send = (o: unknown) => proc.stdin.write(JSON.stringify(o) + "\n");

    const messages: Record<string, unknown>[] = [];
    let buffer = "";
    proc.stdout.on("data", (d: Buffer) => {
      buffer += d.toString();
      let nl;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line) messages.push(JSON.parse(line) as Record<string, unknown>);
      }
    });
    const waitFor = (id: number, timeoutMs = 10_000) =>
      new Promise<Record<string, unknown>>((resolve, reject) => {
        const t0 = Date.now();
        const tick = () => {
          const hit = messages.find((m) => m.id === id);
          if (hit) return resolve(hit);
          if (Date.now() - t0 > timeoutMs) return reject(new Error(`timeout waiting for id ${id}`));
          setTimeout(tick, 25);
        };
        tick();
      });

    try {
      send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "adversary", version: "0.0.0" },
        },
      });
      const init = await waitFor(1);
      const serverInfo = (init.result as { serverInfo: { name: string } }).serverInfo;
      expect(serverInfo.name).toBe("etim-json");
      send({ jsonrpc: "2.0", method: "notifications/initialized" });

      send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
      const list = await waitFor(2);
      expect((list.result as { tools: unknown[] }).tools).toHaveLength(5);

      send({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "etim_get_class", arguments: { code: "EC990002" } },
      });
      const call = await waitFor(3);
      const sc = (call.result as { structuredContent: { found: boolean } }).structuredContent;
      expect(sc.found).toBe(true);

      // Hostile: unknown tool must produce a JSON-RPC error, not a crash.
      send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "shell_exec", arguments: {} } });
      const hostileCall = await waitFor(4);
      expect(hostileCall.error ?? (hostileCall.result as { isError?: boolean }).isError).toBeTruthy();

      // Hostile: unparseable frame on the wire; server must survive and answer the next request.
      proc.stdin.write("this is not json\n");
      send({ jsonrpc: "2.0", id: 5, method: "tools/list", params: {} });
      const after = await waitFor(5);
      expect((after.result as { tools: unknown[] }).tools).toHaveLength(5);
    } finally {
      proc.kill();
    }
  }, 30_000);
});

/* ---- regressions pinned from the first external review ------------------- */

describe("review findings stay fixed", () => {
  it("P1: malformed bindings (null/number/string/array) yield findings, never a TypeError", () => {
    const m = demoModel() as unknown as {
      classes: Record<string, { features: unknown[] }>;
    };
    m.classes["EC990001"]!.features.push(null, 42, "EF990001", ["EF990001"]);
    const res = validateModel(m);
    expect(res.ok).toBe(false);
    const bindingErrors = res.errors.filter((e) => e.message.includes("Binding must be an object"));
    expect(bindingErrors).toHaveLength(4);
    expect(bindingErrors[0]?.path).toBe('$.classes["EC990001"].features[4]');
  });

  it("P1: prototype-chain names are not valid references", () => {
    const m = demoModel();
    m.classes["EC990001"]!.groupCode = "toString";
    m.classes["EC990002"]!.features[0]!.code = "hasOwnProperty" as never;
    m.classes["EC990003"]!.features[0]!.unitCode = "valueOf";
    const res = validateModel(m);
    const paths = res.errors.map((e) => e.path).join("\n");
    expect(paths).toContain('$.classes["EC990001"].groupCode');
    expect(paths).toContain('$.classes["EC990002"].features[0].code');
    expect(paths).toContain('$.classes["EC990003"].features[0].unitCode');
  });

  it("P2: unknown feature types survive the adapter verbatim and fail validation", () => {
    const { model, warnings } = modelFromApiClasses(
      [
        {
          code: "EC990197",
          version: 1,
          descriptionEn: "verbatim type",
          group: { code: "EG990197", descriptionEn: "g" },
          features: [{ code: "EF990197", type: "Z", descriptionEn: "odd", orderNumber: 1 }],
        },
      ],
      { release: "T" },
    );
    expect((model.features["EF990197"] as { type: string }).type).toBe("Z");
    expect(warnings.some((w) => w.includes("kept verbatim"))).toBe(true);
    const res = validateModel(model);
    expect(res.errors.some((e) => e.path === '$.features["EF990197"].type')).toBe(true);
  });

  it("P2: English is never listed as a translation language", () => {
    const { model } = modelFromApiClasses(
      [
        {
          code: "EC990187",
          version: 1,
          descriptionEn: "c",
          group: { code: "EG990187", descriptionEn: "g" },
          features: [],
          translations: [
            { languagecode: "EN", description: "english" },
            { languagecode: "DE", description: "deutsch" },
          ],
        },
      ],
      { release: "T", languages: ["EN", "DE", "en"] },
    );
    // languages is DERIVED from what was retained; EN is base text, never a
    // translation, so it can never appear here.
    expect(model.languages).toEqual(["DE"]);
    expect(Object.keys(model.classes["EC990187"]?.translations ?? {})).toEqual(["DE"]);
  });

  it("P2: release and attribution cannot close the generated comment", () => {
    const m = demoModel();
    (m as { release: string }).release = "EVIL */ export const pwned = 1; /*";
    m.attribution.statement = "notice */ export const pwned2 = 2; /*";
    const src = generateTypes(m);
    // The only comment-closers are the legitimate ones ending each block.
    for (const line of src.split("\n")) {
      if (line.includes("pwned")) expect(line).toContain("*\\/");
    }
    expect(src).not.toMatch(/^\s*export const pwned/m);
  });

  it("P2: the size ceiling counts UTF-8 bytes, not UTF-16 units", () => {
    const euro = "€".repeat(4); // 4 chars, 12 UTF-8 bytes
    expect(() => parseModelJson(`"${euro}"`, { maxBytes: 10 })).toThrow(/ceiling/);
    expect(() => parseModelJson(`"${euro}"`, { maxBytes: 20 })).not.toThrow();
  });
});

describe("second-pass review finding stays fixed", () => {
  it("P1: a string valueCodes is a shape error, and getClass cannot be crashed by a validated model", () => {
    const m = demoModel() as unknown as {
      classes: Record<string, { features: { valueCodes?: unknown }[] }>;
    };
    m.classes["EC990001"]!.features[1]!.valueCodes = "EV990001";
    const res = validateModel(m);
    expect(res.ok).toBe(false);
    expect(
      res.errors.some(
        (e) => e.path === '$.classes["EC990001"].features[1].valueCodes' && e.message.includes("must be an array"),
      ),
    ).toBe(true);
    // The contract the finding was really about: validation passing implies
    // the resolvers cannot crash. A model that fails validation is refused by
    // assertModel, so getClass never sees the string.
    expect(() => assertModel(m)).toThrow(/valueCodes/);
  });
});

describe("third-pass review finding stays fixed", () => {
  it("P2: EN never appears as a translation key anywhere in the model", () => {
    const { model } = modelFromApiClasses(
      [
        {
          code: "EC990196",
          version: 1,
          descriptionEn: "en-consistency",
          group: {
            code: "EG990196",
            descriptionEn: "g",
            translations: [
              { languagecode: "EN", description: "english leak" },
              { languagecode: "de-DE", description: "gut" },
            ],
          },
          translations: [
            { languagecode: "en", description: "english leak", synonyms: ["leak"] },
            { languagecode: "de-DE", description: "gut", synonyms: ["prima"] },
          ],
          features: [
            {
              code: "EF990196",
              type: "N",
              descriptionEn: "f",
              orderNumber: 1,
              unit: {
                code: "EU990196",
                descriptionEn: "u",
                abbreviationEn: "x",
                translations: [
                  { languagecode: "EN", description: "english leak", abbreviation: "x" },
                  { languagecode: "de-DE", description: "gut", abbreviation: "x" },
                ],
              },
            },
          ],
        },
      ],
      { release: "T", languages: ["EN", "DE"] },
    );
    const allKeys = [
      ...Object.keys(model.classes["EC990196"]?.translations ?? {}),
      ...Object.keys(model.classes["EC990196"]?.synonymTranslations ?? {}),
      ...Object.keys(model.groups["EG990196"]?.translations ?? {}),
      ...Object.keys(model.units["EU990196"]?.translations ?? {}),
      ...Object.keys(model.units["EU990196"]?.abbreviationTranslations ?? {}),
    ];
    expect(allKeys.filter((k) => k.toUpperCase() === "EN")).toEqual([]);
    expect(allKeys).toContain("DE-DE");
    // Derived from the data: the retained key is the regional form the API
    // issued, and languages says so rather than a tidied-up guess.
    expect(model.languages).toEqual(["DE-DE"]);
  });
});

describe("fourth-pass review finding stays fixed", () => {
  it("P2: an EN translation is promoted to base text when descriptionEn is absent, not deleted", () => {
    const { model } = modelFromApiClasses(
      [
        {
          code: "EC990195",
          version: 1,
          descriptionEn: null,
          description: "Nur Deutsch",
          group: {
            code: "EG990195",
            descriptionEn: null,
            description: "Gruppe",
            translations: [{ languagecode: "EN", description: "English group" }],
          },
          translations: [
            { languagecode: "EN", description: "English class", synonyms: ["english synonym"] },
            { languagecode: "de-DE", description: "Nur Deutsch" },
          ],
          features: [
            {
              code: "EF990195",
              type: "N",
              descriptionEn: null,
              description: "Merkmal",
              translations: [{ languagecode: "en", description: "English feature" }],
              orderNumber: 1,
              unit: {
                code: "EU990195",
                descriptionEn: null,
                description: "Einheit",
                abbreviationEn: null,
                abbreviation: "mm",
                translations: [{ languagecode: "EN", description: "English unit", abbreviation: "MM" }],
              },
            },
          ],
        },
      ],
      { release: "T", languages: ["DE"] },
    );
    expect(model.classes["EC990195"]?.description).toBe("English class");
    expect(model.classes["EC990195"]?.synonyms).toEqual(["english synonym"]);
    expect(model.groups["EG990195"]?.description).toBe("English group");
    expect(model.features["EF990195"]?.description).toBe("English feature");
    expect(model.units["EU990195"]?.description).toBe("English unit");
    expect(model.units["EU990195"]?.abbreviation).toBe("MM");
    // and still: EN never stored as a translation key
    expect(Object.keys(model.classes["EC990195"]?.translations ?? {})).toEqual(["DE-DE"]);
  });
});

describe("fifth-pass review finding stays fixed", () => {
  it("P2: English translation synonyms outrank primary-language top-level synonyms", () => {
    const { model } = modelFromApiClasses(
      [
        {
          code: "EC990194",
          version: 1,
          descriptionEn: "precedence",
          synonyms: ["deutsches synonym"],
          group: { code: "EG990194", descriptionEn: "g" },
          translations: [
            { languagecode: "EN", description: "precedence", synonyms: ["english synonym"] },
            { languagecode: "de-DE", description: "Vorrang", synonyms: ["deutsches synonym"] },
          ],
          features: [],
        },
      ],
      { release: "T", languages: ["DE"] },
    );
    expect(model.classes["EC990194"]?.synonyms).toEqual(["english synonym"]);
    expect(model.classes["EC990194"]?.synonymTranslations?.["DE-DE"]).toEqual(["deutsches synonym"]);
    // No English source at all → primary-language synonyms survive as the fallback.
    const { model: m2 } = modelFromApiClasses(
      [
        {
          code: "EC990193",
          version: 1,
          descriptionEn: "fallback",
          synonyms: ["nur deutsch"],
          group: { code: "EG990193", descriptionEn: "g" },
          features: [],
        },
      ],
      { release: "T", languages: ["DE"] },
    );
    expect(m2.classes["EC990193"]?.synonyms).toEqual(["nur deutsch"]);
  });
});

/* ---- findings raised on the full-repository PR (#1) ---------------------- */

describe("full-repo review findings stay fixed", () => {
  it("P1: optional class search fields are shape-checked, so search cannot be crashed", () => {
    for (const [field, bad] of [
      ["synonyms", "not-an-array"],
      ["sectors", "E"],
      ["translations", "de"],
      ["synonymTranslations", { DE: "not-an-array" }],
    ] as const) {
      const m = demoModel() as unknown as { classes: Record<string, Record<string, unknown>> };
      m.classes["EC990001"]![field] = bad;
      const res = validateModel(m);
      expect(res.ok, `${field} must be rejected`).toBe(false);
      expect(res.errors.some((e) => e.path.includes(field))).toBe(true);
      expect(() => assertModel(m)).toThrow();
    }
    // A model that validates never crashes the search.
    const good = demoModel();
    expect(() => searchClasses(assertModel(good), "anything")).not.toThrow();
  });

  it("P2: attribution must be complete and non-empty", () => {
    for (const bad of [
      { statement: "" },
      { statement: "x" },
      { licence: "ODC-BY 1.0", licenceUrl: "", statement: "x" },
    ]) {
      const m = demoModel() as unknown as { attribution: unknown };
      m.attribution = bad;
      const res = validateModel(m);
      expect(res.ok).toBe(false);
      expect(res.errors.some((e) => e.path.startsWith("$.attribution"))).toBe(true);
    }
  });

  it("P2: a hostile entity code is kept and rejected, never silently swallowed", () => {
    const { model } = modelFromApiClasses(
      [
        {
          code: "__proto__",
          version: 1,
          descriptionEn: "hostile class code",
          group: { code: "EG990192", descriptionEn: "g" },
          features: [],
        },
        {
          code: "EC990192",
          version: 1,
          descriptionEn: "real one",
          group: { code: "EG990192", descriptionEn: "g" },
          features: [],
        },
      ],
      { release: "T" },
    );
    // Present as an own key — not swallowed by a prototype setter…
    expect(Object.keys(model.classes)).toContain("__proto__");
    // …and therefore visible to validation, which refuses it.
    const res = validateModel(model);
    expect(res.ok).toBe(false);
    expect(res.errors.some((e) => e.path.includes("__proto__"))).toBe(true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe("fetch paging contract", () => {
  /** A fake ETIM API: one token, then pages of synthetic classes. */
  const server = (totalClasses: number) => {
    const calls: { size: number; from: number; languagecode: string; translations: boolean }[] = [];
    const fetchImpl = async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("connect/token")) {
        return new Response(JSON.stringify({ access_token: "t" }), { status: 200 });
      }
      const body = JSON.parse(String(init?.body)) as {
        from: number;
        size: number;
        languagecode: string;
        include: { translations: boolean };
      };
      calls.push({
        size: body.size,
        from: body.from,
        languagecode: body.languagecode,
        translations: body.include.translations,
      });
      const classes = Array.from({ length: Math.min(body.size, totalClasses - body.from) }, (_, i) => ({
        code: `EC99${String(body.from + i).padStart(4, "0")}`,
        version: 1,
        descriptionEn: `c${body.from + i}`,
        group: { code: "EG990001", descriptionEn: "g" },
        features: [],
        /* Carry a translation only when the request asked for them, so the
           test exercises the real round trip rather than a stub. */
        ...(body.include.translations
          ? { translations: [{ languagecode: "de-DE", description: `c${body.from + i} (de)` }] }
          : {}),
      }));
      return new Response(JSON.stringify({ total: totalClasses, classes }), { status: 200 });
    };
    return { calls, fetchImpl };
  };

  it("P2: the class ceiling clamps the request and refuses a truncated model", async () => {
    const { calls, fetchImpl } = server(500);
    const original = globalThis.fetch;
    globalThis.fetch = fetchImpl as typeof fetch;
    try {
      /* Hitting the ceiling with pages left is an error, not a quiet partial
         result: a silently truncated ETIM model makes absent classes look
         like they do not exist. The clamp is still asserted — the page
         request asks for the remaining allowance, never the full pageSize. */
      await expect(
        fetchModel({ clientId: "x", clientSecret: "y", pageSize: 100, maxClasses: 10, languages: ["EN"] }),
      ).rejects.toThrow(/ceiling/);
      expect(calls[0]?.size).toBe(10);
    } finally {
      globalThis.fetch = original;
    }
  });

  /* Offset pagination over a model the server may be changing underneath us.
     A repeat advanced `from` twice while modelFromApiClasses kept one row, so
     the loop satisfied `from >= total` and returned fewer classes than it
     reported — with nothing saying which were lost. */
  /* `total` is re-read each page because DYNAMIC can change size mid-fetch,
     but it must stay consistent with the cursor. Two rows collected under
     total: 4, then an offset-2 page reporting total: 1, used to hit the
     empty-page branch and be written as a complete model. */
  it("P2: a total that falls behind the cursor is refused", async () => {
    let page = 0;
    const impl = async (url: string | URL) => {
      if (String(url).includes("connect/token")) {
        return new Response(JSON.stringify({ access_token: "t" }), { status: 200 });
      }
      if (page++ === 0) {
        return new Response(
          JSON.stringify({
            total: 4,
            classes: [
              { code: "EC990000", version: 1, descriptionEn: "a", group: { code: "EG990001", descriptionEn: "g" }, features: [] },
              { code: "EC990001", version: 1, descriptionEn: "b", group: { code: "EG990001", descriptionEn: "g" }, features: [] },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ total: 1, classes: [] }), { status: 200 });
    };
    const original = globalThis.fetch;
    globalThis.fetch = impl as unknown as typeof fetch;
    try {
      await expect(
        fetchModel({ clientId: "x", clientSecret: "y", pageSize: 2, maxClasses: 100, languages: ["EN"] }),
      ).rejects.toThrow(/fewer than already fetched/);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("P2: a class repeated across pages is refused, not silently collapsed", async () => {
    const repeating = () => {
      let page = 0;
      return async (url: string | URL, init?: RequestInit) => {
        const u = String(url);
        if (u.includes("connect/token")) {
          return new Response(JSON.stringify({ access_token: "t" }), { status: 200 });
        }
        void init;
        // both pages carry EC990000; total claims four distinct classes
        const codes = page++ === 0 ? ["EC990000", "EC990001"] : ["EC990000", "EC990002"];
        const classes = codes.map((code) => ({
          code,
          version: 1,
          descriptionEn: code,
          group: { code: "EG990001", descriptionEn: "g" },
          features: [],
        }));
        return new Response(JSON.stringify({ total: 4, classes }), { status: 200 });
      };
    };
    const original = globalThis.fetch;
    globalThis.fetch = repeating() as unknown as typeof fetch;
    try {
      await expect(
        fetchModel({ clientId: "x", clientSecret: "y", pageSize: 2, maxClasses: 100, languages: ["EN"] }),
      ).rejects.toThrow(/more than one page/);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("P2: a release inside the ceiling converts completely", async () => {
    const { calls, fetchImpl } = server(7);
    const original = globalThis.fetch;
    globalThis.fetch = fetchImpl as typeof fetch;
    try {
      const { model } = await fetchModel({
        clientId: "x",
        clientSecret: "y",
        pageSize: 5,
        maxClasses: 100,
        languages: ["EN"],
      });
      expect(Object.keys(model.classes)).toHaveLength(7);
      expect(calls.map((c) => c.size)).toEqual([5, 5]);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("P1: a sole non-English language still requests English base + translations", async () => {
    const { calls, fetchImpl } = server(1);
    const original = globalThis.fetch;
    globalThis.fetch = fetchImpl as typeof fetch;
    try {
      const { model } = await fetchModel({
        clientId: "x",
        clientSecret: "y",
        languages: ["DE"],
        maxClasses: 5,
      });
      expect(calls[0]?.languagecode).toBe("EN");
      expect(calls[0]?.translations).toBe(true);
      // and the German actually arrived, which is the point of the finding
      expect(model.languages).toEqual(["DE-DE"]);
      expect(Object.values(model.classes)[0]?.translations?.["DE-DE"]).toContain("(de)");
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("sixth-pass review findings stay fixed", () => {
  it("P1: a server ignoring the requested size is refused, not silently trimmed", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      if (String(url).includes("connect/token")) {
        return new Response(JSON.stringify({ access_token: "t" }), { status: 200 });
      }
      void init;
      // Ignores `size` entirely and returns everything, reporting total: 50.
      const classes = Array.from({ length: 50 }, (_, i) => ({
        code: `EC99${String(i).padStart(4, "0")}`,
        version: 1,
        descriptionEn: `c${i}`,
        group: { code: "EG990001", descriptionEn: "g" },
        features: [],
      }));
      return new Response(JSON.stringify({ total: 50, classes }), { status: 200 });
    }) as typeof fetch;
    try {
      await expect(
        fetchModel({ clientId: "x", clientSecret: "y", pageSize: 100, maxClasses: 10 }),
      ).rejects.toThrow(/refusing to truncate/);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("P2: a feature-type conflict between classes is reported, not swallowed", () => {
    const mk = (code: string, type: string) => ({
      code,
      version: 1,
      descriptionEn: "c",
      group: { code: "EG990191", descriptionEn: "g" },
      features: [{ code: "EF990191", type, descriptionEn: "same text", orderNumber: 1 }],
    });
    const { warnings } = modelFromApiClasses([mk("EC990190", "N"), mk("EC990191", "A")], {
      release: "T",
    });
    expect(warnings.some((w) => w.includes("EF990191") && w.includes("type differs"))).toBe(true);
  });

  it("P2: a non-boolean deprecated flag is rejected everywhere it can appear", () => {
    const places: [string, (m: ReturnType<typeof demoModel>) => void][] = [
      ['$.features["EF990001"].deprecated', (m) => ((m.features["EF990001"] as { deprecated?: unknown }).deprecated = "false")],
      ['$.values["EV990001"].deprecated', (m) => ((m.values["EV990001"] as { deprecated?: unknown }).deprecated = 1)],
      ['$.units["EU990001"].deprecated', (m) => ((m.units["EU990001"] as { deprecated?: unknown }).deprecated = "yes")],
      ['$.classes["EC990001"].features[0].deprecated', (m) => ((m.classes["EC990001"]!.features[0] as { deprecated?: unknown }).deprecated = "true")],
    ];
    for (const [path, mutate] of places) {
      const m = demoModel();
      mutate(m);
      const res = validateModel(m);
      expect(res.ok, path).toBe(false);
      expect(res.errors.some((e) => e.path === path)).toBe(true);
    }
  });
});

describe("seventh-pass review findings stay fixed", () => {
  it("P1: an empty page with classes outstanding fails the fetch", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL) => {
      if (String(url).includes("connect/token")) {
        return new Response(JSON.stringify({ access_token: "t" }), { status: 200 });
      }
      return new Response(JSON.stringify({ total: 500, classes: [] }), { status: 200 });
    }) as typeof fetch;
    try {
      await expect(fetchModel({ clientId: "x", clientSecret: "y" })).rejects.toThrow(/partial model/);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("P2: languages describes what was retained, and extras are dropped", () => {
    const { model, warnings } = modelFromApiClasses(
      [
        {
          code: "EC990189",
          version: 1,
          descriptionEn: "c",
          group: { code: "EG990189", descriptionEn: "g" },
          features: [],
          translations: [
            { languagecode: "DE", description: "Deutsch" },
            { languagecode: "FR", description: "Français" }, // not requested
          ],
        },
      ],
      { release: "T", languages: ["EN", "DE"] },
    );
    expect(Object.keys(model.classes["EC990189"]?.translations ?? {})).toEqual(["DE"]);
    expect(model.languages).toEqual(["DE"]);
    expect(warnings).toEqual([]);

    // Asking for a language the response never carries is reported, not implied.
    const { model: m2, warnings: w2 } = modelFromApiClasses(
      [
        {
          code: "EC990188",
          version: 1,
          descriptionEn: "c",
          group: { code: "EG990188", descriptionEn: "g" },
          features: [],
        },
      ],
      { release: "T", languages: ["EN", "SV"] },
    );
    expect(m2.languages).toEqual([]);
    expect(w2.some((w) => w.includes("SV"))).toBe(true);
  });

  it("P2: a non-boolean synthetic flag is rejected", () => {
    const m = demoModel() as unknown as { synthetic: unknown };
    m.synthetic = "false";
    const res = validateModel(m);
    expect(res.ok).toBe(false);
    expect(res.errors.some((e) => e.path === "$.synthetic")).toBe(true);
  });

  it("P2: validateModel never throws, even on BigInt or cyclic input", () => {
    const big = demoModel() as unknown as { features: Record<string, { deprecated?: unknown }> };
    big.features["EF990001"]!.deprecated = 1n;
    expect(() => validateModel(big)).not.toThrow();
    expect(validateModel(big).ok).toBe(false);

    const cyclic = demoModel() as unknown as { classes: Record<string, { version: unknown }> };
    const loop: Record<string, unknown> = {};
    loop.self = loop;
    cyclic.classes["EC990001"]!.version = loop;
    expect(() => validateModel(cyclic)).not.toThrow();
    expect(validateModel(cyclic).ok).toBe(false);
  });
});

describe("eighth-pass review findings stay fixed", () => {
  it("P1: a demo source without the synthetic marker is refused", () => {
    const m = demoModel() as unknown as { synthetic?: unknown };
    delete m.synthetic;
    expect(validateModel(m).errors.some((e) => e.path === "$.synthetic")).toBe(true);
    m.synthetic = false;
    expect(validateModel(m).errors.some((e) => e.path === "$.synthetic")).toBe(true);
    // The bundled demo itself is consistent.
    expect(validateModel(demoModel()).ok).toBe(true);
  });

  it("P2: source.type must be one of the documented values", () => {
    for (const bad of ["remote", "", "ETIM-API", 7]) {
      const m = demoModel() as unknown as { source: { type: unknown } };
      m.source = { type: bad };
      const res = validateModel(m);
      expect(res.ok, String(bad)).toBe(false);
      expect(res.errors.some((e) => e.path.startsWith("$.source"))).toBe(true);
    }
  });

  it("P2: searching DE finds a DE-DE translation, as API-converted models carry", () => {
    const { model } = modelFromApiClasses(
      [
        {
          code: "EC990186",
          version: 1,
          descriptionEn: "regional search",
          group: { code: "EG990186", descriptionEn: "g" },
          features: [],
          translations: [
            { languagecode: "de-DE", description: "Leitungsschutzschalter", synonyms: ["Sicherungsautomat"] },
          ],
        },
      ],
      { release: "T", languages: ["DE"] },
    );
    model.attribution = demoModel().attribution;
    expect(Object.keys(model.classes["EC990186"]?.translations ?? {})).toEqual(["DE-DE"]);
    // The documented request form is the primary subtag.
    expect(searchClasses(model, "Leitungsschutzschalter", { language: "DE" })[0]?.code).toBe("EC990186");
    expect(searchClasses(model, "Sicherungsautomat", { language: "DE" })[0]?.code).toBe("EC990186");
    // And the exact regional form still works.
    expect(searchClasses(model, "Leitungsschutzschalter", { language: "de-DE" })[0]?.code).toBe("EC990186");
  });

  it("P2: the packed manifest matches what the build actually emits", () => {
    // check-pack is exercised for real by `npm run verify` / CI; this pins the
    // premise it depends on — declaration maps ARE emitted.
    expect(existsSync(join(import.meta.dirname, "..", "dist", "model.d.ts.map"))).toBe(true);
  });
});

describe("ninth-pass review findings stay fixed", () => {
  it("P2: regional English is English — promoted, never listed as a translation", () => {
    const { model } = modelFromApiClasses(
      [
        {
          code: "EC990185",
          version: 1,
          descriptionEn: null,
          description: "Nur Deutsch",
          group: { code: "EG990185", descriptionEn: "g" },
          features: [],
          translations: [{ languagecode: "EN-GB", description: "British English base" }],
        },
      ],
      { release: "T" },
    );
    expect(model.classes["EC990185"]?.description).toBe("British English base");
    expect(Object.keys(model.classes["EC990185"]?.translations ?? {})).toEqual([]);
    expect(model.languages).toEqual([]);
  });

  it("P2: a deprecation conflict between classes is reported", () => {
    const mk = (code: string, deprecated: boolean) => ({
      code,
      version: 1,
      descriptionEn: "c",
      group: { code: "EG990184", descriptionEn: "g" },
      features: [
        {
          code: "EF990184",
          type: "A",
          descriptionEn: "f",
          orderNumber: 1,
          values: [{ code: "EV990184", descriptionEn: "same text", deprecated }],
        },
      ],
    });
    const { warnings } = modelFromApiClasses([mk("EC990183", false), mk("EC990184", true)], {
      release: "T",
    });
    expect(warnings.some((w) => w.includes("EV990184") && w.includes("deprecated differs"))).toBe(true);
  });

  it("P2: languages must match the translations actually present", () => {
    const claimsMissing = demoModel();
    claimsMissing.languages = ["DE", "FR"];
    expect(validateModel(claimsMissing).errors.some((e) => e.path === "$.languages")).toBe(true);

    const claimsEnglish = demoModel();
    claimsEnglish.languages = ["DE", "EN"];
    expect(validateModel(claimsEnglish).errors.some((e) => e.path === "$.languages")).toBe(true);

    const understates = demoModel();
    understates.languages = [];
    expect(validateModel(understates).errors.some((e) => e.path === "$.languages")).toBe(true);

    expect(validateModel(demoModel()).ok).toBe(true);
  });

  it("P2: an unusable type prefix fails loudly instead of emitting broken .d.ts", () => {
    for (const bad of ["ETIM-", "123", "", "my type"]) {
      expect(() => generateTypes(demoModel(), { prefix: bad })).toThrow(/valid TypeScript identifier/);
    }
    expect(generateTypes(demoModel(), { prefix: "$Etim_2" })).toContain("$Etim_2ClassCode");
  });
});

describe("tenth-pass review finding stays fixed", () => {
  it("P2: an explicit English-only request keeps no translations at all", () => {
    const payload = [
      {
        code: "EC990182",
        version: 1,
        descriptionEn: "english only",
        group: { code: "EG990182", descriptionEn: "g" },
        features: [],
        translations: [
          { languagecode: "DE", description: "unrequested" },
          { languagecode: "FR", description: "unrequested" },
        ],
      },
    ];
    const explicit = modelFromApiClasses(payload, { release: "T", languages: ["EN"] });
    expect(Object.keys(explicit.model.classes["EC990182"]?.translations ?? {})).toEqual([]);
    expect(explicit.model.languages).toEqual([]);

    // No filter supplied at all still means "keep whatever arrived".
    const unfiltered = modelFromApiClasses(payload, { release: "T" });
    expect(Object.keys(unfiltered.model.classes["EC990182"]?.translations ?? {}).sort()).toEqual(["DE", "FR"]);
    expect(unfiltered.model.languages).toEqual(["DE", "FR"]);
  });
});

describe("eleventh-pass review findings stay fixed", () => {
  it("P2: a later class contributes translations the first one lacked", () => {
    const mk = (code: string, langs: string[]) => ({
      code,
      version: 1,
      descriptionEn: "c",
      group: { code: "EG990181", descriptionEn: "g" },
      features: [
        {
          code: "EF990181",
          type: "N",
          descriptionEn: "shared feature",
          orderNumber: 1,
          translations: langs.map((l) => ({ languagecode: l, description: `f-${l}` })),
          unit: {
            code: "EU990181",
            descriptionEn: "u",
            abbreviationEn: "x",
            translations: langs.map((l) => ({ languagecode: l, description: `u-${l}`, abbreviation: `x-${l}` })),
          },
        },
      ],
    });
    const { model, warnings } = modelFromApiClasses(
      [mk("EC990180", ["DE"]), mk("EC990181", ["FR"])],
      { release: "T", languages: ["DE", "FR"] },
    );
    // Both languages survive, from different classes.
    expect(Object.keys(model.features["EF990181"]?.translations ?? {}).sort()).toEqual(["DE", "FR"]);
    expect(Object.keys(model.units["EU990181"]?.translations ?? {}).sort()).toEqual(["DE", "FR"]);
    expect(Object.keys(model.units["EU990181"]?.abbreviationTranslations ?? {}).sort()).toEqual(["DE", "FR"]);
    expect(model.languages).toEqual(["DE", "FR"]);
    expect(warnings).toEqual([]);
  });

  it("P2: languages order does not change the serialised bytes", () => {
    const a = demoModel();
    const b = demoModel();
    b.languages = ["de"]; // different case, same member
    expect(serializeModel(b)).toBe(serializeModel(a));

    const multi = demoModel();
    multi.languages = ["FR", "DE"];
    const multi2 = demoModel();
    multi2.languages = ["DE", "FR"];
    expect(serializeModel(multi)).toBe(serializeModel(multi2));
  });

  it("P2: non-canonical languages are rejected even with the right members", () => {
    for (const bad of [["de"], ["DE", "DE"], []]) {
      const m = demoModel();
      m.languages = bad as string[];
      const res = validateModel(m);
      expect(res.ok, JSON.stringify(bad)).toBe(false);
      expect(res.errors.some((e) => e.path === "$.languages")).toBe(true);
    }
    expect(validateModel(demoModel()).ok).toBe(true);
  });

  it("P2: malformed vocabulary translation records are rejected", () => {
    const cases: [string, (m: ReturnType<typeof demoModel>) => void][] = [
      ['$.groups["EG990001"].translations', (m) => ((m.groups["EG990001"] as { translations?: unknown }).translations = "de")],
      ['$.features["EF990001"].translations["DE"]', (m) => ((m.features["EF990001"]!.translations as Record<string, unknown>)["DE"] = 42)],
      ['$.units["EU990001"].abbreviationTranslations', (m) => ((m.units["EU990001"] as { abbreviationTranslations?: unknown }).abbreviationTranslations = ["mm"])],
    ];
    for (const [path, mutate] of cases) {
      const m = demoModel();
      mutate(m);
      const res = validateModel(m);
      expect(res.ok, path).toBe(false);
      expect(res.errors.some((e) => e.path === path), path).toBe(true);
    }
  });
});

describe("twelfth-pass review findings stay fixed", () => {
  it("P2: an EN translation is rejected even when languages agrees with it", () => {
    const m = demoModel();
    m.classes["EC990001"]!.translations = { ...m.classes["EC990001"]!.translations, "EN-GB": "leak" };
    m.languages = ["DE", "EN-GB"]; // consistent with the data, still wrong
    const res = validateModel(m);
    expect(res.ok).toBe(false);
    expect(res.errors.some((e) => e.path === "$.languages" && /English/.test(e.message))).toBe(true);
  });

  it("P2: an explicitly empty English synonym list wins over localized synonyms", () => {
    const { model } = modelFromApiClasses(
      [
        {
          code: "EC990179",
          version: 1,
          descriptionEn: "empty english synonyms",
          synonyms: ["deutsches synonym"],
          group: { code: "EG990179", descriptionEn: "g" },
          features: [],
          translations: [
            { languagecode: "EN", description: "empty english synonyms", synonyms: [] },
            { languagecode: "DE", description: "leer", synonyms: ["deutsches synonym"] },
          ],
        },
      ],
      { release: "T", languages: ["DE"] },
    );
    // English says "no synonyms" — that is an answer, not a gap to fill.
    expect(model.classes["EC990179"]?.synonyms).toBeUndefined();
    expect(model.classes["EC990179"]?.synonymTranslations?.["DE"]).toEqual(["deutsches synonym"]);
  });
});

describe("thirteenth-pass review finding stays fixed", () => {
  const payload = (langs: string[]) => [
    {
      code: "EC990178",
      version: 1,
      descriptionEn: "regional specificity",
      group: { code: "EG990178", descriptionEn: "g" },
      features: [],
      translations: langs.map((l) => ({ languagecode: l, description: `t-${l}` })),
    },
  ];

  it("P2: a regional request keeps only that locale", () => {
    const { model } = modelFromApiClasses(payload(["de-AT", "de-DE", "fr-FR"]), {
      release: "T",
      languages: ["DE-AT"],
    });
    expect(Object.keys(model.classes["EC990178"]?.translations ?? {})).toEqual(["DE-AT"]);
    expect(model.languages).toEqual(["DE-AT"]);
  });

  it("P2: a bare request still accepts any regional variant", () => {
    const { model, warnings } = modelFromApiClasses(payload(["de-DE"]), {
      release: "T",
      languages: ["DE"],
    });
    expect(Object.keys(model.classes["EC990178"]?.translations ?? {})).toEqual(["DE-DE"]);
    expect(warnings).toEqual([]);
  });

  it("P2: a regional request the response never carries is reported", () => {
    const { warnings } = modelFromApiClasses(payload(["de-DE"]), {
      release: "T",
      languages: ["DE-AT"],
    });
    expect(warnings.some((w) => w.includes("DE-AT"))).toBe(true);
  });
});

describe("fourteenth-pass review finding stays fixed", () => {
  it("P2: search does not answer a regional request with another region's text", () => {
    const m = demoModel();
    m.classes["EC990001"]!.translations = { "DE-DE": "Installationskabel" };
    m.classes["EC990001"]!.synonymTranslations = { "DE-DE": ["Mantelleitung"] };
    /* The rest of the demo carries plain DE, so both keys are retained and
       both must be declared — the validator's own rule, applied to itself. */
    m.languages = ["DE", "DE-DE"];
    expect(validateModel(m).ok).toBe(true);

    // Bare request: any German answers it.
    expect(searchClasses(m, "Installationskabel", { language: "DE" })[0]?.code).toBe("EC990001");
    // Exact regional request that exists: answered.
    expect(searchClasses(m, "Installationskabel", { language: "de-DE" })[0]?.code).toBe("EC990001");
    // Different region: absent means absent, not "close enough".
    expect(searchClasses(m, "Installationskabel", { language: "DE-AT" })).toEqual([]);
    expect(searchClasses(m, "Mantelleitung", { language: "DE-AT" })).toEqual([]);
  });
});

describe("fifteenth-pass review finding stays fixed", () => {
  it("P2: a bare language request searches every regional variant", () => {
    const m = demoModel();
    m.classes["EC990001"]!.translations = { "DE-DE": "Installationskabel" };
    m.classes["EC990002"]!.translations = { "DE-AT": "Sicherungsautomat" };
    m.classes["EC990003"]!.translations = { "DE-DE": "Kabelverschraubung" };
    m.languages = ["DE", "DE-AT", "DE-DE"];
    expect(validateModel(m).ok).toBe(true);

    // A term that exists ONLY in the Austrian variant must still be found.
    expect(searchClasses(m, "Sicherungsautomat", { language: "DE" })[0]?.code).toBe("EC990002");
    // And one that exists only in DE-DE.
    expect(searchClasses(m, "Installationskabel", { language: "DE" })[0]?.code).toBe("EC990001");
    // Regional requests stay exact.
    expect(searchClasses(m, "Sicherungsautomat", { language: "DE-DE" })).toEqual([]);
    expect(searchClasses(m, "Sicherungsautomat", { language: "DE-AT" })[0]?.code).toBe("EC990002");
  });

  it("P2: bare-language synonym search also covers every variant", () => {
    const m = demoModel();
    m.classes["EC990001"]!.synonymTranslations = { "DE-AT": ["Nurösterreich"] };
    m.classes["EC990001"]!.translations = { "DE-AT": "kabel" };
    m.languages = ["DE", "DE-AT"];
    expect(validateModel(m).ok).toBe(true);
    expect(searchClasses(m, "Nurösterreich", { language: "DE" })[0]?.code).toBe("EC990001");
  });
});

describe("open PR-1 findings stay fixed", () => {
  it("P2: a non-finite class ceiling is refused rather than silently disabling itself", async () => {
    for (const bad of [NaN, Infinity, 0, -5, 1.5]) {
      await expect(
        fetchModel({ clientId: "x", clientSecret: "y", maxClasses: bad }),
      ).rejects.toThrow(/positive whole number/);
    }
  });

  it("P2: feature bindings are stored in published order, not response order", () => {
    const { model } = modelFromApiClasses(
      [
        {
          code: "EC990177",
          version: 1,
          descriptionEn: "out of order",
          group: { code: "EG990177", descriptionEn: "g" },
          features: [
            { code: "EF990173", type: "N", descriptionEn: "third", orderNumber: 3 },
            { code: "EF990171", type: "N", descriptionEn: "first", orderNumber: 1 },
            { code: "EF990172", type: "N", descriptionEn: "second", orderNumber: 2 },
          ],
        },
      ],
      { release: "T" },
    );
    expect(model.classes["EC990177"]?.features.map((f) => f.orderNumber)).toEqual([1, 2, 3]);
    expect(model.classes["EC990177"]?.features.map((f) => f.code)).toEqual([
      "EF990171", "EF990172", "EF990173",
    ]);
  });

  it("P2: optional source metadata is type-checked before the cast", () => {
    const cases: [string, unknown][] = [
      ["$.source.retrievedAt", { type: "custom", retrievedAt: 42 }],
      ["$.source.retrievedAt", { type: "custom", retrievedAt: "not a date" }],
      ["$.source.apiVersion", { type: "custom", apiVersion: [] }],
    ];
    for (const [path, source] of cases) {
      const m = demoModel() as unknown as { source: unknown; synthetic?: unknown };
      m.source = source;
      delete m.synthetic; // "custom" must not require the demo marker
      const res = validateModel(m);
      expect(res.ok, path).toBe(false);
      expect(res.errors.some((e) => e.path === path), path).toBe(true);
    }
    // A well-formed custom source passes.
    const ok = demoModel() as unknown as { source: unknown; synthetic?: unknown };
    ok.source = { type: "custom", retrievedAt: "2026-08-12T00:00:00Z", apiVersion: "x" };
    delete ok.synthetic;
    expect(validateModel(ok).ok).toBe(true);
  });
});

describe("seventeenth-pass review findings stay fixed", () => {
  it("P2: a bare request covers the exact key AND every regional variant", () => {
    const m = demoModel();
    m.classes["EC990001"]!.translations = { DE: "Installationskabel", "DE-AT": "Nurösterreichisch" };
    m.languages = ["DE", "DE-AT"];
    expect(validateModel(m).ok).toBe(true);
    // Both must be findable under the bare request.
    expect(searchClasses(m, "Installationskabel", { language: "DE" })[0]?.code).toBe("EC990001");
    expect(searchClasses(m, "Nurösterreichisch", { language: "DE" })[0]?.code).toBe("EC990001");
    // The regional request still sees only its own locale.
    expect(searchClasses(m, "Installationskabel", { language: "DE-AT" })).toEqual([]);
  });

  it("P2: an unusable pagination total is refused", async () => {
    for (const total of [null, undefined, "50", 1.5, -1]) {
      const original = globalThis.fetch;
      globalThis.fetch = (async (url: string | URL) => {
        if (String(url).includes("connect/token")) {
          return new Response(JSON.stringify({ access_token: "t" }), { status: 200 });
        }
        return new Response(
          JSON.stringify({
            total,
            classes: [
              { code: "EC990176", version: 1, descriptionEn: "c", group: { code: "EG990176", descriptionEn: "g" }, features: [] },
            ],
          }),
          { status: 200 },
        );
      }) as typeof fetch;
      try {
        await expect(
          fetchModel({ clientId: "x", clientSecret: "y", languages: ["EN"] }),
        ).rejects.toThrow(/pagination total/);
      } finally {
        globalThis.fetch = original;
      }
    }
  });

  it("P2: a NaN byte ceiling is refused rather than disabling the guard", () => {
    expect(() => parseModelJson('{"a":1}', { maxBytes: NaN })).toThrow(/positive finite/);
    expect(() => parseModelJson('{"a":1}', { maxBytes: 0 })).toThrow(/positive finite/);
    expect(() => parseModelJson('{"a":1}', { maxBytes: Infinity })).toThrow(/positive finite/);
    expect(() => parseModelJson('{"a":1}', { maxBytes: 1000 })).not.toThrow();
  });
});

describe("eighteenth-pass review findings stay fixed", () => {
  it("P2: a page of code-less entries is refused, not counted", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL) => {
      if (String(url).includes("connect/token")) {
        return new Response(JSON.stringify({ access_token: "t" }), { status: 200 });
      }
      return new Response(JSON.stringify({ total: 1, classes: [{}] }), { status: 200 });
    }) as typeof fetch;
    try {
      await expect(fetchModel({ clientId: "x", clientSecret: "y" })).rejects.toThrow(/without a code/);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("P2: a word-start match anywhere outranks a mid-word one", () => {
    const m = demoModel();
    m.classes["EC990001"]!.description = "Microkabel kabel switch"; // 'kabel' mid-word first
    m.classes["EC990002"]!.description = "Zwischenkabel";           // only mid-word
    const hits = searchClasses(m, "kabel");
    // EC990001 has a word-start occurrence later in the string, so it wins.
    expect(hits[0]?.code).toBe("EC990001");
    expect(hits.map((h) => h.code)).toContain("EC990002");
  });

  it("P2: a non-finite union cap is refused rather than disabling itself", () => {
    for (const bad of [NaN, Infinity, -1, 1.5]) {
      expect(() => generateTypes(demoModel(), { unionCap: bad })).toThrow(/non-negative whole number/);
    }
    expect(() => generateTypes(demoModel(), { unionCap: 0 })).not.toThrow();
  });
});
