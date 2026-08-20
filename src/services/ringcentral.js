import { config } from '../config.js';

/**
 * Minimal RingCentral SMS client: JWT auth + one endpoint. The full SDK brings a
 * lot of surface for the one call we make.
 */

let cachedToken = null; // { value, expiresAt }

async function getAccessToken(fetchImpl = fetch) {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) {
    return cachedToken.value;
  }
  const { serverUrl, clientId, clientSecret, jwt } = config.ringcentral;
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const response = await fetchImpl(`${serverUrl}/restapi/oauth/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(
      `RingCentral auth failed (${response.status}). Check the client id/secret and that the JWT is for this environment. ${body.slice(0, 200)}`,
    );
  }

  const payload = await response.json();
  cachedToken = {
    value: payload.access_token,
    expiresAt: Date.now() + Number(payload.expires_in || 3600) * 1000,
  };
  return cachedToken.value;
}

export function resetTokenCache() {
  cachedToken = null;
}

/**
 * @returns {Promise<{id: string, to: string, dryRun: boolean}>}
 */
export async function sendSms({ to, text }, fetchImpl = fetch) {
  if (!config.ringcentral.enabled) {
    throw new Error(
      'RingCentral is not configured. Fill in the RINGCENTRAL_* values in .env to enable the SMS fallback.',
    );
  }
  if (!to) throw new Error('No destination number for the SMS.');
  if (!text || !text.trim()) throw new Error('Refusing to send an empty SMS.');

  if (config.dryRun) {
    console.log(`[dry-run] SMS to ${to}:\n${text}`);
    return { id: 'dry-run', to, dryRun: true };
  }

  const token = await getAccessToken(fetchImpl);
  const response = await fetchImpl(
    `${config.ringcentral.serverUrl}/restapi/v1.0/account/~/extension/~/sms`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        from: { phoneNumber: config.ringcentral.fromNumber },
        to: [{ phoneNumber: to }],
        text,
      }),
    },
  );

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    // A stale token is the one failure worth retrying automatically.
    if (response.status === 401) {
      resetTokenCache();
      throw new Error('RingCentral rejected the access token — try the send again.');
    }
    throw new Error(`RingCentral SMS failed (${response.status}): ${body.slice(0, 300)}`);
  }

  const payload = await response.json();
  return { id: payload.id ? String(payload.id) : 'unknown', to, dryRun: false };
}

/** SMS segments are 160 chars, or 70 if any non-GSM character sneaks in. */
export function estimateSegments(text) {
  const body = String(text || '');
  const unicode = /[^\x20-\x7e\n\r]/.test(body);
  const single = unicode ? 70 : 160;
  const concatenated = unicode ? 67 : 153;
  if (body.length <= single) return 1;
  return Math.ceil(body.length / concatenated);
}
