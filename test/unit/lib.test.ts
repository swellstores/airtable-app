import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  AirtableError,
  COMPATIBLE_TYPES,
  TABLES,
  airtableRequest,
  applyDelete,
  applySchemaOp,
  checkConnection,
  chunk,
  deleteMode,
  deleteRecords,
  describeMismatch,
  describeOp,
  ensureParentRows,
  errorMessage,
  expandFor,
  expectedType,
  fieldDefinition,
  findRecordIds,
  findRows,
  findTable,
  getAirtableSettings,
  isConfigured,
  isRetryable,
  isSwellPermissionDenied,
  isSynced,
  listTables,
  markDeleted,
  missingColumns,
  oldColumnName,
  pageSize,
  parseEventType,
  planSchema,
  pruneChildren,
  removeRecord,
  sleep,
  syncedCollections,
  syncedTables,
  tableName,
  throttle,
  typeMismatches,
  upsertRecords,
} from "../../functions/lib/airtable";
import { PRODUCT, SETTINGS, airtableFetch, fetchCall, fullTable, jsonResponse, settingsMock, table } from "../helpers/fixtures";

const ID = "6ac38528c0fbb00012ac7cf0";
const ID2 = "6ac38528c0fbb00012ac7cf1";
const ALL = { ...SETTINGS, collections: ["orders", "order_items", "accounts", "products", "variants", "subscriptions", "coupons", "categories"] };

beforeEach(() => {
  throttle.ms = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("settings helpers", () => {
  it("getAirtableSettings reads the airtable group", async () => {
    const swell = { settings: settingsMock() } as unknown as SwellAPI;
    expect(await getAirtableSettings(swell)).toEqual(SETTINGS);
    const empty = { settings: vi.fn().mockResolvedValue(null) } as unknown as SwellAPI;
    expect(await getAirtableSettings(empty)).toEqual({});
  });

  it("isConfigured needs a token and a base ID starting with app", () => {
    expect(isConfigured(SETTINGS as any)).toBe(true);
    expect(isConfigured({ ...SETTINGS, access_token: " " } as any)).toBe(false);
    expect(isConfigured({ ...SETTINGS, base_id: "tblX" } as any)).toBe(false);
    expect(isConfigured({})).toBe(false);
  });

  it("syncedTables defaults to orders, customers, products and needs parents for child tables", () => {
    expect(syncedTables({})).toEqual(["orders", "accounts", "products"]);
    expect(syncedTables({ collections: ["products", "nope"] })).toEqual(["products"]);
    expect(syncedTables({ collections: ["order_items", "variants", "products"] })).toEqual(["products", "variants"]);
    expect(syncedTables(ALL as any)).toHaveLength(8);
    expect(syncedCollections).toBe(syncedTables);
  });

  it("isSynced checks one table", () => {
    expect(isSynced(ALL as any, "variants")).toBe(true);
    expect(isSynced(SETTINGS as any, "variants")).toBe(false);
  });

  it("pageSize defaults to 50 and caps at 100", () => {
    expect(pageSize({})).toBe(50);
    expect(pageSize({ backfill_page_size: 0 })).toBe(50);
    expect(pageSize({ backfill_page_size: 7.9 })).toBe(7);
    expect(pageSize({ backfill_page_size: 500 })).toBe(100);
  });

  it("tableName uses the setting or the default", () => {
    expect(tableName({}, "accounts")).toBe("Customers");
    expect(tableName({}, "order_items")).toBe("Order line items");
    expect(tableName({ orders_table: " tblABC " }, "orders")).toBe("tblABC");
  });

  it("deleteMode defaults to delete", () => {
    expect(deleteMode({})).toBe("delete");
    expect(deleteMode({ on_delete: "mark" })).toBe("mark");
    expect(deleteMode({ on_delete: "keep" })).toBe("keep");
    expect(deleteMode({ on_delete: "x" as any })).toBe("delete");
  });

  it("expandFor adds item links to orders only when line items are synced", () => {
    expect(expandFor(SETTINGS as any, "orders")).toEqual(["account"]);
    expect(expandFor(ALL as any, "orders")).toEqual(["account", "items.product", "items.variant"]);
    expect(expandFor(ALL as any, "products")).toBeUndefined();
    expect(expandFor(ALL as any, "categories")).toEqual(["parent"]);
  });

  it("parseEventType maps event roots to tables", () => {
    expect(parseEventType("order.updated")).toEqual({ collection: "orders", action: "updated" });
    expect(parseEventType("product.variant.deleted")).toEqual({ collection: "variants", action: "deleted" });
    expect(parseEventType("category.created")).toEqual({ collection: "categories", action: "created" });
    expect(parseEventType("invoice.created")).toBeNull();
    expect(parseEventType("order")).toBeNull();
    expect(parseEventType(undefined)).toBeNull();
  });
});

describe("schema helpers", () => {
  it("fieldDefinition adds the options Airtable requires", () => {
    expect(fieldDefinition({ name: "N", type: "number", value: () => 0 })).toEqual({ name: "N", type: "number", options: { precision: 2 } });
    expect(fieldDefinition({ name: "C", type: "number", precision: 0, value: () => 0 }).options).toEqual({ precision: 0 });
    expect(fieldDefinition({ name: "B", type: "checkbox", value: () => 0 }).options).toEqual({ icon: "check", color: "greenBright" });
    expect(fieldDefinition({ name: "D", type: "dateTime", value: () => 0 }).options).toMatchObject({ timeZone: "utc" });
    expect(fieldDefinition({ name: "E", type: "email", value: () => 0 })).toEqual({ name: "E", type: "email" });
    expect(fieldDefinition({ name: "L", type: "link", value: () => 0 }, "tblP")).toEqual({
      name: "L", type: "multipleRecordLinks", options: { linkedTableId: "tblP" },
    });
  });

  it("expectedType names the Airtable type", () => {
    expect(expectedType({ name: "L", type: "link", value: () => 0 })).toBe("multipleRecordLinks");
    expect(expectedType({ name: "N", type: "number", value: () => 0 })).toBe("number");
  });

  it("every column type has compatible Airtable types including itself", () => {
    for (const config of Object.values(TABLES)) {
      for (const column of config.columns) {
        expect(COMPATIBLE_TYPES[column.type]).toContain(expectedType(column));
      }
    }
  });

  it("chunk splits into batches", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 10)).toEqual([]);
  });

  it("sleep resolves", async () => {
    await expect(sleep(0)).resolves.toBeUndefined();
    await expect(sleep(1)).resolves.toBeUndefined();
  });
});

