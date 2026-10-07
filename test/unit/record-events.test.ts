import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import handler, { config, syncRecord } from "../../functions/record-events";
import { throttle } from "../../functions/lib/airtable";
import { createMockRequest } from "../helpers/mock-request";
import { ORDER, PRODUCT, SETTINGS, VARIANT, airtableFetch, fetchCall, jsonResponse, settingsMock } from "../helpers/fixtures";

const ID = ORDER.id;
const ALL = { ...SETTINGS, collections: ["orders", "order_items", "accounts", "products", "variants", "subscriptions", "coupons", "categories"] };

function setup({
  type = "order.updated",
  data = { id: ID } as Record<string, any>,
  eventData = {} as Record<string, any>,
  record = ORDER as Record<string, any> | null,
  settings = SETTINGS as Record<string, any>,
} = {}) {
  const get = vi.fn(async (url: string) => (url.startsWith("/products/") || url === "/products" ? { results: [PRODUCT], ...PRODUCT } : record));
  const req = createMockRequest({
    data: { ...data, $event: { id: "evt_1", type, data: eventData } } as any,
    swell: { settings: settingsMock(settings), get },
  });
  return { req, get };
}

function calls(fetchMock: { mock: { calls: any[][] } }) {
  return fetchMock.mock.calls.map((_, n) => fetchCall(fetchMock, n));
}

