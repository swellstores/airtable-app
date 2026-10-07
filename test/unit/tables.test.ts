import { describe, it, expect } from "vitest";
import {
  COLLECTIONS,
  MAX_TEXT,
  TABLES,
  TABLE_IDS,
  bool,
  childTables,
  date,
  formatAddress,
  formatDiscounts,
  formatInterval,
  formatItems,
  fullName,
  itemSku,
  num,
  lineItemKey,
  orderItemRows,
  stripHtml,
  text,
  toFields,
} from "../../functions/lib/tables";
import { ORDER, VARIANT } from "../helpers/fixtures";

const ID = "6ac38528c0fbb00012ac7cf0";

describe("value helpers", () => {
  it("text trims, nulls empties and truncates", () => {
    expect(text("  a ")).toBe("a");
    expect(text("")).toBeNull();
    expect(text(null)).toBeNull();
    expect(text(undefined)).toBeNull();
    expect(text(12)).toBe("12");
    expect(text("x".repeat(MAX_TEXT + 5))).toHaveLength(MAX_TEXT);
  });

  it("num parses numbers and nulls the rest", () => {
    expect(num(1.5)).toBe(1.5);
    expect(num("2")).toBe(2);
    expect(num(0)).toBe(0);
    expect(num(null)).toBeNull();
    expect(num("")).toBeNull();
    expect(num("abc")).toBeNull();
  });

  it("bool is true only for true", () => {
    expect(bool(true)).toBe(true);
    expect(bool("true")).toBe(false);
    expect(bool(undefined)).toBe(false);
  });

  it("date returns ISO strings or null", () => {
    expect(date("2026-10-04T19:13:45.917Z")).toBe("2026-10-04T19:13:45.917Z");
    expect(date("not a date")).toBeNull();
    expect(date(null)).toBeNull();
  });

  it("stripHtml removes tags and decodes entities", () => {
    expect(stripHtml("<p>Fish &amp; chips</p><p>Hot&nbsp;now</p>")).toBe("Fish & chips\nHot now");
    expect(stripHtml("a<br/>b")).toBe("a\nb");
    expect(stripHtml(null)).toBeNull();
    expect(stripHtml(5)).toBe("5");
  });

  it("fullName prefers name, then first and last name", () => {
    expect(fullName({ name: "A B" })).toBe("A B");
    expect(fullName({ first_name: "A", last_name: "B" })).toBe("A B");
    expect(fullName({ first_name: null })).toBeNull();
    expect(fullName(null)).toBeNull();
  });

  it("formatAddress joins the address lines", () => {
    expect(formatAddress(ORDER.shipping)).toBe("Ship To\n1 Main St\nSpringfield IL 62701\nUS");
    expect(formatAddress({ name: null, address1: null })).toBeNull();
    expect(formatAddress(undefined)).toBeNull();
  });

  it("itemSku prefers the variant SKU", () => {
    expect(itemSku({ variant: { sku: "V" }, product: { sku: "P" } })).toBe("V");
    expect(itemSku({ product: { sku: "P" } })).toBe("P");
    expect(itemSku({})).toBeNull();
  });

  it("formatItems writes one line per item", () => {
    expect(formatItems(ORDER.items)).toBe("2 × Shirt - Large (SH-L)");
    expect(formatItems([{ product: { name: "Mug", sku: "MUG" } }])).toBe("1 × Mug (MUG)");
    expect(formatItems([])).toBeNull();
    expect(formatItems(undefined)).toBeNull();
  });

  it("formatInterval describes billing schedules", () => {
    expect(formatInterval({ interval: "weekly", interval_count: 2 })).toBe("every 2 weeks");
    expect(formatInterval({ interval: "monthly", interval_count: 1 })).toBe("monthly");
    expect(formatInterval(null, "yearly")).toBe("yearly");
    expect(formatInterval({ interval: "custom", interval_count: 3 })).toBe("every 3 custom");
    expect(formatInterval(null)).toBeNull();
  });

  it("formatDiscounts summarizes coupon discounts", () => {
    expect(
      formatDiscounts([
        { type: "order", value_type: "percent", value_percent: 10 },
        { type: "shipment", value_type: "fixed", value_fixed: 5 },
      ]),
    ).toBe("10% off order, 5 off shipment");
    expect(formatDiscounts([{ value_type: "fixed" }])).toBe("0 off order");
    expect(formatDiscounts([])).toBeNull();
  });
});