describe("airtableRequest", () => {
  it("sends the bearer token and JSON body", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ ok: 1 }));
    expect(await airtableRequest(SETTINGS as any, "POST", "/x", { a: 1 })).toEqual({ ok: 1 });
    const call = fetchCall(fetchMock);
    expect(call.url).toBe("https://api.airtable.com/v0/x");
    expect(call.method).toBe("POST");
    expect(call.headers.authorization).toBe("Bearer patTEST.secret");
    expect(call.headers["content-type"]).toBe("application/json");
    expect(call.body).toEqual({ a: 1 });
  });

  it("throws when not configured", async () => {
    await expect(airtableRequest({}, "GET", "/x")).rejects.toMatchObject({ status: 400 });
  });

  it("turns Airtable errors into AirtableError with a hint", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse({ error: { type: "UNKNOWN_FIELD_NAME", message: 'Unknown field name: "Paid"' } }, 422),
    );
    const err = await airtableRequest(SETTINGS as any, "GET", "/x").catch((e) => e);
    expect(err).toBeInstanceOf(AirtableError);
    expect(err.status).toBe(422);
    expect(err.type).toBe("UNKNOWN_FIELD_NAME");
    expect(err.message).toContain('Unknown field name: "Paid"');
    expect(err.message).toContain("Create tables & columns");
  });

  it("handles string errors and non-JSON bodies", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ error: "NOT_FOUND" }, 404))
      .mockResolvedValueOnce(new Response("bad gateway", { status: 502 }))
      .mockResolvedValueOnce(jsonResponse({ error: { type: "AUTHENTICATION_REQUIRED" } }, 401))
      .mockResolvedValueOnce(jsonResponse({ errors: [] }, 429));
    await expect(airtableRequest(SETTINGS as any, "GET", "/x")).rejects.toThrow(/404: NOT_FOUND\. Check the base ID/);
    await expect(airtableRequest(SETTINGS as any, "GET", "/x")).rejects.toThrow("Airtable 502: bad gateway");
    await expect(airtableRequest(SETTINGS as any, "GET", "/x")).rejects.toThrow(/personal access token/);
    await expect(airtableRequest(SETTINGS as any, "GET", "/x")).rejects.toThrow(/rate limit/);
  });
});

