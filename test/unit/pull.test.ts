import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { STOCK, TABLES, editableColumns, throttle } from "../../functions/lib/airtable";
import {
  LOOKBACK_MS,
  OVERLAP_MS,
  checkCursor,
  latestPull,
  applyDiff,
  cellValue,
  diffRow,
  hasChanges,
  isPulled,
  listEditedRows,
  omitUnchangedEditable,
  pullTable,
  pullTables,
} from "../../functions/lib/pull";
import { PRODUCT, SETTINGS, VARIANT, fetchCall, jsonResponse } from "../helpers/fixtures";

const P_ID = PRODUCT.id;
const SWELL_PRODUCT = { ...PRODUCT, sku: "SIM", sale: false, sale_price: null, stock_tracking: true, stock_level: 5 };
const CURSOR = "2026-10-06T10:00:00.000Z";
const PULL_SETTINGS = { ...SETTINGS, pull_collections: ["products"] };

// Airtable fields matching SWELL_PRODUCT (empty cells left out, as Airtable does)
const SAME_ROW = { "Swell ID": P_ID, Name: "Simple", SKU: "SIM", Active: true, Price: 3, "Track stock": true, "Stock level": 5 };

function col(name: string, id = "products") {
  return TABLES[id].columns.find((c) => c.name === name)!;
}

function swellMock(records: Record<string, any>[] = [SWELL_PRODUCT], write: any = {}) {
  return {
    get: vi.fn().mockResolvedValue({ results: records }),
    put: vi.fn().mockResolvedValue(write),
    post: vi.fn().mockResolvedValue(write),
  };
}

// Airtable list responses, one per call
function pages(...responses: any[]) {
  let n = 0;
  return vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    const res = responses[Math.min(n++, responses.length - 1)];
    return res instanceof Response ? res : jsonResponse(res);
  });
}

describe("pull settings", () => {
  it("writes back only selected tables that are synced and editable", () => {
    expect(pullTables(SETTINGS as any)).toEqual([]);
    expect(pullTables({ ...SETTINGS, pull_collections: ["products", "orders", "coupons"] } as any)).toEqual(["products"]);
    expect(pullTables({ ...SETTINGS, collections: ["products", "variants"], pull_collections: ["variants"] } as any)).toEqual(["variants"]);
    expect(isPulled(PULL_SETTINGS as any, "products")).toBe(true);
    expect(isPulled(PULL_SETTINGS as any, "accounts")).toBe(false);
  });
});

describe("cellValue", () => {
  it("reads empty cells as null, or false for checkboxes", () => {
    expect(cellValue(col("Name"), undefined)).toBeNull();
    expect(cellValue(col("Name"), "")).toBeNull();
    expect(cellValue(col("Active"), undefined)).toBe(false);
  });

  it("normalizes text, numbers, checkboxes and dates", () => {
    expect(cellValue(col("Name"), "  Mug ")).toBe("Mug");
    expect(cellValue(col("Price"), 2.5)).toBe(2.5);
    expect(cellValue(col("Price"), "4")).toBe(4);
    expect(cellValue(col("Active"), true)).toBe(true);
    expect(cellValue(col("Expires", "coupons"), "2026-12-31T00:00:00.000Z")).toBe("2026-12-31T00:00:00.000Z");
  });

  it("marks values that don't fit the column as invalid", () => {
    expect(typeof cellValue(col("Price"), "abc")).toBe("symbol");
    expect(typeof cellValue(col("Expires", "coupons"), "soon")).toBe("symbol");
    expect(typeof cellValue(col("Name"), ["a"])).toBe("symbol");
  });
});

