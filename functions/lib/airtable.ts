import {
  DEFAULT_TABLES,
  DELETED_FIELD,
  MERGE_FIELD,
  TABLES,
  TABLE_IDS,
  childTables,
  toFields,
  type Column,
} from './tables';

export * from './tables';

export const API_URL = 'https://api.airtable.com/v0';

// Airtable accepts at most 10 records per create/update/delete request
export const MAX_BATCH = 10;
export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 100;
// "Create tables & columns" stops starting schema writes after this long, so the action stays within 10 s
export const SETUP_BUDGET_MS = 8000;
// Swell IDs per OR() formula when looking up parent rows
export const MAX_LOOKUP = 50;

// `waiting`: paused after a rate limit or Airtable outage until `date_retry`
export const ACTIVE_STATUSES = ['pending', 'running', 'waiting'];

// Pause between Airtable requests to stay under 5 requests per second per base. Tests set it to 0.
export const throttle = { ms: 220 };

export interface AirtableSettings {
  access_token?: string;
  base_id?: string;
  collections?: string[];
  orders_table?: string;
  order_items_table?: string;
  accounts_table?: string;
  products_table?: string;
  variants_table?: string;
  subscriptions_table?: string;
  coupons_table?: string;
  categories_table?: string;
  on_delete?: 'delete' | 'mark' | 'keep';
  backfill_page_size?: number;
  enabled?: boolean;
  [key: string]: any;
}

export interface AirtableField {
  id?: string;
  name: string;
  type: string;
  options?: Record<string, any>;
}

export interface AirtableTable {
  id: string;
  name: string;
  primaryFieldId?: string;
  fields: AirtableField[];
}

export interface Mismatch {
  table: string;
  tableId: string;
  fieldId?: string;
  column: string;
  actual: string;
  expected: string;
}

export type SchemaOp =
  | { kind: 'table'; collection: string; name: string; fields: AirtableField[] }
  | { kind: 'field'; collection: string; table: string; tableId: string; field: AirtableField }
  | { kind: 'rename'; collection: string; table: string; tableId: string; fieldId: string; from: string; to: string };

export interface SchemaPlan {
  ops: SchemaOp[];
  mismatches: Mismatch[];
  // Link columns that wait for their parent table to be created first
  deferred: number;
}

export class AirtableError extends Error {
  status: number;
  type?: string;
  constructor(message: string, status: number, type?: string) {
    super(message);
    this.status = status;
    this.type = type;
  }
}

// Settings

export async function getAirtableSettings(swell: SwellAPI): Promise<AirtableSettings> {
  const all = await swell.settings();
  return all?.airtable || {};
}

export function isConfigured(settings: AirtableSettings): boolean {
  return Boolean(settings.access_token?.trim()) && /^app[A-Za-z0-9]+$/.test(settings.base_id?.trim() || '');
}

// Selected tables. Child tables (line items, variants) count only when their parent is selected too.
export function syncedTables(settings: AirtableSettings): string[] {
  const selected = Array.isArray(settings.collections) ? settings.collections : DEFAULT_TABLES;
  return TABLE_IDS.filter((id) => selected.includes(id) && (!TABLES[id].parent || selected.includes(TABLES[id].parent!)));
}

// Backwards-compatible name
export const syncedCollections = syncedTables;

export function isSynced(settings: AirtableSettings, id: string): boolean {
  return syncedTables(settings).includes(id);
}

export function pageSize(settings: AirtableSettings): number {
  const size = Math.floor(Number(settings.backfill_page_size));
  if (!size || size < 1) {
    return DEFAULT_PAGE_SIZE;
  }
  return Math.min(size, MAX_PAGE_SIZE);
}

export function tableName(settings: AirtableSettings, id: string): string {
  const target = TABLES[id];
  return settings[target.tableSetting]?.trim() || target.defaultTable;
}

export function deleteMode(settings: AirtableSettings): 'delete' | 'mark' | 'keep' {
  return settings.on_delete === 'mark' || settings.on_delete === 'keep' ? settings.on_delete : 'delete';
}

