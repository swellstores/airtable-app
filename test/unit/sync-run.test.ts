import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import handler, { MAX_RETRIES, retryDelaySeconds, runBackfill, shouldRun } from "../../functions/sync-run";
import { AirtableError, TABLES, throttle } from "../../functions/lib/airtable";
import { createMockRequest } from "../helpers/mock-request";
import { ORDER, PRODUCT, SETTINGS, VARIANT, airtableFetch, fetchCall, fullTable, jsonResponse, settingsMock, table } from "../helpers/fixtures";

const JOB = { id: "job_1", collection: "orders", status: "pending", pages: 0, sent: 0 };

const fullTables = () => [fullTable("t1", "Orders", "orders"), fullTable("t2", "Customers", "accounts"), fullTable("t3", "Products", "products")];

function setup({
  job = JOB as Record<string, any> | null,
  current = undefined as Record<string, any> | null | undefined,
  page = { count: 3, results: [{ ...ORDER, id: "a1" }, { ...ORDER, id: "a2" }] } as any,
  settings = SETTINGS as Record<string, any>,
  event = { type: "sync.created", data: {} } as Record<string, any>,
} = {}) {
  let jobReads = 0;
  const get = vi.fn(async (url: string) => {
    if (url === "/syncs/job_1") {
      jobReads++;
      return jobReads === 1 ? job : current === undefined ? job : current;
    }
    return page;
  });
  const put = vi.fn().mockResolvedValue({});
  const req = createMockRequest({
    data: { id: "job_1", $event: event } as any,
    swell: { settings: settingsMock(settings), get, put },
  });
  return { req, get, put };
}

let fetchMock: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  throttle.ms = 0;
  vi.spyOn(console, "error").mockImplementation(() => {});
  fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(airtableFetch({ tables: fullTables() }));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("shouldRun", () => {
  it("runs on create", () => {
    expect(shouldRun({ $event: { type: "sync.created", data: {} } } as any)).toBe(true);
  });

  it("runs when a step was recorded or the job was set to pending", () => {
    expect(shouldRun({ $event: { type: "sync.updated", data: { pages: 2 } } } as any)).toBe(true);
    expect(shouldRun({ $event: { type: "sync.updated", data: { status: "pending" } } } as any)).toBe(true);
  });

  it("does not run for other edits", () => {
    expect(shouldRun({ $event: { type: "sync.updated", data: { status: "waiting" } } } as any)).toBe(false);
    expect(shouldRun({} as any)).toBe(false);
  });
});

describe("retryDelaySeconds", () => {
  it("waits a minute after rate limits and backs off otherwise", () => {
    expect(retryDelaySeconds(new AirtableError("x", 429), 5)).toBe(60);
    expect(retryDelaySeconds(new AirtableError("x", 503), 1)).toBe(60);
    expect(retryDelaySeconds(new AirtableError("x", 503), 3)).toBe(240);
    expect(retryDelaySeconds(new TypeError("network"), 10)).toBe(1800);
    expect(retryDelaySeconds(new TypeError("network"), 0)).toBe(60);
  });
});

