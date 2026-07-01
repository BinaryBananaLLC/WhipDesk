/**
 * Defeats static module resolution so optional native deps (sharp, nut.js) can be
 * absent without breaking `tsc` or crashing the agent. The specifier is a runtime
 * value, so TypeScript types the result as `any` and never tries to resolve it.
 */
export async function optionalImport(specifier: string): Promise<any | null> {
  try {
    return await import(specifier);
  } catch {
    return null;
  }
}
