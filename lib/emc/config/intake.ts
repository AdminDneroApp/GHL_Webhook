// step 1 constants shared by the intake service and the GHL setup

// the GHL workflow triggers on "Tag Added" for this tag, so the backend removes it after every intake
export const EMC_HANDOFF_TAG = "emc-handoff-requested";

// GHL contact custom fields (keys without the "contact." prefix) — the agents' mirror of the DB state
export const EMC_FIELD_STATUS = "emc_handoff_status";
export const EMC_FIELD_TIME = "emc_handoff_time";
export const EMC_FIELD_EXTERNAL_ID = "emc_handoff_external_id";

export const REJECTED_NOTE = {
  title: "EMC handoff not sent",
  body:
    "This contact was tagged for an EMC handoff, but it has no phone number or email address. " +
    "Add a phone or an email to the contact, then add the tag again.",
};