// Links to expand when reading a record; orders also expand items when line items are synced
export function expandFor(settings: AirtableSettings, id: string): string[] | undefined {
  const expand = [...(TABLES[id].expand || [])];
  for (const child of childTables(id)) {
    if (isSynced(settings, child) && TABLES[child].path === TABLES[id].path) {
      expand.push(...(TABLES[child].expand || []));
    }
  }
  return expand.length ? expand : undefined;
}

// `product.variant.deleted` → { collection: 'variants', action: 'deleted' }
export function parseEventType(type?: string): { collection: string; action: string } | null {
  if (!type) {
    return null;
  }
  const dot = type.lastIndexOf('.');
  if (dot < 1) {
    return null;
  }
  const root = type.slice(0, dot);
  const action = type.slice(dot + 1);
  const collection = TABLE_IDS.find((id) => TABLES[id].event === root);
  return collection ? { collection, action } : null;
}

// Airtable field definition for the Meta API
export function fieldDefinition(column: Column, linkedTableId?: string): AirtableField {
  switch (column.type) {
    case 'number':
      return { name: column.name, type: 'number', options: { precision: column.precision ?? 2 } };
    case 'checkbox':
      return { name: column.name, type: 'checkbox', options: { icon: 'check', color: 'greenBright' } };
    case 'dateTime':
      return {
        name: column.name,
        type: 'dateTime',
        options: { dateFormat: { name: 'iso' }, timeFormat: { name: '24hour' }, timeZone: 'utc' },
      };
    case 'link':
      return { name: column.name, type: 'multipleRecordLinks', options: { linkedTableId } };
    default:
      return { name: column.name, type: column.type };
  }
}

// Airtable field types the app can write each column type into (with typecast)
export const COMPATIBLE_TYPES: Record<string, string[]> = {
  singleLineText: ['singleLineText', 'multilineText', 'richText', 'singleSelect', 'email', 'url', 'phoneNumber'],
  multilineText: ['multilineText', 'richText', 'singleLineText'],
  email: ['email', 'singleLineText'],
  phoneNumber: ['phoneNumber', 'singleLineText'],
  number: ['number', 'currency', 'percent'],
  checkbox: ['checkbox'],
  dateTime: ['dateTime', 'date'],
  link: ['multipleRecordLinks'],
};

export function expectedType(column: Column): string {
  return column.type === 'link' ? 'multipleRecordLinks' : column.type;
}

// HTTP

export function sleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

export async function airtableRequest(
  settings: AirtableSettings,
  method: string,
  path: string,
  body?: unknown,
): Promise<any> {
  if (!isConfigured(settings)) {
    throw new AirtableError('Airtable access token or base ID is not set', 400);
  }
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${settings.access_token!.trim()}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const raw = await res.text().catch(() => '');
  let json: any = null;
  try {
    json = raw ? JSON.parse(raw) : null;
  } catch {
    json = null;
  }

  if (!res.ok) {
    // Airtable errors: { error: { type, message } } or { error: "NOT_FOUND" }
    const error = json?.error;
    const type = typeof error === 'string' ? error : error?.type;
    const detail = typeof error === 'object' && error?.message ? error.message : '';
    const message = [type, detail].filter(Boolean).join(': ') || raw.slice(0, 300) || res.statusText;
    throw new AirtableError(`Airtable ${res.status}: ${message}${hint(res.status, type)}`, res.status, type);
  }
  return json;
}

function hint(status: number, type?: string): string {
  if (status === 401) {
    return '. Check the personal access token.';
  }
  if (status === 403 || status === 404) {
    return '. Check the base ID and table names, and that the token has access to the base and the needed scopes.';
  }
  if (type === 'UNKNOWN_FIELD_NAME' || type === 'INVALID_VALUE_FOR_COLUMN') {
    return '. Run "Create tables & columns" from the Actions menu of the Airtable app to add missing columns or fix column types.';
  }
  if (status === 429) {
    return '. Airtable rate limit reached; it lifts after 30 seconds.';
  }
  return '';
}

function basePath(settings: AirtableSettings): string {
  return encodeURIComponent(settings.base_id!.trim());
}

export function tablePath(settings: AirtableSettings, table: string): string {
  return `/${basePath(settings)}/${encodeURIComponent(table)}`;
}

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

function assertSwellId(id: string) {
  if (!/^[0-9a-f]{24}$/i.test(id)) {
    throw new AirtableError(`Invalid Swell ID: ${id}`, 400);
  }
}

