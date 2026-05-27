import { ENV } from "./env";

type HeadersInit = Record<string, string>;

const baseHeaders: HeadersInit = {
  "Authorization": `Bearer ${ENV.TOKEN}`,
  "Version": ENV.API_VERSION,
  "Content-Type": "application/json"
};

const dneroWebHeaders: HeadersInit = {
  "Authorization": `Bearer ${ENV.DNEROWEB_ACCESS_TOKEN}`,
  "Content-Type": "application/json",
  "Version": ENV.API_VERSION,
}

const c3Headers: HeadersInit = {
  "Authorization": `Bearer ${ENV.GHL_C3_INTEGRATION_KEY}`,
  "Content-Type": "application/json",
  "Version": ENV.API_VERSION,
}

type HeadersMode = "default" | "dneroWeb" | "c3";

// shared fetch wrapper — routes to the right auth headers based on account mode (default / dneroWeb / c3)
async function apiFetch<T>(path: string, init?: RequestInit, useDneroWebHeaders: boolean | HeadersMode = false): Promise<T> {
  const url = `${ENV.BASE_URL}${path}`;
  let selectedHeaders: HeadersInit;
  if (useDneroWebHeaders === "c3") selectedHeaders = c3Headers;
  else if (useDneroWebHeaders === true || useDneroWebHeaders === "dneroWeb") selectedHeaders = dneroWebHeaders;
  else selectedHeaders = baseHeaders;
  console.log('using headers mode:', useDneroWebHeaders);
  const res = await fetch(url, {
    ...init,
    headers: { ...selectedHeaders, ...(init?.headers as HeadersInit) }
  });
  if (!res.ok) {
    console.error(`API request failed: ${res.status} ${res.statusText} @ ${path}`);
    const text = await res.text().catch(() => "No response body");
    throw new Error(`HTTP ${res.status} ${res.statusText} @ ${path} :: Response Body: ${text}`);
  }
  console.log(`API request successful: ${res.status} ${res.statusText} @ ${path}`);
  if (res.status === 204) return {} as T;
  return (await res.json()) as T;
}

// contacts

export interface ContactRecord {
  id: string;
  email?: string;
  phone?: string;
  firstName?: string;
  lastName?: string;
  tags?: string[];
}

export async function searchContactByPhone(phone: string): Promise<ContactRecord | null> {
  console.log("Searching contact by phone:", phone);
  const q = String(phone).trim();
  const data = await apiFetch<{ contacts?: any[] }>(
    `/contacts/search`,
    {
      method: "POST",
      body: JSON.stringify({
        locationId: ENV.LOCATION_ID,
        query: q,
        pageLimit: 1
      })
    }
  );
  const c = data.contacts?.[0];
  console.log("Found contact:", c);
  if (!c) return null;
  return {
    id: c.id,
    email: c.email,
    phone: c.phone,
    firstName: c.firstName,
    lastName: c.lastName,
    tags: Array.isArray(c.tags) ? c.tags : []
  };
}

export interface UpsertContactInput {
  email?: string;
  phone?: string;
  firstName?: string;
  lastName?: string;
  fullName?: string;
  companyName?: string;
  tags?: string[];
  address1?: string;
  city?: string;
  state?: string;
  country?: string;
  postalCode?: string;
  website?: string;
  dateOfBirth?: string;
  customFields?: { id: string; value: any }[];
  type?: any; 
}

// merges existing tags with incoming tags before write so we never overwrite history
export async function upsertContact(input: UpsertContactInput, existingId?: string): Promise<{ id: string }> {
  if (input.tags?.length) {
    const query = input.phone?.trim() || input.email?.trim();
    if (query) {
      const existing = await searchContactByPhone(query).catch(() => null);
      if (existing?.tags?.length) {
        const merged = Array.from(new Set([...existing.tags, ...input.tags]));
        input = { ...input, tags: merged };
      }
    }
  }

  const contactBody = mapContactBody(input);

  if (existingId) {
    const res = await apiFetch<{ id: string }>(`/contacts/${existingId}`, {
      method: "PUT",
      body: JSON.stringify(contactBody)
    });
    const contactId = res.id || existingId;
    if (!contactId) throw new Error("Contact ID missing after PUT update.");
    return { id: contactId };
  }

  const res = await apiFetch<any>(`/contacts/upsert`, {
    method: "POST",
    body: JSON.stringify({ ...contactBody, locationId: ENV.LOCATION_ID })
  });
  console.log("UPSERT_CONTACT_RESPONSE", JSON.stringify(res));
  const contactId = res?.id ?? res?.contact?.id ?? res?.contactId;
  if (!contactId) throw new Error("Contact ID missing after POST upsert.");
  return { id: contactId };
}