describe("diffRow", () => {
  it("finds nothing when Airtable matches Swell", () => {
    const diff = diffRow("products", SWELL_PRODUCT, SAME_ROW);
    expect(diff).toEqual({ update: {}, invalid: [] });
    expect(hasChanges(diff)).toBe(false);
  });

  it("maps changed cells to Swell fields", () => {
    const diff = diffRow("products", SWELL_PRODUCT, { ...SAME_ROW, Name: "Mug", Price: 4.5, Active: undefined, "On sale": true, "Sale price": 4 });
    expect(diff.update).toEqual({
      name: "Mug",
      active: false,
      purchase_options: { standard: { price: 4.5, sale: true, sale_price: 4 } },
    });
    expect(hasChanges(diff)).toBe(true);
  });

  it("reads prices from purchase_options.standard, not the top-level copies", () => {
    const record = { ...SWELL_PRODUCT, price: 99, sale: true, sale_price: 1 };
    expect(diffRow("products", record, SAME_ROW).update).toEqual({});
  });

  it("writes variant price, on sale and sale price to purchase_options.standard", () => {
    const row = { Name: "green", SKU: "SMPG", Active: true, Price: 5, "On sale": true, "Sale price": 4, "Stock level": 7 };
    expect(diffRow("variants", VARIANT, row).update).toEqual({ purchase_options: { standard: { price: 5, sale: true, sale_price: 4 } } });
  });

  it("clears fields emptied in Airtable", () => {
    expect(diffRow("products", SWELL_PRODUCT, { ...SAME_ROW, SKU: undefined }).update).toEqual({ sku: null });
  });

  it("turns a stock level edit into an adjustment for the difference", () => {
    expect(diffRow("products", SWELL_PRODUCT, { ...SAME_ROW, "Stock level": 12 })).toEqual({ update: {}, stock: 7, invalid: [] });
    expect(diffRow("variants", VARIANT, { Name: "green", SKU: "SMPG", Active: true, Price: 3, "Stock level": 2 }).stock).toBe(-5);
  });

  it("ignores an emptied stock level and rejects fractions", () => {
    expect(hasChanges(diffRow("products", SWELL_PRODUCT, { ...SAME_ROW, "Stock level": undefined }))).toBe(false);
    expect(diffRow("products", SWELL_PRODUCT, { ...SAME_ROW, "Stock level": 2.5 }).invalid[0]).toContain("whole number");
  });

  it("reports cells it can't read and still applies the rest", () => {
    const diff = diffRow("products", SWELL_PRODUCT, { ...SAME_ROW, Price: "cheap", Name: "Mug" });
    expect(diff.update).toEqual({ name: "Mug" });
    expect(diff.invalid).toEqual(['Price: "cheap" is not a valid number']);
  });

  it("compares date-only Airtable columns by day", () => {
    const coupon = { id: P_ID, name: "C", active: true, date_expired: "2026-12-31T15:00:00.000Z" };
    expect(diffRow("coupons", coupon, { Name: "C", Active: true, Expires: "2026-12-31" }).update).toEqual({});
    expect(diffRow("coupons", coupon, { Name: "C", Active: true, Expires: "2027-01-02" }).update).toEqual({
      date_expired: "2027-01-02T00:00:00.000Z",
    });
  });
});

describe("applyDiff", () => {
  it("updates the record at its path", async () => {
    const swell = swellMock();
    const update = { purchase_options: { standard: { price: 4 } } };
    await applyDiff(swell as any, "variants", VARIANT, { update, invalid: [] });
    expect(swell.put).toHaveBeenCalledWith(`/products:variants/${VARIANT.id}`, update);
    expect(swell.post).not.toHaveBeenCalled();
  });

  it("adds stock adjustments for products and variants", async () => {
    const swell = swellMock();
    await applyDiff(swell as any, "products", SWELL_PRODUCT, { update: {}, stock: 3, invalid: [] });
    expect(swell.post).toHaveBeenCalledWith("/products:stock", { parent_id: P_ID, quantity: 3 });
    await applyDiff(swell as any, "variants", VARIANT, { update: {}, stock: -2, invalid: [] });
    expect(swell.post).toHaveBeenLastCalledWith("/products:stock", { parent_id: VARIANT.parent_id, variant_id: VARIANT.id, quantity: -2 });
    expect(swell.put).not.toHaveBeenCalled();
  });

  it("throws a non-retryable error when Swell rejects the values", async () => {
    const swell = swellMock([], { errors: { name: { code: "REQUIRED", message: "Required" } } });
    const err = await applyDiff(swell as any, "products", SWELL_PRODUCT, { update: { name: null }, invalid: [] }).catch((e) => e);
    expect(err.message).toBe("Swell rejected the edit - name: Required");
    expect(err.status).toBe(422);
  });
});