// Records

// Creates or updates rows matched on the Swell ID column, 10 per request.
// Returns the Airtable record id of each row by Swell ID.
export async function upsertRecords(
  settings: AirtableSettings,
  table: string,
  rows: Record<string, any>[],
): Promise<Record<string, string>> {
  const ids: Record<string, string> = {};
  // Airtable rejects a request that updates the same row twice; keep the last row per Swell ID
  const unique = new Map<unknown, Record<string, any>>();
  rows.forEach((row, i) => unique.set(row[MERGE_FIELD] ?? `#${i}`, row));
  const batches = chunk([...unique.values()], MAX_BATCH);
  for (let i = 0; i < batches.length; i++) {
    if (i > 0) {
      await sleep(throttle.ms);
    }
    const result = await airtableRequest(settings, 'PATCH', tablePath(settings, table), {
      performUpsert: { fieldsToMergeOn: [MERGE_FIELD] },
      records: batches[i].map((fields) => ({ fields })),
      typecast: true,
    });
    for (const record of result?.records || []) {
      const swellId = record?.fields?.[MERGE_FIELD];
      if (swellId && record.id) {
        ids[swellId] = record.id;
      }
    }
  }
  return ids;
}

// Rows whose `field` equals one of `values`, as { id, swellId }. Follows Airtable's pagination.
export async function findRows(
  settings: AirtableSettings,
  table: string,
  field: string,
  values: string[],
): Promise<{ id: string; swellId: string }[]> {
  if (!values.length) {
    return [];
  }
  values.forEach(assertSwellId);
  const terms = values.map((value) => `{${field}}='${value}'`);
  const formula = terms.length === 1 ? terms[0] : `OR(${terms.join(',')})`;

  const rows: { id: string; swellId: string }[] = [];
  let offset: string | undefined;
  do {
    const query = new URLSearchParams();
    query.set('filterByFormula', formula);
    query.append('fields[]', MERGE_FIELD);
    if (field !== MERGE_FIELD) {
      query.append('fields[]', field);
    }
    query.set('pageSize', '100');
    if (offset) {
      query.set('offset', offset);
      await sleep(throttle.ms);
    }
    const result = await airtableRequest(settings, 'GET', `${tablePath(settings, table)}?${query}`);
    for (const record of result?.records || []) {
      rows.push({ id: record.id, swellId: record.fields?.[MERGE_FIELD] });
    }
    offset = result?.offset;
  } while (offset);
  return rows;
}

export async function findRecordIds(settings: AirtableSettings, table: string, swellId: string): Promise<string[]> {
  return (await findRows(settings, table, MERGE_FIELD, [swellId])).map((row) => row.id);
}

export async function deleteRecords(settings: AirtableSettings, table: string, ids: string[]): Promise<number> {
  const batches = chunk(ids, MAX_BATCH);
  for (let i = 0; i < batches.length; i++) {
    if (i > 0) {
      await sleep(throttle.ms);
    }
    const query = new URLSearchParams();
    batches[i].forEach((id) => query.append('records[]', id));
    await airtableRequest(settings, 'DELETE', `${tablePath(settings, table)}?${query}`);
  }
  return ids.length;
}

export async function markDeleted(settings: AirtableSettings, table: string, ids: string[]): Promise<number> {
  const batches = chunk(ids, MAX_BATCH);
  for (let i = 0; i < batches.length; i++) {
    if (i > 0) {
      await sleep(throttle.ms);
    }
    await airtableRequest(settings, 'PATCH', tablePath(settings, table), {
      records: batches[i].map((id) => ({ id, fields: { [DELETED_FIELD]: true } })),
    });
  }
  return ids.length;
}

// Deletes or flags rows per the "When a record is deleted in Swell" setting
export async function applyDelete(settings: AirtableSettings, table: string, ids: string[]): Promise<number> {
  const mode = deleteMode(settings);
  if (mode === 'keep' || !ids.length) {
    return 0;
  }
  await sleep(throttle.ms);
  return mode === 'mark' ? markDeleted(settings, table, ids) : deleteRecords(settings, table, ids);
}