describe("records", () => {
  it("upsertRecords merges on Swell ID in batches of 10 and returns record ids", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(airtableFetch());
    const rows = Array.from({ length: 23 }, (_, i) => ({ "Swell ID": `s${i}` }));
    const ids = await upsertRecords(SETTINGS as any, "Orders", rows);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(Object.keys(ids)).toHaveLength(23);
    expect(ids.s0).toBe("recs0");
    const first = fetchCall(fetchMock);
    expect(first.url).toBe("https://api.airtable.com/v0/appTEST1234567890/Orders");
    expect(first.method).toBe("PATCH");
    expect(first.body.performUpsert).toEqual({ fieldsToMergeOn: ["Swell ID"] });
    expect(first.body.typecast).toBe(true);
    expect(first.body.records).toHaveLength(10);
    expect(fetchCall(fetchMock, 2).body.records).toHaveLength(3);
  });

  it("upsertRecords sends each Swell ID once per call, keeping the last row", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(airtableFetch());
    await upsertRecords(SETTINGS as any, "Orders", [{ "Swell ID": "a", n: 1 }, { "Swell ID": "b" }, { "Swell ID": "a", n: 2 }, { other: 1 }, { other: 2 }]);
    const sent = fetchCall(fetchMock).body.records.map((r: any) => r.fields);
    expect(sent).toEqual([{ "Swell ID": "a", n: 2 }, { "Swell ID": "b" }, { other: 1 }, { other: 2 }]);
  });

  it("upsertRecords encodes table names and tolerates empty responses", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({}));
    expect(await upsertRecords(SETTINGS as any, "My Orders", [{}])).toEqual({});
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.airtable.com/v0/appTEST1234567890/My%20Orders");
  });

  it("findRows filters by one value or an OR of values and follows pages", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ records: [{ id: "rec1", fields: { "Swell ID": ID } }], offset: "next" }))
      .mockResolvedValueOnce(jsonResponse({ records: [{ id: "rec2", fields: { "Swell ID": ID2 } }] }));
    const rows = await findRows(SETTINGS as any, "Order line items", "Order Swell ID", [ID, ID2]);
    expect(rows).toEqual([{ id: "rec1", swellId: ID }, { id: "rec2", swellId: ID2 }]);
    const first = fetchCall(fetchMock);
    expect(first.url).toContain(`filterByFormula=OR({Order Swell ID}='${ID}',{Order Swell ID}='${ID2}')`);
    expect(first.url).toContain("fields[]=Swell ID&fields[]=Order Swell ID");
    expect(fetchCall(fetchMock, 1).url).toContain("offset=next");
  });

  it("findRows returns nothing for no values and rejects non-object ids", async () => {
    expect(await findRows(SETTINGS as any, "Orders", "Swell ID", [])).toEqual([]);
    await expect(findRows(SETTINGS as any, "Orders", "Swell ID", ["x' OR 1"])).rejects.toThrow(/Invalid Swell ID/);
  });

  it("findRecordIds filters by Swell ID", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ records: [{ id: "rec1", fields: {} }] }));
    expect(await findRecordIds(SETTINGS as any, "Orders", ID)).toEqual(["rec1"]);
    expect(fetchCall(fetchMock).url).toContain(`filterByFormula={Swell ID}='${ID}'`);
  });

  it("deleteRecords deletes in batches", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => jsonResponse({}));
    const ids = Array.from({ length: 12 }, (_, i) => `rec${i}`);
    expect(await deleteRecords(SETTINGS as any, "Orders", ids)).toBe(12);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchCall(fetchMock).method).toBe("DELETE");
    expect(fetchCall(fetchMock).url).toContain("records[]=rec0&records[]=rec1");
  });

  it("markDeleted checks the Deleted column", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({}));
    await markDeleted(SETTINGS as any, "Orders", ["rec1"]);
    expect(fetchCall(fetchMock).body).toEqual({ records: [{ id: "rec1", fields: { Deleted: true } }] });
  });

  it("applyDelete follows the delete setting", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => jsonResponse({}));
    expect(await applyDelete(SETTINGS as any, "Orders", ["rec1"])).toBe(1);
    expect(fetchCall(fetchMock).method).toBe("DELETE");
    expect(await applyDelete({ ...SETTINGS, on_delete: "mark" } as any, "Orders", ["rec1"])).toBe(1);
    expect(fetchCall(fetchMock, 1).method).toBe("PATCH");
    expect(await applyDelete({ ...SETTINGS, on_delete: "keep" } as any, "Orders", ["rec1"])).toBe(0);
    expect(await applyDelete(SETTINGS as any, "Orders", [])).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("removeRecord removes the row and its child rows", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(
      airtableFetch({ find: (url) => (url.includes("Order Swell ID") ? [{ id: "recItem", swellId: "i1" }] : [{ id: "recOrder", swellId: ID }]) }),
    );
    expect(await removeRecord(ALL as any, "orders", ID)).toBe(2);
    const calls = fetchMock.mock.calls.map((_, n) => fetchCall(fetchMock, n));
    expect(calls.map((c) => c.method)).toEqual(["GET", "DELETE", "GET", "DELETE"]);
    expect(calls[3].url).toContain("/Order line items?records[]=recItem");
  });

  it("removeRecord skips unsynced children and keep mode", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(airtableFetch({ find: () => [{ id: "rec1", swellId: ID }] }));
    expect(await removeRecord(SETTINGS as any, "products", ID)).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    fetchMock.mockClear();
    expect(await removeRecord({ ...SETTINGS, on_delete: "keep" } as any, "products", ID)).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("pruneChildren removes rows no longer on the parent", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(
      airtableFetch({ find: () => [{ id: "recA", swellId: "a" }, { id: "recB", swellId: "b" }] }),
    );
    expect(await pruneChildren(SETTINGS as any, "order_items", ID, ["a"])).toBe(1);
    expect(fetchCall(fetchMock, 1).url).toContain("records[]=recB");
    expect(fetchCall(fetchMock, 1).url).not.toContain("recA");
  });

  it("ensureParentRows finds parents and upserts the missing ones from Swell", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(airtableFetch({ find: () => [{ id: "recFound", swellId: ID }] }));
    const get = vi.fn().mockResolvedValue({ results: [PRODUCT] });
    const ids = await ensureParentRows(SETTINGS as any, { get } as any, "products", [ID, PRODUCT.id, PRODUCT.id, ""]);
    expect(ids).toEqual({ [ID]: "recFound", [PRODUCT.id]: `rec${PRODUCT.id}` });
    expect(get).toHaveBeenCalledWith("/products", { where: { id: { $in: [PRODUCT.id] } }, limit: 1 });
    expect(fetchCall(fetchMock, 1).body.records[0].fields.Name).toBe("Simple");
  });

  it("ensureParentRows does not call Swell when every parent exists", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(airtableFetch({ find: () => [{ id: "rec1", swellId: ID }] }));
    const get = vi.fn();
    expect(await ensureParentRows(SETTINGS as any, { get } as any, "orders", [ID])).toEqual({ [ID]: "rec1" });
    expect(get).not.toHaveBeenCalled();
  });
});

