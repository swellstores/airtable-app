# Airtable for Swell

Sync your Swell **orders, order line items, customers, products, product variants, subscriptions, coupons and categories** to an [Airtable](https://airtable.com) base. Every Swell record becomes one Airtable row. The row is created when the record is created, updated when the record changes and removed (or flagged) when the record is deleted. Line items and variants are linked to their order and product rows. Existing records can be sent with backfills.

Sync is two way for the columns marked ✎ below: edits made to them in Airtable are written back to Swell within about a minute, for the tables you turn on in **Write Airtable edits back to Swell**. Every other column is read-only: Swell overwrites it on the record's next change.

## Features

- **Two-way editing:** for products, variants, customers, coupons and categories, edits in Airtable to names, SKUs, prices, active flags, stock levels and the other ✎ columns are written to Swell. Turn it on per table in settings. A stock level edit becomes a Swell stock adjustment for the difference. Each table's write-back status (records updated, edits rejected, last error) is under **Airtable edits** in the dashboard sidebar.
- **Live sync:** when a synced record is created or updated in Swell, the app reads the full record and upserts it into Airtable. Rows are matched on the **Swell ID** column, so updates never create duplicates.
- **Multiple tables:** Orders, Order line items, Customers, Products, Product variants, Subscriptions, Coupons and Categories. Pick the ones you want in settings. Orders, Customers and Products are on by default.
- **Linked rows:** each order line item links to its order row, and each variant links to its product row, through Airtable linked-record columns (**Order**, **Product**). Airtable adds the reverse link column to the parent table automatically. If a variant changes before its product is in Airtable, the app adds the product row first.
- **Line items follow their order:** when an order is created or its items change, its line-item rows are upserted, and rows for items removed from the order are deleted or flagged.
- **Deletions:** when a record is deleted in Swell, the app deletes its Airtable row, checks its **Deleted** column, or leaves it alone, depending on the settings. Deleting an order or product does the same to its line-item or variant rows.
- **Table setup:** a **Create tables & columns** sync job creates the tables with typed columns (text, number, checkbox, date, email, phone, linked records). If you made the tables yourself, it adds only the columns that are missing. You can add your own columns; the app leaves them alone.
- **Column type checks and repair:** the setup job and the connection test check that every synced column has a type the app can write into. Wrong types are reported. Tick **Replace columns with the wrong type** on a setup job to rename each wrong column to `<name> (old)` (its data stays) and create it again with the right type. Then run a backfill to fill it.
- **Connection test:** a **Connection test** sync job checks the token, the base, the tables, every column and their types, and lists what's wrong.
- **Backfills:** a **Backfill** sync job sends existing records of one table, optionally only those created after a date. **Backfill all synced collections** starts one per synced table. Each job shows its status, records sent, total and the last error. Jobs can be canceled and resumed. A resumed job continues after the last record sent.
- **Automatic retries:** a sync job step that hits Airtable's rate limit (429), a timeout or an Airtable server error doesn't fail. The job goes to **Waiting to retry** and resumes by itself: after 1 minute for rate limits, otherwise after 1, 2, 4 … up to 30 minutes. It fails after 8 retries in a row. **Resume** on a waiting job retries right away. Live updates that hit the same errors are retried by Swell's event retries.
- **Clear errors:** configuration errors (wrong token, base, table, missing column) are not retried. Swell permission denials (`The client does not have the required permissions`) are retried like rate limits, because they also happen for a while after an app's permissions change. The job fails, or the event is logged, with a hint on how to fix it.

## Settings

All credentials and options are app settings (`settings/airtable.json`). Nothing is hard-coded.

| Setting | Required | Default | Description |
|---|---|---|---|
| Personal access token | yes | | Airtable personal access token, stored as a secret setting (masked in the dashboard). Scopes: `data.records:read`, `data.records:write`. Add `schema.bases:read` for column checks and `schema.bases:write` for table setup. |
| Base ID | yes | | Starts with `app`. The part after `airtable.com/` in the base URL. |
| Collections to sync | no | Orders, Customers, Products | Tables that are synced live and offered by **Backfill all synced collections**. **Order line items** needs **Orders** selected, and **Product variants** needs **Products**. |
| Orders table | no | `Orders` | Table name or table ID (`tbl…`). |
| Order line items table | no | `Order line items` | Table name or table ID. |
| Customers table | no | `Customers` | Table name or table ID. |
| Products table | no | `Products` | Table name or table ID. |
| Product variants table | no | `Product variants` | Table name or table ID. |
| Subscriptions table | no | `Subscriptions` | Table name or table ID. |
| Coupons table | no | `Coupons` | Table name or table ID. |
| Categories table | no | `Categories` | Table name or table ID. |
| When a record is deleted in Swell | no | Delete the Airtable row | `Delete the Airtable row`, `Check the row's Deleted column`, or `Keep the row unchanged`. |
| Write Airtable edits back to Swell | no | none | Tables whose ✎ columns are written back to Swell: Products, Product variants, Customers, Coupons, Categories. The table must also be in **Collections to sync**. |
| Backfill page size | no | 50 | Records (or order line items) per backfill step (1–100). Lower it if backfills often wait for rate limits. |
| Enabled | no | on | Turns off all syncing without uninstalling the app. Running sync jobs fail with a message. |

Table names are matched exactly, including case. If a table is renamed in Airtable, update the setting or use the table ID, which never changes.

## Setup

1. **Create a base** in Airtable, or pick an existing one. Copy its **base ID** from the URL: `https://airtable.com/appXXXXXXXXXXXXXX/...` → `appXXXXXXXXXXXXXX`. You can also find it at [airtable.com/api](https://airtable.com/api) after picking the base.
2. **Create a personal access token** at [airtable.com/create/tokens](https://airtable.com/create/tokens):
   - Scopes: `data.records:read`, `data.records:write`, `schema.bases:read`, `schema.bases:write`.
   - Access: add the base from step 1.
   - Copy the token (`pat…`). Airtable shows it only once.
3. **Install the app** in Swell and open **Apps → Airtable → Settings**. Paste the token and base ID, pick the collections and save. Change the table names only if you want to use existing tables.
4. Open **Airtable** in the dashboard sidebar. Click **New**, choose **Create tables & columns** and save. After a few seconds the job shows **Completed**, and its **Result** lists the tables and columns created. With line items or variants selected, the job takes two steps: tables first, then the link columns.
5. Click **New** again, choose **Connection test** and save. The result should say `Connected. Tables … have every column with the right type.` If it fails, the error says what's wrong.
6. Click **Backfill all synced collections** to send existing records. Watch the jobs reach **Completed**.
7. From now on, every change in Swell appears in Airtable within a few seconds.
8. **Optional, two-way editing:** in the app settings, tick the tables under **Write Airtable edits back to Swell** and save. Within a minute, **Airtable edits** in the sidebar shows one row per table. Only edits made after that are written back. Edit a ✎ cell in Airtable, for example a product's price; it shows in Swell within about a minute.

If you don't want to grant the schema scopes, create the tables and columns yourself with the names and types listed below. The column names must match exactly. Without `schema.bases:read`, the connection test only checks that the tables can be read.

## Airtable columns

The first column is the table's primary field. Number columns use 2 decimals unless noted. Dates are date-time columns in UTC. ☑ is a checkbox, 🔗 a linked-record column, and ✎ a column whose Airtable edits are written back to Swell when write-back is on for the table.

**Orders:** Number (primary), Swell ID, Date created, Status, Paid ☑, Delivered ☑, Refunded ☑, Canceled ☑, Customer email (email), Customer name, Items (long text, one line per item: `2 × Shirt - Large (SKU)`), Item count (integer), Subtotal, Shipping, Tax, Discount, Total, Refunded amount, Currency, Shipping method, Shipping address (long text), Coupon, Date updated, Deleted ☑.

**Order line items:** Item (primary, `<order number> - <product>`), Swell ID (`<order id>-<item id>`, see below), Order 🔗 Orders, Order number, Order Swell ID, Item Swell ID, Product, Variant, SKU, Product Swell ID, Variant Swell ID, Quantity (integer), Price, Discount, Tax, Total, Currency, Order date, Deleted ☑.

**Customers:** Email ✎ (primary), Swell ID, First name ✎, Last name ✎, Phone ✎ (phone), Type, Group, Email opt-in ☑ ✎, Order count (integer), Order value, Currency, Date created, Date updated, Deleted ☑.

**Products:** Name ✎ (primary), Swell ID, SKU ✎, Slug, Type, Active ☑ ✎, Price ✎, On sale ☑ ✎, Sale price ✎, Track stock ☑ ✎, Stock level ✎ (integer), Stock status, Date created, Date updated, Deleted ☑.

**Product variants:** Name ✎ (primary), Swell ID, Product 🔗 Products, Product Swell ID, SKU ✎, Active ☑ ✎, Price ✎, Sale price ✎, Stock level ✎ (integer), Currency, Date created, Date updated, Deleted ☑.

**Subscriptions:** Number (primary), Swell ID, Status, Active ☑, Paid ☑, Canceled ☑, Customer email (email), Customer name, Product, Product Swell ID, Plan, Interval (e.g. `every 2 weeks`), Quantity (integer), Price, Recurring total, Currency, Period start, Period end, Date canceled, Date created, Date updated, Deleted ☑.

**Coupons:** Name ✎ (primary), Swell ID, Code (empty for coupons with multiple generated codes), Multiple codes ☑, Description (long text), Active ☑ ✎, Discounts (e.g. `10% off order, 5 off shipment`), Uses (integer), Use limit ✎ (integer), Valid from ✎, Expires ✎, Currency, Date created, Date updated, Deleted ☑.

**Categories:** Name ✎ (primary), Swell ID, Slug ✎, Active ☑ ✎, Parent (parent category name), Parent Swell ID, Description (long text, HTML removed), Date created, Date updated, Deleted ☑.

Swell reuses item ids across orders (subscription renewal orders, for example, all carry the subscription's item id), so a line-item row is keyed on the order id and the item id together. The plain item id is in **Item Swell ID**.

Each sync writes all of these columns and sets **Deleted** to unchecked. With write-back on, live updates skip ✎ columns whose Swell field didn't change (see **Two-way editing**). Columns you add yourself are never touched. Requests are sent with `typecast: true`.

**Column types the app accepts** (anything else is reported as a wrong type):

| Synced column | Airtable types accepted |
|---|---|
| Text | single line text, long text, rich text, single select, email, URL, phone |
| Long text | long text, rich text, single line text |
| Email / Phone | email / phone, or single line text |
| Number | number, currency, percent |
| Checkbox | checkbox |
| Date | date and time, date |
| Link (🔗) | link to another record, pointing at the parent table |

So you can turn **Status** into a single select or **Total** into a currency column in Airtable and the sync keeps working.

## How it works

| File | Trigger | What it does |
|---|---|---|
| `functions/record-events.ts` | `created`, `updated`, `deleted` of `order`, `account`, `product`, `product.variant`, `subscription`, `coupon`, `category` | Checks the settings, re-reads the full record (with the links the mapping needs), maps it and upserts it into Airtable. Variants first make sure their product row exists, to link to it. Orders also upsert their line items when the order is created or its items change, and remove rows of items no longer on the order. On delete, finds the row by Swell ID and deletes or flags it, along with its line-item or variant rows. |
| `functions/pull-edits.ts` | Cron, every minute | Writes Airtable edits back to Swell for the tables chosen in settings (see **Two-way editing** below). |
| `functions/sync-run.ts` | `sync.created`, `sync.updated` (status `pending` or `running`) | Runs one step of a sync job. **test:** checks the connection, columns and types. **setup:** creates, renames or recreates up to 12 tables/columns per step. **backfill:** upserts one page of records (sorted by id, after `last_id`). Line-item backfills page through orders and stop at a whole order once the page size is reached. Saving the step's progress triggers the next step, so each step gets its own 10-second function run. On a retryable error, sets the job to `waiting` with `date_retry`. |
| `functions/sync-retry.ts` | Model schedule on `sync.updated`: runs at `date_retry` while the job is `waiting` | Sets the job back to `pending`, which makes `sync-run` retry the step. |
| `functions/sync-all.ts` | Action: **Backfill all synced collections** (sync jobs list) | Creates a pending backfill for each synced table that has no active one. |
| `functions/sync-control.ts` | Actions: **Cancel**, **Resume** (sync job page) | Sets the job to `canceled`, or back to `pending` (a waiting job retries right away). |
| `functions/lib/tables.ts` | Shared | The tables, their columns and the Swell → Airtable mapping. |
| `functions/lib/airtable.ts` | Shared | Settings helpers, Airtable client (upsert, find, delete, parent rows), schema planner and type checks, connection check. |
| `functions/lib/pull.ts` | Shared | Airtable → Swell: finds edited rows, compares them with Swell and writes the differences. |

Sync jobs are stored in the app collection `apps/airtable/syncs` (`models/syncs.json`): `type` (`test`, `setup`, `backfill`), `collection`, `status` (`pending`, `running`, `waiting`, `completed`, `failed`, `canceled`), `date_from`, `replace_columns`, `last_id`, `pages`, `sent`, `total`, `message`, `last_error`, `retries`, `date_retry`, `date_started`, `date_completed`. The dashboard views are in `content/syncs.json`.

Write-back state is stored in the app collection `apps/airtable/pulls` (`models/pulls.json`), one record per table: `table`, `date_cursor`, `offset`, `date_pass_started`, `date_last_run`, `date_last_change`, `changed`, `failed`, `last_error`, `date_last_error`. The dashboard view is in `content/pulls.json`.

### Two-way editing

Airtable can't call a Swell function directly (Swell routes need a public key header that Airtable webhooks can't send), so the app polls:

1. Every minute, `pull-edits` asks Airtable for each write-back table's rows whose ✎ columns changed since the table's cursor: `filterByFormula` with `LAST_MODIFIED_TIME({Name},{SKU},...)`, skipping rows without a Swell ID and rows marked Deleted.
2. It reads those records from Swell (`id $in [...]`, up to 100 at a time) and compares each ✎ cell with the value the column would get from Swell. Only cells that differ are written: one `PUT` to the record with the changed fields, plus a `POST /products:stock` adjustment (new level minus current level) when the stock level changed. Names of products, variants, coupons and categories are stored per language in Swell, and the dashboard shows the value saved for the store's default language (for example `en-US`) whenever there is one. So a name edit is written twice: to the base name and, with `$locale`, to the store's default language, read from `/:clients/:self`. Translations in other languages are left alone.
3. Writing to Swell fires the usual update event, which upserts the row back to Airtable with the same values. The next pull compares them as equal and does nothing, so edits never bounce back and forth.
4. Swell validation errors (an emptied required name, a duplicate SKU, ...) and cells that can't be read (text in a number column) count as **Edits rejected** and show as **Last error**; other rows still go through. The rejected cell keeps its Airtable value until the record changes in Swell.
5. A run stops starting new work after 7 seconds. An unfinished pass keeps its Airtable page offset and continues on the next run. When a pass finishes, the cursor moves to the pass's start time minus one minute (rows in the overlap compare equal). Rate limits, Swell permission denials and outages stop the pass without moving the cursor, so it's retried a minute later.

When write-back is on for a table, live Swell `updated` events send only the ✎ columns whose Swell field changed (from the event's changed fields), so editing a product's name in Swell doesn't overwrite a price edited in Airtable a few seconds earlier. Stock level is always sent, because sales change it.

**Airtable API calls:**
- **Upserts:** `PATCH /v0/{base}/{table}` with `performUpsert.fieldsToMergeOn: ["Swell ID"]`, at most 10 records per request. The response gives each row's Airtable record id, which is used for the links.
- **Lookups:** rows are found with `filterByFormula`, e.g. `{Swell ID}='<id>'`, or `OR(...)` for up to 50 parents at once.
- **Pacing:** the app pauses about 220 ms between requests to stay under Airtable's limit of 5 requests per second per base.
- **Table setup:** uses the Meta API: create table, create field, and update field (only to rename a wrong-type column; Airtable's API can't change a column's type).

**App permissions** (`swell.json`): `[]`, i.e. full store access, the same as the Sendcloud and Fivetran apps. The app only reads orders, customers, products, variants, subscriptions, coupons, categories and its settings. It writes its own `syncs` and `pulls` collections, and, only with write-back on, the ✎ fields of products, variants, customers, coupons and categories plus product stock adjustments. Scoped permissions (`read_orders`, `read_coupons`, ...) were tried, but on an existing install Swell applied newly added permissions to only some requests for hours, so coupon, subscription and category reads failed at random.

## Limits

- **Write-back covers only ✎ columns** of products, variants, customers, coupons and categories. Orders, line items and subscriptions are read-only in Airtable. Rows added or deleted in Airtable are not created or deleted in Swell.
- **About a minute's delay:** Airtable edits reach Swell on the next minute's run. If the same field changes in Swell during that minute, Swell's value wins and the Airtable edit is overwritten. A backfill sends every column and also overwrites edits not yet written back.
- **Only edits made after write-back is turned on** for a table are written back. Earlier differences between Airtable and Swell stay until the record changes in Swell or a backfill runs.
- **Stock edits are adjustments:** changing **Stock level** from 5 to 12 adds a +7 stock adjustment, so sales that happen meanwhile still count. An emptied stock cell is ignored, and fractions are rejected. Stock locations aren't supported.
- **Formatted fields aren't editable:** descriptions, coupon discounts, addresses and other columns holding simplified values (HTML removed, text summaries) can't be mapped back to Swell.
- **Fixed columns:** column names and the mapping are fixed. You can add columns, but you can't rename or remap synced ones.
- **Column types can't be converted in place:** Airtable's API can't change a column's type. **Replace columns with the wrong type** keeps the old column as `<name> (old)` and creates a new one, which stays empty until the next backfill or change. Delete the old column yourself once you no longer need it.
- **Line items are refreshed with their order:** line-item rows update when the order is created or its items change. A line-item backfill doesn't remove rows of items that were removed from orders earlier; live updates do. Orders with more items than the page size are sent in one step, and very large orders (hundreds of items) may hit the 10-second limit.
- **Coupons with many codes:** only single-code coupons show their code. Generated codes of multi-code coupons aren't synced.
- **Rate limits:** Airtable allows 5 requests per second per base. Backfill steps wait and retry automatically, and live updates are retried by Swell about a minute later. Running many backfills at once while the store is busy slows everything down.
- **Backfill speed:** about 50 records per step with the default page size, so large catalogs take a while.
- **Airtable plan limits:** the record limit per base depends on your plan (1,000 on Free). Line items and variants add up quickly. Syncs fail with Airtable's error once the base is full.
- **Long text:** values longer than 100,000 characters are truncated.
- **Duplicate Swell IDs:** if two rows have the same Swell ID (for example, a row you copied by hand), upserts for that record fail until one is removed.
- **Deleted column:** with **Check the row's Deleted column**, rows are flagged but stay in the table.
- **Permission changes take a while:** after an app's permissions change, Swell can deny some requests to collections for a long time. Sync jobs wait and retry; live updates are retried by Swell. If it persists, reinstalling the app gives it new API keys with fresh permissions.

## Development

Requirements: Node 20+, the [Swell CLI](https://developers.swell.is/cli) logged in to a store (`swell login`).

```bash
npm install
npm run typecheck          # functions and tests
npm test                   # unit + integration tests (vitest, Cloudflare workers pool)
npx vitest run test/unit   # unit tests only, no store needed
swell app push             # deploy to the test environment
swell app push --force     # after changes in functions/lib only
swell app dev              # run model events locally against the test store
swell inspect functions --app=.
swell logs --type function -s record-events
```

- **Unit tests** (`test/unit/`) mock `fetch` and `req.swell`. `test/helpers/fixtures.ts` has `airtableFetch()`, which answers like Airtable (upserts echo their rows with record ids, lookups and table lists are configurable). Every exported function in `functions/` has tests.
- **Integration tests** (`test/integration/`) are read-only. They use the Swell CLI session to read the app settings, the `syncs` collection and a page of each synced table. Run `swell app push` first.
- **Testing against Airtable:** create a scratch base and a token, enter them in the app settings in the **test** environment, and run the setup steps above. To trigger sync jobs from the CLI: `swell api post /apps/airtable/syncs --body '{"type":"test"}'`. In Git Bash on Windows, set `MSYS_NO_PATHCONV=1` first so paths starting with `/` aren't rewritten.
- **Testing retries:** put a job in `waiting` with an update, e.g. `swell api put /apps/airtable/syncs/<id> --body '{"status":"waiting","date_retry":"<a minute from now>"}'`. The schedule registers on `sync.updated`, not on create.
- **Making a column editable:** set `writeTo` on the column in `functions/lib/tables.ts` to the Swell field (or `STOCK`), add it to the table's option label in `settings/airtable.json`, mark it ✎ in this README and extend `test/unit/pull.test.ts`. The Airtable value goes through `cellValue` and is compared with `column.value(record)`, so the column's mapping must be reversible (plain text, number, checkbox or date).
- **Testing write-back:** turn on a table in **Write Airtable edits back to Swell**, wait for its row under **Airtable edits**, edit a ✎ cell in Airtable, and check the record in Swell a minute later. `swell logs --type function -s pull-edits` shows the runs.
- **Adding a column:** add it to the table's `columns` in `functions/lib/tables.ts`. Run a **Create tables & columns** job to add it to existing bases, update the column list in this README, and extend the mapping tests.
- **Changing a column's type:** change it in `functions/lib/tables.ts` and check `COMPATIBLE_TYPES` in `functions/lib/airtable.ts`. Existing bases then report the column as a wrong type. Tell merchants to run setup with **Replace columns with the wrong type**, then a backfill.
- **Adding a table:** add an entry to `TABLES` in `functions/lib/tables.ts`, its events to `functions/record-events.ts`, a table setting and option to `settings/airtable.json`, the option to `models/syncs.json` and `content/syncs.json`, and the `read_<collection>` permission to `swell.json`. Child tables also need `parent`, `linkColumn` and `parentIdColumn`.
