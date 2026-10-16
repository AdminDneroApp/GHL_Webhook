// creates the EMC contact custom fields in GHL if they don't exist yet (idempotent).
//
//   node --env-file=.env.local --experimental-strip-types scripts/create-emc-fields.ts --dry-run
//   node --env-file=.env.local --experimental-strip-types scripts/create-emc-fields.ts
//
// --dry-run only lists what exists and what would be created.
// env is read directly (lib/env.ts needs the @lib build setup and requires unrelated vars):
//   GHL token:    LC_ACCESS_TOKEN | GHL_TOKEN | GHL_C2_API_KEY
//   location:     GHL_C2_LOCATION_ID | TARGET_LOCATION_ID
//   optional:     GHL_BASE_URL, GHL_API_VERSION
//
// GHL derives the field key from the name ("emc_handoff_status" → "contact.emc_handoff_status"),
// so each field is created with its key as the name; the script checks the key it got back.

interface FieldSpec {
  key: string;
  dataType: "SINGLE_OPTIONS" | "TEXT";
  options?: string[];
}

interface GhlField {
  id: string;
  name: string;
  fieldKey: string;
  dataType: string;
  model?: string;
  picklistOptions?: string[];
}

const FIELDS: FieldSpec[] = [
  {
    key: "emc_handoff_status",
    dataType: "SINGLE_OPTIONS",
    options: ["requested", "sent", "pending", "failed", "completed"],
  },
  // TEXT, not DATE: GHL DATE fields drop the time of day. value is "YYYY-MM-DD HH:mm:ss UTC"
  { key: "emc_handoff_time", dataType: "TEXT" },
  { key: "emc_handoff_external_id", dataType: "TEXT" },
];

function env(...names: string[]): string | undefined {
  for (const n of names) {
    const v = process.env[n]?.trim();
    if (v) return v;
  }
  return undefined;
}

const TOKEN = env("LC_ACCESS_TOKEN", "GHL_TOKEN", "GHL_C2_API_KEY");
const LOCATION_ID = env("GHL_C2_LOCATION_ID", "TARGET_LOCATION_ID");
const BASE_URL = env("GHL_BASE_URL") || "https://services.leadconnectorhq.com";
const API_VERSION = env("GHL_API_VERSION") || "2021-07-28";
const DRY_RUN = process.argv.includes("--dry-run");

async function ghl<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Version: API_VERSION,
      Accept: "application/json",
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    // field metadata only, no contact data — the GHL error message helps diagnose a bad payload
    const text = await res.text().catch(() => "");
    throw new Error(`GHL ${method} ${path} failed: HTTP ${res.status} ${text.slice(0, 500)}`);
  }
  return (await res.json()) as T;
}

const bare = (k: string) => k.trim().toLowerCase().replace(/^contact\./, "");

async function main() {
  if (!TOKEN || !LOCATION_ID) {
    console.error("missing GHL token or location id env vars (see header comment)");
    process.exit(1);
  }
  const loc = encodeURIComponent(LOCATION_ID);

  const { customFields = [] } = await ghl<{ customFields?: GhlField[] }>(
    "GET",
    `/locations/${loc}/customFields?model=contact`,
  );
  const existing = new Map(customFields.map((f) => [bare(f.fieldKey || ""), f]));

  console.log(`location ${LOCATION_ID}${DRY_RUN ? " (dry run)" : ""}`);
  let failed = false;

  for (const spec of FIELDS) {
    const found = existing.get(spec.key);
    if (found) {
      if (found.dataType !== spec.dataType) {
        // GHL can't change a field's type in place: delete and recreate it in the UI, then rerun
        console.error(
          `MISMATCH ${spec.key} (id ${found.id}): dataType is ${found.dataType}, expected ${spec.dataType} — recreate it in the GHL UI`,
        );
        failed = true;
        continue;
      }
      console.log(`skip    ${spec.key} (exists, id ${found.id})`);
      continue;
    }
    if (DRY_RUN) {
      console.log(`create  ${spec.key} (${spec.dataType}${spec.options ? `: ${spec.options.join(", ")}` : ""}) — dry run`);
      continue;
    }

    try {
      // `options` (string list) for dropdowns; the v2 spec of this endpoint doesn't list it,
      // so the result is checked against picklistOptions below
      const { customField } = await ghl<{ customField?: GhlField }>("POST", `/locations/${loc}/customFields`, {
        name: spec.key,
        dataType: spec.dataType,
        model: "contact",
        ...(spec.options ? { options: spec.options } : {}),
      });
      if (!customField?.id) throw new Error("response had no customField.id");
      console.log(`created ${spec.key} (id ${customField.id}, key ${customField.fieldKey})`);

      if (bare(customField.fieldKey || "") !== spec.key) {
        console.warn(`  WARNING: GHL assigned key "${customField.fieldKey}", expected "contact.${spec.key}" — rename it in the UI`);
        failed = true;
      }
      if (spec.options) {
        const got = customField.picklistOptions ?? [];
        const missing = spec.options.filter((o) => !got.includes(o));
        if (missing.length) {
          console.warn(`  WARNING: options missing on the created field: ${missing.join(", ")} — add them in the UI`);
          failed = true;
        }
      }
    } catch (err) {
      console.error(`failed  ${spec.key}: ${err instanceof Error ? err.message : String(err)}`);
      failed = true;
    }
  }

  if (failed) process.exit(1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
