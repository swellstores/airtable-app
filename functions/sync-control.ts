import { ACTIVE_STATUSES } from './lib/airtable';

export const config: SwellConfig = {
  description: 'Cancel or resume an Airtable backfill',
  action: true,
};

export default async function (req: SwellRequest) {
  const { swell, data } = req;
  const action = data.$action;
  const id = action?.record_id;

  if (!id || !/^[0-9a-f]{24}$/i.test(id)) {
    throw new SwellError('Open a backfill to run this action', { status: 400 });
  }

  const job: Record<string, any> | null = await swell.get(`/syncs/${id}`);
  if (!job) {
    throw new SwellError('Backfill not found', { status: 404 });
  }

  if (action?.id === 'cancel') {
    if (!ACTIVE_STATUSES.includes(job.status)) {
      return { message: `This backfill is already ${job.status}.` };
    }
    await swell.put(`/syncs/${id}`, { status: 'canceled', date_completed: new Date().toISOString() });
    return { message: 'Backfill canceled.' };
  }

  if (action?.id === 'resume') {
    if (!['failed', 'canceled', 'waiting'].includes(job.status)) {
      return { message: `Only failed, canceled or waiting backfills can be resumed. This one is ${job.status}.` };
    }
    // Backfills continue after `last_id`.
    // A waiting job retries right away instead of at date_retry.
    await swell.put(`/syncs/${id}`, { status: 'pending', last_error: null, date_completed: null, retries: 0, date_retry: null });
    return { message: 'Backfill resumed.' };
  }

  throw new SwellError(`Unknown action: ${action?.id}`, { status: 400 });
}