describe("schema", () => {
  const orders = () => fullTable("tblO", "Orders", "orders");
  const items = (parent = "tblO") => fullTable("tblI", "Order line items", "order_items", parent);

  it("listTables reads the Meta API", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ tables: [table("tbl1", "Orders", [])] }));
    expect(await listTables(SETTINGS as any)).toHaveLength(1);
    expect(fetchCall(fetchMock).url).toBe("https://api.airtable.com/v0/meta/bases/appTEST1234567890/tables");
  });

  it("findTable matches by id or exact name", () => {
    const tables = [table("tbl1", "Orders", [])];
    expect(findTable(tables, "tbl1")?.name).toBe("Orders");
    expect(findTable(tables, "Orders")?.id).toBe("tbl1");
    expect(findTable(tables, "orders")).toBeUndefined();
  });

  it("missingColumns ignores case", () => {
    const t = orders();
    t.fields = t.fields.filter((f) => f.name !== "Paid").map((f) => ({ ...f, name: f.name.toLowerCase() }));
    expect(missingColumns("orders", t).map((c) => c.name)).toEqual(["Paid"]);
  });

  it("typeMismatches finds wrong types and links to the wrong table", () => {
    const t = orders();
    t.fields.find((f) => f.name === "Total")!.type = "singleLineText";
    t.fields.find((f) => f.name === "Status")!.type = "singleSelect";
    expect(typeMismatches("orders", t, [t], SETTINGS as any)).toEqual([
      { table: "Orders", tableId: "tblO", fieldId: expect.any(String), column: "Total", actual: "singleLineText", expected: "number" },
    ]);
    const wrongLink = items("tblOther");
    const mismatches = typeMismatches("order_items", wrongLink, [orders(), wrongLink], ALL as any);
    expect(mismatches).toEqual([expect.objectContaining({ column: "Order", expected: "link to Orders" })]);
    expect(typeMismatches("order_items", items(), [orders(), items()], ALL as any)).toEqual([]);
  });

  it("describeMismatch reads well", () => {
    expect(describeMismatch({ table: "Orders", tableId: "t", column: "Total", actual: "singleLineText", expected: "number" })).toBe(
      'Column "Orders.Total" is singleLineText, expected number',
    );
  });

  it("oldColumnName finds a free name", () => {
    expect(oldColumnName(table("t", "T", ["Total"]), "Total")).toBe("Total (old)");
    expect(oldColumnName(table("t", "T", ["Total", "Total (old)", "total (old 2)"]), "Total")).toBe("Total (old 3)");
  });

  it("planSchema creates missing tables first and defers link columns", () => {
    const plan = planSchema(ALL as any, []);
    const tables = plan.ops.filter((op) => op.kind === "table");
    expect(tables).toHaveLength(8);
    expect(tables.slice(-2).map((op: any) => op.collection)).toEqual(["order_items", "variants"]);
    expect((tables.find((op: any) => op.collection === "order_items") as any).fields.map((f: any) => f.name)).not.toContain("Order");
    expect(plan.deferred).toBe(2);
  });

  it("planSchema adds link columns once the parent table exists", () => {
    const itemsTable = items();
    itemsTable.fields = itemsTable.fields.filter((f) => f.name !== "Order");
    const plan = planSchema({ ...SETTINGS, collections: ["orders", "order_items"] } as any, [orders(), itemsTable]);
    expect(plan.ops).toEqual([
      expect.objectContaining({ kind: "field", tableId: "tblI", field: { name: "Order", type: "multipleRecordLinks", options: { linkedTableId: "tblO" } } }),
    ]);
    expect(plan.deferred).toBe(0);
  });

  it("planSchema reports mismatches and replaces them only when asked", () => {
    const t = orders();
    const total = t.fields.find((f) => f.name === "Total")!;
    total.type = "singleLineText";
    const settings = { ...SETTINGS, collections: ["orders"] } as any;

    const keep = planSchema(settings, [t]);
    expect(keep.ops).toEqual([]);
    expect(keep.mismatches).toHaveLength(1);

    const replace = planSchema(settings, [t], true);
    expect(replace.ops).toEqual([
      { kind: "rename", collection: "orders", table: "Orders", tableId: "tblO", fieldId: total.id, from: "Total", to: "Total (old)" },
      expect.objectContaining({ kind: "field", field: { name: "Total", type: "number", options: { precision: 2 } } }),
    ]);
  });

  it("planSchema fails for a table ID that does not exist", () => {
    expect(() => planSchema({ ...SETTINGS, orders_table: "tblMissing" } as any, [])).toThrow(/tblMissing was not found/);
  });

  it("applySchemaOp creates tables and fields and renames fields", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => jsonResponse({}));
    await applySchemaOp(SETTINGS as any, { kind: "table", collection: "orders", name: "Orders", fields: [{ name: "Number", type: "singleLineText" }] });
    expect(fetchCall(fetchMock)).toMatchObject({
      method: "POST",
      url: "https://api.airtable.com/v0/meta/bases/appTEST1234567890/tables",
      body: { name: "Orders", fields: [{ name: "Number", type: "singleLineText" }] },
    });
    await applySchemaOp(SETTINGS as any, { kind: "field", collection: "orders", table: "Orders", tableId: "tbl1", field: { name: "Tax", type: "number" } });
    expect(fetchCall(fetchMock, 1)).toMatchObject({ method: "POST", url: expect.stringMatching(/tables\/tbl1\/fields$/), body: { name: "Tax", type: "number" } });
    await applySchemaOp(SETTINGS as any, { kind: "rename", collection: "orders", table: "Orders", tableId: "tbl1", fieldId: "fld1", from: "Tax", to: "Tax (old)" });
    expect(fetchCall(fetchMock, 2)).toMatchObject({ method: "PATCH", url: expect.stringMatching(/tables\/tbl1\/fields\/fld1$/), body: { name: "Tax (old)" } });
  });

  it("describeOp names the change", () => {
    expect(describeOp({ kind: "table", collection: "orders", name: "Orders", fields: [] })).toBe("created table Orders");
    expect(describeOp({ kind: "field", collection: "orders", table: "Orders", tableId: "t", field: { name: "Tax", type: "number" } })).toBe("created column Orders.Tax");
    expect(describeOp({ kind: "rename", collection: "orders", table: "Orders", tableId: "t", fieldId: "f", from: "Tax", to: "Tax (old)" })).toBe('renamed Orders.Tax to "Tax (old)"');
  });
});

