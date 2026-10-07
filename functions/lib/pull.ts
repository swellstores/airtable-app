// Airtable → Swell: reads rows whose editable columns changed in Airtable and writes the edits to Swell.
// Rows are compared with the current Swell record, so the app's own upserts (which leave both sides
// equal) never cause writes, and only cells that really differ are sent.

import {
  AirtableError,
  DELETED_FIELD,
  EDITABLE_TABLES,
  MERGE_FIELD,
  STOCK,
  TABLES,
  airtableRequest,
  date,
  editableColumns,
  errorMessage,
  isRetryable,
  isSynced,
  num,
  sleep,
  sourceField,
  tableName,
  tablePath,
  text,
  throttle,
  type AirtableSettings,
  type Column,
} from './airtable';

// pull-edits runs every 5 minutes (its cron schedule)
export const PULL_INTERVAL_MS = 5 * 60_000;
// Stop starting new work after this long, well within the function's time limit
export const TIME_BUDGET_MS = 7000;
// A table's first check reads rows edited in this window; later checks read from the previous check with edits
export const LOOKBACK_MS = 10 * 60_000;
// Rows edited this long before the previous check started are read again, covering clock skew
export const OVERLAP_MS = 60_000;
export const PULL_PAGE_SIZE = 100;

// A record of `apps/airtable/pulls`: one check of a table that found edits
export interface PullRun {
  id?: string;
  table: string;
  status?: 'running' | 'completed';
  found?: number;
  changed?: number;
  failed?: number;
  date_cursor?: string | null;
  date_pass_started?: string | null;
  offset?: string | null;
  date_created?: string;
  [key: string]: any;
}

export interface RowDiff {
  // Swell field values to PUT
  update: Record<string, any>;
  // Stock adjustment quantity (new level minus current level)
  stock?: number;
  // "<column>: <reason>" for cells that can't be written
  invalid: string[];
}

export class SwellWriteError extends Error {
  status = 422;
}

const INVALID = Symbol('invalid');

// Tables whose Airtable edits are written back: "Get updates from Airtable" on, chosen in settings, synced,
// and with editable columns
export function pullTables(settings: AirtableSettings): string[] {
  if (settings.pull_enabled === false) {
    return [];
  }
  const selected: string[] = Array.isArray(settings.pull_collections) ? settings.pull_collections : [];
  return EDITABLE_TABLES.filter((id) => selected.includes(id) && isSynced(settings, id));
}

export function isPulled(settings: AirtableSettings, id: string): boolean {
  return pullTables(settings).includes(id);
}

// Airtable cell → the value the column would hold for a Swell record. Airtable leaves empty cells out.
export function cellValue(column: Column, cell: unknown): any {
  if (cell === undefined || cell === null || cell === '') {
    return column.type === 'checkbox' ? false : null;
  }
  switch (column.type) {
    case 'checkbox':
      return cell === true;
    case 'number':
      return num(cell) ?? INVALID;
    case 'dateTime':
      return typeof cell === 'string' ? (date(cell) ?? INVALID) : INVALID;
    default:
      return typeof cell === 'string' || typeof cell === 'number' ? text(cell) : INVALID;
  }
}

function sameValue(column: Column, cell: unknown, airtable: any, swell: any): boolean {
  if (airtable === null || swell === null || swell === undefined) {
    return airtable === (swell ?? null);
  }
  if (column.type === 'number') {
    return Math.abs(airtable - swell) < 1e-6;
  }
  // Date-only Airtable columns hold just the day; compare at that precision
  if (column.type === 'dateTime' && typeof cell === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(cell)) {
    return String(swell).slice(0, 10) === cell;
  }
  return airtable === swell;
}

// Edits in an Airtable row's fields compared with the Swell record
export function diffRow(id: string, record: Record<string, any>, fields: Record<string, any>): RowDiff {
  const diff: RowDiff = { update: {}, invalid: [] };
  for (const column of editableColumns(id)) {
    const cell = fields[column.name];
    const value = cellValue(column, cell);
    if (value === INVALID) {
      diff.invalid.push(`${column.name}: "${String(cell)}" is not a valid ${column.type === 'number' ? 'number' : column.type === 'dateTime' ? 'date' : 'value'}`);
      continue;
    }
    const current = column.value(record, {});
    if (sameValue(column, cell, value, current)) {
      continue;
    }
    if (column.writeTo === STOCK) {
      if (value === null) {
        continue; // an empty stock cell isn't a stock level
      }
      if (!Number.isInteger(value)) {
        diff.invalid.push(`${column.name}: "${String(cell)}" is not a whole number`);
        continue;
      }
      diff.stock = value - (num(record.stock_level) ?? 0);
      continue;
    }
    setPath(diff.update, column.writeTo!, value);
  }
  return diff;
}

