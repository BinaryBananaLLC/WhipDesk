import { createRequire } from "node:module";
import { isPackaged } from "./paths";

/**
 * Defeats static module resolution so optional native deps (sharp, nut.js, werift) can be
 * absent without breaking `tsc` or crashing the agent. The specifier is a runtime value, so
 * TypeScript types the result as `any` and never tries to resolve it.
 *
 * In a distributed build the app runs as an on-disk bundle (SEA `resources/app.cjs`, or an npm
 * install under node_modules) with its native/asset deps in a sibling `node_modules`. We resolve
 * them through a `createRequire` anchored at THIS module's real location so they load regardless
 * of how the bundler rewrites dynamic `import()`. In a source checkout we use plain `import()`.
 */
export async function optionalImport(specifier: string): Promise<any | null> {
  try {
    if (isPackaged()) return createRequire(import.meta.url)(specifier);
    return await import(specifier);
  } catch {
    return null;
  }
}
