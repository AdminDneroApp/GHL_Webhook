// feature flags, read on every access so a redeploy with new env values (or a test) takes effect

function envBool(name: string, fallback: boolean): boolean {
  const v = process.env[name]?.trim().toLowerCase();
  if (!v) return fallback;
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  return fallback;
}

export const flags = {
  // step 1 intake (record cycle/revision, remove tag, mirror status). off until rollout.
  get EMC_INTAKE_ENABLED(): boolean {
    return envBool("EMC_INTAKE_ENABLED", false);
  },
  // dry run: decide and log, but write nothing to the DB or GHL
  get EMC_INTAKE_DRY_RUN(): boolean {
    return envBool("EMC_INTAKE_DRY_RUN", true);
  },
};