// Removes the row of a deleted record and the rows of its child tables (line items, variants)
export async function removeRecord(settings: AirtableSettings, id: string, swellId: string): Promise<number> {
  if (deleteMode(settings) === 'keep') {
    return 0;
  }
  const table = tableName(settings, id);
  let count = await applyDelete(settings, table, await findRecordIds(settings, table, swellId));
  for (const child of childTables(id)) {
    if (!isSynced(settings, child)) {
      continue;
    }
    const childTable = tableName(settings, child);
    await sleep(throttle.ms);
    const rows = await findRows(settings, childTable, TABLES[child].parentIdColumn!, [swellId]);
    count += await applyDelete(settings, childTable, rows.map((row) => row.id));
  }
  return count;
}

// Removes child rows of a parent that are no longer in `keepSwellIds` (e.g. items removed from an order)
export async function pruneChildren(
  settings: AirtableSettings,
  child: string,
  parentSwellId: string,
  keepSwellIds: string[],
): Promise<number> {
  const table = tableName(settings, child);
  const rows = await findRows(settings, table, TABLES[child].parentIdColumn!, [parentSwellId]);
  const keep = new Set(keepSwellIds);
  return applyDelete(settings, table, rows.filter((row) => !keep.has(row.swellId)).map((row) => row.id));
}

// Airtable record ids of parent rows by Swell ID. Parents missing in Airtable are read from
// Swell and upserted first, so child rows can always link to them.
export async function ensureParentRows(
  settings: AirtableSettings,
  swell: SwellAPI,
  parent: string,
  swellIds: string[],
): Promise<Record<string, string>> {
  const unique = [...new Set(swellIds.filter(Boolean))];
  const table = tableName(settings, parent);
  const recIds: Record<string, string> = {};

  for (const ids of chunk(unique, MAX_LOOKUP)) {
    for (const row of await findRows(settings, table, MERGE_FIELD, ids)) {
      recIds[row.swellId] = row.id;
    }
  }

  const missing = unique.filter((id) => !recIds[id]);
  if (missing.length) {
    const result: any = await swell.get(TABLES[parent].path, {
      where: { id: { $in: missing } },
      limit: missing.length,
      ...(TABLES[parent].expand ? { expand: TABLES[parent].expand } : {}),
    });
    const records: Record<string, any>[] = result?.results || [];
    if (records.length) {
      await sleep(throttle.ms);
      Object.assign(recIds, await upsertRecords(settings, table, records.map((r) => toFields(parent, r))));
    }
  }
  return recIds;
}

// Schema (Meta API)

export async function listTables(settings: AirtableSettings): Promise<AirtableTable[]> {
  const result = await airtableRequest(settings, 'GET', `/meta/bases/${basePath(settings)}/tables`);
  return result?.tables || [];
}

export function findTable(tables: AirtableTable[], nameOrId: string): AirtableTable | undefined {
  return tables.find((t) => t.id === nameOrId || t.name === nameOrId);
}

function findField(table: AirtableTable, name: string): AirtableField | undefined {
  return table.fields.find((f) => f.name.toLowerCase() === name.toLowerCase());
}

export function missingColumns(id: string, table: AirtableTable): Column[] {
  return TABLES[id].columns.filter((c) => !findField(table, c.name));
}

// Existing columns whose Airtable type the app can't write into, and link columns pointing at the wrong table
export function typeMismatches(id: string, table: AirtableTable, tables: AirtableTable[], settings: AirtableSettings): Mismatch[] {
  const mismatches: Mismatch[] = [];
  for (const column of TABLES[id].columns) {
    const field = findField(table, column.name);
    if (!field) {
      continue;
    }
    const base = { table: table.name, tableId: table.id, fieldId: field.id, column: field.name, actual: field.type, expected: expectedType(column) };
    if (!COMPATIBLE_TYPES[column.type].includes(field.type)) {
      mismatches.push(base);
      continue;
    }
    if (column.type === 'link') {
      const parent = findTable(tables, tableName(settings, TABLES[id].parent!));
      if (parent && field.options?.linkedTableId && field.options.linkedTableId !== parent.id) {
        mismatches.push({ ...base, actual: `link to another table`, expected: `link to ${parent.name}` });
      }
    }
  }
  return mismatches;
}

