import { vi } from "vitest";
import { TABLES, fieldDefinition } from "../../functions/lib/airtable";

export const SETTINGS = {
  access_token: "patTEST.secret",
  base_id: "appTEST1234567890",
  collections: ["orders", "accounts", "products"],
  orders_table: "Orders",
  accounts_table: "Customers",
  products_table: "Products",
  on_delete: "delete",
  backfill_page_size: 2,
  enabled: true,
};

export const ORDER = {
  id: "6ac38528c0fbb00012ac7cf0",
  number: "100491",
  status: "delivery_pending",
  paid: true,
  delivered: false,
  refunded: false,
  canceled: false,
  currency: "USD",
  sub_total: 22,
  shipment_total: 5,
  tax_total: 1.5,
  discount_total: 0,
  grand_total: 28.5,
  refund_total: 0,
  item_quantity: 2,
  coupon_code: "SAVE",
  date_created: "2026-10-04T19:13:45.917Z",
  date_updated: "2026-10-04T19:13:52.703Z",
  account: { email: "one@test.com", first_name: "One", last_name: "On", name: "One On" },
  billing: { name: "Bill Payer" },
  shipping: {
    name: "Ship To",
    address1: "1 Main St",
    city: "Springfield",
    state: "IL",
    zip: "62701",
    country: "US",
    service_name: "Standard",
  },
  items: [
    { id: "6ac4b7228938770012072e38", product_id: "6ac4b32256c0310012a102eb", product_name: "Shirt", variant_name: "Large", quantity: 2, price: 11, price_total: 22, variant: { sku: "SH-L" } },
  ],
};

export function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function settingsMock(settings: Record<string, any> = SETTINGS) {
  return vi.fn().mockResolvedValue({ airtable: settings });
}

type FetchMock = { mock: { calls: any[][] } };

// URL, method and parsed JSON body of the nth fetch call
export function fetchCall(fetchMock: FetchMock, n = 0) {
  const [url, init] = fetchMock.mock.calls[n] as [string, RequestInit];
  return {
    url: decodeURIComponent(url.replace(/\+/g, " ")),
    method: init?.method,
    headers: init?.headers as Record<string, string>,
    body: init?.body ? JSON.parse(init.body as string) : undefined,
  };
}

export function table(id: string, name: string, fieldNames: string[]) {
  return { id, name, fields: fieldNames.map((n, i) => ({ id: `fld${i}`, name: n, type: "singleLineText" })) };
}

// Airtable table with every column of an app table, typed as the app creates them
export function fullTable(tableId: string, name: string, collection: string, parentTableId = "tblParent") {
  return {
    id: tableId,
    name,
    fields: TABLES[collection].columns.map((c, i) => {
      const def = fieldDefinition(c, parentTableId);
      return { id: `fld${tableId}${i}`, ...def };
    }),
  };
}

// Airtable upsert response for the given rows
export function upsertResponse(rows: { fields: Record<string, any> }[], prefix = "rec") {
  return { records: rows.map((r, i) => ({ id: `${prefix}${r.fields["Swell ID"] ?? i}`, fields: r.fields })) };
}

export const VARIANT = {
  id: "6ac4b32456c0310012a104bf",
  parent_id: "6ac4b32256c0310012a102eb",
  name: "green",
  sku: "SMPG",
  active: true,
  price: 3,
  stock_level: 7,
  currency: "USD",
};

export const PRODUCT = { id: "6ac4b32256c0310012a102eb", name: "Simple", price: 3, active: true };

// fetch implementation that answers like Airtable: upserts echo their records with ids "rec<Swell ID>",
// meta reads return `tables`, formula lookups return what `find(url)` returns
export function airtableFetch(
  opts: { tables?: any[]; find?: (url: string) => { id: string; swellId: string }[] } = {},
) {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = decodeURIComponent(String(input).replace(/\+/g, " "));
    const method = init?.method;
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    if (method === "GET" && url.includes("/meta/bases/")) {
      return jsonResponse({ tables: opts.tables || [] });
    }
    if (method === "PATCH" && body?.performUpsert) {
      return jsonResponse(upsertResponse(body.records));
    }
    if (method === "GET" && url.includes("filterByFormula")) {
      const rows = opts.find?.(url) || [];
      return jsonResponse({ records: rows.map((r) => ({ id: r.id, fields: { "Swell ID": r.swellId } })) });
    }
    return jsonResponse({});
  };
}
