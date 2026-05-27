import { NextResponse } from "next/server";
import { WebhookPayloadSchema } from "@lib/validation/webhook-schema";
import { ENV } from "@lib/env";
import { normalizePhone } from "@lib/phone";
import {
  searchContactByPhone,
  upsertContact,
  resolvePipeline,
  findStageIdByName,
  upsertOpportunity,
  createContactNote 
} from "@lib/ghl-client";
import { mapCustomFieldsFromPayload } from "@lib/custom-fields";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {

  // field pickers — accepts multiple naming conventions from different CRM sources
  function pickNoteBody(p: any): string | undefined {
    const cands = [p.note_body, p.noteBody, p.note, p.note_text, p.noteText, p.contact_note, p.contactNote];
    for (const v of cands) {
      const s = typeof v === "string" ? v.trim() : "";
      if (s) return s;
    }
    return undefined;
  }

  function pickNoteUserId(p: any): string | undefined {
    const cands = [p.note_user_id, p.noteUserId, p.user_id, p.userId, p.owner_id, p.ownerId];
    for (const v of cands) {
      const s = typeof v === "string" ? v.trim() : "";
      if (s) return s;
    }
    return undefined;
  }
  
  try {
    // token auth
    if (ENV.WEBHOOK_TOKEN) {
      const token = req.headers.get("x-webhook-token");
      if (token !== ENV.WEBHOOK_TOKEN) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      }
    }

    async function readJson(req: Request) {
      const raw = await req.text();
      if (!raw || !raw.trim()) {
        throw new Error("Empty body");
      }
      try {
        return JSON.parse(raw);
      } catch (e: any) {
        console.error("INVALID_JSON_SNIPPET", raw.slice(0, 400));
        throw new Error(`Invalid JSON: ${e?.message || "parse error"}`);
      }
    }

    // parse + validate
    const body = await readJson(req);
    const parsed = WebhookPayloadSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid payload", issues: parsed.error.flatten() }, { status: 400 });
    }
    const payload = parsed.data;

    // contact — phone-first lookup, email as fallback identity
    const phone = normalizePhone(payload.phone, ENV.DEFAULT_COUNTRY as any);
    const email = (payload.email || "").trim() || undefined;
    if (!phone && !email) {
      return NextResponse.json({ error: "Missing contact identity (phone or email required)" }, { status: 400 });
    }

    const found = phone ? await searchContactByPhone(phone) : null;

    // tags: normalize to array regardless of how sender formats them
    const tags = Array.isArray(payload.tags)
      ? payload.tags
      : typeof payload.tags === "string"
        ? payload.tags.split(",").map(s => s.trim()).filter(Boolean)
        : [];

    const customFields = await mapCustomFieldsFromPayload(payload);

    const firstName = payload.first_name || payload.full_name?.split(" ")?.[0] || undefined;
    const lastName  = payload.last_name  || payload.full_name?.split(" ")?.slice(1).join(" ") || undefined;

    // upsert contact — creates or updates, existing tags are merged in ghl-client
    const contactRes = await upsertContact(
      {
        email,
        phone: phone || undefined,
        firstName,
        lastName,
        companyName: payload.company_name,
        tags,
        address1: payload.address1,
        city: payload.city,
        state: payload.state,
        country: payload.country,
        postalCode: payload.postal_code,
        website: payload.website,
        dateOfBirth: payload.date_of_birth,
        customFields,
      },
      found?.id
    );

    // opportunity — skipped entirely if no opp-related fields are in the payload
    const hasOpportunity =
      !!payload.opportunity_name ||
      !!payload.status ||
      !!payload.lead_value ||
      !!payload.pipleline_stage ||
      !!payload.pipeline_id ||
      !!payload.pipeline_name ||
      !!payload.source ||
      !!payload.opportunity_source;

    let opportunityId: string | null = null;

    if (hasOpportunity) {
      const pipeline = await resolvePipeline();
      const stageId = findStageIdByName(pipeline, payload.pipleline_stage) ||
                      findStageIdByName(pipeline, payload.pipeline_name) || 
                      findStageIdByName(pipeline, ENV.DEFAULT_STAGE_NAME) ||
                      pipeline.stages?.[0]?.id;

      const leadValue = typeof payload.lead_value === "string"
        ? Number(payload.lead_value)
        : payload.lead_value;

      const cf = Array.isArray(customFields)
        ? customFields.map((c: any) => {
            if ('field_value' in c && (c.id || c.key)) return c;
            if ('id' in c)  return { id: c.id,  field_value: c.value };
            if ('key' in c) return { key: c.key, field_value: c.value };
            return c;
          })
        : undefined;

      const opp = await upsertOpportunity({
        contactId:        contactRes.id,
        pipelineId:       pipeline.id,
        pipelineStageId:  stageId,
        status:           payload.status || undefined,
        title:            (payload.opportunity_name || `${(firstName ?? '').trim()} ${(lastName ?? '').trim()}`.trim() || 'Opportunity'),
        monetaryValue:    Number.isFinite(leadValue as number) ? (leadValue as number) : undefined,
        source:           payload.opportunity_source || payload.source || undefined,
        customFields:     cf,
      });

      opportunityId = opp.id;
    }

    // optional note — attached to the contact if note body is present
    let noteId: string | null = null;
    const noteBody = pickNoteBody(payload);
    if (noteBody) {
      const userId = pickNoteUserId(payload);
      const res = await createContactNote(contactRes.id, { body: noteBody, ...(userId ? { userId } : {}) });
      noteId = res.id;
    }

    return NextResponse.json({
      processed: true,
      contactId: contactRes.id,
      opportunityId,
      noteId
    });
  } catch (err: any) {
    console.error("WEBHOOK_ERROR", { message: err?.message, stack: err?.stack });
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
