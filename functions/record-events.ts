import {
  TABLES,
  childTables,
  ensureParentRows,
  errorMessage,
  expandFor,
  getAirtableSettings,
  isConfigured,
  isRetryable,
  isSynced,
  orderItemRows,
  parseEventType,
  pruneChildren,
  removeRecord,
  sleep,
  tableName,
  throttle,
  toFields,
  upsertRecords,
  type AirtableSettings,
  type RowContext,
} from './lib/airtable';
import { isPulled, omitUnchangedEditable } from './lib/pull';

const ACTIONS = ['created', 'updated', 'deleted'];

export const config: SwellConfig = {
  description: 'Sync record changes to Airtable',
  model: {
    events: [
      'order.created', 'order.updated', 'order.deleted',
      'account.created', 'account.updated', 'account.deleted',
      'product.created', 'product.updated', 'product.deleted',
      'product.variant.created', 'product.variant.updated', 'product.variant.deleted',
      'subscription.created', 'subscription.updated', 'subscription.deleted',
      'coupon.created', 'coupon.updated', 'coupon.deleted',
      'category.created', 'category.updated', 'category.deleted',
    ],
  },
};

export default async function (req: SwellRequest) {
  const { swell, data } = req;
  const event = data.$event;
  const parsed = parseEventType(event?.type);

  if (!parsed || !ACTIONS.includes(parsed.action)) {
    return;
  }

  const { collection: id, action } = parsed;
  // deleted events carry the record only in $event.data
  const recordId: string | undefined = data.id || event?.data?.id;
  const settings = await getAirtableSettings(swell);

  if (!recordId || settings.enabled === false || !isSynced(settings, id)) {
    return;
  }
  if (!isConfigured(settings)) {
    console.error('Airtable: access token or base ID is not set');
    return;
  }

  try {
    if (action === 'deleted') {
      await removeRecord(settings, id, recordId);
      return;
    }
    // Events carry only changed fields on update; read the full record, with links the mapping needs
    const expand = expandFor(settings, id);
    const record = await swell.get(`${TABLES[id].path}/${recordId}`, expand ? { expand } : undefined);
    if (!record) {
      return; // deleted since; the delete event covers it
    }
    const itemsChanged = action === 'created' || 'items' in (event?.data || {});
    // With write-back on, leave editable columns whose Swell field didn't change as they are in Airtable
    const changedFields =
      action === 'updated' && isPulled(settings, id) && event?.data && typeof event.data === 'object'
        ? Object.keys(event.data)
        : undefined;
    await syncRecord(swell, settings, id, record, { syncItems: itemsChanged, prune: action === 'updated', changedFields });
  } catch (err) {
    const message = errorMessage(err);
    console.error(`Airtable: failed to sync ${event?.type} ${recordId} - ${message}`);
    throw new SwellError(message, { status: 502, retry: isRetryable(err) });
  }
}

// Upserts one record, linking it to its parent row, and its order line items when they changed
export async function syncRecord(
  swell: SwellAPI,
  settings: AirtableSettings,
  id: string,
  record: Record<string, any>,
  options: { syncItems?: boolean; prune?: boolean; changedFields?: string[] } = {},
): Promise<void> {
  const config = TABLES[id];
  const ctx: RowContext = {};
  if (config.parent) {
    const parentRecIds = await ensureParentRows(settings, swell, config.parent, [record.parent_id]);
    ctx.parentRecId = parentRecIds[record.parent_id] ?? null;
    await sleep(throttle.ms);
  }
  const fields = omitUnchangedEditable(id, toFields(id, record, ctx), options.changedFields);
  const recIds = await upsertRecords(settings, tableName(settings, id), [fields]);

  if (!options.syncItems) {
    return;
  }
  // Child tables read from the same record (orders → line items); variants have their own events
  for (const child of childTables(id)) {
    if (!isSynced(settings, child) || TABLES[child].path !== config.path) {
      continue;
    }
    const rows = orderItemRows(record);
    const parentRecId = recIds[record.id] ?? null;
    if (rows.length) {
      await sleep(throttle.ms);
      await upsertRecords(settings, tableName(settings, child), rows.map((row) => toFields(child, row, { parentRecId })));
    }
    if (options.prune) {
      await sleep(throttle.ms);
      await pruneChildren(settings, child, record.id, rows.map((row) => row.line_key));
    }
  }
}
