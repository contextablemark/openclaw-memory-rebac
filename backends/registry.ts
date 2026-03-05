/**
 * Backend registry — loaded dynamically from backends.json.
 *
 * Uses top-level await (ESM) so all backends are fully imported by the time
 * any consumer calls createBackend(). No backend names appear in this file.
 *
 * To add a new backend:
 *   1. Create backends/<name>.ts  (exports `defaults` and `create`)
 *   2. Create backends/<name>.defaults.json
 *   3. Add `"<name>": "./<name>.js"` to backends/backends.json
 *   No TypeScript changes needed anywhere else.
 */

import backendsJson from "./backends.json" with { type: "json" };
import type { MemoryBackend } from "../backend.js";

export type BackendModule = {
  create: (config: Record<string, unknown>) => MemoryBackend;
  defaults: Record<string, unknown>;
};

const loaded: Record<string, BackendModule> = {};
for (const [name, modulePath] of Object.entries(backendsJson as Record<string, string>)) {
  const url = new URL(modulePath, import.meta.url);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mod = await import(url.href) as any;
  loaded[name] = mod as BackendModule;
}

export const backendRegistry: Readonly<Record<string, BackendModule>> = loaded;