// strips undefined fields — GHL rejects null/empty on some endpoints
function mapContactBody(c: UpsertContactInput) {
  const body: any = {};
  if (c.email) body.email = c.email;
  if (c.phone) body.phone = c.phone;
  if (c.firstName) body.firstName = c.firstName;
  if (c.lastName) body.lastName = c.lastName;
  if (c.companyName) body.companyName = c.companyName;
  if (c.tags?.length) body.tags = c.tags;
  if (c.address1) body.address1 = c.address1;
  if (c.city) body.city = c.city;
  if (c.state) body.state = c.state;
  if (c.country) body.country = c.country;
  if (c.postalCode) body.postalCode = c.postalCode;
  if (c.website) body.website = c.website;
  if (c.dateOfBirth) body.dateOfBirth = c.dateOfBirth;
  if (c.customFields?.length) body.customFields = c.customFields;
  return body;
}


// pipelines — resolves by ID first, name match as fallback

export interface Pipeline {
  id: string;
  name: string;
  stages: { id: string; name: string }[];
}

export async function resolvePipeline(): Promise<Pipeline> {
  
  const list = await apiFetch<{ pipelines: any[] }>(
    `/opportunities/pipelines?locationId=${encodeURIComponent(ENV.LOCATION_ID)}`
  );
  
  let p: any;
  
  if (ENV.PIPELINE_ID) {
    p = list.pipelines?.find((p: any) => p.id === ENV.PIPELINE_ID);
    if (!p) throw new Error(`Pipeline ID not found: ${ENV.PIPELINE_ID}`);
  } else {
    p = list.pipelines?.find((p: any) => String(p.name).toLowerCase() === ENV.PIPELINE_NAME.toLowerCase());
    if (!p) throw new Error(`Pipeline not found by name: ${ENV.PIPELINE_NAME}`);
  }
  
  return {
    id: p.id,
    name: p.name,
    stages: (p.stages || []).map((s: any) => ({ id: s.id, name: s.name }))
  };
}

export function findStageIdByName(p: Pipeline, name?: string): string | undefined {
  if (!name) return undefined;
  const s = p.stages.find(st => st.name.toLowerCase() === name.toLowerCase());
  return s?.id;
}

// opportunities

export interface UpsertOpportunityInput {
  contactId: string;
  pipelineId: string;
  stageId?: string;              
  pipelineStageId?: string;      
  title?: string;
  status?: string;
  source?: string;
  monetaryValue?: number;
  assignedTo?: string;
  customFields?: Array<
    | { id: string; value: any }
    | { key: string; value: any }
    | { id: string; field_value: any }
    | { key: string; field_value: any }
  >;
}

export async function listOpportunitiesByContactInPipeline(
  contactId: string,
  pipelineId: string,
  opts: { status?: string; page?: number; pageLimit?: number } = {}
): Promise<{ id: string }[]> {
  const params = new URLSearchParams();
  params.set("location_id", ENV.LOCATION_ID);
  params.set("contact_id", contactId);
  params.set("pipeline_id", pipelineId);
  if (opts.status) params.set("status", opts.status); // optional
  console.log("Listing opportunities with params:", params.toString());

  const data = await apiFetch<{ opportunities?: any[] }>(
    `/opportunities/search?${params.toString()}`
  );

  return (data.opportunities || []).map(o => ({ id: o.id }));
}

function normalizeCustomFields(list?: UpsertOpportunityInput['customFields']) {
  if (!Array.isArray(list) || list.length === 0) return undefined;
  return list.map((cf: any) => {
    if ('field_value' in cf && ('id' in cf || 'key' in cf)) return cf;
    if ('id' in cf)  return { id: cf.id,  field_value: cf.value };
    if ('key' in cf) return { key: cf.key, field_value: cf.value };
    return cf;
  });
}

