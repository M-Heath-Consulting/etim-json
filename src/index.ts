/* etim-json — library surface.
 *
 * Everything the CLI and MCP server do is available programmatically:
 * load, validate, search, resolve, generate types, transform API responses.
 */

export {
  FORMAT_VERSION,
  FEATURE_TYPES,
  CODE_SHAPE,
  MAX_MODEL_BYTES,
  odcByAttribution,
  parseModelJson,
  serializeModel,
} from "./model.js";
export type {
  Attribution,
  ClassFeatureBinding,
  Described,
  EntityKind,
  EtimClassEntry,
  EtimFeatureEntry,
  EtimGroupEntry,
  EtimModel,
  EtimUnitEntry,
  EtimValueEntry,
  FeatureType,
  LanguageCode,
  ModelSource,
} from "./model.js";

export { validateModel, assertModel } from "./validate.js";
export type { Finding, ValidationResult } from "./validate.js";

export { fold, getClass, kindOfCode, lookupCode, modelStats, searchClasses } from "./search.js";
export type {
  ClassHit,
  CodeLookup,
  ModelStats,
  ResolvedClass,
  ResolvedFeature,
  SearchOptions,
} from "./search.js";

export { generateTypes } from "./typegen.js";
export type { TypegenOptions } from "./typegen.js";

export { demoModel } from "./demo.js";

export { fetchModel, modelFromApiClasses } from "./adapters/etim-api.js";
export type {
  ApiClass,
  ApiClassFeature,
  ApiClassFeatureValue,
  ApiGroup,
  ApiUnit,
  FetchOptions,
  TransformOptions,
  TransformResult,
} from "./adapters/etim-api.js";

export { buildServer, serveStdio, SERVER_NAME, SERVER_VERSION } from "./mcp.js";
