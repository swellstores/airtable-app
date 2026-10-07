// Airtable tables the app syncs and how Swell records map to their columns.
// Changing a column here also changes what "Create tables & columns" creates and checks.

export const MERGE_FIELD = 'Swell ID';
export const DELETED_FIELD = 'Deleted';
// Airtable long text limit
export const MAX_TEXT = 100000;
// `writeTo` of stock level columns: edits become stock adjustments, not field updates
export const STOCK = '$stock';

export type FieldType =
  | 'singleLineText'
  | 'multilineText'
  | 'email'
  | 'phoneNumber'
  | 'number'
  | 'checkbox'
  | 'dateTime'
  | 'link';

export interface RowContext {
  // Airtable record id of the parent row, for child tables' link column
  parentRecId?: string | null;
}

export interface Column {
  name: string;
  type: FieldType;
  // number columns: decimal places (default 2)
  precision?: number;
  // `undefined` leaves the Airtable value unchanged; `null` clears it
  value: (row: Record<string, any>, ctx: RowContext) => any;
  // Editable in Airtable: the Swell field an edit is written to (a dot path for nested fields), or STOCK for a stock adjustment
  writeTo?: string;
  // Swell stores the field per locale; edits are also written to the store's locale, the value the dashboard shows
  localized?: boolean;
}

export interface TableConfig {
  id: string;
  label: string;
  tableSetting: string;
  defaultTable: string;
  // First column is the table's primary field
  columns: Column[];
  // Swell API path of the records, used by backfills
  path: string;
  // Event root: `order.created` → `order`. Order line items have no events of their own.
  event?: string;
  expand?: string[];
  // Child tables: parent table id, link column to the parent row, and column holding the parent's Swell ID
  parent?: string;
  linkColumn?: string;
  parentIdColumn?: string;
}

// Value helpers

export function text(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  const str = String(value).trim();
  if (!str) {
    return null;
  }
  return str.length > MAX_TEXT ? str.slice(0, MAX_TEXT) : str;
}

