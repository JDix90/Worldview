/** Thin authed fetch for the server's /api endpoints (same-origin via Vite proxy). */

export async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(path, {
    headers: { Authorization: `Bearer ${__ORRERY_TOKEN__}` },
  });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return (await res.json()) as T;
}
