interface Window {
  count: number;
  expiresAt: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number;
}

const store = new Map<string, Window>();

setInterval(() => {
  const now = Date.now();
  for (const [key, win] of store) {
    if (now >= win.expiresAt) store.delete(key);
  }
}, 60_000);

export function checkRateLimit(
  key: string,
  max: number,
  windowMs: number,
): RateLimitResult {
  const now = Date.now();
  let win = store.get(key);

  if (!win || now >= win.expiresAt) {
    win = { count: 1, expiresAt: now + windowMs };
    store.set(key, win);
    return { allowed: true, remaining: max - 1, resetAt: win.expiresAt };
  }

  if (win.count >= max) {
    return { allowed: false, remaining: 0, resetAt: win.expiresAt };
  }

  win.count++;
  return { allowed: true, remaining: max - win.count, resetAt: win.expiresAt };
}
