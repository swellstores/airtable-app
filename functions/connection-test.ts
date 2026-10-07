import { checkConnection, errorMessage, getAirtableSettings, isConfigured } from './lib/airtable';

export const config: SwellConfig = {
  description: 'Check the Airtable token, base, tables and columns',
  action: true,
};

export default async function (req: SwellRequest) {
  const settings = await getAirtableSettings(req.swell);
  if (!isConfigured(settings)) {
    throw new SwellError('Set the Airtable access token and base ID in the app settings first', { status: 400 });
  }
  try {
    return { message: await checkConnection(settings) };
  } catch (err) {
    throw new SwellError(errorMessage(err), { status: 400 });
  }
}
