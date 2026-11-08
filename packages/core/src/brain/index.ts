// GTM-agents: public entry point for the brain: parsing, validation, the lock file, slice
// assembly and the runtime loader. Safe to import from Node (the CLI) and from the Worker.
export { COMPONENT_IDS, LOCK_FILE, TASKS, TASK_SPECS, isComponentId, tasksReading } from "./components.ts";
export type { BrainTask, ComponentId, TaskSpec } from "./components.ts";
export { COMPONENT_SCHEMAS, ITEM_ID, PRICE_COMPONENT, REFERENCES, URL_FIELDS, coerceFields, frontmatterSchema } from "./schema.ts";
export type { BrainFrontmatter } from "./schema.ts";
export { parseBrainFile } from "./parse.ts";
export type { BrainItem, ParsedBrainFile } from "./parse.ts";
export { validateBrain } from "./validate.ts";
export type { BrainFileInput, BrainValidation, ValidateOptions } from "./validate.ts";
export { brainVersion, computeLock, lockSchema, parseLock, serializeLock, sha256Hex } from "./lock.ts";
export type { BrainLock } from "./lock.ts";
export { assembleSlice, headerLine, missingLine, renderComponent } from "./assemble.ts";
export type { BrainSlice } from "./assemble.ts";
export { BRAIN_LOCK_KEY, brainFileKey, loadBrain } from "./load.ts";
export type { KVReader } from "./load.ts";
export type { Issue } from "../shared/frontmatter.ts";
