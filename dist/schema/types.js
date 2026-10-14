/**
 * The shared contract between the engine, the CFO agent and the dashboard.
 *
 * Every type here has a matching JSON Schema in this folder
 * (`*.schema.json`). Change both together and bump SCHEMA_VERSION when a
 * change is not backwards compatible.
 *
 * Money is stored as integer nanos of USD (1 USD = 1_000_000_000), the unit
 * the Agent Orchestrator usage endpoint reports. Config files use plain USD.
 */
export const SCHEMA_VERSION = 1;
//# sourceMappingURL=types.js.map