describe("listEditedRows", () => {
  afterEach(() => vi.restoreAllMocks());

  it("asks for rows whose editable columns changed after the cursor", async () => {
    const fetchMock = pages({ records: [{ id: "rec1", fields: SAME_ROW }], offset: "itr2" });
    const page = await listEditedRows(PULL_SETTINGS as any, "categories", CURSOR, "itr1");
    expect(page).toEqual({ records: [{ id: "rec1", fields: SAME_ROW }], offset: "itr2" });
    const { url, method } = fetchCall(fetchMock);
    expect(method).toBe("GET");
    expect(url).toContain("/Categories?");
    expect(url).toContain(
      `filterByFormula=AND({Swell ID}!='',NOT({Deleted}),IS_AFTER(LAST_MODIFIED_TIME({Name},{Slug},{Active}),DATETIME_PARSE('${CURSOR}')))`,
    );
    expect(url).toContain("fields[]=Swell ID&fields[]=Name&fields[]=Slug&fields[]=Active");
    expect(url).toContain("offset=itr1");
  });
});

describe("checkCursor", () => {
  const NOW = Date.parse("2026-10-06T10:30:00.000Z");

  it("reads the look-back window without a previous check", () => {
    expect(checkCursor(undefined, NOW)).toBe(new Date(NOW - LOOKBACK_MS).toISOString());
  });

  it("starts at the previous check minus the overlap, however long ago it was", () => {
    expect(checkCursor({ table: "products", date_pass_started: "2026-10-06T10:28:00.000Z" }, NOW)).toBe("2026-10-06T10:27:00.000Z");
    expect(checkCursor({ table: "products", date_pass_started: "2026-10-01T09:00:00.000Z" }, NOW)).toBe("2026-10-01T08:59:00.000Z");
  });

  it("falls back to the creation date of older records", () => {
    expect(checkCursor({ table: "products", date_created: "2026-10-06T10:29:00.000Z" }, NOW)).toBe("2026-10-06T10:28:00.000Z");
  });
});