// Sets `a.b.c` in a nested update; Swell merges nested objects on PUT, so siblings are kept
function setPath(target: Record<string, any>, path: string, value: any) {
  const keys = path.split('.');
  let node = target;
  for (const key of keys.slice(0, -1)) {
    node = node[key] ??= {};
  }
  node[keys[keys.length - 1]] = value;
}

export function hasChanges(diff: RowDiff): boolean {
  return Object.keys(diff.update).length > 0 || Boolean(diff.stock);
}

// Swell writes report validation problems as `{ errors: { field: { message } } }` instead of throwing
function assertWritten(result: any) {
  const errors = result?.errors;
  if (errors && typeof errors === 'object' && Object.keys(errors).length) {
    const details = Object.entries(errors).map(([field, e]: [string, any]) => `${field}: ${e?.message || e?.code || 'invalid'}`);
    throw new SwellWriteError(`Swell rejected the edit - ${details.join(', ')}`);
  }
}

// Writes the edits. Names go to the base value, which is the store's default locale.
export async function applyDiff(
  swell: SwellAPI,
  id: string,
  record: Record<string, any>,
  diff: RowDiff,
): Promise<void> {
  if (Object.keys(diff.update).length) {
    const path = `${TABLES[id].path}/${record.id}`;
    assertWritten(await swell.put(path, diff.update));
  }
  if (diff.stock) {
    const isVariant = Boolean(TABLES[id].parent);
    assertWritten(
      await swell.post('/products:stock', {
        parent_id: isVariant ? record.parent_id : record.id,
        ...(isVariant ? { variant_id: record.id } : {}),
        quantity: diff.stock,
      }),
    );
  }
}

// One page of rows whose editable columns changed after `cursor`
export async function listEditedRows(
  settings: AirtableSettings,
  id: string,
  cursor: string,
  offset?: string,
): Promise<{ records: { id: string; fields: Record<string, any> }[]; offset?: string }> {
  const columns = editableColumns(id);
  const watched = columns.map((c) => `{${c.name}}`).join(',');
  const query = new URLSearchParams();
  query.set(
    'filterByFormula',
    `AND({${MERGE_FIELD}}!='',NOT({${DELETED_FIELD}}),IS_AFTER(LAST_MODIFIED_TIME(${watched}),DATETIME_PARSE('${cursor}')))`,
  );
  query.append('fields[]', MERGE_FIELD);
  columns.forEach((c) => query.append('fields[]', c.name));
  query.set('pageSize', String(PULL_PAGE_SIZE));
  if (offset) {
    query.set('offset', offset);
  }
  const result = await airtableRequest(settings, 'GET', `${tablePath(settings, tableName(settings, id))}?${query}`);
  return { records: result?.records || [], offset: result?.offset };
}

async function readSwellRecords(swell: SwellAPI, id: string, ids: string[]): Promise<Record<string, Record<string, any>>> {
  if (!ids.length) {
    return {};
  }
  const result: any = await swell.get(TABLES[id].path, { where: { id: { $in: ids } }, limit: ids.length });
  const byId: Record<string, Record<string, any>> = {};
  for (const record of result?.results || []) {
    byId[record.id] = record;
  }
  return byId;
}

const iso = (ms: number) => new Date(ms).toISOString();

// The table's latest check with edits, if any
export async function latestPull(swell: SwellAPI, id: string): Promise<PullRun | undefined> {
  const result: any = await swell.get('/pulls', { where: { table: id }, sort: 'date_created desc', limit: 1 });
  return result?.results?.[0];
}

// Where a new check starts reading: the start of the previous check with edits, or the look-back window without one
export function checkCursor(latest: PullRun | undefined, nowMs: number): string {
  const previous = Date.parse(latest?.date_pass_started || latest?.date_created || '');
  return iso(Number.isNaN(previous) ? nowMs - LOOKBACK_MS : previous - OVERLAP_MS);
}

