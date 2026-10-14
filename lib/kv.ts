import { ENV } from "./env";

// minimal Upstash Redis REST client — no SDK, one command per request.
// shared across serverless instances, unlike in-memory state.

const TIMEOUT_MS = 3000;

export function isKvConfigured(): boolean {
  return !!(ENV.KV_REST_URL && ENV.KV_REST_TOKEN);
}

async function command<T>(cmd: (string | number)[]): Promise<T> {
  if (!isKvConfigured()) throw new Error("KV not configured");
  const res = await fetch(ENV.KV_REST_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${ENV.KV_REST_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(cmd),
    cache: "no-store",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const data = (await res.json().catch(() => ({}))) as { result?: T; error?: string };
  // command name only — keys and values may carry partner data
  if (!res.ok || data.error) throw new Error(`KV ${cmd[0]} failed: HTTP ${res.status} ${data.error ?? ""}`.trim());
  return data.result as T;
}

// SET NX — true only for the first caller, which makes it usable as a lock
export async function kvSetIfAbsent(key: string, value: string, ttlSeconds: number): Promise<boolean> {
  return (await command<string | null>(["SET", key, value, "NX", "EX", ttlSeconds])) === "OK";
}

export async function kvSet(key: string, value: string, ttlSeconds: number): Promise<void> {
  await command(["SET", key, value, "EX", ttlSeconds]);
}

export async function kvGet(key: string): Promise<string | null> {
  return command<string | null>(["GET", key]);
}

export async function kvDel(key: string): Promise<void> {
  await command(["DEL", key]);
}
