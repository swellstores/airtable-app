import {
  ACTIVE_STATUSES,
  MAX_SCHEMA_WRITES,
  TABLES,
  AirtableError,
  applySchemaOp,
  checkConnection,
  describeMismatch,
  describeOp,
  ensureParentRows,
  errorMessage,
  getAirtableSettings,
  isConfigured,
  isRetryable,
  listTables,
  orderItemRows,
  pageSize,
  planSchema,
  sleep,
  tableName,
  throttle,
  toFields,
  upsertRecords,
  type AirtableSettings,
} from './lib/airtable';

// Automatic retries after rate limits and Airtable outages before a job fails
export const MAX_RETRIES = 8;

export const config: SwellConfig = {
  description: 'Run one step of an Airtable sync job',
  model: {
    events: ['sync.created', 'sync.updated'],
    conditions: { status: { $in: ['pending', 'running'] } },
  },
};

// Each recorded step re-triggers this function for the next one. Edits to other fields don't.
export function shouldRun(data: SwellRequest['data']): boolean {
  const event = data.$event;
  if (event?.type === 'sync.created') {
    return true;
  }
  const changed = event?.data || {};
  return 'pages' in changed || changed.status === 'pending';
}

// Airtable asks for 30 s after a 429; other errors back off 1, 2, 4 ... up to 30 minutes
export function retryDelaySeconds(err: unknown, attempt: number): number {
  if (err instanceof AirtableError && err.status === 429) {
    return 60;
  }
  return Math.min(60 * 2 ** Math.max(attempt - 1, 0), 1800);
}

type Job = Record<string, any>;
type Update = Record<string, any>;

export default async function (req: SwellRequest) {
  const { swell, data } = req;

  if (!shouldRun(data)) {
    return;
  }

  const job: Job | null = await swell.get(`/syncs/${data.id}`);
  if (!job || !['pending', 'running'].includes(job.status)) {
    return;
  }

  const fail = (error: string) =>
    swell.put(`/syncs/${job.id}`, { status: 'failed', last_error: error, date_completed: new Date().toISOString() });

  const settings = await getAirtableSettings(swell);
  if (settings.enabled === false) {
    return fail('The Airtable app is turned off in settings');
  }
  if (!isConfigured(settings)) {
    return fail('Airtable access token or base ID is not set in the app settings');
  }

  try {
    let update: Update;
    if (job.type === 'test') {
      update = await runTest(settings);
    } else if (job.type === 'setup') {
      update = await runSetup(settings, job);
    } else {
      update = await runBackfill(swell, settings, job);
    }
    await save(swell, job, update);
  } catch (err) {
    const message = errorMessage(err);
    console.error(`Airtable: sync ${job.id} (${job.type} ${job.collection || ''}) failed - ${message}`);

    const retries = (job.retries || 0) + 1;
    if (!isRetryable(err) || retries > MAX_RETRIES) {
      return fail(retries > MAX_RETRIES ? `${message} Gave up after ${MAX_RETRIES} retries.` : message);
    }
    // Pause the job; sync-retry sets it back to pending at date_retry
    const at = new Date(Date.now() + retryDelaySeconds(err, retries) * 1000).toISOString();
    const current: Job | null = await swell.get(`/syncs/${job.id}`);
    if (current && ['pending', 'running'].includes(current.status)) {
      await swell.put(`/syncs/${job.id}`, {
        status: 'waiting',
        retries,
        date_retry: at,
        last_error: `${message} Retry ${retries} of ${MAX_RETRIES} at ${at}.`,
      });
    }
  }
}

// Writes progress and the final status; keeps a cancel made while this step was running
async function save(swell: SwellAPI, job: Job, update: Update) {
  const now = new Date().toISOString();
  if (!job.date_started) {
    update.date_started = now;
  }
  if (job.retries) {
    update.retries = 0;
    update.date_retry = null;
  }
  const done = update.status === 'completed';
  delete update.status;

  const current: Job | null = await swell.get(`/syncs/${job.id}`);
  if (current && ['pending', 'running'].includes(current.status)) {
    update.status = done ? 'completed' : 'running';
    if (done) {
      update.date_completed = now;
    }
  }
  await swell.put(`/syncs/${job.id}`, update);
}

