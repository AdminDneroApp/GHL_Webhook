import { ENV } from "./env";

type HeadersInit = Record<string, string>;

const baseHeaders: HeadersInit = {
  "Authorization": `Bearer ${ENV.TOKEN}`,
  "Version": ENV.API_VERSION,
  "Content-Type": "application/json"
};

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const url = `${ENV.BASE_URL}${path}`;
  const res = await fetch(url, {
    ...init,
    headers: { ...baseHeaders, ...(init?.headers as HeadersInit) }
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} ${res.statusText} @ ${path} :: ${text}`);
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

export async function searchContactByPhone(phone: string): Promise<ContactRecord | null> {
  // LeadConnector v2: búsqueda por teléfono (POST /contacts/search)
  // payload común soportado: { query, locationId, limit, skip }
  const data = await apiFetch<{ contacts?: any[] }>(
    `/contacts/search`,
    {
      method: "POST",
      body: JSON.stringify({
        query: phone,
        locationId: ENV.LOCATION_ID,
        limit: 1
      })
    }
  );
  const c = data.contacts?.[0];
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
  if (existingId) {
    const payload: any = {
      ...mapContactBody(input),
      locationId: ENV.LOCATION_ID
    };
    const res = await apiFetch<{ id: string }>(`/contacts/${existingId}`, {
      method: "PUT",
      body: JSON.stringify(payload)
    });
    return { id: res.id || existingId };
  }

  try {
    const res = await apiFetch<{ id: string }>(`/contacts/upsert`, {
      method: "POST",
      body: JSON.stringify({
        ...mapContactBody(input),
        locationId: ENV.LOCATION_ID
      })
    });
    return { id: res.id };
  } catch {
    const res = await apiFetch<{ id: string }>(`/contacts`, {   // opcional: sin slash final
      method: "POST",
      body: JSON.stringify({
        ...mapContactBody(input),
        locationId: ENV.LOCATION_ID
      })
    });
    return { id: res.id };
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

export interface Pipeline {
  id: string;
  name: string;
  stages: { id: string; name: string }[];
}

export async function resolvePipeline(): Promise<Pipeline> {
  if (ENV.PIPELINE_ID) {
    const list = await apiFetch<{ pipelines: any[] }>(
      `/opportunities/pipelines?locationId=${encodeURIComponent(ENV.LOCATION_ID)}`
    );
    const p = list.pipelines?.find((p: any) => p.id === ENV.PIPELINE_ID);
    if (!p) throw new Error(`Pipeline ID not found: ${ENV.PIPELINE_ID}`);
    return {
      id: p.id,
      name: p.name,
      stages: (p.stages || []).map((s: any) => ({ id: s.id, name: s.name }))
    };
  }

  const list = await apiFetch<{ pipelines: any[] }>(
    `/opportunities/pipelines?locationId=${encodeURIComponent(ENV.LOCATION_ID)}`
  );
  const p = list.pipelines?.find((p: any) => String(p.name).toLowerCase() === ENV.PIPELINE_NAME.toLowerCase());
  if (!p) throw new Error(`Pipeline not found by name: ${ENV.PIPELINE_NAME}`);
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
  title?: string;          
  status?: string;
  monetaryValue?: number;
  source?: string;
}

export async function listOpportunitiesByContactInPipeline(
  contactId: string,
  pipelineId: string
): Promise<{ id: string }[]> {
  const data = await apiFetch<{ opportunities?: any[] }>(
    `/opportunities?locationId=${encodeURIComponent(ENV.LOCATION_ID)}&contactId=${encodeURIComponent(contactId)}&pipelineId=${encodeURIComponent(pipelineId)}`
  );
  return (data.opportunities || []).map(o => ({ id: o.id }));
}

export async function updateOpportunity(id: string, input: UpsertOpportunityInput): Promise<{ id: string }> {
  const payload: any = {
    contactId: input.contactId,
    pipelineId: input.pipelineId,
    stageId: input.stageId,
    status: input.status,
    name: input.title,
    monetaryValue: input.monetaryValue,
    source: input.source,
    locationId: ENV.LOCATION_ID
  };
  const res = await apiFetch<{ id: string }>(`/opportunities/${id}`, {
    method: "PUT",
    body: JSON.stringify(payload)
  });
  return { id: res.id || id };
}

export async function createOpportunity(input: UpsertOpportunityInput): Promise<{ id: string }> {
  const payload: any = {
    contactId: input.contactId,
    pipelineId: input.pipelineId,
    stageId: input.stageId,
    status: input.status,
    name: input.title,
    monetaryValue: input.monetaryValue,
    source: input.source,
    locationId: ENV.LOCATION_ID
  };
  const res = await apiFetch<{ id: string }>(`/opportunities/`, {
    method: "POST",
    body: JSON.stringify(payload)
  });
  return { id: res.id };
}

export async function upsertOpportunity(input: UpsertOpportunityInput): Promise<{ id: string }> {
  // si  hay una oportunidad  contacto en el pipeline → actualizar 
  // si no hay → crear una nueva.
  const existing = await listOpportunitiesByContactInPipeline(input.contactId, input.pipelineId);
  if (existing.length > 0) {
    return updateOpportunity(existing[0].id, input);
  }
  // upsert directo 
  try {
    const res = await apiFetch<{ id: string }>(`/opportunities/upsert`, {
      method: "POST",
      body: JSON.stringify({
        contactId: input.contactId,
        pipelineId: input.pipelineId,
        stageId: input.stageId,
        status: input.status,
        name: input.title,
        monetaryValue: input.monetaryValue,
        source: input.source,
        locationId: ENV.LOCATION_ID
      })
    });
    return { id: res.id };
  } catch {
    return createOpportunity(input);
  }
}
