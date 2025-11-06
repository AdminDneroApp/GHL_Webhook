import { NextResponse } from "next/server";
import { WebhookPayloadSchema } from "@lib/validation/webhook-schema";
import { ENV } from "@lib/env";
import { normalizePhone } from "@lib/phone";
import {
  searchContactByPhone,
  upsertContact,
  resolvePipeline,
  findStageIdByName,
  upsertOpportunity
} from "@lib/ghl-client";
import { mapCustomFieldsFromPayload } from "@lib/custom-fields";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    if (ENV.WEBHOOK_TOKEN) {
      const token = req.headers.get("x-webhook-token");
      if (token !== ENV.WEBHOOK_TOKEN) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      }
    }

    const body = await req.json();
    const parsed = WebhookPayloadSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid payload", issues: parsed.error.flatten() }, { status: 400 });
    }
    const payload = parsed.data;

    // === CONTACTO: prioridad por PHONE (requisito)
    const phone = normalizePhone(payload.phone, ENV.DEFAULT_COUNTRY as any);
    const email = (payload.email || "").trim() || undefined;
    if (!phone && !email) {
      return NextResponse.json({ error: "Missing contact identity (phone or email required)" }, { status: 400 });
    }

    // Buscar por teléfono primero
    const found = phone ? await searchContactByPhone(phone) : null;

    // Tags
    const tags = Array.isArray(payload.tags)
      ? payload.tags
      : typeof payload.tags === "string"
        ? payload.tags.split(",").map(s => s.trim()).filter(Boolean)
        : [];

    // Custom fields (root + customData) -> [{id,value}]
    const customFields = await mapCustomFieldsFromPayload(payload);

    // Upsert CONTACT
    const firstName = payload.first_name || payload.full_name?.split(" ")?.[0] || undefined;
    const lastName  = payload.last_name  || payload.full_name?.split(" ")?.slice(1).join(" ") || undefined;

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
        customFields, // <-- NUEVO
      },
      found?.id
    );

    // === OPORTUNIDAD 
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

      const opp = await upsertOpportunity({
        contactId: contactRes.id,
        pipelineId: pipeline.id,
        stageId,
        status: payload.status || undefined,
        title: payload.opportunity_name || `${firstName ?? ""} ${lastName ?? ""}`.trim() || "Opportunity",
        monetaryValue: Number.isFinite(leadValue as number) ? (leadValue as number) : undefined,
        source: payload.opportunity_source || payload.source || undefined
      });
      opportunityId = opp.id;
    }

    return NextResponse.json({
      processed: true,
      contactId: contactRes.id,
      opportunityId
    });
  } catch (err: any) {
    console.error("WEBHOOK_ERROR", { message: err?.message, stack: err?.stack });
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