describe("runBackfill", () => {
  it("upserts a page and reports progress", async () => {
    const get = vi.fn().mockResolvedValue({ count: 3, results: [{ ...ORDER, id: "a1" }, { ...ORDER, id: "a2" }] });
    const update = await runBackfill({ get } as any, SETTINGS as any, JOB);
    expect(get).toHaveBeenCalledWith("/orders", { where: {}, sort: "id asc", limit: 2, expand: ["account"] });
    expect(fetchCall(fetchMock).body.records).toHaveLength(2);
    expect(update).toEqual({ status: "running", last_id: "a2", pages: 1, sent: 2, total: 3, last_error: null });
  });

  it("continues after last_id with date_from and completes on a short page", async () => {
    const get = vi.fn().mockResolvedValue({ count: 1, results: [{ id: "a3", email: "x@y.co" }] });
    const job = { ...JOB, collection: "accounts", last_id: "a2", date_from: "2026-01-01", pages: 1, sent: 2, total: 3 };
    const update = await runBackfill({ get } as any, SETTINGS as any, job);
    expect(get).toHaveBeenCalledWith("/accounts", { where: { id: { $gt: "a2" }, date_created: { $gte: "2026-01-01" } }, sort: "id asc", limit: 2 });
    expect(update).toEqual({ status: "completed", last_id: "a3", pages: 2, sent: 3, last_error: null });
  });

  it("completes without calling Airtable on an empty page", async () => {
    const get = vi.fn().mockResolvedValue({ count: 0, results: [] });
    const update = await runBackfill({ get } as any, SETTINGS as any, JOB);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(update).toMatchObject({ status: "completed", sent: 0, total: 0 });
  });

  it("sends order line items of whole orders up to the page size, linked to their orders", async () => {
    const order = (id: string, n: number) => ({ ...ORDER, id, items: Array.from({ length: n }, (_, i) => ({ id: `${id.slice(0, 22)}${i}${i}`, product_name: "P" })) });
    const ids = ["6ac38528c0fbb00012ac7c01", "6ac38528c0fbb00012ac7c02", "6ac38528c0fbb00012ac7c03"];
    const get = vi.fn().mockResolvedValue({ count: 3, results: [order(ids[0], 1), order(ids[1], 1), order(ids[2], 1)] });
    fetchMock.mockImplementation(airtableFetch({ find: () => ids.map((id) => ({ id: `recO${id}`, swellId: id })) }));
    const settings = { ...SETTINGS, collections: ["orders", "order_items"], backfill_page_size: 3 };
    const update = await runBackfill({ get } as any, settings as any, { ...JOB, collection: "order_items" });

    expect(get).toHaveBeenCalledWith("/orders", { where: {}, sort: "id asc", limit: 3, expand: ["items.product", "items.variant"] });
    const upsert = fetchCall(fetchMock, 1);
    expect(upsert.url).toMatch(/\/Order line items$/);
    expect(upsert.body.records).toHaveLength(3);
    expect(upsert.body.records[0].fields.Order).toEqual([`recO${ids[0]}`]);
    // A full page of orders: not done yet, and no total for line items
    expect(update).toEqual({ status: "running", last_id: ids[2], pages: 1, sent: 3, last_error: null });
  });

  it("backfills the same Swell item from different orders as separate rows", async () => {
    const shared = { id: "655cc83f61a850001226b14d", product_name: "Box" };
    const ids = ["6ac38528c0fbb00012ac7c01", "6ac38528c0fbb00012ac7c02"];
    const get = vi.fn().mockResolvedValue({ count: 2, results: ids.map((id) => ({ ...ORDER, id, items: [shared] })) });
    fetchMock.mockImplementation(airtableFetch({ find: () => ids.map((id) => ({ id: `recO${id}`, swellId: id })) }));
    await runBackfill({ get } as any, { ...SETTINGS, backfill_page_size: 10 } as any, { ...JOB, collection: "order_items" });
    const keys = fetchCall(fetchMock, 1).body.records.map((r: any) => r.fields["Swell ID"]);
    expect(keys).toEqual(ids.map((id) => `${id}-${shared.id}`));
  });

  it("stops line items at an order boundary when the page is full", async () => {
    const big = { ...ORDER, id: "6ac38528c0fbb00012ac7c01", items: [{ id: "i1" }, { id: "i2" }] };
    const next = { ...ORDER, id: "6ac38528c0fbb00012ac7c02", items: [{ id: "i3" }] };
    const get = vi.fn().mockResolvedValue({ count: 2, results: [big, next] });
    const update = await runBackfill({ get } as any, { ...SETTINGS, backfill_page_size: 2 } as any, { ...JOB, collection: "order_items" });
    expect(update).toMatchObject({ status: "running", last_id: big.id, sent: 2 });
  });

  it("sends variants linked to their products", async () => {
    const get = vi.fn(async (url: string) => (url === "/products:variants" ? { count: 1, results: [VARIANT] } : { results: [PRODUCT] }));
    const update = await runBackfill({ get } as any, SETTINGS as any, { ...JOB, collection: "variants" });
    const variantsUpsert = fetchCall(fetchMock, 2);
    expect(variantsUpsert.url).toMatch(/\/Product variants$/);
    expect(variantsUpsert.body.records[0].fields.Product).toEqual([`rec${PRODUCT.id}`]);
    expect(update).toMatchObject({ status: "completed", sent: 1, total: 1 });
  });

  it("rejects unknown collections", async () => {
    await expect(runBackfill({ get: vi.fn() } as any, SETTINGS as any, { ...JOB, collection: "nope" })).rejects.toThrow(/Unknown collection/);
  });
});

