/* The API transform, tested against fixtures shaped exactly by the public
 * ETIM API 2.0 swagger contract (fetched 2026-08-12). If ETIM changes the
 * contract, these fixtures are the record of what this version was built
 * against. */

import { describe, expect, it } from "vitest";
import { modelFromApiClasses, type ApiClass } from "../src/adapters/etim-api.js";
import { validateModel } from "../src/validate.js";

/** A class as the API returns it: vocabulary embedded, translations as
 *  arrays of { languagecode, description }. */
const apiClass = (over: Partial<ApiClass> = {}): ApiClass => ({
  code: "EC990101",
  version: 4,
  descriptionEn: "Fixture cable",
  description: "Fixture-Kabel",
  synonyms: ["fixture wire"],
  sectors: ["E"],
  group: {
    code: "EG990101",
    descriptionEn: "Fixture group",
    translations: [{ languagecode: "de-DE", description: "Fixturgruppe" }],
  },
  translations: [
    { languagecode: "de-DE", description: "Fixture-Kabel", synonyms: ["Fixturdraht"] },
  ],
  features: [
    {
      code: "EF990101",
      type: "N",
      descriptionEn: "Fixture diameter",
      orderNumber: 1,
      unit: {
        code: "EU990101",
        descriptionEn: "millimetre",
        abbreviationEn: "mm",
        translations: [{ languagecode: "de-DE", description: "Millimeter", abbreviation: "mm" }],
      },
      unitImperial: { code: "EU990102", descriptionEn: "inch", abbreviationEn: "in" },
    },
    {
      code: "EF990102",
      type: "A",
      descriptionEn: "Fixture material",
      orderNumber: 2,
      values: [
        { code: "EV990101", descriptionEn: "copper" },
        { code: "EV990102", descriptionEn: "aluminium", deprecated: true },
      ],
    },
  ],
  ...over,
});