describe("record-events", () => {
  let fetchMock: ReturnType<typeof vi.spyOn>;
  let errorLog: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    throttle.ms = 0;
    errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(airtableFetch());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("subscribes to created/updated/deleted of every synced model", () => {
    expect(config.model?.events).toHaveLength(21);
    expect(config.model?.events).toContain("product.variant.updated");
    expect(config.model?.events).toContain("category.deleted");
  });

  it("re-reads the full order with its account and upserts it", async () => {
    const { req, get } = setup();
    await handler(req);
    expect(get).toHaveBeenCalledWith(`/orders/${ID}`, { expand: ["account"] });
    const [call] = calls(fetchMock);
    expect(call.method).toBe("PATCH");
    expect(call.url).toBe("https://api.airtable.com/v0/appTEST1234567890/Orders");
    expect(call.body.records[0].fields).toMatchObject({ Number: "100491", "Swell ID": ID, "Customer email": "one@test.com" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("syncs line items of a created order with the order link", async () => {
    const { req, get } = setup({ type: "order.created", settings: ALL });
    await handler(req);
    expect(get).toHaveBeenCalledWith(`/orders/${ID}`, { expand: ["account", "items.product", "items.variant"] });
    const [order, items] = calls(fetchMock);
    expect(order.url).toMatch(/\/Orders$/);
    expect(items.url).toMatch(/\/Order line items$/);
    expect(items.body.records[0].fields).toMatchObject({ Order: [`rec${ID}`], "Order Swell ID": ID, Item: "100491 - Shirt" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("re-syncs and prunes line items when an order's items changed", async () => {
    fetchMock.mockImplementation(
      airtableFetch({ find: () => [{ id: "recKeep", swellId: `${ID}-${ORDER.items[0].id}` }, { id: "recGone", swellId: `${ID}-6ac4b7228938770012072e99` }] }),
    );
    const { req } = setup({ eventData: { items: [] }, settings: ALL });
    await handler(req);
    const all = calls(fetchMock);
    expect(all.map((c) => c.method)).toEqual(["PATCH", "PATCH", "GET", "DELETE"]);
    expect(all[3].url).toContain("records[]=recGone");
    expect(all[3].url).not.toContain("recKeep");
  });

  it("skips line items when other order fields changed", async () => {
    const { req } = setup({ eventData: { status: "complete" }, settings: ALL });
    await handler(req);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("links a variant to its product row, creating the product row if missing", async () => {
    const { req, get } = setup({ type: "product.variant.updated", data: { id: VARIANT.id }, record: VARIANT, settings: ALL });
    await handler(req);
    expect(get).toHaveBeenCalledWith(`/products:variants/${VARIANT.id}`, undefined);
    const all = calls(fetchMock);
    expect(all.map((c) => c.method)).toEqual(["GET", "PATCH", "PATCH"]);
    expect(all[1].url).toMatch(/\/Products$/);
    expect(all[2].url).toMatch(/\/Product variants$/);
    expect(all[2].body.records[0].fields).toMatchObject({ Name: "green", Product: [`rec${PRODUCT.id}`] });
  });

  it("upserts subscriptions, coupons and categories into their tables", async () => {
    for (const [type, url] of [["subscription.created", "Subscriptions"], ["coupon.updated", "Coupons"], ["category.created", "Categories"]]) {
      fetchMock.mockClear();
      const { req } = setup({ type, record: { id: ID, name: "x" }, settings: ALL });
      await handler(req);
      expect(fetchCall(fetchMock).url).toBe(`https://api.airtable.com/v0/appTEST1234567890/${url}`);
    }
  });

  it("removes the row and child rows on delete using the id from $event.data", async () => {
    fetchMock.mockImplementation(airtableFetch({ find: () => [{ id: "rec1", swellId: ID }] }));
    const { req, get } = setup({ type: "order.deleted", data: {}, eventData: { id: ID }, settings: ALL });
    await handler(req);
    expect(get).not.toHaveBeenCalled();
    expect(calls(fetchMock).map((c) => c.method)).toEqual(["GET", "DELETE", "GET", "DELETE"]);
  });

  it("skips a record that no longer exists", async () => {
    const { req } = setup({ record: null });
    await handler(req);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("skips unknown events, disabled app, unsynced tables and missing settings", async () => {
    for (const options of [
      { type: "invoice.created" },
      { type: "order.paid" },
      { type: "product.variant.updated" },
      { settings: { ...SETTINGS, enabled: false } },
      { settings: { ...SETTINGS, collections: ["products"] } },
      { settings: { ...SETTINGS, access_token: "" } },
      { data: {} },
    ]) {
      const { req, get } = setup(options);
      await handler(req);
      expect(get).not.toHaveBeenCalled();
    }
    expect(fetchMock).not.toHaveBeenCalled();
    expect(errorLog).toHaveBeenCalledWith("Airtable: access token or base ID is not set");
  });

  it("throws a retryable SwellError on rate limits", async () => {
    fetchMock.mockImplementation(async () => jsonResponse({ errors: [] }, 429));
    const { req } = setup();
    await expect(handler(req)).rejects.toMatchObject({ status: 502, retry: true });
  });

  it("throws a non-retryable SwellError on bad columns", async () => {
    fetchMock.mockImplementation(async () => jsonResponse({ error: { type: "UNKNOWN_FIELD_NAME", message: "Unknown field" } }, 422));
    const { req } = setup();
    const err = await handler(req).catch((e) => e);
    expect(err).toBeInstanceOf(SwellError);
    expect(err.retry).toBe(false);
    expect(err.message).toContain("UNKNOWN_FIELD_NAME");
  });

  it("with write-back on, sends only editable columns whose Swell field changed", async () => {
    const product = { ...PRODUCT, sku: "S1", stock_level: 4 };
    const { req } = setup({
      type: "product.updated",
      data: { id: PRODUCT.id },
      eventData: { price: 3 },
      record: product,
      settings: { ...SETTINGS, pull_collections: ["products"] },
    });
    req.swell.get = vi.fn().mockResolvedValue(product);
    await handler(req);
    const fields = fetchCall(fetchMock).body.records[0].fields;
    expect(fields).toMatchObject({ Price: 3, "Stock level": 4, "Swell ID": PRODUCT.id, Slug: null });
    expect(fields).not.toHaveProperty("Name");
    expect(fields).not.toHaveProperty("SKU");
  });

  it("sends every column when write-back is off", async () => {
    const { req } = setup({ type: "product.updated", data: { id: PRODUCT.id }, eventData: { price: 3 }, record: PRODUCT });
    req.swell.get = vi.fn().mockResolvedValue(PRODUCT);
    await handler(req);
    expect(fetchCall(fetchMock).body.records[0].fields).toMatchObject({ Name: "Simple", Price: 3 });
  });
});

describe("syncRecord", () => {
  beforeEach(() => {
    throttle.ms = 0;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("upserts only the record by default", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(airtableFetch());
    await syncRecord({ get: vi.fn() } as any, { ...SETTINGS, collections: ["orders", "order_items"] } as any, "orders", ORDER);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("clears the link when the parent can't be found in Swell", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(airtableFetch());
    const get = vi.fn().mockResolvedValue({ results: [] });
    await syncRecord({ get } as any, { ...SETTINGS, collections: ["products", "variants"] } as any, "variants", VARIANT);
    expect(fetchCall(fetchMock, 1).body.records[0].fields.Product).toEqual([]);
  });
});