// Checks one table for Airtable edits and writes them to Swell. A pulls record is created only when the
// check finds a row that differs from Swell; a check that finds nothing writes nothing. A running check
// (out of time, or stopped by a retryable error) keeps its cursor and page offset and continues on the next run.
export async function pullTable(
  swell: SwellAPI,
  settings: AirtableSettings,
  id: string,
  latest: PullRun | undefined,
  deadline: number,
  now: () => number = Date.now,
): Promise<PullRun | undefined> {
  const resume = latest?.status === 'running' ? latest : undefined;
  const passStart = resume?.date_pass_started || iso(now());
  const cursor = resume?.date_cursor || checkCursor(latest, Date.parse(passStart));
  let run = resume;
  let offset = resume?.offset || undefined;
  let found = 0;
  let changed = 0;
  let failed = 0;
  let lastError: string | undefined;
  let done = false;

  const start = async () => {
    run ??= await swell.post('/pulls', { table: id, status: 'running', date_cursor: cursor, date_pass_started: passStart });
  };

  try {
    for (;;) {
      if (now() >= deadline) {
        break;
      }
      const page = await listEditedRows(settings, id, cursor, offset);
      const rows = page.records.filter((row) => /^[0-9a-f]{24}$/i.test(String(row.fields?.[MERGE_FIELD] || '')));
      const records = await readSwellRecords(swell, id, rows.map((row) => row.fields[MERGE_FIELD]));

      let outOfTime = false;
      for (const row of rows) {
        const swellId = row.fields[MERGE_FIELD];
        const record = records[swellId];
        if (!record) {
          continue; // deleted in Swell
        }
        const diff = diffRow(id, record, row.fields);
        if (!diff.invalid.length && !hasChanges(diff)) {
          continue; // matches Swell, e.g. a row the app itself just synced
        }
        if (now() >= deadline) {
          outOfTime = true; // this page is read again next run; rows already written compare equal then
          break;
        }
        await start();
        found++;
        if (diff.invalid.length) {
          failed++;
          lastError = `${TABLES[id].label} ${swellId}: ${diff.invalid.join('; ')}`;
        }
        if (!hasChanges(diff)) {
          continue;
        }
        try {
          await applyDiff(swell, id, record, diff);
          changed++;
        } catch (err) {
          if (isRetryable(err)) {
            throw err;
          }
          failed++;
          lastError = `${TABLES[id].label} ${swellId}: ${errorMessage(err)}`;
        }
      }
      if (outOfTime) {
        break;
      }
      if (!page.offset) {
        done = true;
        break;
      }
      offset = page.offset;
      await sleep(throttle.ms);
    }
  } catch (err) {
    // Airtable page offsets expire; a running check starts over from its first page
    if (err instanceof AirtableError && err.type === 'LIST_RECORDS_ITERATOR_NOT_AVAILABLE') {
      offset = undefined;
    }
    lastError = `${TABLES[id].label}: ${errorMessage(err)}`;
  }

  if (!run) {
    if (lastError) {
      console.error(`Airtable: checking ${TABLES[id].label} edits failed - ${lastError}`);
    }
    return undefined;
  }
  const save: Record<string, any> = {
    found: (run.found || 0) + found,
    changed: (run.changed || 0) + changed,
    failed: (run.failed || 0) + failed,
  };
  if (done) {
    Object.assign(save, { status: 'completed', offset: null, date_completed: iso(now()) });
  } else {
    save.offset = offset ?? null;
  }
  if (lastError) {
    Object.assign(save, { last_error: lastError, date_last_error: iso(now()) });
  }
  await swell.put(`/pulls/${run.id}`, save);
  return { ...run, ...save };
}

// On Swell `updated` events of tables with write-back, send only the editable columns whose Swell field
// changed, so a Swell change to one field can't overwrite an Airtable edit of another before it's read.
// Stock level is always sent: sales change it without an edit on either side.
export function omitUnchangedEditable(id: string, fields: Record<string, any>, changed?: string[]): Record<string, any> {
  if (!changed) {
    return fields;
  }
  const out = { ...fields };
  for (const column of editableColumns(id)) {
    // Events report top-level fields: purchase_options, or the price/sale/sale_price fields Swell mirrors from it
    const path = sourceField(column)!.split('.');
    if (column.writeTo !== STOCK && !changed.includes(path[0]) && !changed.includes(path[path.length - 1])) {
      delete out[column.name];
    }
  }
  return out;
}
