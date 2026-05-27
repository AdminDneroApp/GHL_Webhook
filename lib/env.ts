function must(name: string): string {
  const v = process.env[name];
  if (!v || !v.trim()) throw new Error(`Missing required env var: ${name}`);
  return v;
}

// picks the first defined env var — supports legacy and current naming side by side
function first(...names: string[]): string | undefined {
  for (const n of names) {
    const v = process.env[n];
    if (v && v.trim()) return v.trim();
  }
  return undefined;
}

export const ENV = {
  TOKEN: first("LC_ACCESS_TOKEN", "GHL_TOKEN", "GHL_C2_API_KEY") ?? must("GHL_C2_API_KEY"),
  DNEROWEB_ACCESS_TOKEN: process.env.DNEROWEB_ACCESS_TOKEN || "",

  BASE_URL: process.env.GHL_BASE_URL?.trim() || "https://services.leadconnectorhq.com",
  API_VERSION: process.env.GHL_API_VERSION?.trim() || "2021-07-28",

  PIPELINE_NAME: first("TARGET_PIPELINE_NAME", "GHL_C2_PIPELINE_NAME") ?? must("GHL_C2_PIPELINE_NAME"),
  PIPELINE_ID: first("TARGET_PIPELINE_ID", "GHL_PIPELINE_ID", "GHL_C2_PIPELINE_ID") || "",

  LOCATION_ID: first("GHL_C2_LOCATION_ID", "TARGET_LOCATION_ID") ?? must("GHL_C2_LOCATION_ID"),

  WEBHOOK_TOKEN: process.env.WEBHOOK_TOKEN || "",

  // dnero web
  DNEROWEB_LOCATION_ID: process.env.DNEROWEB_LOCATION_ID || "",
  DNEROWEB_TOKEN: process.env.DNEROWEB_TOKEN || "",

  DEFAULT_STAGE_NAME: process.env.DEFAULT_STAGE_NAME?.trim() || "New Lead",
  DEFAULT_COUNTRY: process.env.DEFAULT_COUNTRY?.trim() || "US",
  CORS_ORIGINS: process.env.CORS_ORIGINS || "",

  // c3
  GHL_C3_LOCATION_ID: process.env.GHL_C3_LOCATION_ID || "",
  GHL_C3_INTEGRATION_KEY: process.env.GHL_C3_INTEGRATION_KEY || "",
};
