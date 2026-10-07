import { SETUP_BUDGET_MS, errorMessage, getAirtableSettings, isConfigured, setupTables } from './lib/airtable';

export const config: SwellConfig = {
  description: 'Create missing Airtable tables and columns',
  action: true,
};

export default async function (req: SwellRequest) {
  const { swell, data } = req;
  const deadline = Date.now() + SETUP_BUDGET_MS;

  const settings = await getAirtableSettings(swell);
  if (!isConfigured(settings)) {
    throw new SwellError('Set the Airtable access token and base ID in the app settings first', { status: 400 });
  }
  try {
    const { message } = await setupTables(settings, data.replace_columns === true, deadline);
    return { message };
  } catch (err) {
    throw new SwellError(errorMessage(err), { status: 400 });
  }
}
