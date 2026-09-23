// node:sqlite prints an ExperimentalWarning on first load; keep stderr clean for MCP clients.
const originalEmit = process.emitWarning;
process.emitWarning = ((warning: string | Error, ...args: unknown[]) => {
  if (String(warning).includes('SQLite')) return;
  return (originalEmit as (...a: unknown[]) => void).call(process, warning, ...args);
}) as typeof process.emitWarning;
const sqlite = await import('node:sqlite');
process.emitWarning = originalEmit;

export const DatabaseSync = sqlite.DatabaseSync;
export type Database = InstanceType<typeof sqlite.DatabaseSync>;