export function describeMismatch(m: Mismatch): string {
  return `Column "${m.table}.${m.column}" is ${m.actual}, expected ${m.expected}`;
}

// A free name for a replaced column: "Total (old)", "Total (old 2)", ...
export function oldColumnName(table: AirtableTable, name: string): string {
  const taken = new Set(table.fields.map((f) => f.name.toLowerCase()));
  let candidate = `${name} (old)`;
  for (let n = 2; taken.has(candidate.toLowerCase()); n++) {
    candidate = `${name} (old ${n})`;
  }
  return candidate;
}

// Tables and columns to create for the synced tables. Existing columns are left alone unless
// `replace` is set: then columns with the wrong type are renamed to "<name> (old)" and recreated.
export function planSchema(settings: AirtableSettings, tables: AirtableTable[], replace = false): SchemaPlan {
  const plan: SchemaPlan = { ops: [], mismatches: [], deferred: 0 };
  // Parents first, so their tables exist before children link to them
  const ids = syncedTables(settings).sort((a, b) => Number(Boolean(TABLES[a].parent)) - Number(Boolean(TABLES[b].parent)));

  for (const id of ids) {
    const config = TABLES[id];
    const name = tableName(settings, id);
    const table = findTable(tables, name);
    const parentTable = config.parent ? findTable(tables, tableName(settings, config.parent)) : undefined;

    if (!table) {
      if (/^tbl[A-Za-z0-9]+$/.test(name)) {
        throw new AirtableError(`Table ${name} was not found in the base`, 404);
      }
      const fields = config.columns.filter((c) => c.type !== 'link').map((c) => fieldDefinition(c));
      plan.ops.push({ kind: 'table', collection: id, name, fields });
      // The link column is added on the next step, once both tables exist
      plan.deferred += config.columns.filter((c) => c.type === 'link').length;
      continue;
    }

    const mismatches = typeMismatches(id, table, tables, settings);
    plan.mismatches.push(...mismatches);
    if (replace) {
      for (const m of mismatches) {
        if (m.fieldId) {
          plan.ops.push({ kind: 'rename', collection: id, table: table.name, tableId: table.id, fieldId: m.fieldId, from: m.column, to: oldColumnName(table, m.column) });
        }
      }
    }
    const recreate = replace ? new Set(mismatches.map((m) => m.column.toLowerCase())) : new Set<string>();
    const toCreate = [...missingColumns(id, table), ...config.columns.filter((c) => recreate.has(c.name.toLowerCase()))];

    for (const column of toCreate) {
      if (column.type === 'link') {
        if (!parentTable) {
          plan.deferred++;
          continue;
        }
        plan.ops.push({ kind: 'field', collection: id, table: table.name, tableId: table.id, field: fieldDefinition(column, parentTable.id) });
      } else {
        plan.ops.push({ kind: 'field', collection: id, table: table.name, tableId: table.id, field: fieldDefinition(column) });
      }
    }
  }
  return plan;
}

export async function applySchemaOp(settings: AirtableSettings, op: SchemaOp): Promise<void> {
  const base = `/meta/bases/${basePath(settings)}/tables`;
  if (op.kind === 'table') {
    await airtableRequest(settings, 'POST', base, {
      name: op.name,
      description: `Swell ${TABLES[op.collection].label.toLowerCase()}, synced by the Swell Airtable app`,
      fields: op.fields,
    });
  } else if (op.kind === 'field') {
    await airtableRequest(settings, 'POST', `${base}/${encodeURIComponent(op.tableId)}/fields`, op.field);
  } else {
    await airtableRequest(settings, 'PATCH', `${base}/${encodeURIComponent(op.tableId)}/fields/${encodeURIComponent(op.fieldId)}`, {
      name: op.to,
    });
  }
}

export function describeOp(op: SchemaOp): string {
  if (op.kind === 'table') {
    return `created table ${op.name}`;
  }
  if (op.kind === 'field') {
    return `created column ${op.table}.${op.field.name}`;
  }
  return `renamed ${op.table}.${op.from} to "${op.to}"`;
}

export interface SetupResult {
  // false when the time ran out before every table and column was created
  done: boolean;
  message: string;
}