function mapOpportunityBody(input: UpsertOpportunityInput, withLocation = false) {
  const body: any = {
    pipelineId:    input.pipelineId,
    contactId:     input.contactId,
    name:          input.title,
    status:        input.status ?? 'open',
    monetaryValue: input.monetaryValue,
    ...(input.pipelineStageId || input.stageId
        ? { pipelineStageId: input.pipelineStageId ?? input.stageId }
        : {}),
    ...(input.assignedTo ? { assignedTo: input.assignedTo } : {}),
  };

  const cf = normalizeCustomFields(input.customFields);
  if (cf) body.customFields = cf;

  if (withLocation) body.locationId = ENV.LOCATION_ID;
  return body;
}

// update
export async function updateOpportunity(id: string, input: UpsertOpportunityInput): Promise<{ id: string }> {
  const payload = mapOpportunityBody(input, false);
  const res = await apiFetch<{ id: string }>(`/opportunities/${id}`, {
    method: "PUT",
    body: JSON.stringify(payload),
  });
  return { id: res.id ?? id };
}

// create
export async function createOpportunity(input: UpsertOpportunityInput): Promise<{ id: string }> {
  if (!input.contactId) throw new Error("Cannot create opportunity: Missing contactId");
  const payload = mapOpportunityBody(input, true);
  const res = await apiFetch<{ id: string }>(`/opportunities/`, { // trailing slash required
    method: "POST",
    body: JSON.stringify(payload),
  });
  return { id: res.id };
}

// upsert — checks for an existing opp in the pipeline first; updates if found, creates otherwise
export async function upsertOpportunity(input: UpsertOpportunityInput): Promise<{ id: string }> {
  const existing = await listOpportunitiesByContactInPipeline(input.contactId, input.pipelineId);
  if (existing.length) return updateOpportunity(existing[0].id, input);

  const upsertPayload = mapOpportunityBody(input, true);
  try {
    const res = await apiFetch<{ id: string }>(`/opportunities/upsert`, {
      method: "POST",
      body: JSON.stringify(upsertPayload),
    });
    return { id: res.id };
  } catch {
    return createOpportunity(input);
  }
}

// notes

export async function searchContactAtLocation(
  locationId: string,
  query: string
): Promise<ContactRecord | null> {
  const data = await apiFetch<{ contacts?: any[] }>(`/contacts/search`, {
    method: "POST",
    body: JSON.stringify({
      locationId,
      query: String(query).trim(),
      pageLimit: 1,
    }),
  }, true);
  const c = data.contacts?.[0];
  if (!c) return null;
  return {
    id: c.id,
    email: c.email,
    phone: c.phone,
    firstName: c.firstName,
    lastName: c.lastName,
    tags: Array.isArray(c.tags) ? c.tags : [],
  };
}

export interface ContactNote {
  id: string;
  body?: string;
  title?: string;
  pinned?: boolean;
  createdAt?: string;
  updatedAt?: string;
  userId?: string;
}

export interface ListNotesOptions {
  pageLimit?: number;
  startAfterId?: string; 
}

export async function listContactNotes(
  contactId: string,
  opts: ListNotesOptions = {}
): Promise<ContactNote[]> {
  const params = new URLSearchParams();
  if (opts.pageLimit) params.set("pageLimit", String(opts.pageLimit));
  if (opts.startAfterId) params.set("startAfterId", opts.startAfterId);

  const path =
    `/contacts/${encodeURIComponent(contactId)}/notes` +
    (params.toString() ? `?${params.toString()}` : "");

  const data = await apiFetch<{ notes?: any[] }>(path);
  return (data.notes ?? []).map(n => ({
    id: n.id,
    body: n.body,
    title: n.title,
    pinned: n.pinned,
    createdAt: n.createdAt,
    updatedAt: n.updatedAt,
    userId: n.userId,
  }), true);
}

export interface CreateContactNoteInput {
  body: string;
  title?: string;
  pinned?: boolean;
  [k: string]: any;
}

export interface CreateContactNoteInput {
  body: string;
  userId?: string;
}

