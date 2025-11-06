export function normalizePhone(input?: string, defaultCountry: "US" | "SV" = "US"): string | undefined {
  if (!input) return undefined;
  const s = String(input).trim();
  if (!s) return undefined;
  if (s.startsWith("+")) return s.replace(/[^\d+]/g, "");
  const digits = s.replace(/\D+/g, "");
  if (!digits) return undefined;
  // Heurística simple: si 10 dígitos, asume US
  if (defaultCountry === "US" && digits.length === 10) return `+1${digits}`;
  // fallback: devuelve con +
  return `+${digits}`;
}
