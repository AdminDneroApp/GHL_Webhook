export function normalizePhone(input?: string, defaultCountry: "US" | "SV" = "US"): string | undefined {
  if (!input) return undefined;
  const s = String(input).trim();
  if (!s) return undefined;
  if (s.startsWith("+")) return s.replace(/[^\d+]/g, "");
  const digits = s.replace(/\D+/g, "");
  if (!digits) return undefined;
  if (defaultCountry === "US" && digits.length === 10) return `+1${digits}`;
  return `+${digits}`;
}
