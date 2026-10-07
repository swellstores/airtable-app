import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import handler, { config } from "../../functions/pull-edits";
import { throttle } from "../../functions/lib/airtable";
import { createMockRequest } from "../helpers/mock-request";
import { PRODUCT, SETTINGS, jsonResponse, settingsMock } from "../helpers/fixtures";

const PULL = { ...SETTINGS, collections: ["accounts", "products"], pull_collections: ["products", "accounts"] };

function setup(settings: Record<string, any> = PULL, latest: Record<string, any>[] = []) {
  const get = vi.fn(async (url: string, query?: any) =>
    url === "/pulls" ? { results: latest.filter((r) => r.table === query?.where?.table) } : { results: [PRODUCT] },
  );
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
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("runs every 5 minutes", () => {
    expect(config.cron?.schedule).toBe("*/5 * * * *");
  });

  it("does nothing when write-back is off, the app is disabled or not configured", async () => {
    for (const settings of [SETTINGS, { ...PULL, enabled: false }, { ...PULL, access_token: "" }, { ...PULL, pull_enabled: false }]) {
      const { req, get } = setup(settings);
      await handler(req);
      expect(get).not.toHaveBeenCalled();
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("checks every table and writes nothing when Airtable has no edits", async () => {
    const { req, get, put, post } = setup();
    await handler(req);
    expect(get.mock.calls.filter((c) => c[0] === "/pulls").map((c) => c[1].where.table).sort()).toEqual(["accounts", "products"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(put).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });

  it("continues a table's running check", async () => {
    const running = { id: "p1", table: "products", status: "running", date_cursor: "2026-10-06T10:00:00.000Z", date_pass_started: "2026-10-06T10:00:00.000Z", offset: "itr5" };
    const { req, put } = setup(PULL, [running]);
    await handler(req);
    const products = fetchMock.mock.calls.map((c) => decodeURIComponent(String(c[0]))).find((url) => url.includes("/Products?"));
    expect(products).toContain("offset=itr5");
    expect(put).toHaveBeenCalledWith("/pulls/p1", expect.objectContaining({ status: "completed" }));
  });

  it("starts with a different table each run", async () => {
    const firstTable = async (run: number) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(run * 5 * 60_000);
      fetchMock.mockClear();
      await handler(setup().req);
      vi.useRealTimers();
      return String(fetchMock.mock.calls[0][0]);
    };
    expect(await firstTable(0)).toContain("/Customers?");
    expect(await firstTable(1)).toContain("/Products?");
    expect(await firstTable(2)).toContain("/Customers?");
  });
});
