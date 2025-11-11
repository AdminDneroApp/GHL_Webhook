function must(name: string): string {
  const v = process.env[name];
  if (!v || !v.trim()) throw new Error(`Missing required env var: ${name}`);
  return v;
}

// Soporta nombres antiguos y nuevos sin romper tu setup
function first(...names: string[]): string | undefined {
  for (const n of names) {
    const v = process.env[n];
    if (v && v.trim()) return v.trim();
  }
  return undefined;
}

export const ENV = {
  // Token: prioridad a LC_ACCESS_TOKEN / GHL_TOKEN, fallback al previo GHL_C2_API_KEY
  TOKEN: first("LC_ACCESS_TOKEN", "GHL_TOKEN", "GHL_C2_API_KEY") ?? must("GHL_C2_API_KEY"),
  DNEROWEB_ACCESS_TOKEN: process.env.DNEROWEB_ACCESS_TOKEN || "",

  // Base API y versión
  BASE_URL: process.env.GHL_BASE_URL?.trim() || "https://services.leadconnectorhq.com",
  API_VERSION: process.env.GHL_API_VERSION?.trim() || "2021-07-28",

  // Pipeline destino
  PIPELINE_NAME: first("TARGET_PIPELINE_NAME", "GHL_C2_PIPELINE_NAME") ?? must("GHL_C2_PIPELINE_NAME"),
  PIPELINE_ID: first("TARGET_PIPELINE_ID", "GHL_PIPELINE_ID", "GHL_C2_PIPELINE_ID") || "",

  // Location destino (muchos endpoints lo piden)
  LOCATION_ID: first("GHL_C2_LOCATION_ID", "TARGET_LOCATION_ID") ?? must("GHL_C2_LOCATION_ID"),

  // Seguridad opcional del webhook
  WEBHOOK_TOKEN: process.env.WEBHOOK_TOKEN || "",
  
  // DneroWeb Location ID
  DNEROWEB_LOCATION_ID: process.env.DNEROWEB_LOCATION_ID || "",

  // Opcionales
  DEFAULT_STAGE_NAME: process.env.DEFAULT_STAGE_NAME?.trim() || "New Lead",
  DEFAULT_COUNTRY: process.env.DEFAULT_COUNTRY?.trim() || "US",
  DNEROWEB_TOKEN: process.env.DNEROWEB_TOKEN || "",
};