describe("sync-run handler", () => {
  it("runs a backfill step and saves progress", async () => {
    const { req, put } = setup();
    await handler(req);
    expect(put).toHaveBeenCalledWith("/syncs/job_1", expect.objectContaining({ status: "running", last_id: "a2", pages: 1, sent: 2, total: 3 }));
    expect(put.mock.calls[0][1].date_started).toBeTypeOf("string");
  });

  it("sets completion date on the last page and clears retries", async () => {
    const { req, put } = setup({ job: { ...JOB, retries: 2 }, page: { count: 1, results: [{ id: "a1" }] } });
    await handler(req);
    expect(put.mock.calls[0][1]).toMatchObject({ status: "completed", retries: 0, date_retry: null, date_completed: expect.any(String) });
  });

  it("keeps a cancel made during the step", async () => {
    const { req, put } = setup({ current: { ...JOB, status: "canceled" } });
    await handler(req);
    expect(put.mock.calls[0][1].status).toBeUndefined();
    expect(put.mock.calls[0][1].sent).toBe(2);
  });

  it("waits and schedules a retry after a rate limit", async () => {
    fetchMock.mockImplementation(async () => jsonResponse({ errors: [] }, 429));
    const { req, put } = setup({ job: { ...JOB, retries: 1 } });
    const before = Date.now();
    await handler(req);
    const update = put.mock.calls[0][1];
    expect(update).toMatchObject({ status: "waiting", retries: 2 });
    expect(new Date(update.date_retry).getTime()).toBeGreaterThanOrEqual(before + 59000);
    expect(update.last_error).toMatch(/Airtable 429.*Retry 2 of 8 at/);
  });

  it("does not schedule a retry over a cancel", async () => {
    fetchMock.mockImplementation(async () => jsonResponse({ errors: [] }, 503));
    const { req, put } = setup({ current: { ...JOB, status: "canceled" } });
    await handler(req);
    expect(put).not.toHaveBeenCalled();
  });

  it("fails after the last retry", async () => {
    fetchMock.mockImplementation(async () => jsonResponse({ errors: [] }, 429));
    const { req, put } = setup({ job: { ...JOB, retries: MAX_RETRIES } });
    await handler(req);
    expect(put.mock.calls[0][1]).toMatchObject({ status: "failed", last_error: expect.stringContaining(`Gave up after ${MAX_RETRIES} retries`) });
  });

  it("fails right away on errors retrying won't fix", async () => {
    fetchMock.mockImplementation(async () => jsonResponse({ error: { type: "INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND" } }, 403));
    const { req, put } = setup();
    await handler(req);
    expect(put).toHaveBeenCalledWith("/syncs/job_1", expect.objectContaining({ status: "failed", last_error: expect.stringContaining("Airtable 403") }));
  });

  it("waits and retries when Swell denies access to a collection", async () => {
    const { req, put, get } = setup();
    get.mockImplementation(async (url: string) => {
      if (url === "/syncs/job_1") return JOB;
      throw new SwellError("The client does not have the required permissions", { status: 403 });
    });
    await handler(req);
    expect(put.mock.calls[0][1]).toMatchObject({ status: "waiting", retries: 1, last_error: expect.stringContaining("required permissions") });
  });

  it("fails when the app is off or not configured", async () => {
    const off = setup({ settings: { ...SETTINGS, enabled: false } });
    await handler(off.req);
    expect(off.put.mock.calls[0][1]).toMatchObject({ status: "failed", last_error: "The Airtable app is turned off in settings" });

    const missing = setup({ settings: { ...SETTINGS, base_id: "" } });
    await handler(missing.req);
    expect(missing.put.mock.calls[0][1].last_error).toMatch(/access token or base ID is not set/);
  });

  it("ignores irrelevant updates, waiting and finished jobs", async () => {
    const edit = setup({ event: { type: "sync.updated", data: { message: "x" } } });
    await handler(edit.req);
    expect(edit.get).not.toHaveBeenCalled();

    for (const status of ["completed", "waiting"]) {
      const done = setup({ job: { ...JOB, status } });
      await handler(done.req);
      expect(done.put).not.toHaveBeenCalled();
    }

    const gone = setup({ job: null });
    await handler(gone.req);
    expect(gone.put).not.toHaveBeenCalled();
  });
});
