import { ENV } from "./env";

type HeadersInit = Record<string, string>;

const baseHeaders: HeadersInit = {
  "Authorization": `Bearer ${ENV.TOKEN}`,
  // Ensure the correct API Version is set in ENV
  "Version": ENV.API_VERSION, 
  "Content-Type": "application/json"
};

const dneroWebHeaders: HeadersInit = {
  "Authorization": `Bearer ${ENV.DNEROWEB_ACCESS_TOKEN}`,
  "Content-Type": "application/json",
  "Version": ENV.API_VERSION,
}

async function apiFetch<T>(path: string, init?: RequestInit, useDneroWebHeaders = false): Promise<T> {
  const url = `${ENV.BASE_URL}${path}`;
  const res = await fetch(url, {
    ...init,
    headers: { ...(useDneroWebHeaders ? dneroWebHeaders : baseHeaders), ...(init?.headers as HeadersInit) }
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "No response body");
    // Enhanced error message to include the response body which holds the 422 details
    throw new Error(`HTTP ${res.status} ${res.statusText} @ ${path} :: Response Body: ${text}`);
  }
  if (res.status === 204) return {} as T;
  return (await res.json()) as T;
}

/** ===================== CONTACTOS ===================== **/

export interface ContactRecord {
  id: string;
  email?: string;
  phone?: string;
  firstName?: string;
  lastName?: string;
  tags?: string[];
}

// Search Contact function (no changes needed)
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
}

export async function upsertContact(input: UpsertContactInput, existingId?: string): Promise<{ id: string }> {
  const contactBody = mapContactBody(input);
  
  if (existingId) {
    const res = await apiFetch<{ id: string }>(`/contacts/${existingId}`, {
      method: "PUT",
      body: JSON.stringify(contactBody)
    });
    // Ensure we return a valid ID
    const contactId = res.id || existingId;
    if (!contactId) throw new Error("Contact ID missing after PUT update.");
    return { id: contactId };
  }
  
  try {
    const res = await apiFetch<{ id: string }>(`/contacts/upsert`, {
      method: "POST",
      body: JSON.stringify({ ...contactBody, locationId: ENV.LOCATION_ID })
    });
    const contactId = res.id;
    if (!contactId) throw new Error("Contact ID missing after POST upsert.");
    return { id: contactId };
  } catch (e) {
    // Optional: Log the error (e) here for debugging the upsert failure
    const res = await apiFetch<{ id: string }>(`/contacts`, {
      method: "POST",
      body: JSON.stringify({ ...contactBody, locationId: ENV.LOCATION_ID })
    });
    const contactId = res.id;
    if (!contactId) throw new Error("Contact ID missing after POST create.");
    return { id: contactId };
  }
}

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


/** ===================== PIPELINES & STAGES ===================== **/
// (No changes needed in this section)

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

/** ===================== OPORTUNIDADES ===================== **/

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

// List opportunities (no changes needed)
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

// --- helper: map body exactly to GHL schema (camelCase) ---
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

// UPDATE (PUT /opportunities/{id})
export async function updateOpportunity(id: string, input: UpsertOpportunityInput): Promise<{ id: string }> {
  const payload = mapOpportunityBody(input, false); // locationId not required on update
  const res = await apiFetch<{ id: string }>(`/opportunities/${id}`, {
    method: "PUT",
    body: JSON.stringify(payload),
  });
  return { id: res.id ?? id };
}

// CREATE (POST /opportunities/)  <-- trailing slash REQUIRED
export async function createOpportunity(input: UpsertOpportunityInput): Promise<{ id: string }> {
  if (!input.contactId) throw new Error("Cannot create opportunity: Missing contactId");
  const payload = mapOpportunityBody(input, true); // include locationId
  const res = await apiFetch<{ id: string }>(`/opportunities/`, {   // <-- slash
    method: "POST",
    body: JSON.stringify(payload),
  });
  return { id: res.id };
}

// UPSERT (POST /opportunities/upsert)
export async function upsertOpportunity(input: UpsertOpportunityInput): Promise<{ id: string }> {
  // first check if it already exists
  const existing = await listOpportunitiesByContactInPipeline(input.contactId, input.pipelineId);
  if (existing.length) return updateOpportunity(existing[0].id, input);

  // try upsert
  const upsertPayload = mapOpportunityBody(input, true); // include locationId
  try {
    const res = await apiFetch<{ id: string }>(`/opportunities/upsert`, {
      method: "POST",
      body: JSON.stringify(upsertPayload),
    });
    return { id: res.id };
  } catch {
    // fallback to create
    return createOpportunity(input);
  }
}

/** ===================== CONTACT NOTES ===================== **/

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

/** GET /contacts/:contactId/notes */
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
  }));
}

/** POST /contacts/:contactId/notes */
export interface CreateContactNoteInput {
  body: string;
  title?: string;
  pinned?: boolean;
  [k: string]: any;
}

export interface CreateContactNoteInput {
  body: string;         // required
  userId?: string;      // optional (author)
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
    }
  );

  const id = res.id ?? res.note?.id;
  if (!id) throw new Error("Create note succeeded but no note id returned");
  return { id };
}

/** ===================== DNERO WEB ===================== **/
export async function upsertContactAtLocation(
  locationId: string,
  input: { firstName?: string; lastName?: string; phone?: string; email?: string }
): Promise<{ id: string }> {
  const body = mapContactBody({
    email: input.email,
    phone: input.phone,
    firstName: input.firstName,
    lastName: input.lastName,
  });
  const res = await apiFetch<{ id: string }>(`/contacts/upsert`, {
    method: "POST",
    body: JSON.stringify({ ...body, locationId }),
    
  }, true);
  if (!res.id) throw new Error("Contact ID missing after upsert at custom location.");
  return { id: res.id };
}
