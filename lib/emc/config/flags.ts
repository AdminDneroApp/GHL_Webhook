// feature flags, read on every access so a redeploy with new env values (or a test) takes effect

function envBool(name: string, fallback: boolean): boolean {
  const v = process.env[name]?.trim().toLowerCase();
  if (!v) return fallback;
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  return fallback;
}

export const flags = {
  // intake (record cycle/revision, remove tag, mirror status) + step 2 send to EMC. off until rollout.
  get EMC_INTAKE_ENABLED(): boolean {
    return envBool("EMC_INTAKE_ENABLED", false);
  },
  // dry run: decide and log, but write nothing to the DB or GHL and send nothing to EMC (except the preview)
  get EMC_INTAKE_DRY_RUN(): boolean {
    return envBool("EMC_INTAKE_DRY_RUN", true);
  },
  // preview send: while the intake is in dry run, build the real webhook 2 body from GHL and POST it to
  // EMC_WEBHOOK_URL (fresh preview handoffId, nothing written to the DB or GHL), so EMC gets real examples
  get EMC_FORWARD_PREVIEW(): boolean {
    return envBool("EMC_FORWARD_PREVIEW", false);
  },
  // TESTING ONLY: logs the sanitized webhook 1 payload (and, with EMC_FORWARD_PREVIEW, the outgoing
  // webhook 2 body) WITH values (contact PII). turn off after testing.
  get EMC_GHL_DEBUG_BODY(): boolean {
    return envBool("EMC_GHL_DEBUG_BODY", false);
  },
};