export async function runTest(settings: AirtableSettings): Promise<Update> {
  const message = await checkConnection(settings);
  return { status: 'completed', message, pages: 1, last_error: null };
}

// Creates, renames or replaces up to MAX_SCHEMA_WRITES tables/columns per step; the next step re-plans and continues
export async function runSetup(settings: AirtableSettings, job: Job): Promise<Update> {
  const plan = planSchema(settings, await listTables(settings), job.replace_columns === true);
  const batch = plan.ops.slice(0, MAX_SCHEMA_WRITES);
  for (const op of batch) {
    await sleep(throttle.ms);
    await applySchemaOp(settings, op);
  }

  const sent = (job.sent || 0) + batch.length;
  // Deferred link columns need another step once their parent table exists
  const done = !batch.length || (plan.ops.length <= MAX_SCHEMA_WRITES && plan.deferred === 0);
  const lines = job.message ? [job.message] : [];
  if (batch.length) {
    const text = batch.map(describeOp).join(', ');
    lines.push(text.charAt(0).toUpperCase() + text.slice(1) + '.');
  }
  if (done) {
    if (plan.mismatches.length && job.replace_columns !== true) {
      lines.push(
        `Not changed: ${plan.mismatches.map(describeMismatch).join('; ')}. Create another "Create tables & columns" job with "Replace columns with the wrong type" ticked to fix them.`,
      );
    }
    if (!lines.length) {
      lines.push('Every table and column already exists with the right type.');
    }
  }
  return {
    status: done ? 'completed' : 'running',
    pages: (job.pages || 0) + 1,
    sent,
    total: sent - batch.length + plan.ops.length + plan.deferred,
    message: lines.join('\n'),
    last_error: null,
  };
}

// Sends one page. Order line items page through orders and stop at whole orders once `limit` rows are collected.
export async function runBackfill(swell: SwellAPI, settings: AirtableSettings, job: Job): Promise<Update> {
  const config = TABLES[job.collection];
  if (!config) {
    throw new Error(`Unknown collection: ${job.collection}`);
  }
  const isItems = job.collection === 'order_items';

  const limit = pageSize(settings);
  const where: Record<string, any> = {};
  if (job.last_id) {
    where.id = { $gt: job.last_id };
  }
  if (job.date_from) {
    where.date_created = { $gte: job.date_from };
  }

  const page: any = await swell.get(config.path, {
    where,
    sort: 'id asc',
    limit,
    ...(config.expand ? { expand: config.expand } : {}),
  });
  const records: Record<string, any>[] = page?.results || [];

  let processed = records;
  let rows = records;
  if (isItems) {
    processed = [];
    rows = [];
    for (const order of records) {
      const items = orderItemRows(order);
      if (processed.length && rows.length + items.length > limit) {
        break;
      }
      processed.push(order);
      rows.push(...items);
    }
  }

  let parentRecIds: Record<string, string> = {};
  const parentIdOf = (row: Record<string, any>) => (isItems ? row.order?.id : row.parent_id);
  if (config.parent && rows.length) {
    parentRecIds = await ensureParentRows(settings, swell, config.parent, rows.map(parentIdOf));
    await sleep(throttle.ms);
  }

  if (rows.length) {
    await upsertRecords(
      settings,
      tableName(settings, job.collection),
      rows.map((row) => toFields(job.collection, row, config.parent ? { parentRecId: parentRecIds[parentIdOf(row)] ?? null } : {})),
    );
  }

  const update: Update = {
    status: records.length < limit && processed.length === records.length ? 'completed' : 'running',
    last_id: processed.length ? processed[processed.length - 1].id : job.last_id,
    pages: (job.pages || 0) + 1,
    sent: (job.sent || 0) + rows.length,
    last_error: null,
  };
  // For line items the count is of orders, not rows, so no total is shown
  if (!job.last_id && typeof page?.count === 'number' && !isItems) {
    update.total = page.count;
  }
  return update;
}