describe("checkConnection", () => {
  const tables = () => [fullTable("t1", "Orders", "orders"), fullTable("t2", "Customers", "accounts"), fullTable("t3", "Products", "products")];

  it("passes when every table and column exists with the right type", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(airtableFetch({ tables: tables() }));
    expect(await checkConnection(SETTINGS as any)).toMatch(/Connected\. Tables Orders, Customers, Products have every column with the right type/);
  });

  it("lists missing tables, columns and wrong types", async () => {
    const t = tables();
    t[0].fields = t[0].fields.filter((f) => f.name !== "Swell ID");
    t[0].fields.find((f) => f.name === "Paid")!.type = "singleLineText";
    vi.spyOn(globalThis, "fetch").mockImplementation(airtableFetch({ tables: [t[0]] }));
    const err = await checkConnection({ ...SETTINGS, collections: ["orders", "coupons"] } as any).catch((e) => e);
    expect(err.message).toContain('Table "Orders" is missing columns: Swell ID');
    expect(err.message).toContain('Column "Orders.Paid" is singleLineText, expected checkbox');
    expect(err.message).toContain('Table "Coupons" not found');
    expect(err.status).toBe(422);
  });

  it("falls back to reading records without schema scopes", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ error: { type: "INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND" } }, 403))
      .mockResolvedValue(jsonResponse({ records: [] }));
    expect(await checkConnection({ ...SETTINGS, collections: ["orders"] } as any)).toMatch(/Columns were not checked/);
    expect(fetchCall(fetchMock, 1).url).toBe("https://api.airtable.com/v0/appTEST1234567890/Orders?maxRecords=1");
  });

  it("rethrows other errors and requires collections", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ error: { type: "AUTHENTICATION_REQUIRED" } }, 401));
    await expect(checkConnection(SETTINGS as any)).rejects.toMatchObject({ status: 401 });
    await expect(checkConnection({ ...SETTINGS, collections: [] } as any)).rejects.toThrow(/No collections/);
  });
});

