import { describe, expect, it } from "vitest";
import { payloadShape } from "@lib/emc/payload-shape";

describe("payloadShape", () => {
  it("keeps key names and types, never values", () => {
    const shape = payloadShape({
      contact_id: "c_123",
      email: "ana@example.com",
      phone: "",
      lead_value: 5000,
      location: { id: "loc_1", name: "Dnero" },
      tags: ["emc", "hot"],
      customData: {},
      none: null,
    });
    expect(shape).toEqual({
      contact_id: "string",
      email: "string",
      phone: "string(empty)",
      lead_value: "number",
      location: { id: "string", name: "string" },
      tags: ["string", "…2 items"],
      customData: {},
      none: "null",
    });
    expect(JSON.stringify(shape)).not.toContain("ana@example.com");
  });

  it("stops descending past the depth limit", () => {
    expect(payloadShape({ a: { b: { c: { d: { e: 1 } } } } })).toEqual({ a: { b: { c: { d: "object" } } } });
  });
});
