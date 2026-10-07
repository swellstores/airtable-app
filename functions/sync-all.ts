import { ACTIVE_STATUSES, TABLES, getAirtableSettings, isConfigured, syncedTables } from './lib/airtable';

export const config: SwellConfig = {
  description: 'Start backfills for every synced collection',
  action: true,
};

export default async function (req: SwellRequest) {
  const { swell, data } = req;
  const settings = await getAirtableSettings(swell);

  if (!isConfigured(settings)) {
    throw new SwellError('Set the Airtable access token and base ID in the app settings first', { status: 400 });
  }

  const collections = syncedTables(settings);
  if (!collections.length) {
    throw new SwellError('No collections are selected in the app settings', { status: 400 });
  }

  const active: any = await swell.get('/syncs', {
    where: { type: 'backfill', status: { $in: ACTIVE_STATUSES } },
    fields: 'collection',
    limit: 100,
  });
  const busy = new Set((active?.results || []).map((job: any) => job.collection));

  const started: string[] = [];
  const skipped: string[] = [];
  for (const collection of collections) {
    if (busy.has(collection)) {
      skipped.push(TABLES[collection].label);
      continue;
    }
    await swell.post('/syncs', {
      type: 'backfill',
      collection,
      status: 'pending',
      ...(data.date_from ? { date_from: data.date_from } : {}),
    });
    started.push(TABLES[collection].label);
  }

  const parts = [];
  if (started.length) {
    parts.push(`Started backfills for ${started.join(', ')}.`);
  }
  if (skipped.length) {
    parts.push(`Already running: ${skipped.join(', ')}.`);
  }
  return { message: parts.join(' ') };
}
