import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import handler, { config } from "../../functions/pull-edits";
import { throttle } from "../../functions/lib/airtable";
import { createMockRequest } from "../helpers/mock-request";
import { PRODUCT, SETTINGS, jsonResponse, settingsMock } from "../helpers/fixtures";

const PULL = { ...SETTINGS, collections: ["accounts", "products"], pull_collections: ["products", "accounts"] };

function setup(settings: Record<string, any> = PULL, states: Record<string, any>[] = []) {
  const get = vi.fn(async (url: string) => (url === "/pulls" ? { results: states } : { results: [PRODUCT] }));
  const put = vi.fn().mockResolvedValue({});
  const post = vi.fn().mockResolvedValue({});
  const req = createMockRequest({ data: {}, swell: { settings: settingsMock(settings), get, put, post } });
  return { req, get, put, post };
}

describe("pull-edits", () => {
  let fetchMock: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    throttle.ms = 0;
    fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => jsonResponse({ records: [] }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("runs every minute", () => {
    expect(config.cron?.schedule).toBe("* * * * *");
  });

  it("does nothing when write-back is off, the app is disabled or not configured", async () => {
    for (const settings of [SETTINGS, { ...PULL, enabled: false }, { ...PULL, access_token: "" }]) {
      const { req, get } = setup(settings);
      await handler(req);
      expect(get).not.toHaveBeenCalled();
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("starts each new table's cursor at the current time without reading Airtable", async () => {
    const { req, post } = setup();
    await handler(req);
    expect(post).toHaveBeenCalledTimes(2);
    expect(post.mock.calls.map((c) => c[1].table)).toEqual(["accounts", "products"]);
    expect(post.mock.calls[0][0]).toBe("/pulls");
    expect(post.mock.calls[0][1]).toMatchObject({ changed: 0, failed: 0 });
    expect(Date.parse(post.mock.calls[0][1].date_cursor)).toBeGreaterThan(Date.now() - 5000);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("pulls each table, least recently checked first, and saves its state", async () => {
    const states = [
      { id: "p1", table: "products", date_cursor: "2026-10-06T10:00:00.000Z", date_last_run: "2026-10-06T10:02:00.000Z" },
      { id: "p2", table: "accounts", date_cursor: "2026-10-06T10:00:00.000Z", date_last_run: "2026-10-06T10:01:00.000Z" },
    ];
    const { req, put } = setup(PULL, states);
    await handler(req);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0][0])).toContain("/Customers?");
    expect(String(fetchMock.mock.calls[1][0])).toContain("/Products?");
    expect(put.mock.calls.map((c) => c[0])).toEqual(["/pulls/p2", "/pulls/p1"]);
    expect(put.mock.calls[0][1]).toMatchObject({ offset: null, date_pass_started: null });
    expect(put.mock.calls[0][1].date_cursor).toBeDefined();
  });
});
