import { getAirtableSettings, isConfigured } from './lib/airtable';
import { PULL_INTERVAL_MS, TIME_BUDGET_MS, latestPull, pullTable, pullTables } from './lib/pull';

export const config: SwellConfig = {
  description: 'Write Airtable edits back to Swell',
  cron: {
    schedule: '*/5 * * * *',
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

  // The first table changes every run, so one busy table can't starve the others
  const first = Math.floor(started / PULL_INTERVAL_MS) % tables.length;
  const order = [...tables.slice(first), ...tables.slice(0, first)];

  for (const id of order) {
    if (Date.now() >= deadline) {
      break;
    }
    await pullTable(swell, settings, id, await latestPull(swell, id), deadline);
  }
}