export function num(value: unknown): number | null {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function bool(value: unknown): boolean {
  return value === true;
}

export function date(value: unknown): string | null {
  if (!value) {
    return null;
  }
  const d = new Date(value as string);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function stripHtml(value: unknown): string | null {
  if (typeof value !== 'string') {
    return text(value);
  }
  return text(
    value
      .replace(/<(br|\/p|\/div|\/li)\s*\/?>/gi, '\n')
      .replace(/<[^>]*>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\n{3,}/g, '\n\n'),
  );
}

export function fullName(person?: Record<string, any> | null): string | null {
  if (!person) {
    return null;
  }
  return text(person.name) || text([person.first_name, person.last_name].filter(Boolean).join(' '));
}

export function formatAddress(address?: Record<string, any> | null): string | null {
  if (!address) {
    return null;
  }
  const cityLine = [address.city, address.state, address.zip].filter(Boolean).join(' ');
  const lines = [fullName(address), address.company, address.address1, address.address2, cityLine, address.country];
  return text(lines.filter(Boolean).join('\n'));
}

export function itemSku(item: Record<string, any>): string | null {
  return text(item.variant?.sku || item.product?.sku || item.sku);
}

// One line per item: "2 × Shirt - Large (SKU-1)"
export function formatItems(items?: Record<string, any>[] | null): string | null {
  if (!Array.isArray(items) || !items.length) {
    return null;
  }
  const lines = items.map((item) => {
    const name = item.product_name || item.product?.name || item.product_id || 'Item';
    const variant = item.variant_name || item.variant?.name;
    const sku = itemSku(item);
    return `${item.quantity ?? 1} × ${name}${variant ? ` - ${variant}` : ''}${sku ? ` (${sku})` : ''}`;
  });
  return text(lines.join('\n'));
}

// "every 2 weeks", "monthly"
export function formatInterval(schedule?: Record<string, any> | null, fallback?: string): string | null {
  const interval = schedule?.interval || fallback;
  if (!interval) {
    return null;
  }
  const count = Number(schedule?.interval_count) || 1;
  if (count === 1) {
    return interval;
  }
  const unit = { daily: 'days', weekly: 'weeks', monthly: 'months', yearly: 'years' }[interval as string] || interval;
  return `every ${count} ${unit}`;
}

// "10% off order, 5 off shipment"
export function formatDiscounts(discounts?: Record<string, any>[] | null): string | null {
  if (!Array.isArray(discounts) || !discounts.length) {
    return null;
  }
  const parts = discounts.map((d) => {
    const value = d.value_type === 'percent' ? `${d.value_percent ?? 0}%` : `${d.value_fixed ?? d.value_amount ?? 0}`;
    return `${value} off ${d.type || 'order'}`;
  });
  return text(parts.join(', '));
}

const deleted: Column = { name: DELETED_FIELD, type: 'checkbox', value: () => false };
const swellId: Column = { name: MERGE_FIELD, type: 'singleLineText', value: (r) => text(r.id) };
const dateCreated: Column = { name: 'Date created', type: 'dateTime', value: (r) => date(r.date_created) };
const dateUpdated: Column = { name: 'Date updated', type: 'dateTime', value: (r) => date(r.date_updated) };
const parentLink = (name: string): Column => ({
  name,
  type: 'link',
  value: (_r, ctx) => (ctx.parentRecId === undefined ? undefined : ctx.parentRecId ? [ctx.parentRecId] : []),
});

// Products and variants keep their one-time purchase price in purchase_options.standard
const STANDARD_PURCHASE_OPTION = 'purchase_options.standard';
const standard = (r: Record<string, any>): Record<string, any> => r.purchase_options?.standard || {};
const standardPrice: Column = { name: 'Price', type: 'number', value: (r) => num(standard(r).price), writeTo: `${STANDARD_PURCHASE_OPTION}.price` };
const standardSale: Column = { name: 'On sale', type: 'checkbox', value: (r) => bool(standard(r).sale), writeTo: `${STANDARD_PURCHASE_OPTION}.sale` };
const standardSalePrice: Column = {
  name: 'Sale price',
  type: 'number',
  value: (r) => num(standard(r).sale_price),
  writeTo: `${STANDARD_PURCHASE_OPTION}.sale_price`,
};

const ORDER_COLUMNS: Column[] = [
  { name: 'Number', type: 'singleLineText', value: (r) => text(r.number) },
  swellId,
  dateCreated,
  { name: 'Status', type: 'singleLineText', value: (r) => text(r.status) },
  { name: 'Paid', type: 'checkbox', value: (r) => bool(r.paid) },
  { name: 'Delivered', type: 'checkbox', value: (r) => bool(r.delivered) },
  { name: 'Refunded', type: 'checkbox', value: (r) => bool(r.refunded) },
  { name: 'Canceled', type: 'checkbox', value: (r) => bool(r.canceled) },
  { name: 'Customer email', type: 'email', value: (r) => text(r.account?.email) },
  { name: 'Customer name', type: 'singleLineText', value: (r) => fullName(r.billing) || fullName(r.shipping) || fullName(r.account) },
  { name: 'Items', type: 'multilineText', value: (r) => formatItems(r.items) },
  { name: 'Item count', type: 'number', precision: 0, value: (r) => num(r.item_quantity) },
  { name: 'Subtotal', type: 'number', value: (r) => num(r.sub_total) },
  { name: 'Shipping', type: 'number', value: (r) => num(r.shipment_total) },
  { name: 'Tax', type: 'number', value: (r) => num(r.tax_total) },
  { name: 'Discount', type: 'number', value: (r) => num(r.discount_total) },
  { name: 'Total', type: 'number', value: (r) => num(r.grand_total) },
  { name: 'Refunded amount', type: 'number', value: (r) => num(r.refund_total) },
  { name: 'Currency', type: 'singleLineText', value: (r) => text(r.currency) },
  { name: 'Shipping method', type: 'singleLineText', value: (r) => text(r.shipping?.service_name) },
  { name: 'Shipping address', type: 'multilineText', value: (r) => formatAddress(r.shipping) },
  { name: 'Coupon', type: 'singleLineText', value: (r) => text(r.coupon_code) },
  dateUpdated,
  deleted,
];

// Rows are order items with the order attached as `order` (see orderItemRows).
// Swell reuses item ids across orders (e.g. subscription renewals), so the row key is `<order id>-<item id>`.
const ORDER_ITEM_COLUMNS: Column[] = [
  { name: 'Item', type: 'singleLineText', value: (r) => text([r.order?.number, r.product_name || r.product?.name].filter(Boolean).join(' - ')) },
  { name: MERGE_FIELD, type: 'singleLineText', value: (r) => text(r.line_key) },
  parentLink('Order'),
  { name: 'Order number', type: 'singleLineText', value: (r) => text(r.order?.number) },
  { name: 'Order Swell ID', type: 'singleLineText', value: (r) => text(r.order?.id) },
  { name: 'Item Swell ID', type: 'singleLineText', value: (r) => text(r.id) },
  { name: 'Product', type: 'singleLineText', value: (r) => text(r.product_name || r.product?.name) },
  { name: 'Variant', type: 'singleLineText', value: (r) => text(r.variant_name || r.variant?.name) },
  { name: 'SKU', type: 'singleLineText', value: (r) => itemSku(r) },
  { name: 'Product Swell ID', type: 'singleLineText', value: (r) => text(r.product_id) },
  { name: 'Variant Swell ID', type: 'singleLineText', value: (r) => text(r.variant_id) },
  { name: 'Quantity', type: 'number', precision: 0, value: (r) => num(r.quantity) },
  { name: 'Price', type: 'number', value: (r) => num(r.price) },
  { name: 'Discount', type: 'number', value: (r) => num(r.discount_total) },
  { name: 'Tax', type: 'number', value: (r) => num(r.tax_total) },
  { name: 'Total', type: 'number', value: (r) => num(r.price_total) },
  { name: 'Currency', type: 'singleLineText', value: (r) => text(r.order?.currency) },
  { name: 'Order date', type: 'dateTime', value: (r) => date(r.order?.date_created) },
  deleted,
];

const ACCOUNT_COLUMNS: Column[] = [
  { name: 'Email', type: 'singleLineText', value: (r) => text(r.email), writeTo: 'email' },
  swellId,
  { name: 'First name', type: 'singleLineText', value: (r) => text(r.first_name), writeTo: 'first_name' },
  { name: 'Last name', type: 'singleLineText', value: (r) => text(r.last_name), writeTo: 'last_name' },
  { name: 'Phone', type: 'phoneNumber', value: (r) => text(r.phone), writeTo: 'phone' },
  { name: 'Type', type: 'singleLineText', value: (r) => text(r.type) },
  { name: 'Group', type: 'singleLineText', value: (r) => text(r.group) },
  { name: 'Email opt-in', type: 'checkbox', value: (r) => bool(r.email_optin), writeTo: 'email_optin' },
  { name: 'Order count', type: 'number', precision: 0, value: (r) => num(r.order_count) },
  { name: 'Order value', type: 'number', value: (r) => num(r.order_value) },
  { name: 'Currency', type: 'singleLineText', value: (r) => text(r.currency) },
  dateCreated,
  dateUpdated,
  deleted,
];

const PRODUCT_COLUMNS: Column[] = [
  { name: 'Name', type: 'singleLineText', value: (r) => text(r.name), writeTo: 'name', localized: true },
  swellId,
  { name: 'SKU', type: 'singleLineText', value: (r) => text(r.sku), writeTo: 'sku' },
  { name: 'Slug', type: 'singleLineText', value: (r) => text(r.slug) },
  { name: 'Type', type: 'singleLineText', value: (r) => text(r.type) },
  { name: 'Active', type: 'checkbox', value: (r) => bool(r.active), writeTo: 'active' },
  standardPrice,
  standardSale,
  standardSalePrice,
  { name: 'Track stock', type: 'checkbox', value: (r) => bool(r.stock_tracking), writeTo: 'stock_tracking' },
  { name: 'Stock level', type: 'number', precision: 0, value: (r) => num(r.stock_level), writeTo: STOCK },
  { name: 'Stock status', type: 'singleLineText', value: (r) => text(r.stock_status) },
  dateCreated,
  dateUpdated,
  deleted,
];

const VARIANT_COLUMNS: Column[] = [
  { name: 'Name', type: 'singleLineText', value: (r) => text(r.name), writeTo: 'name', localized: true },
  swellId,
  parentLink('Product'),
  { name: 'Product Swell ID', type: 'singleLineText', value: (r) => text(r.parent_id) },
  { name: 'SKU', type: 'singleLineText', value: (r) => text(r.sku), writeTo: 'sku' },
  { name: 'Active', type: 'checkbox', value: (r) => bool(r.active), writeTo: 'active' },
  standardPrice,
  standardSale,
  standardSalePrice,
  { name: 'Stock level', type: 'number', precision: 0, value: (r) => num(r.stock_level), writeTo: STOCK },
  { name: 'Currency', type: 'singleLineText', value: (r) => text(r.currency) },
  dateCreated,
  dateUpdated,
  deleted,
];

const SUBSCRIPTION_COLUMNS: Column[] = [
  { name: 'Number', type: 'singleLineText', value: (r) => text(r.number) },
  swellId,
  { name: 'Status', type: 'singleLineText', value: (r) => text(r.status) },
  { name: 'Active', type: 'checkbox', value: (r) => bool(r.active) },
  { name: 'Paid', type: 'checkbox', value: (r) => bool(r.paid) },
  { name: 'Canceled', type: 'checkbox', value: (r) => bool(r.canceled) },
  { name: 'Customer email', type: 'email', value: (r) => text(r.account?.email) },
  { name: 'Customer name', type: 'singleLineText', value: (r) => fullName(r.billing) || fullName(r.account) },
  { name: 'Product', type: 'singleLineText', value: (r) => text(r.product_name || r.product?.name) },
  { name: 'Product Swell ID', type: 'singleLineText', value: (r) => text(r.product_id) },
  { name: 'Plan', type: 'singleLineText', value: (r) => text(r.plan_name) },
  { name: 'Interval', type: 'singleLineText', value: (r) => formatInterval(r.billing_schedule, r.interval) },
  { name: 'Quantity', type: 'number', precision: 0, value: (r) => num(r.quantity) },
  { name: 'Price', type: 'number', value: (r) => num(r.price) },
  { name: 'Recurring total', type: 'number', value: (r) => num(r.recurring_total) },
  { name: 'Currency', type: 'singleLineText', value: (r) => text(r.currency) },
  { name: 'Period start', type: 'dateTime', value: (r) => date(r.date_period_start) },
  { name: 'Period end', type: 'dateTime', value: (r) => date(r.date_period_end) },
  { name: 'Date canceled', type: 'dateTime', value: (r) => date(r.date_canceled) },
  dateCreated,
  dateUpdated,
  deleted,
];

const COUPON_COLUMNS: Column[] = [
  { name: 'Name', type: 'singleLineText', value: (r) => text(r.name), writeTo: 'name', localized: true },
  swellId,
  { name: 'Code', type: 'singleLineText', value: (r) => (r.multi_codes ? null : text(r.code)) },
  { name: 'Multiple codes', type: 'checkbox', value: (r) => bool(r.multi_codes) },
  { name: 'Description', type: 'multilineText', value: (r) => stripHtml(r.description) },
  { name: 'Active', type: 'checkbox', value: (r) => bool(r.active), writeTo: 'active' },
  { name: 'Discounts', type: 'singleLineText', value: (r) => formatDiscounts(r.discounts) },
  { name: 'Uses', type: 'number', precision: 0, value: (r) => num(r.use_count) },
  { name: 'Use limit', type: 'number', precision: 0, value: (r) => num(r.limit_uses), writeTo: 'limit_uses' },
  { name: 'Valid from', type: 'dateTime', value: (r) => date(r.date_valid), writeTo: 'date_valid' },
  { name: 'Expires', type: 'dateTime', value: (r) => date(r.date_expired), writeTo: 'date_expired' },
  { name: 'Currency', type: 'singleLineText', value: (r) => text(r.currency) },
  dateCreated,
  dateUpdated,
  deleted,
];

const CATEGORY_COLUMNS: Column[] = [
  { name: 'Name', type: 'singleLineText', value: (r) => text(r.name), writeTo: 'name', localized: true },
  swellId,
  { name: 'Slug', type: 'singleLineText', value: (r) => text(r.slug), writeTo: 'slug' },
  { name: 'Active', type: 'checkbox', value: (r) => bool(r.active), writeTo: 'active' },
  { name: 'Parent',type: 'singleLineText', value: (r) => text(r.parent?.name) },
  { name: 'Parent Swell ID', type: 'singleLineText', value: (r) => text(r.parent_id) },
  { name: 'Description', type: 'multilineText', value: (r) => stripHtml(r.description) },
  dateCreated,
  dateUpdated,
  deleted,
];

export const TABLES: Record<string, TableConfig> = {
  orders: {
    id: 'orders',
    label: 'Orders',
    tableSetting: 'orders_table',
    defaultTable: 'Orders',
    path: '/orders',
    event: 'order',
    expand: ['account'],
    columns: ORDER_COLUMNS,
  },
  order_items: {
    id: 'order_items',
    label: 'Order line items',
    tableSetting: 'order_items_table',
    defaultTable: 'Order line items',
    path: '/orders',
    expand: ['items.product', 'items.variant'],
    parent: 'orders',
    linkColumn: 'Order',
    parentIdColumn: 'Order Swell ID',
    columns: ORDER_ITEM_COLUMNS,
  },
  accounts: {
    id: 'accounts',
    label: 'Customers',
    tableSetting: 'accounts_table',
    defaultTable: 'Customers',
    path: '/accounts',
    event: 'account',
    columns: ACCOUNT_COLUMNS,
  },
  products: {
    id: 'products',
    label: 'Products',
    tableSetting: 'products_table',
    defaultTable: 'Products',
    path: '/products',
    event: 'product',
    columns: PRODUCT_COLUMNS,
  },
  variants: {
    id: 'variants',
    label: 'Product variants',
    tableSetting: 'variants_table',
    defaultTable: 'Product variants',
    path: '/products:variants',
    event: 'product.variant',
    parent: 'products',
    linkColumn: 'Product',
    parentIdColumn: 'Product Swell ID',
    columns: VARIANT_COLUMNS,
  },
  subscriptions: {
    id: 'subscriptions',
    label: 'Subscriptions',
    tableSetting: 'subscriptions_table',
    defaultTable: 'Subscriptions',
    path: '/subscriptions',
    event: 'subscription',
    expand: ['account'],
    columns: SUBSCRIPTION_COLUMNS,
  },
  coupons: {
    id: 'coupons',
    label: 'Coupons',
    tableSetting: 'coupons_table',
    defaultTable: 'Coupons',
    path: '/coupons',
    event: 'coupon',
    columns: COUPON_COLUMNS,
  },
  categories: {
    id: 'categories',
    label: 'Categories',
    tableSetting: 'categories_table',
    defaultTable: 'Categories',
    path: '/categories',
    event: 'category',
    expand: ['parent'],
    columns: CATEGORY_COLUMNS,
  },
};

// Backwards-compatible name used by earlier code and tests
export const COLLECTIONS = TABLES;

export const TABLE_IDS = Object.keys(TABLES);
export const DEFAULT_TABLES = ['orders', 'accounts', 'products'];

// Tables with columns that can be edited in Airtable and written back to Swell
export const EDITABLE_TABLES = TABLE_IDS.filter((id) => TABLES[id].columns.some((c) => c.writeTo));

export function editableColumns(id: string): Column[] {
  return TABLES[id].columns.filter((c) => c.writeTo);
}

// Swell field an editable column's value comes from (stock adjustments change stock_level)
export function sourceField(column: Column): string | undefined {
  return column.writeTo === STOCK ? 'stock_level' : column.writeTo;
}

// Children of a table: orders → order_items, products → variants
export function childTables(id: string): string[] {
  return TABLE_IDS.filter((child) => TABLES[child].parent === id);
}

// Swell ID of a line-item row: item ids repeat across orders, so it includes the order id
export function lineItemKey(orderId: string, itemId: string): string {
  return `${orderId}-${itemId}`;
}

// Order items as rows of the line items table, each with its order and row key attached
export function orderItemRows(order: Record<string, any>): Record<string, any>[] {
  const items: Record<string, any>[] = Array.isArray(order.items) ? order.items : [];
  return items.filter((item) => item?.id).map((item) => ({ ...item, order, line_key: lineItemKey(order.id, item.id) }));
}

// Swell record → Airtable fields. Columns whose value is `undefined` are left out.
export function toFields(id: string, row: Record<string, any>, ctx: RowContext = {}): Record<string, any> {
  const fields: Record<string, any> = {};
  for (const column of TABLES[id].columns) {
    const value = column.value(row, ctx);
    if (value !== undefined) {
      fields[column.name] = value;
    }
  }
  return fields;
}