describe("tables", () => {
  it("every table has a Swell ID and Deleted column and a text primary field", () => {
    for (const id of TABLE_IDS) {
      const names = TABLES[id].columns.map((c) => c.name);
      expect(names).toContain("Swell ID");
      expect(names).toContain("Deleted");
      expect(TABLES[id].columns[0].type).toBe("singleLineText");
      expect(new Set(names).size).toBe(names.length);
      expect(TABLES[id].id).toBe(id);
    }
  });

  it("child tables declare their parent, link and parent id columns", () => {
    for (const id of ["order_items", "variants"]) {
      const config = TABLES[id];
      const names = config.columns.map((c) => c.name);
      expect(TABLES[config.parent!]).toBeDefined();
      expect(names).toContain(config.linkColumn);
      expect(names).toContain(config.parentIdColumn);
    }
    expect(childTables("orders")).toEqual(["order_items"]);
    expect(childTables("products")).toEqual(["variants"]);
    expect(childTables("accounts")).toEqual([]);
  });

  it("COLLECTIONS is the same registry", () => {
    expect(COLLECTIONS).toBe(TABLES);
  });

  it("orderItemRows attaches the order and a per-order key to each item with an id", () => {
    const rows = orderItemRows({ ...ORDER, items: [...ORDER.items, { product_name: "No id" }] });
    expect(rows).toHaveLength(1);
    expect(rows[0].order.number).toBe("100491");
    expect(rows[0].line_key).toBe(lineItemKey(ORDER.id, ORDER.items[0].id));
    expect(orderItemRows({ id: ID })).toEqual([]);
  });

  it("gives the same Swell item in two orders different row keys", () => {
    const item = { id: "655cc83f61a850001226b14d", product_name: "Box" };
    const a = orderItemRows({ id: "o1", items: [item] })[0];
    const b = orderItemRows({ id: "o2", items: [item] })[0];
    expect(toFields("order_items", a)["Swell ID"]).toBe("o1-655cc83f61a850001226b14d");
    expect(toFields("order_items", b)["Swell ID"]).toBe("o2-655cc83f61a850001226b14d");
    expect(toFields("order_items", b)["Item Swell ID"]).toBe("655cc83f61a850001226b14d");
  });

  it("lineItemKey joins order and item ids", () => {
    expect(lineItemKey("o", "i")).toBe("o-i");
  });
});

describe("toFields", () => {
  it("maps an order to every order column", () => {
    const fields = toFields("orders", ORDER);
    expect(Object.keys(fields)).toEqual(TABLES.orders.columns.map((c) => c.name));
    expect(fields).toMatchObject({
      Number: "100491",
      "Swell ID": ORDER.id,
      Status: "delivery_pending",
      Paid: true,
      "Customer email": "one@test.com",
      "Customer name": "Bill Payer",
      Items: "2 × Shirt - Large (SH-L)",
      Total: 28.5,
      "Shipping method": "Standard",
      Deleted: false,
    });
  });

  it("maps order line items with the order link", () => {
    const [row] = orderItemRows(ORDER);
    const fields = toFields("order_items", row, { parentRecId: "recOrder" });
    expect(fields).toMatchObject({
      Item: "100491 - Shirt",
      "Swell ID": `${ORDER.id}-6ac4b7228938770012072e38`,
      "Item Swell ID": "6ac4b7228938770012072e38",
      Order: ["recOrder"],
      "Order number": "100491",
      "Order Swell ID": ORDER.id,
      Variant: "Large",
      SKU: "SH-L",
      Quantity: 2,
      Price: 11,
      Total: 22,
      Currency: "USD",
    });
  });

  it("leaves the link out without context and clears it when the parent is missing", () => {
    expect(toFields("variants", VARIANT)).not.toHaveProperty("Product");
    expect(toFields("variants", VARIANT, { parentRecId: null }).Product).toEqual([]);
    expect(toFields("variants", VARIANT, { parentRecId: "recP" })).toMatchObject({
      Name: "green",
      Product: ["recP"],
      "Product Swell ID": VARIANT.parent_id,
      SKU: "SMPG",
      "Stock level": 7,
    });
  });

  it("maps customers, products, subscriptions, coupons and categories", () => {
    expect(toFields("accounts", { id: ID, email: "a@b.co", order_count: 3, email_optin: true })).toMatchObject({
      Email: "a@b.co",
      "Order count": 3,
      "Email opt-in": true,
      Phone: null,
    });
    expect(
      toFields("products", { id: ID, name: "Mug", price: 1, active: true, purchase_options: { standard: { price: 9.5, sale: true, sale_price: 8 } } }),
    ).toMatchObject({
      Name: "Mug",
      Price: 9.5,
      Active: true,
      "On sale": true,
      "Sale price": 8,
    });
    expect(toFields("products", { id: ID, name: "Mug", price: 9.5 })).toMatchObject({ Price: null, "On sale": false, "Sale price": null });
    expect(
      toFields("variants", { ...VARIANT, purchase_options: { standard: { price: 5, sale: true, sale_price: 4 } } }),
    ).toMatchObject({ Price: 5, "On sale": true, "Sale price": 4 });
    expect(
      toFields("subscriptions", {
        id: ID,
        number: "100023",
        status: "unpaid",
        product_name: "Box",
        plan_name: "Weekly",
        billing_schedule: { interval: "weekly", interval_count: 2 },
        recurring_total: 7,
        account: { email: "s@b.co" },
      }),
    ).toMatchObject({ Number: "100023", Status: "unpaid", Product: "Box", Plan: "Weekly", Interval: "every 2 weeks", "Recurring total": 7, "Customer email": "s@b.co" });
    expect(
      toFields("coupons", { id: ID, name: "S10", code: "S10", discounts: [{ type: "shipment", value_type: "fixed", value_fixed: 10 }], use_count: 2 }),
    ).toMatchObject({ Name: "S10", Code: "S10", "Multiple codes": false, Discounts: "10 off shipment", Uses: 2 });
    expect(toFields("coupons", { id: ID, name: "Many", code: "X", multi_codes: true }).Code).toBeNull();
    expect(
      toFields("categories", { id: ID, name: "Shoes", parent_id: "p1", parent: { name: "Clothing" }, description: "<p>Hi</p>" }),
    ).toMatchObject({ Name: "Shoes", Parent: "Clothing", "Parent Swell ID": "p1", Description: "Hi" });
  });
});