export async function createContactNote(
  contactId: string,
  input: CreateContactNoteInput
): Promise<{ id: string }> {
  const bodyText = (input?.body || "").trim();
  if (!bodyText) throw new Error("Cannot create note: 'body' is required");

  const payload: any = { body: bodyText };
  if (input.userId) payload.userId = input.userId; 

  const res = await apiFetch<{ id?: string; note?: { id?: string } }>(
    `/contacts/${encodeURIComponent(contactId)}/notes`,
    {
      method: "POST",
      body: JSON.stringify(payload),
      
    }, true
  );

  const id = res.id ?? res.note?.id;
  console.log("Created contact note with ID:", id);
  if (!id) throw new Error("Create note succeeded but no note id returned");
  return { id };
}

// dnero web — separate sub-account; 3-step write: upsert → create → search
export async function upsertContactAtLocation(
  locationId: string,
  input: { 
    firstName?: string; 
    lastName?: string; 
    phone?: string; 
    email?: string ,
    tags?: string[], 
    timeOfPurchase?: string, 
    cityOfPurchase?: string, 
    objectiveRefinance?: string, 
    californiaCity?: string,
    wordPress_source?: string,
    utmSource?: string,
    utmCampaign?: string,
    utmMedium?: string,
    utmContent?: string,
    utmTerm?: string,
    toogle?: boolean }
): Promise<{ id: string }> {
  const body = mapContactBody({
    email: input.email,
    phone: input.phone,
    firstName: input.firstName,
    lastName: input.lastName,
    tags: input.tags,
    type: "Select",
    customFields: [
      { id: "SsLyPWgZdWgbpfGS7J53", value: input.timeOfPurchase },
      { id: "h36xYxny9AEGkMIU3uky", value: input.cityOfPurchase },
      { id: "jZL7GeNhHWWFi65VVyNr", value: null },
      { id: "3XvOQfUTGuMZziYJUCLo", value: input.objectiveRefinance },
      { id: "UUhPXJEAKzxgfT7jcCox", value: input.californiaCity },
      { id: "9nudhGcA50M4Nbbd7H8l", value: input.wordPress_source },
      { id: "RWsDDTvFzqNLmtZKcTIl", value: input.utmSource },
      { id: "wa4m0sEPHXfbveoYJLln", value: input.utmCampaign },
      { id: "uFBPELwDS7D0kPnD3jp0", value: input.utmMedium },
      { id: "huAZgjUs1bPEEQnN4sHP", value: input.utmContent },
      { id: "WNwa5CSwmGY1aCEWAzZC", value: input.utmTerm },
    ]
  });
  console.log("Upserting contact at location:", locationId, body);

  // upsert
  try {
    const res = await apiFetch<any>(`/contacts/upsert`, {
      method: "POST",
      body: JSON.stringify({ ...body, locationId }),
    }, input.toogle ?? true);
    console.log("Upsert response:", res);
    const upsertId = res?.id ?? res?.contact?.id ?? res?.contactId ?? res?.data?.id;
    if (upsertId) return { id: upsertId };
  } catch (e) {
    console.warn("Upsert failed, falling back to create:", e);
  }

  // fallback create
  try {
    const res = await apiFetch<any>(`/contacts`, {
      method: "POST",
      body: JSON.stringify({ ...body, locationId }),
    }, true);
    console.log("Create response:", res);
    const createId = res?.id ?? res?.contact?.id ?? res?.contactId ?? res?.data?.id;
    if (createId) return { id: createId };
  } catch (e) {
    console.warn("Create failed, falling back to search:", e);
  }

  // fallback search
  const q = input.phone?.trim() || input.email?.trim();
  if (q) {
    console.log("Searching contact at location with query:", q);
    const found = await searchContactAtLocation(locationId, q);
    if (found?.id) return { id: found.id };
    console.warn("Search fallback failed to find contact:", q);
  }

  throw new Error("Contact ID missing after upsert/create at custom location.");
}

// c3

export async function upsertContactC3(input: {
  firstName?: string;
  lastName?: string;
  phone?: string;
  email?: string;
  tags?: string[];
}): Promise<{ id: string }> {
  const locationId = ENV.GHL_C3_LOCATION_ID;
  const body = mapContactBody(input);

  const res = await apiFetch<any>(`/contacts/upsert`, {
    method: "POST",
    body: JSON.stringify({ ...body, locationId }),
  }, "c3");

  console.log("C3_UPSERT_RESPONSE", JSON.stringify(res));
  const id = res?.id ?? res?.contact?.id ?? res?.contactId;
  if (!id) throw new Error("Contact ID missing after C3 upsert.");
  return { id };
}
