import { describe, it, expect, vi } from "vitest";
import handler, { config } from "../../functions/sync-control";
import { createMockRequest } from "../helpers/mock-request";

const ID = "6ac38528c0fbb00012ac7cf0";

function setup(actionId: string, job: Record<string, any> | null, recordId: string | null = ID) {
  const get = vi.fn().mockResolvedValue(job);
  const put = vi.fn().mockResolvedValue({});
  const req = createMockRequest({
    data: { $action: { id: actionId, source: "record", record_id: recordId ?? undefined } } as any,
    swell: { get, put },
  });
  return { req, get, put };
}

describe("sync-control", () => {
  it("is an action", () => {
    expect(config.action).toBe(true);
  });

  it("cancels an active or waiting job", async () => {
    const { req, put } = setup("cancel", { id: ID, status: "waiting" });
    expect(await handler(req)).toEqual({ message: "Sync job canceled." });
    expect(put).toHaveBeenCalledWith(`/syncs/${ID}`, { status: "canceled", date_completed: expect.any(String) });
  });

  it("does not cancel a finished job", async () => {
    const { req, put } = setup("cancel", { id: ID, status: "completed" });
    expect(await handler(req)).toEqual({ message: "This sync job is already completed." });
    expect(put).not.toHaveBeenCalled();
  });

  it("resumes failed, canceled and waiting jobs", async () => {
    for (const status of ["failed", "canceled", "waiting"]) {
      const { req, put } = setup("resume", { id: ID, status });
      expect(await handler(req)).toEqual({ message: "Sync job resumed." });
      expect(put).toHaveBeenCalledWith(`/syncs/${ID}`, { status: "pending", last_error: null, date_completed: null, retries: 0, date_retry: null });
    }
  });

  it("does not resume an active job", async () => {
    const { req, put } = setup("resume", { id: ID, status: "running" });
    expect((await handler(req)).message).toMatch(/Only failed, canceled or waiting/);
    expect(put).not.toHaveBeenCalled();
  });

  it("validates the record id, record and action", async () => {
    await expect(handler(setup("cancel", null, "../settings").req)).rejects.toMatchObject({ status: 400 });
    await expect(handler(setup("cancel", null, null).req)).rejects.toMatchObject({ status: 400 });
    await expect(handler(setup("cancel", null).req)).rejects.toMatchObject({ status: 404 });
    await expect(handler(setup("delete", { id: ID, status: "failed" }).req)).rejects.toThrow(/Unknown action/);
  });
});
