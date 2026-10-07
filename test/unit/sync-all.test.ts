import { describe, it, expect, vi } from "vitest";
import handler, { config } from "../../functions/sync-all";
import { createMockRequest } from "../helpers/mock-request";
import { SETTINGS, settingsMock } from "../helpers/fixtures";

function setup({ settings = SETTINGS as Record<string, any>, active = [] as any[], data = {} as Record<string, any> } = {}) {
  const get = vi.fn().mockResolvedValue({ results: active });
  const post = vi.fn().mockResolvedValue({});
  const req = createMockRequest({
    data: { ...data, $action: { id: "sync_all", source: "list" } } as any,
    swell: { settings: settingsMock(settings), get, post },
  });
  return { req, get, post };
}

describe("sync-all", () => {
  it("is an action", () => {
    expect(config.action).toBe(true);
  });

  it("starts a backfill per synced collection", async () => {
    const { req, get, post } = setup({ data: { date_from: "2026-01-01" } });
    const result = await handler(req);
    expect(get).toHaveBeenCalledWith("/syncs", {
      where: { type: "backfill", status: { $in: ["pending", "running", "waiting"] } },
      fields: "collection",
      limit: 100,
    });
    expect(post).toHaveBeenCalledTimes(3);
    expect(post).toHaveBeenCalledWith("/syncs", { type: "backfill", collection: "orders", status: "pending", date_from: "2026-01-01" });
    expect(result).toEqual({ message: "Started backfills for Orders, Customers, Products." });
  });

  it("includes child and extra tables that are selected", async () => {
    const { req, post } = setup({ settings: { ...SETTINGS, collections: ["orders", "order_items", "variants", "coupons"] } });
    const result = await handler(req);
    expect(post.mock.calls.map((c) => c[1].collection)).toEqual(["orders", "order_items", "coupons"]);
    expect(result).toEqual({ message: "Started backfills for Orders, Order line items, Coupons." });
  });

  it("skips collections with an active backfill", async () => {
    const { req, post } = setup({ active: [{ collection: "orders" }] });
    const result = await handler(req);
    expect(post).toHaveBeenCalledTimes(2);
    expect(post.mock.calls[0][1]).toEqual({ type: "backfill", collection: "accounts", status: "pending" });
    expect(result).toEqual({ message: "Started backfills for Customers, Products. Already running: Orders." });
  });

  it("requires settings and collections", async () => {
    await expect(handler(setup({ settings: { ...SETTINGS, access_token: "" } }).req)).rejects.toMatchObject({ status: 400 });
    await expect(handler(setup({ settings: { ...SETTINGS, collections: [] } }).req)).rejects.toThrow(/No collections/);
  });
});
