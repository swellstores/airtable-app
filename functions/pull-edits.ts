import { getAirtableSettings, isConfigured } from './lib/airtable';
import { TIME_BUDGET_MS, pullTable, pullTables, storeLocale, type PullState } from './lib/pull';

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

  const result: any = await swell.get('/pulls', { limit: 50 });
  const states: Record<string, PullState> = {};
  for (const state of result?.results || []) {
    states[state.table] = state;
  }

  // Tables that waited longest go first, so one busy table can't starve the others
  const order = [...tables].sort((a, b) => String(states[a]?.date_last_run || '').localeCompare(String(states[b]?.date_last_run || '')));

  const locale = await storeLocale(swell);

  for (const id of order) {
    const state = states[id];
    if (!state) {
      // First run for this table: only edits made from now on are written back
      const now = new Date().toISOString();
      await swell.post('/pulls', { table: id, date_cursor: now, date_last_run: now, changed: 0, failed: 0 });
      continue;
    }
    if (Date.now() >= deadline) {
      break;
    }
    const save = await pullTable(swell, settings, id, state, deadline, Date.now, locale);
    await swell.put(`/pulls/${state.id}`, save);
  }
}
