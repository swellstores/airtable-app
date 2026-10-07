import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import handler, { config } from "../../functions/connection-test";
import { throttle } from "../../functions/lib/airtable";
import { createMockRequest } from "../helpers/mock-request";
import { SETTINGS, airtableFetch, fullTable, settingsMock } from "../helpers/fixtures";

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

const request = (settings: Record<string, any> = SETTINGS) => createMockRequest({ data: {} as any, swell: { settings: settingsMock(settings) } });

describe("connection-test", () => {
  it("is an app action", () => {
    expect(config.action).toBe(true);
  });

  it("returns the connection summary", async () => {
    expect((await handler(request())).message).toMatch(/^Connected\. Tables Orders, Customers, Products/);
  });

  it("returns the problems found as an action error", async () => {
    await expect(handler(request({ ...SETTINGS, collections: ["orders", "coupons"] }))).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining("Coupons"),
    });
  });

  it("asks for the token and base ID first", async () => {
    await expect(handler(request({ ...SETTINGS, base_id: "" }))).rejects.toMatchObject({ status: 400 });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
