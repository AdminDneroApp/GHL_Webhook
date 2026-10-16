// describes a payload by its key names only — never values — so logs show what a sender
// sends without holding contact PII. nested objects keep their structure; arrays show their length.

export type PayloadShape = string | PayloadShape[] | { [key: string]: PayloadShape };

const MAX_DEPTH = 4;

export function payloadShape(value: unknown, depth = 0): PayloadShape {
  if (value === null) return "null";
  if (Array.isArray(value)) {
    if (depth >= MAX_DEPTH) return `array(${value.length})`;
    // the first element stands for the rest: GHL arrays are uniform (tags, notes…)
    return value.length ? [payloadShape(value[0], depth + 1), `…${value.length} items`] : [];
  }
  if (typeof value === "object") {
    if (depth >= MAX_DEPTH) return "object";
    const out: Record<string, PayloadShape> = {};
    for (const [k, v] of Object.entries(value)) out[k] = payloadShape(v, depth + 1);
    return out;
  }
  // type only, plus whether a string is empty (GHL sends "" for missing fields)
  if (typeof value === "string") return value === "" ? "string(empty)" : "string";
  return typeof value;
}
