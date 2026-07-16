export function log(component: string, msg: string, data?: Record<string, unknown>): void {
  const suffix = data ? ` ${JSON.stringify(data)}` : '';
  console.log(`${new Date().toISOString()} [${component}] ${msg}${suffix}`);
}

export function logError(component: string, msg: string, err?: unknown): void {
  console.error(`${new Date().toISOString()} [${component}] ${msg}`, err ?? '');
}
