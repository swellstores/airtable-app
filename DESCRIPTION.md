Keep your store's orders, customers, products and more in an Airtable base that updates itself. Every Swell record becomes one Airtable row, created, updated and removed as the record changes, so your team can filter, report and plan in Airtable without exports.

Connect a base with an Airtable personal access token and its base ID, pick the collections to sync and let the app create the tables. From then on, each change in Swell appears in Airtable within a few seconds.

- **Multiple tables.** Orders, order line items, customers, products, product variants, subscriptions, coupons and categories. Orders, customers and products are on by default.
- **Tables set up for you.** One action creates the tables with typed columns, or adds only the missing columns to tables you already have. Your own extra columns are left alone.
- **Linked rows.** Line items link to their order row and variants to their product row, and rows are matched on the Swell ID column, so updates never create duplicates.
- **Edit in Airtable, update Swell.** Turn on write-back per table, and edits to names, SKUs, prices, active flags, stock levels and other marked columns are written to Swell within about 5 minutes. A stock level edit becomes a stock adjustment.
- **Backfill your history.** Send existing records per table or all at once, optionally only those created after a date, with progress, cancel and resume.
- **Deletions your way.** When a record is deleted in Swell, delete its row, check its Deleted column or keep it unchanged.
- **Runs on its own.** Rate limits and Airtable errors are retried automatically, and a connection test checks the token, base, tables and every column type.

Setup takes a few minutes. In Airtable, create a personal access token with the data.records:read, data.records:write, schema.bases:read and schema.bases:write scopes and give it access to your base. Paste the token and base ID in the app settings and save. Then run Create tables & columns from the app's Actions menu, and Backfill all synced collections under Airtable syncs in the dashboard sidebar.