describe("modelFromApiClasses", () => {
  it("produces a model that passes validation", () => {
    const { model, warnings } = modelFromApiClasses([apiClass()], {
      release: "ETIM-10.0",
      languages: ["EN", "DE"],
      retrievedAt: "2026-08-12T00:00:00Z",
    });
    const res = validateModel(model);
    expect(res.errors).toEqual([]);
    expect(warnings).toEqual([]);
    expect(model.release).toBe("ETIM-10.0");
    expect(model.source.type).toBe("etim-api");
  });

  it("lifts embedded vocabulary into global dictionaries", () => {
    const { model } = modelFromApiClasses([apiClass()], { release: "T" });
    expect(model.features["EF990101"]?.type).toBe("N");
    expect(model.units["EU990101"]?.abbreviation).toBe("mm");
    expect(model.units["EU990102"]?.abbreviation).toBe("in");
    expect(model.values["EV990102"]?.deprecated).toBe(true);
    expect(model.classes["EC990101"]?.features[0]?.unitImperialCode).toBe("EU990102");
  });

  it("uppercases translation language keys and keeps synonym translations", () => {
    const { model } = modelFromApiClasses([apiClass()], { release: "T" });
    expect(model.classes["EC990101"]?.translations?.["DE-DE"]).toBe("Fixture-Kabel");
    expect(model.classes["EC990101"]?.synonymTranslations?.["DE-DE"]).toEqual(["Fixturdraht"]);
    expect(model.groups["EG990101"]?.translations?.["DE-DE"]).toBe("Fixturgruppe");
  });

  it("prefers English descriptions and falls back to the requested language", () => {
    const { model } = modelFromApiClasses(
      [apiClass({ descriptionEn: null, description: "Nur Deutsch" })],
      { release: "T" },
    );
    expect(model.classes["EC990101"]?.description).toBe("Nur Deutsch");
  });

  it("reports vocabulary conflicts and keeps the first entry", () => {
    const a = apiClass();
    const b = apiClass({
      code: "EC990102",
      features: [
        {
          code: "EF990101",
          type: "N",
          descriptionEn: "A DIFFERENT description for the same feature",
          orderNumber: 1,
        },
      ],
    });
    const { model, warnings } = modelFromApiClasses([a, b], { release: "T" });
    expect(model.features["EF990101"]?.description).toBe("Fixture diameter");
    expect(warnings.some((w) => w.includes("EF990101") && w.includes("differs"))).toBe(true);
  });

  it("skips entities with no code and says so", () => {
    const { model, warnings } = modelFromApiClasses(
      [apiClass({ code: null }), apiClass({ code: "EC990103", features: [{ code: null, type: "N" }] })],
      { release: "T" },
    );
    expect(Object.keys(model.classes)).toEqual(["EC990103"]);
    expect(warnings.some((w) => w.includes("no code"))).toBe(true);
  });

  it("flags unknown feature types instead of inventing meaning", () => {
    const { warnings } = modelFromApiClasses(
      [apiClass({ features: [{ code: "EF990199", type: "Z", descriptionEn: "odd", orderNumber: 1 }] })],
      { release: "T" },
    );
    expect(warnings.some((w) => w.includes("unknown type"))).toBe(true);
  });

  it("synthesises order numbers only when the API omits them", () => {
    const { model } = modelFromApiClasses(
      [
        apiClass({
          features: [
            { code: "EF990101", type: "N", descriptionEn: "one" },
            { code: "EF990102", type: "L", descriptionEn: "two" },
          ],
        }),
      ],
      { release: "T" },
    );
    expect(model.classes["EC990101"]?.features.map((f) => f.orderNumber)).toEqual([1, 2]);
  });

  /* ── second external review: the adapter must refuse malformed input rather
     than quietly emitting a model that still validates ──────────────────── */

  it("merges complementary English translation records", () => {
    /* EN carries the description, EN-GB the synonyms. Returning on the first
       English match promoted only the description — and because every English
       record is then filtered out of `translations`, EN-GB's synonyms were not
       merely unpromoted, they were lost. */
    const { model } = modelFromApiClasses(
      [
        apiClass({
          code: "EC990900",
          /* null, not undefined: the API contract types these as nullable, and
             the point of the fixture is that the English text arrives only via
             the translations array. */
          descriptionEn: null,
          synonyms: null,
          translations: [
            { languagecode: "EN", description: "Circuit breaker" },
            { languagecode: "EN-GB", synonyms: ["MCB"] },
            { languagecode: "DE", description: "Leitungsschutzschalter" },
          ],
        } as Partial<ApiClass>),
      ],
      { release: "T", languages: ["EN", "DE"] },
    );
    const cls = model.classes["EC990900"]!;
    expect(cls.description).toBe("Circuit breaker");
    expect(cls.synonyms).toContain("MCB");
    /* English never appears as a translation — it is the base text. */
    expect(Object.keys(cls.translations ?? {})).toEqual(["DE"]);
  });

  it("refuses a permitted value with no code", () => {
    /* Skipping it left an alphanumeric binding one choice short, which is
       still structurally valid — so nothing downstream could detect it. */
    expect(() =>
      modelFromApiClasses(
        [
          apiClass({
            code: "EC990901",
            features: [
              {
                code: "EF990901",
                type: "A",
                descriptionEn: "f",
                values: [{ code: "EV990901", descriptionEn: "ok" }, { descriptionEn: "no code" }],
              },
            ],
          } as Partial<ApiClass>),
        ],
        { release: "T" },
      ),
    ).toThrow(/permitted value has no code/i);
  });

  it("refuses a unit object that carries no code", () => {
    /* An absent unit is legal on N/R features; a unit object we cannot
       identify is not. Treating them alike emitted a dimensionless feature. */
    expect(() =>
      modelFromApiClasses(
        [
          apiClass({
            code: "EC990902",
            features: [
              { code: "EF990902", type: "N", descriptionEn: "f", unit: { descriptionEn: "millimetre" } },
            ],
          } as Partial<ApiClass>),
        ],
        { release: "T" },
      ),
    ).toThrow(/unit object was supplied with no code/i);
  });

  it("still accepts a numeric feature with no unit at all", () => {
    const { model } = modelFromApiClasses(
      [
        apiClass({
          code: "EC990903",
          features: [{ code: "EF990903", type: "N", descriptionEn: "dimensionless" }],
        } as Partial<ApiClass>),
      ],
      { release: "T" },
    );
    expect(model.classes["EC990903"]?.features?.[0]?.unitCode).toBeUndefined();
  });

});

/* modelFromApiClasses assigns by code, so a repeated row silently replaced its
   predecessor — the caller got fewer classes than rows with no indication. */
describe("duplicate class rows", () => {
  const row = (code: string, description: string) => ({
    code,
    version: 1,
    descriptionEn: description,
    group: { code: "EG000001", descriptionEn: "G" },
    features: [],
  });

  it("keeps the first and says so", () => {
    const { model, warnings } = modelFromApiClasses(
      [row("EC000001", "First"), row("EC000001", "Second")] as never,
      { release: "R", languages: [] },
    );
    expect(Object.keys(model.classes)).toEqual(["EC000001"]);
    expect(model.classes["EC000001"]!.description).toBe("First");
    expect(warnings.some((w) => /appeared more than once/.test(w))).toBe(true);
  });

  it("says nothing when the rows are distinct", () => {
    const { model, warnings } = modelFromApiClasses(
      [row("EC000001", "A"), row("EC000002", "B")] as never,
      { release: "R", languages: [] },
    );
    expect(Object.keys(model.classes)).toHaveLength(2);
    expect(warnings).toEqual([]);
  });
});
