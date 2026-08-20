import test from 'node:test';
import assert from 'node:assert/strict';

// config.js reads the environment once, at import time.
process.env.RINGCENTRAL_CLIENT_ID = 'client-id';
process.env.RINGCENTRAL_CLIENT_SECRET = 'client-secret';
process.env.RINGCENTRAL_JWT = 'jwt-token';
process.env.RINGCENTRAL_FROM_NUMBER = '+15550000000';
process.env.RINGCENTRAL_SERVER_URL = 'https://platform.devtest.ringcentral.com';
process.env.DRY_RUN = '0';

const { sendSms, resetTokenCache, estimateSegments } = await import('../src/services/ringcentral.js');

function ok(body) {
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
}
function fail(status, body = 'nope') {
  return { ok: false, status, json: async () => ({}), text: async () => body };
}

/** Records every call so we can assert on what RingCentral would have received. */
function mockFetch(handlers) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url: String(url), init });
    const handler = String(url).includes('/oauth/token') ? handlers.auth : handlers.sms;
    return typeof handler === 'function' ? handler(calls.length) : handler;
  };
  impl.calls = calls;
  return impl;
}

test('a text authenticates by JWT and posts to the SMS endpoint', async () => {
  resetTokenCache();
  const fetchImpl = mockFetch({
    auth: ok({ access_token: 'tok-1', expires_in: 3600 }),
    sms: ok({ id: 4242 }),
  });

  const result = await sendSms({ to: '+15550102233', text: 'Ready Friday' }, fetchImpl);
  assert.deepEqual(result, { id: '4242', to: '+15550102233', dryRun: false });

  const [auth, sms] = fetchImpl.calls;
  assert.match(auth.url, /platform\.devtest\.ringcentral\.com\/restapi\/oauth\/token$/);
  assert.equal(
    auth.init.headers.Authorization,
    `Basic ${Buffer.from('client-id:client-secret').toString('base64')}`,
  );
  assert.match(auth.init.body.toString(), /grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer/);
  assert.match(auth.init.body.toString(), /assertion=jwt-token/);

  assert.match(sms.url, /\/restapi\/v1\.0\/account\/~\/extension\/~\/sms$/);
  assert.equal(sms.init.headers.Authorization, 'Bearer tok-1');
  assert.deepEqual(JSON.parse(sms.init.body), {
    from: { phoneNumber: '+15550000000' },
    to: [{ phoneNumber: '+15550102233' }],
    text: 'Ready Friday',
  });
});

test('the access token is reused instead of re-fetched for every text', async () => {
  resetTokenCache();
  const fetchImpl = mockFetch({
    auth: ok({ access_token: 'tok-1', expires_in: 3600 }),
    sms: ok({ id: 1 }),
  });

  await sendSms({ to: '+15550102233', text: 'one' }, fetchImpl);
  await sendSms({ to: '+15550102233', text: 'two' }, fetchImpl);

  const authCalls = fetchImpl.calls.filter((call) => call.url.includes('/oauth/token'));
  assert.equal(authCalls.length, 1);
});

test('a token that expires soon is not reused', async () => {
  resetTokenCache();
  const fetchImpl = mockFetch({
    auth: ok({ access_token: 'tok-short', expires_in: 30 }),
    sms: ok({ id: 1 }),
  });

  await sendSms({ to: '+15550102233', text: 'one' }, fetchImpl);
  await sendSms({ to: '+15550102233', text: 'two' }, fetchImpl);

  const authCalls = fetchImpl.calls.filter((call) => call.url.includes('/oauth/token'));
  assert.equal(authCalls.length, 2);
});

test('a rejected token is cleared so the retry can succeed', async () => {
  resetTokenCache();
  const fetchImpl = mockFetch({
    auth: ok({ access_token: 'stale', expires_in: 3600 }),
    sms: fail(401),
  });

  await assert.rejects(
    () => sendSms({ to: '+15550102233', text: 'hi' }, fetchImpl),
    /try the send again/,
  );

  const good = mockFetch({
    auth: ok({ access_token: 'fresh', expires_in: 3600 }),
    sms: ok({ id: 7 }),
  });
  const result = await sendSms({ to: '+15550102233', text: 'hi' }, good);
  assert.equal(result.id, '7');
  assert.equal(good.calls[0].url.includes('/oauth/token'), true, 'it re-authenticated');
});

test('a bad credential explains itself', async () => {
  resetTokenCache();
  const fetchImpl = mockFetch({ auth: fail(400, 'invalid_grant'), sms: ok({}) });
  await assert.rejects(
    () => sendSms({ to: '+15550102233', text: 'hi' }, fetchImpl),
    /RingCentral auth failed \(400\).*invalid_grant/s,
  );
});

test('a rejected send surfaces RingCentral\'s own reason', async () => {
  resetTokenCache();
  const fetchImpl = mockFetch({
    auth: ok({ access_token: 'tok', expires_in: 3600 }),
    sms: fail(400, 'Phone number is invalid'),
  });
  await assert.rejects(
    () => sendSms({ to: '+1555', text: 'hi' }, fetchImpl),
    /RingCentral SMS failed \(400\): Phone number is invalid/,
  );
});

test('empty texts and missing numbers never reach the network', async () => {
  resetTokenCache();
  const fetchImpl = mockFetch({ auth: ok({}), sms: ok({}) });
  await assert.rejects(() => sendSms({ to: '', text: 'hi' }, fetchImpl), /No destination number/);
  await assert.rejects(() => sendSms({ to: '+15550102233', text: '  ' }, fetchImpl), /empty SMS/);
  assert.equal(fetchImpl.calls.length, 0);
});

test('segment counting matches how carriers bill', () => {
  assert.equal(estimateSegments('short'), 1);
  assert.equal(estimateSegments('a'.repeat(160)), 1);
  assert.equal(estimateSegments('a'.repeat(161)), 2);
  assert.equal(estimateSegments('a'.repeat(306)), 2);
  assert.equal(estimateSegments('a'.repeat(307)), 3);
  // One emoji drops the whole message to the 70-character unicode limit.
  assert.equal(estimateSegments('👋'.repeat(35)), 1);
  assert.equal(estimateSegments(`${'a'.repeat(70)}👋`), 2);
});
