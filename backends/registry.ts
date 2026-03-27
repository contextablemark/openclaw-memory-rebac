/**
 * Backend registry — statically imported from backends.json keys.
 *
 * To add a new backend:
 *   1. Create backends/<name>.ts  (exports `defaults` and `create`)
 *   2. Create backends/<name>.defaults.json
 *   3. Import and register it here
 */

import type { MemoryBackend } from "../backend.js";
import * as graphiti from "./graphiti.js";
import * as evermemos from "./evermemos.js";

export type BackendModule = {
  create: (config: Record<string, unknown>) => MemoryBackend;
  defaults: Record<string, unknown>;
};

export const backendRegistry: Readonly<Record<string, BackendModule>> = {
  graphiti,
  evermemos,
};