describe("errors", () => {
  it("isRetryable retries 5xx, 408, 429 and network errors only", () => {
    expect(isRetryable(new AirtableError("x", 500))).toBe(true);
    expect(isRetryable(new AirtableError("x", 429))).toBe(true);
    expect(isRetryable(new AirtableError("x", 408))).toBe(true);
    expect(isRetryable(new AirtableError("x", 422))).toBe(false);
    expect(isRetryable(new AirtableError("x", 401))).toBe(false);
    expect(isRetryable(new TypeError("network"))).toBe(true);
  });

  it("isRetryable treats Swell API errors by their status", () => {
    expect(isRetryable(new SwellError("Not found", { status: 404 }))).toBe(false);
    expect(isRetryable(new SwellError("Busy", { status: 503 }))).toBe(true);
  });

  it("isRetryable retries Swell permission denials, which clear up after a permissions change", () => {
    const denied = new SwellError("GET /coupons\nThe client does not have the required permissions", { status: 403 });
    expect(isSwellPermissionDenied(denied)).toBe(true);
    expect(isRetryable(denied)).toBe(true);
    expect(isSwellPermissionDenied(new AirtableError("does not have the required permissions", 403))).toBe(false);
    expect(isSwellPermissionDenied(new Error("other"))).toBe(false);
  });

  it("errorMessage reads messages", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
    expect(errorMessage("plain")).toBe("plain");
  });
});
