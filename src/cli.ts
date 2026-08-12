#!/usr/bin/env node
/* The etim-json CLI.
 *
 * One binary, small verbs, no argument-parsing dependency. Human output by
 * default, `--json` for machines, non-zero exit on anything that failed —
 * so it composes in CI the way a Unix tool should.
 */

import { closeSync, openSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import process from "node:process";
import { MAX_MODEL_BYTES, parseModelJson, serializeModel, type EtimModel } from "./model.js";
import { assertModel, validateModel } from "./validate.js";
import { demoModel } from "./demo.js";
import { generateTypes } from "./typegen.js";
import { getClass, lookupCode, modelStats, searchClasses } from "./search.js";
import { fetchModel } from "./adapters/etim-api.js";
import { serveStdio } from "./mcp.js";

const HELP = `etim-json — the ETIM classification model as clean JSON

Usage:
  etim-json demo -o <file>                Write the bundled synthetic demo model
  etim-json fetch -o <file> [options]     Convert via the ETIM API (credentials required)
  etim-json validate <model.json>         Validate a model file (exit 1 on errors)
  etim-json stats <model.json>            Entity counts and provenance
  etim-json search <model.json> <query>   Search classes
  etim-json class <model.json> <ECcode>   Show one class in full
  etim-json lookup <model.json> <code>    Identify any ETIM code
  etim-json types <model.json> -o <file>  Generate TypeScript declarations
  etim-json mcp (--model <file> | --demo) Serve the model over MCP (stdio)

fetch options:
  --release <label>      e.g. ETIM-10.0 (default: the dynamic latest model)
  --languages <csv>      e.g. EN,DE (default EN)
  --client-id <id>       or env ETIM_CLIENT_ID
  --client-secret <s>    or env ETIM_CLIENT_SECRET

Common:
  --json                 Machine-readable output
  -o, --out <file>       Output path

The ETIM model is published by ETIM International under ODC-BY 1.0.
This tool ships no ETIM data; converted models carry the attribution with them.
https://github.com/M-Heath-Consulting/etim-json
`;

interface Args {
  cmd: string;
  positional: string[];
  flags: Map<string, string | true>;
}

function parseArgs(argv: string[]): Args {
  const [cmd = "help", ...rest] = argv;
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === "-o") {
      flags.set("out", rest[++i] ?? "");
    } else if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith("--") && BOOL_FLAGS.has(key) === false) {
        flags.set(key, next);
        i++;
      } else {
        flags.set(key, true);
      }
    } else {
      positional.push(a);
    }
  }
  return { cmd, positional, flags };
}

const BOOL_FLAGS = new Set(["json", "demo", "strict"]);

/* Read a model file with the size ceiling enforced BEFORE the bytes are
   materialised. parseModelJson's own guard runs too late to help here: by
   then readFileSync has already pulled the whole file — or hung on a
   character device like /dev/zero — into memory. */
/** Read a stream with no knowable length, stopping the moment it exceeds the
 *  ceiling. Memory stays bounded at the ceiling plus one chunk, however much
 *  the writer intends to send. */
