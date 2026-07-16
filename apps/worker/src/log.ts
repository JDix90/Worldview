export function log(component: string, msg: string, extra?: Record<string, unknown>): void {
  const line = `${new Date().toISOString()} [${component}] ${msg}`;
  console.log(extra && Object.keys(extra).length ? `${line} ${JSON.stringify(extra)}` : line);
}

export function logError(component: string, msg: string, err: unknown): void {
  const detail = err instanceof Error ? err.message : String(err);
  console.error(`${new Date().toISOString()} [${component}] ERROR ${msg}: ${detail}`);
}
