// modelled on GHL v2 GET /contacts/{id}, GET /locations/{id}/customFields and GET /contacts/{id}/notes.
// all values are FAKE.

export const CONTACT_ID = "c_fake_001";

const opt = (id: string, label: string) => ({ id, label, prefillValue: "" });

export const CUSTOM_FIELDS = [
  { id: "f_call_status", fieldKey: "contact.call_status", dataType: "SINGLE_OPTIONS", model: "contact", picklistOptions: ["Contacted", "No Answer"] },
  { id: "f_transfer_date", fieldKey: "contact.transfer_date", dataType: "DATE", model: "contact" },
  { id: "f_created_date", fieldKey: "contact.created_date", dataType: "TEXT", model: "contact" },
  { id: "f_telemarketer", fieldKey: "contact.telemarketer", dataType: "MULTIPLE_OPTIONS", model: "contact" },
  { id: "f_emc_loan_officer", fieldKey: "contact.emc_loan_officer", dataType: "MULTIPLE_OPTIONS", model: "contact" },
  { id: "f_emc_external_id", fieldKey: "contact.emc_handoff_external_id", dataType: "TEXT", model: "contact" },
  { id: "f_rea", fieldKey: "contact.add_real_estate_agent", dataType: "MULTIPLE_OPTIONS", model: "contact" },
  { id: "f_type_of_deal", fieldKey: "contact.type_of_deal", dataType: "MULTIPLE_OPTIONS", model: "contact" },
  { id: "f_ciudad", fieldKey: "contact.ciudad_donde_vives_en_california", dataType: "TEXT", model: "contact" },
  { id: "f_city", fieldKey: "contact.city_of_purchase", dataType: "TEXT", model: "contact" },
  { id: "f_state", fieldKey: "contact.state_of_purchase", dataType: "TEXT", model: "contact" },
  { id: "f_objetivo", fieldKey: "contact.cul_es_tu_objetivo_principal_al_refinanciar", dataType: "MULTIPLE_OPTIONS", model: "contact" },
  { id: "f_property_type", fieldKey: "contact.property_type", dataType: "MULTIPLE_OPTIONS", model: "contact" },
  { id: "f_occupancy", fieldKey: "contact.occupancy", dataType: "MULTIPLE_OPTIONS", model: "contact" },
  { id: "f_ssn", fieldKey: "contact.ssn__itin", dataType: "MULTIPLE_OPTIONS", model: "contact" },
  { id: "f_income", fieldKey: "contact.gross_monthly_income", dataType: "TEXT", model: "contact" },
  { id: "f_credit", fieldKey: "contact.credit_score", dataType: "TEXT", model: "contact" },
  { id: "f_employment", fieldKey: "contact.employement_status", dataType: "MULTIPLE_OPTIONS", model: "contact" },
  { id: "f_fulltime", fieldKey: "contact.have_you_worked_fulltime_for_the_last_two_years", dataType: "SINGLE_OPTIONS", model: "contact" },
  {
    id: "f_bankruptcy",
    fieldKey: "contact.bankruptcy_in_the_past_year",
    dataType: "TEXTBOX_LIST",
    model: "contact",
    textBoxListOptions: [
      opt("11111111-aaaa-4aaa-8aaa-000000000001", "Filed by"),
      opt("11111111-aaaa-4aaa-8aaa-000000000002", "Discharge Date"),
    ],
  },
  { id: "f_taxes", fieldKey: "contact.taxes_from_the_last_2_years", dataType: "MULTIPLE_OPTIONS", model: "contact" },
  {
    id: "f_cosigner",
    fieldKey: "contact.cosigner_information",
    dataType: "TEXTBOX_LIST",
    model: "contact",
    // some responses may carry these as object-shaped picklistOptions
    picklistOptions: [
      opt("22222222-bbbb-4bbb-8bbb-000000000001", "Co-Signer Name"),
      opt("22222222-bbbb-4bbb-8bbb-000000000002", "Relationship"),
    ],
  },
  { id: "f_brief", fieldKey: "contact.brief_explanation", dataType: "LARGE_TEXT", model: "contact" },
  // not in the contract: ignored
  { id: "f_campaign", fieldKey: "contact.campaign_source", dataType: "TEXT", model: "contact" },
  { id: "f_opp", fieldKey: "opportunity.call_status", dataType: "TEXT", model: "opportunity" },
];

export const CONTACT = {
  id: CONTACT_ID,
  locationId: "loc_fake",
  firstName: "Testa",
  lastName: "Fakerson",
  email: "Testa.Fakerson@Example.COM ",
  phone: "(555) 555-0142",
  tags: ["emc-handoff-requested"],
  customFields: [
    { id: "f_call_status", value: "Contacted" },
    { id: "f_transfer_date", value: 1792022400000 }, // epoch millis → 2026-10-15
    { id: "f_created_date", value: "10/16/2026" },
    { id: "f_telemarketer", value: ["Agent Uno"] },
    { id: "f_emc_loan_officer", value: [] }, // empty multi-select
    { id: "f_emc_external_id", value: "ext-0001" }, // DNERO's permanent lead id
    // f_rea absent: never filled
    { id: "f_type_of_deal", value: ["Refinance", "Cash Out"] },
    { id: "f_ciudad", value: "Faketown" },
    { id: "f_city", value: "" }, // empty string
    { id: "f_state", value: "CA" },
    { id: "f_objetivo", value: ["Lower payment"] },
    { id: "f_property_type", value: ["Single Family"] },
    { id: "f_occupancy", value: ["Primary"] },
    { id: "f_ssn", value: ["SSN"] },
    { id: "f_income", value: 6500 },
    { id: "f_credit", value: "700-719" },
    { id: "f_employment", value: "W2" }, // a single string where an array is expected
    { id: "f_fulltime", value: "" },
    {
      id: "f_bankruptcy",
      value: {
        "11111111-aaaa-4aaa-8aaa-000000000001": "DNERO Agent",
        "11111111-aaaa-4aaa-8aaa-000000000002": "01/02/2025",
        "99999999-ffff-4fff-8fff-000000000009": "orphan", // option deleted in GHL
      },
    },
    { id: "f_taxes", value: ["2024", "2025"] },
    {
      id: "f_cosigner",
      value: {
        "22222222-bbbb-4bbb-8bbb-000000000001": "Co Fakerson",
        "22222222-bbbb-4bbb-8bbb-000000000002": "",
      },
    },
    { id: "f_brief", value: "  Wants a lower rate.  " },
    { id: "f_campaign", value: "ignored" },
  ],
};

export const NOTES = [
  { id: "n1", body: "Called, interested.", userId: "u1", dateAdded: "2026-10-15T10:00:00.000Z", contactId: CONTACT_ID, title: "Call 1" },
  { id: "n2", body: "Sent docs list.", userId: "u1", dateAdded: "2026-10-16T09:00:00.000Z", contactId: CONTACT_ID },
];
