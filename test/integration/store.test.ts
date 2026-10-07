import { describe, it, expect } from "vitest";
import { createSwellClient } from "../helpers/swell-client";
import { COLLECTIONS, lineItemKey, orderItemRows, toFields } from "../../functions/lib/airtable";

// Read-only checks against the logged-in test store (uses swell-cli auth). Run `swell app push` first.
describe("store data the app depends on", () => {
  const swell = createSwellClient();

  it("reads the app settings", async () => {
    const settings = await swell.settings("airtable");
    expect(settings).toBeTypeOf("object");
  });

  it("reads the syncs collection", async () => {
    const result = await swell.get("/apps/airtable/syncs", { limit: 1 });
    expect(Array.isArray(result?.results)).toBe(true);
  });

  it.each(Object.keys(COLLECTIONS))("pages %s by id cursor and maps records", async (collection) => {
    const { path, expand } = COLLECTIONS[collection];
    const first = await swell.get(path, { sort: "id asc", limit: 1, ...(expand ? { expand } : {}) });
    expect(Array.isArray(first?.results)).toBe(true);

    const record = first.results[0];
    if (record) {
      if (collection === "order_items") {
        for (const row of orderItemRows(record)) {
          expect(toFields(collection, row)["Swell ID"]).toBe(lineItemKey(record.id, row.id));
        }
      } else {
        expect(toFields(collection, record)["Swell ID"]).toBe(record.id);
      }

      const next = await swell.get(path, { where: { id: { $gt: record.id } }, sort: "id asc", limit: 1, fields: "id" });
      expect(next.results.every((r: any) => r.id > record.id)).toBe(true);
    }
  });
});