describe("pullTable", () => {
  beforeEach(() => {
    throttle.ms = 0;
  });
  afterEach(() => vi.restoreAllMocks());

  const START = "2026-10-06T10:05:00.000Z";
  const clock = (start = Date.parse(START)) => () => start;
  const RUNNING = { id: "run_1", table: "products", status: "running" as const, date_cursor: CURSOR, date_pass_started: CURSOR, found: 2, changed: 2, failed: 0 };

  // Swell mock whose POST /pulls creates the check record
  function swellRun(records: Record<string, any>[] = [SWELL_PRODUCT], write: any = {}) {
    const swell = swellMock(records, write);
    swell.post.mockImplementation(async (url: string, body: any) => (url === "/pulls" ? { id: "run_new", ...body } : write));
    return swell;
  }
  const pullsPost = (swell: ReturnType<typeof swellMock>) => swell.post.mock.calls.filter((c) => c[0] === "/pulls");
  const pullsPut = (swell: ReturnType<typeof swellMock>) => swell.put.mock.calls.filter((c) => String(c[0]).startsWith("/pulls/"));

  it("writes nothing when no row differs from Swell", async () => {
    pages({ records: [{ id: "rec1", fields: SAME_ROW }, { id: "rec2", fields: { ...SAME_ROW, "Swell ID": "6ac4b32256c0310012a10000", Name: "X" } }] });
    const swell = swellRun();
    expect(await pullTable(swell as any, PULL_SETTINGS as any, "products", undefined, Infinity, clock())).toBeUndefined();
    expect(swell.post).not.toHaveBeenCalled();
    expect(swell.put).not.toHaveBeenCalled();
  });

  it("creates a check record when edits exist, writes them and completes it with the counts", async () => {
    const fetchMock = pages({
      records: [
        { id: "rec1", fields: { ...SAME_ROW, Price: 9 } },
        { id: "rec2", fields: { ...SAME_ROW, "Swell ID": "not-an-id" } },
      ],
    });
    const swell = swellRun();
    const run = await pullTable(swell as any, PULL_SETTINGS as any, "products", undefined, Infinity, clock());
    expect(fetchCall(fetchMock).url).toContain(`DATETIME_PARSE('${new Date(Date.parse(START) - LOOKBACK_MS).toISOString()}')`);
    expect(pullsPost(swell)).toEqual([
      ["/pulls", { table: "products", status: "running", date_cursor: new Date(Date.parse(START) - LOOKBACK_MS).toISOString(), date_pass_started: START }],
    ]);
    expect(swell.put).toHaveBeenCalledWith(`/products/${P_ID}`, { purchase_options: { standard: { price: 9 } } });
    expect(pullsPut(swell)).toEqual([
      ["/pulls/run_new", { found: 1, changed: 1, failed: 0, status: "completed", offset: null, date_completed: START }],
    ]);
    expect(run).toMatchObject({ id: "run_new", status: "completed", found: 1, changed: 1 });
  });

  it("reads from the previous check's start minus the overlap", async () => {
    const fetchMock = pages({ records: [] });
    const latest = { id: "old", table: "products", status: "completed" as const, date_pass_started: "2026-10-06T10:02:00.000Z" };
    await pullTable(swellRun() as any, PULL_SETTINGS as any, "products", latest, Infinity, clock());
    expect(fetchCall(fetchMock).url).toContain(`DATETIME_PARSE('${new Date(Date.parse("2026-10-06T10:02:00.000Z") - OVERLAP_MS).toISOString()}')`);
  });

  it("follows Airtable pages", async () => {
    const fetchMock = pages({ records: [], offset: "itr2" }, { records: [] });
    await pullTable(swellRun() as any, PULL_SETTINGS as any, "products", undefined, Infinity, clock());
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchCall(fetchMock, 1).url).toContain("offset=itr2");
  });

  it("continues a running check from its cursor and page offset, adding to its counts", async () => {
    const fetchMock = pages({ records: [{ id: "rec1", fields: { ...SAME_ROW, Price: 9 } }] });
    const swell = swellRun();
    await pullTable(swell as any, PULL_SETTINGS as any, "products", { ...RUNNING, offset: "itr1" }, Infinity, clock());
    const { url } = fetchCall(fetchMock);
    expect(url).toContain(`DATETIME_PARSE('${CURSOR}')`);
    expect(url).toContain("offset=itr1");
    expect(pullsPost(swell)).toEqual([]);
    expect(pullsPut(swell)).toEqual([["/pulls/run_1", expect.objectContaining({ found: 3, changed: 3, status: "completed" })]]);
  });

  it("saves nothing when it runs out of time before finding edits", async () => {
    pages({ records: [], offset: "itr2" });
    let t = 0;
    const swell = swellRun();
    await pullTable(swell as any, PULL_SETTINGS as any, "products", undefined, 1500, () => (t += 1000));
    expect(swell.post).not.toHaveBeenCalled();
    expect(swell.put).not.toHaveBeenCalled();
  });

  it("keeps a running check's page offset when it runs out of time", async () => {
    pages({ records: [{ id: "rec1", fields: { ...SAME_ROW, Price: 9 } }], offset: "itr2" });
    let t = 0;
    const swell = swellRun();
    await pullTable(swell as any, PULL_SETTINGS as any, "products", { ...RUNNING, offset: "itr1" }, 1500, () => (t += 1000));
    expect(swell.put.mock.calls).toEqual([["/pulls/run_1", { found: 2, changed: 2, failed: 0, offset: "itr1" }]]);
  });

  it("records rejected edits and continues", async () => {
    pages({ records: [{ id: "rec1", fields: { ...SAME_ROW, Name: undefined } }] });
    const swell = swellRun([SWELL_PRODUCT], { errors: { name: { message: "Required" } } });
    const run = await pullTable(swell as any, PULL_SETTINGS as any, "products", undefined, Infinity, clock());
    expect(run).toMatchObject({
      found: 1,
      changed: 0,
      failed: 1,
      status: "completed",
      last_error: `Products ${P_ID}: Swell rejected the edit - name: Required`,
    });
  });

  it("counts unreadable cells as found and failed", async () => {
    pages({ records: [{ id: "rec1", fields: { ...SAME_ROW, Price: "x" } }] });
    const run = await pullTable(swellRun() as any, PULL_SETTINGS as any, "products", undefined, Infinity, clock());
    expect(run).toMatchObject({ found: 1, changed: 0, failed: 1, last_error: `Products ${P_ID}: Price: "x" is not a valid number` });
  });

  it("keeps the check running on retryable errors", async () => {
    pages({ records: [{ id: "rec1", fields: { ...SAME_ROW, Price: 9 } }] });
    const swell = swellRun();
    swell.put.mockImplementation(async (url: string) => {
      if (url.startsWith("/pulls/")) return {};
      throw Object.assign(new Error("The client does not have the required permissions"), { status: 403 });
    });
    const run = await pullTable(swell as any, PULL_SETTINGS as any, "products", undefined, Infinity, clock());
    expect(run).toMatchObject({ status: "running", found: 1, changed: 0, offset: null });
    expect(run?.last_error).toContain("required permissions");
  });

  it("only logs Airtable errors when no edits were found", async () => {
    pages(jsonResponse({ error: { type: "UNKNOWN_FIELD_NAME", message: 'Unknown field name: "Sale price"' } }, 422));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const swell = swellRun();
    expect(await pullTable(swell as any, PULL_SETTINGS as any, "products", undefined, Infinity, clock())).toBeUndefined();
    expect(swell.post).not.toHaveBeenCalled();
    expect(error.mock.calls[0][0]).toContain("UNKNOWN_FIELD_NAME");
  });

  it("starts a running check over from its first page when Airtable's page offset expired", async () => {
    pages(jsonResponse({ error: { type: "LIST_RECORDS_ITERATOR_NOT_AVAILABLE" } }, 422));
    const swell = swellRun();
    const run = await pullTable(swell as any, PULL_SETTINGS as any, "products", { ...RUNNING, offset: "old" }, Infinity, clock());
    expect(run).toMatchObject({ status: "running", offset: null });
  });
});