function readCapped(path: string, max: number): string {
  const fd = openSync(path, "r");
  try {
    const chunks: Buffer[] = [];
    const buf = Buffer.allocUnsafe(64 * 1024);
    let total = 0;
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, null);
      if (n === 0) break;
      total += n;
      if (total > max) {
        fail(
          `${path} exceeds the ${max} byte ceiling while streaming — stopped reading. ` +
            "If this is a legitimate ETIM conversion, raise the ceiling deliberately.",
        );
      }
      chunks.push(Buffer.from(buf.subarray(0, n)));
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

function readModelText(path: string): string {
  try {
    const st = statSync(path);
    if (st.isFile()) {
      if (st.size > MAX_MODEL_BYTES) {
        fail(
          `${path} is ${st.size} bytes — over the ${MAX_MODEL_BYTES} byte ceiling. ` +
            "If this is a legitimate ETIM conversion, raise the ceiling deliberately.",
        );
      }
    } else if (st.isFIFO()) {
      /* A pipe has no size to pre-check, so the ceiling has to be enforced
         while reading rather than after it. readFileSync would buffer until
         the writer closed — an unbounded one (`yes > fifo`) exhausts memory
         far past MAX_MODEL_BYTES, which is the very hazard the pre-check
         exists to prevent, reached through a different door. */
      return readCapped(path, MAX_MODEL_BYTES);
    } else {
      /* `etim-json validate <(curl …)` is the composition this CLI
         advertises, and a pipe is a FIFO — while /dev/zero, the unbounded
         source worth refusing outright, is a character device. */
      fail(`${path} is not a regular file or a pipe.`);
    }
    return readFileSync(path, "utf8");
  } catch (e) {
    if (e instanceof Error && "code" in e) {
      fail(`Cannot read ${path}: ${(e as Error).message}`);
    }
    throw e;
  }
}

function loadModel(path: string): EtimModel {
  return assertModel(parseModelJson(readModelText(path)));
}

function fail(msg: string): never {
  console.error(`etim-json: ${msg}`);
  process.exit(1);
}

function out(args: Args, human: string, machine: unknown): void {
  if (args.flags.has("json")) {
    console.log(JSON.stringify(machine, null, 2));
  } else {
    console.log(human);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  switch (args.cmd) {
    case "help":
    case "--help":
    case "-h": {
      console.log(HELP);
      return;
    }

    case "demo": {
      const path = String(args.flags.get("out") ?? "");
      if (!path) fail("demo needs -o <file>");
      writeFileSync(path, serializeModel(demoModel()));
      console.log(`Wrote synthetic demo model to ${path}`);
      return;
    }

    case "fetch": {
      const path = String(args.flags.get("out") ?? "");
      if (!path) fail("fetch needs -o <file>");
      const clientId = String(args.flags.get("client-id") ?? process.env.ETIM_CLIENT_ID ?? "");
      const clientSecret = String(
        args.flags.get("client-secret") ?? process.env.ETIM_CLIENT_SECRET ?? "",
      );
      if (!clientId || !clientSecret) {
        fail(
          "ETIM API credentials required (--client-id/--client-secret or ETIM_CLIENT_ID/ETIM_CLIENT_SECRET). " +
            "Credentials are issued by ETIM International: https://etimapi.etim-international.com/",
        );
      }
      const release = args.flags.get("release");
      const languages = String(args.flags.get("languages") ?? "EN")
        .split(",")
        .map((l) => l.trim().toUpperCase())
        .filter(Boolean);
      const { model, warnings } = await fetchModel({
        clientId,
        clientSecret,
        ...(typeof release === "string" ? { release } : {}),
        languages,
        onProgress: (n, total) => process.stderr.write(`\rfetched ${n}/${total} classes…`),
      });
      process.stderr.write("\n");
      for (const w of warnings) console.error(`warn: ${w}`);
      const check = validateModel(model);
      if (!check.ok) {
        for (const e of check.errors.slice(0, 10)) console.error(`error: ${e.path} ${e.message}`);
        fail("Conversion produced an invalid model — this is a bug worth reporting.");
      }
      writeFileSync(path, serializeModel(model));
      console.log(
        `Wrote ${check.counts.classes} classes (${model.release}) to ${path}. ` +
          `Attribution travels inside the file — ODC-BY requires it stays intact.`,
      );
      return;
    }

    case "validate": {
      const [path] = args.positional;
      if (!path) fail("validate needs a model file");
      let parsed: unknown;
      try {
        parsed = parseModelJson(readModelText(path));
      } catch (e) {
        fail(`${path}: ${(e as Error).message}`);
      }
      const res = validateModel(parsed);
      out(
        args,
        [
          `${path}: ${res.ok ? "VALID" : "INVALID"}`,
          `  classes ${res.counts.classes} · groups ${res.counts.groups} · features ${res.counts.features} · values ${res.counts.values} · units ${res.counts.units}`,
          ...res.errors.map((e) => `  error ${e.path}: ${e.message}`),
          ...res.warnings.map((w) => `  warn  ${w.path}: ${w.message}`),
        ].join("\n"),
        res,
      );
      /* exitCode, not exit(): process.exit() can kill Node before a large
         --json payload has drained through a pipe, which truncates exactly
         the machine-readable output CI depends on. */
      if (!res.ok || (args.flags.has("strict") && res.warnings.length > 0)) process.exitCode = 1;
      return;
    }

    case "stats": {
      const [path] = args.positional;
      if (!path) fail("stats needs a model file");
      const model = loadModel(path);
      const s = modelStats(model);
      out(
        args,
        [
          `Release ${s.release}${s.synthetic ? " — SYNTHETIC DEMO DATA" : ""}`,
          `Languages beyond English: ${s.languages.join(", ") || "none"}`,
          `Classes ${s.counts.classes} · groups ${s.counts.groups} · features ${s.counts.features} · values ${s.counts.values} · units ${s.counts.units}`,
          `Feature types: ${Object.entries(s.featureTypes)
            .map(([t, n]) => `${t}=${n}`)
            .join(" ")}`,
          s.attribution,
        ].join("\n"),
        s,
      );
      return;
    }

    case "search": {
      const [path, ...q] = args.positional;
      const query = q.join(" ");
      if (!path || !query) fail("search needs a model file and a query");
      const model = loadModel(path);
      const language = args.flags.get("language");
      const hits = searchClasses(model, query, {
        ...(typeof language === "string" ? { language } : {}),
      });
      out(
        args,
        hits.length === 0
          ? "No matches."
          : hits.map((h) => `${h.code} v${h.version}  ${h.description}  (${h.group})`).join("\n"),
        hits,
      );
      return;
    }

    case "class": {
      const [path, code] = args.positional;
      if (!path || !code) fail("class needs a model file and an EC code");
      const model = loadModel(path);
      const c = getClass(model, code);
      if (!c) fail(`No class ${code.toUpperCase()} in ${path}`);
      out(
        args,
        [
          `${c.code} v${c.version} — ${c.description}`,
          `Group ${c.group.code} — ${c.group.description}`,
          ...(c.synonyms.length > 0 ? [`Synonyms: ${c.synonyms.join(", ")}`] : []),
          `Features:`,
          ...c.features.map((f) => {
            const unit = f.unit ? ` [${f.unit.abbreviation}]` : "";
            const vals = f.values ? `  → ${f.values.map((v) => v.description).join(" / ")}` : "";
            return `  ${String(f.orderNumber).padStart(2)}. ${f.code} ${f.type}${unit}  ${f.description}${vals}${f.deprecated ? "  (deprecated)" : ""}`;
          }),
        ].join("\n"),
        c,
      );
      return;
    }

    case "lookup": {
      const [path, code] = args.positional;
      if (!path || !code) fail("lookup needs a model file and an ETIM code");
      const model = loadModel(path);
      const hit = lookupCode(model, code);
      if (!hit) fail(`No entity ${code.toUpperCase()} in ${path}`);
      out(
        args,
        `${hit.code} is a ${hit.kind}: ${hit.description}` +
          (hit.detail ? `\n${JSON.stringify(hit.detail, null, 2)}` : ""),
        hit,
      );
      return;
    }

    case "types": {
      const [path] = args.positional;
      const outPath = String(args.flags.get("out") ?? "");
      if (!path || !outPath) fail("types needs a model file and -o <file>");
      const model = loadModel(path);
      writeFileSync(outPath, generateTypes(model));
      console.log(`Wrote TypeScript declarations to ${outPath}`);
      return;
    }

    case "mcp": {
      const modelPath = args.flags.get("model") ?? process.env.ETIM_JSON_MODEL;
      const useDemo = args.flags.has("demo");
      if (!useDemo && typeof modelPath !== "string") {
        fail(
          "mcp needs a model: --model <file> (or ETIM_JSON_MODEL), or --demo for the synthetic demo. " +
            "Convert the real model first: etim-json fetch -o etim.json",
        );
      }
      const model = useDemo ? demoModel() : loadModel(String(modelPath));
      await serveStdio(model);
      return; // server keeps the process alive on the transport
    }

    default:
      fail(`Unknown command "${args.cmd}". Try: etim-json help`);
  }
}

main().catch((e: unknown) => {
  console.error(`etim-json: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
