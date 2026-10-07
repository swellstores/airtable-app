import { getAirtableSettings, isConfigured } from './lib/airtable';
import { TIME_BUDGET_MS, latestPull, pullTable, pullTables } from './lib/pull';

export const config: SwellConfig = {
  description: 'Write Airtable edits back to Swell',
  cron: {
    schedule: '* * * * *',
  },
};

export default async function (req: SwellRequest) {
  const { swell } = req;
  const started = Date.now();
  const deadline = started + TIME_BUDGET_MS;

  const settings = await getAirtableSettings(swell);
  const tables = pullTables(settings);
  if (settings.enabled === false || !tables.length || !isConfigured(settings)) {
    return;
  }

  // The first table changes every minute, so one busy table can't starve the others
  const first = Math.floor(started / 60_000) % tables.length;
  const order = [...tables.slice(first), ...tables.slice(0, first)];

  for (const id of order) {
    if (Date.now() >= deadline) {
      break;
    }
    await pullTable(swell, settings, id, await latestPull(swell, id), deadline);
  }
}