describe("latestPull", () => {
  it("reads the table's newest check", async () => {
    const get = vi.fn().mockResolvedValue({ results: [{ id: "p1", table: "products" }] });
    expect(await latestPull({ get } as any, "products")).toEqual({ id: "p1", table: "products" });
    expect(get).toHaveBeenCalledWith("/pulls", { where: { table: "products" }, sort: "date_created desc", limit: 1 });
  });
});

describe("omitUnchangedEditable", () => {
  const fields = { Name: "Simple", "Swell ID": P_ID, SKU: "SIM", Price: 3, "Stock level": 5, Slug: null };

  it("keeps every column without a change list", () => {
    expect(omitUnchangedEditable("products", fields)).toBe(fields);
  });

  it("drops editable columns whose Swell field didn't change, but keeps stock level", () => {
    expect(omitUnchangedEditable("products", fields, ["price", "date_updated"])).toEqual({ "Swell ID": P_ID, Price: 3, "Stock level": 5, Slug: null });
  });

  it("treats a purchase_options change as a price change", () => {
    expect(omitUnchangedEditable("products", fields, ["purchase_options"])).toEqual({ "Swell ID": P_ID, Price: 3, "Stock level": 5, Slug: null });
  });
});

describe("editable columns", () => {
  it("each editable table has editable columns and stock writes only for products and variants", () => {
    for (const id of ["products", "variants", "accounts", "coupons", "categories"]) {
      expect(editableColumns(id).length).toBeGreaterThan(0);
    }
    expect(editableColumns("orders")).toEqual([]);
    const stock = Object.keys(TABLES).filter((id) => editableColumns(id).some((c) => c.writeTo === STOCK));
    expect(stock).toEqual(["products", "variants"]);
  });
});
