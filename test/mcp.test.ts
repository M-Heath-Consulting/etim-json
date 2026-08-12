/* The MCP server, driven by the SDK's own client over an in-memory transport
 * pair — a real initialize handshake, real tool listing, real calls with
 * schema validation on both sides. What a connected agent would experience,
 * minus the process boundary (the process boundary is covered by the CLI
 * stdio test in adversarial.test.ts). */

import { beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer, SERVER_NAME } from "../src/mcp.js";
import { demoModel } from "../src/demo.js";

type ToolResult = {
  content?: { type: string; text?: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

let client: Client;

beforeAll(async () => {
  const server = buildServer(demoModel());
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "etim-json-test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
});

describe("MCP server", () => {
  it("lists exactly the five read-only tools", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "etim_get_class",
      "etim_list_groups",
      "etim_lookup",
      "etim_model_info",
      "etim_search_classes",
    ]);
    for (const t of tools) {
      expect(t.annotations?.readOnlyHint).toBe(true);
      expect(t.annotations?.openWorldHint).toBe(false);
      expect(t.description?.length ?? 0).toBeGreaterThan(20);
    }
  });

  it("describes the model, loudly marking it synthetic", async () => {
    const res = (await client.callTool({ name: "etim_model_info", arguments: {} })) as ToolResult;
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent?.synthetic).toBe(true);
    expect(res.structuredContent?.release).toBe("DEMO-1.0");
    expect(res.content?.[0]?.text).toContain("SYNTHETIC DEMO DATA");
  });

  it("searches classes and returns structured hits", async () => {
    const res = (await client.callTool({
      name: "etim_search_classes",
      arguments: { query: "circuit breaker" },
    })) as ToolResult;
    const hits = res.structuredContent?.hits as { code: string }[];
    expect(hits.some((h) => h.code === "EC990002")).toBe(true);
  });

  it("searches translations when asked", async () => {
    const res = (await client.callTool({
      name: "etim_search_classes",
      arguments: { query: "Leitungsschutzschalter", language: "DE" },
    })) as ToolResult;
    const hits = res.structuredContent?.hits as { code: string }[];
    expect(hits[0]?.code).toBe("EC990002");
  });

  it("returns a full class with units and value lists", async () => {
    const res = (await client.callTool({
      name: "etim_get_class",
      arguments: { code: "EC990001" },
    })) as ToolResult;
    const cls = res.structuredContent?.class as {
      features: { type: string; unit?: { abbreviation: string }; values?: unknown[] }[];
    };
    expect(res.structuredContent?.found).toBe(true);
    expect(cls.features).toHaveLength(4);
    expect(cls.features[0]?.unit?.abbreviation).toBe("mm");
    expect(cls.features[1]?.values).toHaveLength(3);
  });

  it("answers found:false for a missing class rather than erroring", async () => {
    const res = (await client.callTool({
      name: "etim_get_class",
      arguments: { code: "EC000001" },
    })) as ToolResult;
    expect(res.structuredContent?.found).toBe(false);
  });

  it("looks up any code kind", async () => {
    for (const [code, kind] of [
      ["EC990003", "class"],
      ["EG990001", "group"],
      ["EF990003", "feature"],
      ["EV990001", "value"],
      ["EU990004", "unit"],
    ] as const) {
      const res = (await client.callTool({ name: "etim_lookup", arguments: { code } })) as ToolResult;
      expect(res.structuredContent?.kind).toBe(kind);
    }
  });

  it("lists groups with class counts", async () => {
    const res = (await client.callTool({ name: "etim_list_groups", arguments: {} })) as ToolResult;
    const groups = res.structuredContent?.groups as { code: string; classCount: number }[];
    expect(groups.find((g) => g.code === "EG990001")?.classCount).toBe(2);
    expect(groups.find((g) => g.code === "EG990002")?.classCount).toBe(1);
  });

  it("rejects malformed arguments at the schema boundary", async () => {
    // Wrong code shape.
    const bad1 = (await client.callTool({
      name: "etim_get_class",
      arguments: { code: "not-a-code" },
    })) as ToolResult;
    expect(bad1.isError).toBe(true);

    // Oversized query.
    const bad2 = (await client.callTool({
      name: "etim_search_classes",
      arguments: { query: "x".repeat(10_000) },
    })) as ToolResult;
    expect(bad2.isError).toBe(true);

    // Limit outside bounds.
    const bad3 = (await client.callTool({
      name: "etim_search_classes",
      arguments: { query: "demo", limit: 10_000 },
    })) as ToolResult;
    expect(bad3.isError).toBe(true);
  });

  it("treats regex metacharacters in queries as text, not patterns", async () => {
    const res = (await client.callTool({
      name: "etim_search_classes",
      arguments: { query: ".*)(|[^" },
    })) as ToolResult;
    expect(res.isError).toBeFalsy();
    expect((res.structuredContent?.hits as unknown[]).length).toBe(0);
  });

  it("identifies itself by the registry name", () => {
    expect(SERVER_NAME).toBe("etim-json");
  });
});
