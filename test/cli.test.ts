import { describe, expect, it } from "vitest";
import { execFileSync, execSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { serializeModel } from "../src/model.js";
import { demoModel } from "../src/demo.js";

/* The CLI is the one surface that cannot be exercised in-process, so this is
   the only spawning suite. Both `npm run verify` and CI build before they
   test, so dist is present wherever the gate runs; a bare `vitest run` on a
   clean tree is the only case that skips. */
const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

describe.skipIf(!existsSync(CLI))("cli input handling", () => {
  const dir = mkdtempSync(join(tmpdir(), "etim-cli-"));
  const model = join(dir, "model.json");
  writeFileSync(model, serializeModel(demoModel()));

  const run = (args: string[]) => {
    try {
      return { out: execFileSync(process.execPath, [CLI, ...args], { encoding: "utf8" }), code: 0 };
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string; status?: number };
      return { out: `${err.stdout ?? ""}${err.stderr ?? ""}`, code: err.status ?? 1 };
    }
  };

  it("validates a regular file", () => {
    const r = run(["validate", model]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("VALID");
  });

  /* Refusing everything that was not a regular file also refused pipes, and
     `etim-json validate <(curl …)` is the composition the CLI advertises. */
  it("validates a named pipe", () => {
    const fifo = join(dir, "fifo");
    execSync(`mkfifo ${JSON.stringify(fifo)}`);
    /* The writer has to be genuinely detached. `execSync("… &")` deadlocks:
       execSync keeps the backgrounded process's stdio open and so waits for
       it, while cat blocks until something opens the read end — which never
       happens, because we are still inside execSync. spawn with stdio
       "ignore" and unref() hands the pipes to nobody and returns at once. */
    const writer = spawn("sh", ["-c", `cat ${JSON.stringify(model)} > ${JSON.stringify(fifo)}`], {
      detached: true,
      stdio: "ignore",
    });
    writer.unref();
    try {
      const r = run(["validate", fifo]);
      expect(r.out).toContain("VALID");
      expect(r.code).toBe(0);
    } finally {
      try {
        writer.kill();
      } catch {
        /* already exited */
      }
      rmSync(fifo, { force: true });
    }
  });

  /* The unbounded source the size pre-check exists to stop. It is a character
     device, not a FIFO, which is what lets pipes back in without it. */
  it("refuses /dev/zero", () => {
    const r = run(["validate", "/dev/zero"]);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/not a regular file or a pipe/);
  });

  it("refuses a directory", () => {
    const r = run(["validate", dir]);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/not a regular file or a pipe/);
  });

  it("reports a missing file readably", () => {
    const r = run(["validate", join(dir, "nope.json")]);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/Cannot read/);
  });
});
