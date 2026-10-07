import { describe, it, expect, vi } from "vitest";
import handler, { config } from "../../functions/sync-retry";
import { createMockRequest } from "../helpers/mock-request";

function setup(job: Record<string, any> | null) {
  const get = vi.fn().mockResolvedValue(job);
  const put = vi.fn().mockResolvedValue({});
  const req = createMockRequest({
    data: { id: "job_1", $event: { type: "sync.updated", data: {} } } as any,
    swell: { get, put },
  });
  return { req, get, put };
}

describe("sync-retry", () => {
  it("is scheduled at date_retry for waiting jobs", () => {
    expect(config.model?.schedule).toEqual({ formula: "date_retry" });
    expect(config.model?.conditions).toEqual({ status: "waiting", date_retry: { $exists: true } });
  });

  it("sets a waiting job back to pending", async () => {
    const { req, get, put } = setup({ id: "job_1", status: "waiting" });
    await handler(req);
    expect(get).toHaveBeenCalledWith("/syncs/job_1");
    expect(put).toHaveBeenCalledWith("/syncs/job_1", { status: "pending" });
  });

  it("leaves jobs that were canceled, resumed or deleted", async () => {
    for (const job of [{ id: "job_1", status: "canceled" }, { id: "job_1", status: "running" }, null]) {
      const { req, put } = setup(job);
      await handler(req);
      expect(put).not.toHaveBeenCalled();
    }
  });
});
