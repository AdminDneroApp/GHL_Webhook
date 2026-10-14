// generic deep sanitizer for untrusted partner payloads — runs before schema validation.
// anything outside the limits is rejected rather than silently truncated, so EMC gets a clear 400.

export const SANITIZE_LIMITS = {
  maxDepth: 6,
  maxKeysPerObject: 200,
  maxArrayLength: 200,
  maxKeyLength: 100,
  maxStringLength: 5000,
};

// prototype-pollution vectors — dropped wherever they appear
const BLOCKED_KEYS = new Set(["__proto__", "constructor", "prototype"]);

// C0 control chars except tab / newline / carriage return, plus DEL
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
// zero-width characters and BOM — invisible, but break matching and dedupe in GHL
const INVISIBLE_CHARS = /[​-‍⁠﻿]/g;
// html / script tags — values end up rendered in the GHL UI and in emails
const HTML_TAGS = /<[^>]*>/g;

export class SanitizeError extends Error {}

export function sanitizeString(s: string): string {
  return s
    .normalize("NFC")
    .replace(CONTROL_CHARS, "")
    .replace(INVISIBLE_CHARS, "")
    .replace(HTML_TAGS, "")
    .trim();
}

export function sanitizePayload(value: unknown, depth = 0, path = "$"): unknown {
  if (value === null) return null;

  switch (typeof value) {
    case "string":
      if (value.length > SANITIZE_LIMITS.maxStringLength) {
        throw new SanitizeError(`${path}: string longer than ${SANITIZE_LIMITS.maxStringLength} chars`);
      }
      return sanitizeString(value);
    case "number":
      if (!Number.isFinite(value)) throw new SanitizeError(`${path}: number is not finite`);
      return value;
    case "boolean":
      return value;
  }

  if (depth >= SANITIZE_LIMITS.maxDepth) {
    throw new SanitizeError(`${path}: nested deeper than ${SANITIZE_LIMITS.maxDepth} levels`);
  }

  if (Array.isArray(value)) {
    if (value.length > SANITIZE_LIMITS.maxArrayLength) {
      throw new SanitizeError(`${path}: array longer than ${SANITIZE_LIMITS.maxArrayLength} items`);
    }
    return value.map((v, i) => sanitizePayload(v, depth + 1, `${path}[${i}]`));
  }

  if (typeof value === "object") {
    const entries = Object.entries(value);
    if (entries.length > SANITIZE_LIMITS.maxKeysPerObject) {
      throw new SanitizeError(`${path}: more than ${SANITIZE_LIMITS.maxKeysPerObject} keys`);
    }
    const out: Record<string, unknown> = {};
    for (const [rawKey, v] of entries) {
      const key = sanitizeString(rawKey);
      if (!key || BLOCKED_KEYS.has(key)) continue;
      if (key.length > SANITIZE_LIMITS.maxKeyLength) {
        throw new SanitizeError(`${path}: key longer than ${SANITIZE_LIMITS.maxKeyLength} chars`);
      }
      out[key] = sanitizePayload(v, depth + 1, `${path}.${key}`);
    }
    return out;
  }

  throw new SanitizeError(`${path}: unsupported value type`);
}
