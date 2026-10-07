import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import handler, { config } from "../../functions/create-tables";
import { TABLES, setupTables, throttle } from "../../functions/lib/airtable";
import { createMockRequest } from "../helpers/mock-request";
import { SETTINGS, airtableFetch, fetchCall, fullTable, settingsMock, table } from "../helpers/fixtures";

let fetchMock: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  throttle.ms = 0;
  fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(
    airtableFetch({ tables: [fullTable("t1", "Orders", "orders"), fullTable("t2", "Customers", "accounts"), fullTable("t3", "Products", "products")] }),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

function request(data: Record<string, any> = {}, settings: Record<string, any> = SETTINGS) {
  return createMockRequest({ data: data as any, swell: { settings: settingsMock(settings) } });
}

describe("create-tables", () => {
  it("is an app action", () => {
    expect(config.action).toBe(true);
  });

  it("asks for the token and base ID first", async () => {
    await expect(handler(request({}, { ...SETTINGS, access_token: "" }))).rejects.toMatchObject({ status: 400 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports nothing to do when every column exists", async () => {
    expect(await handler(request())).toEqual({ message: "Every table and column already exists with the right type." });
  });

  it("passes the replace option from the dialog", async () => {
    const orders = fullTable("t1", "Orders", "orders");
    orders.fields.find((f) => f.name === "Total")!.type = "singleLineText";
    let renamed = false;
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PATCH") renamed = true;
      const t = renamed ? fullTable("t1", "Orders", "orders") : orders;
      return airtableFetch({ tables: [t] })(input, init);
    });
    const result = await handler(request({ replace_columns: true }, { ...SETTINGS, collections: ["orders"] }));
    expect(result.message).toBe('Renamed Orders.Total to "Total (old)", created column Orders.Total.');
  });

  it("returns Airtable errors as action errors", async () => {
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ error: { type: "INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND" } }), { status: 403 }));
    await expect(handler(request())).rejects.toMatchObject({ status: 400, message: expect.stringContaining("403") });
  });
});

describe("setupTables", () => {
  it("creates missing tables, then their link columns in the next round", async () => {
    let tables: any[] = [];
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "POST" && url.endsWith("/tables")) {
        const body = JSON.parse(String(init.body));
        const id = body.name === "Orders" ? "t1" : "t2";
        const full = fullTable(id, body.name, id === "t1" ? "orders" : "order_items", "t1");
        if (id === "t2") full.fields = full.fields.filter((f) => f.name !== "Order");
        tables.push(full);
      }
      if (init?.method === "POST" && url.includes("/fields")) {
        tables = [fullTable("t1", "Orders", "orders"), fullTable("t2", "Order line items", "order_items", "t1")];
      }
      return airtableFetch({ tables })(input, init);
    });
    const result = await setupTables({ ...SETTINGS, collections: ["orders", "order_items"] } as any, false, Infinity);
    expect(result).toEqual({
      done: true,
      message: "Created table Orders, created table Order line items, created column Order line items.Order.",
    });
  });

  it("stops at the deadline and says to run it again", async () => {
    fetchMock.mockImplementation(airtableFetch({ tables: [table("t3", "Products", ["Name"])] }));
    let t = 0;
    const result = await setupTables({ ...SETTINGS, collections: ["products"] } as any, false, 2.5, () => t++);
    expect(result.done).toBe(false);
    expect(result.message).toMatch(/^Created column Products\.Swell ID, created column Products\.SKU, created column Products\.Slug\.\nNot finished yet/);
    expect(TABLES.products.columns.length).toBeGreaterThan(3);
  });

  it("reports wrong column types unless asked to replace them", async () => {
    const orders = fullTable("t1", "Orders", "orders");
    orders.fields.find((f) => f.name === "Total")!.type = "singleLineText";
    fetchMock.mockImplementation(airtableFetch({ tables: [orders] }));
    const result = await setupTables({ ...SETTINGS, collections: ["orders"] } as any, false, Infinity);
    expect(result.done).toBe(true);
    expect(result.message).toContain('Not changed: Column "Orders.Total" is singleLineText, expected number');
    expect(result.message).toContain('"Replace columns with the wrong type" turned on');
    expect(fetchCall(fetchMock).method).toBe("GET");
  });

  it("keeps what was done in the error message", async () => {
    let calls = 0;
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST" && ++calls === 2) {
        return new Response(JSON.stringify({ error: { type: "INVALID_REQUEST_UNKNOWN", message: "bad" } }), { status: 422 });
      }
      return airtableFetch({ tables: [table("t3", "Products", ["Name"])] })(input, init);
    });
    const err = await setupTables({ ...SETTINGS, collections: ["products"] } as any, false, Infinity).catch((e) => e);
    expect(err.message).toMatch(/^Created column Products\.Swell ID\.\nThen failed: /);
  });
});
