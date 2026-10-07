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

// pull-edits runs every minute and has 10 s; stop starting new work after this long
export const TIME_BUDGET_MS = 7000;
// The next pass re-reads rows edited this long before the previous pass started, covering clock skew
export const OVERLAP_MS = 60_000;
export const PULL_PAGE_SIZE = 100;

export interface PullState {
  id?: string;
  table: string;
  date_cursor?: string | null;
  offset?: string | null;
  date_pass_started?: string | null;
  changed?: number;
  failed?: number;
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

// Tables whose Airtable edits are written back: chosen in settings, synced, and with editable columns
export function pullTables(settings: AirtableSettings): string[] {
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

// The store's default locale, e.g. "en-US". Reads return a field's value in this locale when it has one.
export async function storeLocale(swell: SwellAPI): Promise<string | null> {
  try {
    const client: any = await swell.get('/:clients/:self');
    return typeof client?.locale === 'string' && client.locale ? client.locale : null;
  } catch {
    return null;
  }
}

// Writes the edits. Localized fields (names) are written to the base value and to the store's locale,
// since the dashboard and API reads show the locale value whenever one has been saved.
export async function applyDiff(
  swell: SwellAPI,
  id: string,
  record: Record<string, any>,
  diff: RowDiff,
  locale: string | null = null,
): Promise<void> {
  if (Object.keys(diff.update).length) {
    const path = `${TABLES[id].path}/${record.id}`;
    assertWritten(await swell.put(path, diff.update));
    const localized: Record<string, any> = {};
    for (const column of editableColumns(id)) {
      if (column.localized && column.writeTo! in diff.update) {
        localized[column.writeTo!] = diff.update[column.writeTo!];
      }
    }
    if (locale && Object.keys(localized).length) {
      assertWritten(await swell.put(path, { ...localized, $locale: locale }));
    }
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

// Runs (part of) a pass over one table's edited rows. Returns the fields to save on its pull state.
// A pass that runs out of time keeps its Airtable offset and continues on the next run; when it
// finishes, the cursor moves to the pass's start time.
export async function pullTable(
  swell: SwellAPI,
  settings: AirtableSettings,
  id: string,
  state: PullState,
  deadline: number,
  now: () => number = Date.now,
  locale: string | null = null,
): Promise<Record<string, any>> {
  const passStart = state.date_pass_started || iso(now());
  const cursor = state.date_cursor || passStart;
  const save: Record<string, any> = { date_last_run: iso(now()) };
  let offset = state.offset || undefined;
  let changed = 0;
  let failed = 0;
  let lastError: string | undefined;

  const pause = () => {
    save.offset = offset ?? null;
    save.date_pass_started = passStart;
  };

  try {
    for (;;) {
      if (now() >= deadline) {
        pause();
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
        if (diff.invalid.length) {
          failed++;
          lastError = `${TABLES[id].label} ${swellId}: ${diff.invalid.join('; ')}`;
        }
        if (!hasChanges(diff)) {
          continue;
        }
        if (now() >= deadline) {
          outOfTime = true; // this page is read again next run; rows already written compare equal then
          break;
        }
        try {
          await applyDiff(swell, id, record, diff, locale);
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
        pause();
        break;
      }
      if (!page.offset) {
        save.date_cursor = iso(Date.parse(passStart) - OVERLAP_MS);
        save.offset = null;
        save.date_pass_started = null;
        break;
      }
      offset = page.offset;
      await sleep(throttle.ms);
    }
  } catch (err) {
    pause();
    // Airtable page offsets expire; start the pass over from its first page
    if (err instanceof AirtableError && err.type === 'LIST_RECORDS_ITERATOR_NOT_AVAILABLE') {
      save.offset = null;
    }
    lastError = `${TABLES[id].label}: ${errorMessage(err)}`;
  }

  if (changed) {
    save.changed = (state.changed || 0) + changed;
    save.date_last_change = iso(now());
  }
  if (failed) {
    save.failed = (state.failed || 0) + failed;
  }
  if (lastError) {
    save.last_error = lastError;
    save.date_last_error = iso(now());
  }
  return save;
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