// Creates missing tables and columns, and with `replace` re-creates columns of the wrong type. Plans again after
// each round, since link columns can only be added once their parent table exists. Stops at `deadline`.
export async function setupTables(
  settings: AirtableSettings,
  replace: boolean,
  deadline: number,
  now: () => number = Date.now,
): Promise<SetupResult> {
  const applied: SchemaOp[] = [];
  const summary = (extra: string[]) => {
    const lines: string[] = [];
    if (applied.length) {
      const text = applied.map(describeOp).join(', ');
      lines.push(text.charAt(0).toUpperCase() + text.slice(1) + '.');
    }
    return [...lines, ...extra].join('\n');
  };

  try {
    for (;;) {
      const plan = planSchema(settings, await listTables(settings), replace);
      if (!plan.ops.length) {
        const extra: string[] = [];
        if (plan.mismatches.length && !replace) {
          extra.push(
            `Not changed: ${plan.mismatches.map(describeMismatch).join('; ')}. Run "Create tables & columns" again with "Replace columns with the wrong type" turned on to fix them.`,
          );
        }
        if (!applied.length && !extra.length) {
          extra.push('Every table and column already exists with the right type.');
        }
        return { done: true, message: summary(extra) };
      }
      for (const op of plan.ops) {
        if (now() >= deadline) {
          return { done: false, message: summary(['Not finished yet. Run "Create tables & columns" again to create the rest.']) };
        }
        await sleep(throttle.ms);
        await applySchemaOp(settings, op);
        applied.push(op);
      }
      await sleep(throttle.ms);
    }
  } catch (err) {
    // Keep what was done in the message, so a rerun after the fix is understood
    if (applied.length && err instanceof Error) {
      err.message = `${summary([])}\nThen failed: ${err.message}`;
    }
    throw err;
  }
}

// Checks the token, base, tables, columns and column types. Returns a summary or throws with the problems found.
export async function checkConnection(settings: AirtableSettings): Promise<string> {
  const ids = syncedTables(settings);
  if (!ids.length) {
    throw new AirtableError('No collections are selected in the app settings', 400);
  }
  const names = ids.map((id) => tableName(settings, id)).join(', ');

  let tables: AirtableTable[];
  try {
    tables = await listTables(settings);
  } catch (err) {
    if (!(err instanceof AirtableError) || err.status !== 403) {
      throw err;
    }
    // Token without schema.bases:read: check that each table can be read instead
    for (const id of ids) {
      await sleep(throttle.ms);
      await airtableRequest(settings, 'GET', `${tablePath(settings, tableName(settings, id))}?maxRecords=1`);
    }
    return `Connected. Tables ${names} are readable. Columns were not checked because the token has no schema.bases:read scope.`;
  }

  const problems: string[] = [];
  for (const id of ids) {
    const name = tableName(settings, id);
    const table = findTable(tables, name);
    if (!table) {
      problems.push(`Table "${name}" not found`);
      continue;
    }
    const missing = missingColumns(id, table);
    if (missing.length) {
      problems.push(`Table "${table.name}" is missing columns: ${missing.map((c) => c.name).join(', ')}`);
    }
    problems.push(...typeMismatches(id, table, tables, settings).map(describeMismatch));
  }
  if (problems.length) {
    throw new AirtableError(
      `${problems.join('. ')}. Run "Create tables & columns" from the Actions menu of the Airtable app to add missing tables and columns; turn on "Replace columns with the wrong type" to fix types.`,
      422,
    );
  }
  return `Connected. Tables ${names} have every column with the right type.`;
}

// Swell denies an app's newly granted collections on some requests for a while after its permissions change
export function isSwellPermissionDenied(err: unknown): boolean {
  return !(err instanceof AirtableError) && /does not have the required permissions/i.test(errorMessage(err));
}

// 4xx other than rate limit or timeout means the settings or the base are wrong; retrying won't help.
// Applies to Airtable errors and to Swell API errors, which also carry `status`.
// Swell permission denials are retried: they clear up once a permissions change has reached every API server.
export function isRetryable(err: unknown): boolean {
  if (isSwellPermissionDenied(err)) {
    return true;
  }
  const status = (err as any)?.status;
  if (typeof status === 'number') {
    return status >= 500 || status === 408 || status === 429;
  }
  return true;
}

export function errorMessage(err: unknown): string {
  return (err as any)?.message || String(err);
}
