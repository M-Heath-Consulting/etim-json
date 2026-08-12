/* The MCP server.
 *
 * Five read-only tools over one loaded model. The server holds no session
 * state, writes nothing, and reaches nothing over the network: the model is
 * loaded once at startup from a path the *operator* chose. No tool accepts a
 * filesystem path or URL — an agent can query the classification, not steer
 * the process. That is the whole security posture, and it is deliberate.
 *
 * Every tool declares readOnlyHint and a closed world, returns structured
 * content alongside prose, and — when the loaded model is the synthetic demo
 * — says so in every response, because an agent quoting demo data as ETIM
 * classification would be worse than no tool at all.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { EtimModel } from "./model.js";
import {
  getClass,
  lookupCode,
  modelStats,
  searchClasses,
} from "./search.js";

export const SERVER_NAME = "etim-json";
export const SERVER_VERSION = "0.1.0";

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

/** Build the server around one loaded model. Exported so tests can drive it
 *  through an in-memory transport instead of a child process. */
export function buildServer(model: EtimModel): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  const demoNote = model.synthetic
    ? "⚠ SYNTHETIC DEMO DATA — this is not the ETIM classification. Convert the real model (see etim-json fetch) before relying on any answer."
    : undefined;

  const stamp = <T extends Record<string, unknown>>(out: T) =>
    model.synthetic ? { ...out, synthetic: true as const } : out;

  const text = (s: string) => ({
    content: [{ type: "text" as const, text: demoNote ? `${demoNote}\n\n${s}` : s }],
  });

  server.registerTool(
    "etim_model_info",
    {
      title: "Describe the loaded ETIM model",
      description:
        "Release, entity counts, languages and licence attribution of the ETIM model this server is answering from. Call once before other tools to learn what you are querying.",
      annotations: READ_ONLY,
      inputSchema: {},
      outputSchema: {
        release: z.string(),
        languages: z.array(z.string()),
        synthetic: z.boolean(),
        counts: z.object({
          classes: z.number(),
          groups: z.number(),
          features: z.number(),
          values: z.number(),
          units: z.number(),
        }),
        attribution: z.string(),
      },
    },
    async () => {
      const s = modelStats(model);
      const structured = {
        release: s.release,
        languages: s.languages,
        synthetic: s.synthetic,
        counts: s.counts,
        attribution: s.attribution,
      };
      return {
        ...text(
          `ETIM model ${s.release} — ${s.counts.classes} classes, ${s.counts.groups} groups, ` +
            `${s.counts.features} features, ${s.counts.values} values, ${s.counts.units} units. ` +
            `Languages beyond English: ${s.languages.join(", ") || "none"}.\n${s.attribution}`,
        ),
        structuredContent: structured,
      };
    },
  );

  server.registerTool(
    "etim_search_classes",
    {
      title: "Search ETIM classes",
      description:
        "Find ETIM classes by name, synonym, translation or exact code (e.g. \"circuit breaker\", \"Kabel\", \"EC990002\"). Returns ranked matches with class code, description and group.",
      annotations: READ_ONLY,
      inputSchema: {
        query: z.string().min(1).max(200).describe("Search text or an ETIM class code"),
        groupCode: z
          .string()
          .regex(/^EG\d{6,8}$/)
          .optional()
          .describe("Restrict results to one ETIM group"),
        language: z
          .string()
          .min(2)
          .max(5)
          .optional()
          .describe("Also search this language's translations, e.g. \"DE\""),
        limit: z.number().int().min(1).max(100).optional().describe("Max results, default 20"),
      },
      outputSchema: {
        synthetic: z.boolean().optional(),
        total: z.number(),
        hits: z.array(
          z.object({
            code: z.string(),
            description: z.string(),
            group: z.string(),
            groupCode: z.string(),
            version: z.number(),
            matched: z.string(),
          }),
        ),
      },
    },
    async ({ query, groupCode, language, limit }) => {
      const hits = searchClasses(model, query, {
        ...(groupCode !== undefined ? { groupCode } : {}),
        ...(language !== undefined ? { language } : {}),
        ...(limit !== undefined ? { limit } : {}),
      }).map(({ rank: _rank, ...h }) => h);
      const structured = stamp({ total: hits.length, hits });
      const lines =
        hits.length === 0
          ? `No classes match ${JSON.stringify(query)} in this model.`
          : hits.map((h) => `${h.code} v${h.version} — ${h.description} (${h.group})`).join("\n");
      return { ...text(lines), structuredContent: structured };
    },
  );

  server.registerTool(
    "etim_get_class",
    {
      title: "Get an ETIM class in full",
      description:
        "The complete definition of one ETIM class by code: description, group, synonyms, and every feature with its type, unit and permitted values.",
      annotations: READ_ONLY,
      inputSchema: {
        code: z
          .string()
          .regex(/^EC\d{6,8}$/i, "An ETIM class code looks like EC003024")
          .describe("ETIM class code"),
      },
      outputSchema: {
        synthetic: z.boolean().optional(),
        found: z.boolean(),
        class: z
          .object({
            code: z.string(),
            version: z.number(),
            description: z.string(),
            group: z.object({ code: z.string(), description: z.string() }),
            synonyms: z.array(z.string()),
            sectors: z.array(z.string()),
            features: z.array(
              z.object({
                code: z.string(),
                description: z.string(),
                type: z.string(),
                orderNumber: z.number(),
                unit: z
                  .object({ code: z.string(), abbreviation: z.string(), description: z.string() })
                  .optional(),
                unitImperial: z
                  .object({ code: z.string(), abbreviation: z.string(), description: z.string() })
                  .optional(),
                values: z.array(z.object({ code: z.string(), description: z.string() })).optional(),
                deprecated: z.boolean().optional(),
              }),
            ),
          })
          .optional(),
      },
    },
    async ({ code }) => {
      const resolved = getClass(model, code);
      if (!resolved) {
        return {
          ...text(`No class ${code.toUpperCase()} in this model (release ${model.release}).`),
          structuredContent: stamp({ found: false }),
        };
      }
      const { translations: _t, ...structuredClass } = resolved;
      const featureLines = resolved.features
        .map((f) => {
          const unit = f.unit ? ` [${f.unit.abbreviation}]` : "";
          const vals = f.values ? ` — ${f.values.map((v) => v.description).join(" / ")}` : "";
          const dep = f.deprecated ? " (deprecated)" : "";
          return `  ${String(f.orderNumber).padStart(2)}. ${f.code} ${f.type}${unit} ${f.description}${vals}${dep}`;
        })
        .join("\n");
      return {
        ...text(
          `${resolved.code} v${resolved.version} — ${resolved.description}\n` +
            `Group: ${resolved.group.code} ${resolved.group.description}\n` +
            (resolved.synonyms.length > 0 ? `Synonyms: ${resolved.synonyms.join(", ")}\n` : "") +
            `Features (${resolved.features.length}):\n${featureLines}`,
        ),
        structuredContent: stamp({ found: true, class: structuredClass }),
      };
    },
  );

  server.registerTool(
    "etim_lookup",
    {
      title: "Look up any ETIM code",
      description:
        "Identify and describe any ETIM code — class (EC), group (EG), feature (EF), value (EV) or unit (EU) — without knowing in advance which kind it is.",
      annotations: READ_ONLY,
      inputSchema: {
        code: z
          .string()
          .regex(/^E[CGFVU]\d{6,8}$/i, "ETIM codes look like EC003024, EF000008, EV000123, EU570448 or EG000017")
          .describe("Any ETIM code"),
      },
      outputSchema: {
        synthetic: z.boolean().optional(),
        found: z.boolean(),
        kind: z.string().optional(),
        code: z.string().optional(),
        description: z.string().optional(),
        detail: z.record(z.string(), z.unknown()).optional(),
      },
    },
    async ({ code }) => {
      const hit = lookupCode(model, code);
      if (!hit) {
        return {
          ...text(`No entity ${code.toUpperCase()} in this model (release ${model.release}).`),
          structuredContent: stamp({ found: false }),
        };
      }
      return {
        ...text(`${hit.code} is a ${hit.kind}: ${hit.description}`),
        structuredContent: stamp({
          found: true,
          kind: hit.kind,
          code: hit.code,
          description: hit.description,
          ...(hit.detail ? { detail: hit.detail } : {}),
        }),
      };
    },
  );

  server.registerTool(
    "etim_list_groups",
    {
      title: "List ETIM groups",
      description:
        "Every product group in the loaded model with its class count — the top-level map of what the model covers.",
      annotations: READ_ONLY,
      inputSchema: {},
      outputSchema: {
        synthetic: z.boolean().optional(),
        groups: z.array(
          z.object({ code: z.string(), description: z.string(), classCount: z.number() }),
        ),
      },
    },
    async () => {
      const counts: Record<string, number> = {};
      for (const c of Object.values(model.classes)) {
        counts[c.groupCode] = (counts[c.groupCode] ?? 0) + 1;
      }
      const groups = Object.entries(model.groups)
        .map(([code, g]) => ({ code, description: g.description, classCount: counts[code] ?? 0 }))
        .sort((a, b) => a.code.localeCompare(b.code));
      return {
        ...text(groups.map((g) => `${g.code} — ${g.description} (${g.classCount} classes)`).join("\n")),
        structuredContent: stamp({ groups }),
      };
    },
  );

  return server;
}

/** Serve over stdio — the CLI's `mcp` command. */
export async function serveStdio(model: EtimModel): Promise<void> {
  const server = buildServer(model);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr, not stdout: stdout is the protocol channel.
  console.error(
    `etim-json MCP server up — release ${model.release}${model.synthetic ? " (SYNTHETIC DEMO)" : ""}, ` +
      `${Object.keys(model.classes).length} classes.`,
  );
}
