import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from './app.js';
import {
  decryptAccountCookie,
  decryptAccountUserAgent,
  lookupTikTokIdentity,
  type AccountMetadata,
  type IdentityLookup,
  type StoredAccount,
} from './accounts.js';

test('health reports dependencies ready when all checks succeed', async () => {
  const app = createApp({
    postgres: async () => {},
    redis: async () => {},
    worker: async () => true,
  });
  const result = await app.inject('/health/ready');
  assert.equal(result.statusCode, 200);
  assert.deepEqual(result.json().dependencies, {
    postgres: 'ready',
    redis: 'ready',
    worker: 'ready',
  });
  await app.close();
});

test('health reports degraded without leaking connection errors', async () => {
  const app = createApp({
    postgres: async () => {
      throw new Error('private URL');
    },
    redis: async () => {},
    worker: async () => false,
  });
  const result = await app.inject('/health/ready');
  assert.equal(result.statusCode, 503);
  assert.equal(result.json().status, 'degraded');
  assert.equal(result.body.includes('private URL'), false);
  await app.close();
});

test('mock stats map into a validated shared event', async () => {
  const app = createApp({
    postgres: async () => {},
    redis: async () => {},
    worker: async () => true,
  });
  const result = await app.inject('/api/v1/mock/live-stats');
  assert.equal(result.statusCode, 200);
  assert.equal(result.json().source, 'mock');
  assert.equal(result.json().verification.status, 'pending_verification');
  assert.equal(result.json().event.eventType, 'stats.updated');
  assert.equal(result.json().contract, 'valid');
  await app.close();
});

const syntheticCurl =
  "curl 'https://www.tiktok.com/api/update/profile/' -X HEAD " +
  "-b 'sessionid=fake-session-only' " +
  "-H 'referer: https://www.tiktok.com/@sample.user' " +
  "-H 'user-agent: Synthetic Test Browser'";
const headers = {
  'x-internal-token': 'synthetic-internal-token-1234567890123456',
  'x-livehub-owner': 'owner-1',
};

function metadata(row: StoredAccount): AccountMetadata {
  return {
    id: row.id,
    alias: row.alias,
    ...(row.claimedHandle === undefined ? {} : { claimedHandle: row.claimedHandle }),
    ...(row.verifiedHandle === undefined ? {} : { verifiedHandle: row.verifiedHandle }),
    ...(row.avatarUrl === undefined ? {} : { avatarUrl: row.avatarUrl }),
    ...(row.verifiedAt === undefined ? {} : { verifiedAt: row.verifiedAt }),
    verificationStatus: row.verificationStatus,
    probe: row.probe,
    probeHttpStatus: row.probeHttpStatus,
    createdAt: row.createdAt,
  };
}

function accountFixture(identityLookup: IdentityLookup) {
  const rows: StoredAccount[] = [];
  const key = Buffer.alloc(32, 7);
  const config = {
    encryptionKey: key,
    internalToken: headers['x-internal-token'],
    identityLookup,
    store: {
      list: async (ownerId: string) => rows.filter((row) => row.ownerId === ownerId).map(metadata),
      insert: async (row: StoredAccount) => {
        rows.push(row);
        return metadata(row);
      },
      findEncrypted: async (ownerId: string, id: string) => {
        const row = rows.find((item) => item.ownerId === ownerId && item.id === id);
        if (!row) return null;
        return {
          id: row.id,
          ownerId: row.ownerId,
          ciphertext: row.ciphertext,
          iv: row.iv,
          tag: row.tag,
          ...(row.userAgent ? { userAgent: row.userAgent } : {}),
        };
      },
      setVerification: async (
        ownerId: string,
        id: string,
        identity: Awaited<ReturnType<IdentityLookup>>,
      ) => {
        const row = rows.find((item) => item.ownerId === ownerId && item.id === id);
        if (!row) return null;
        row.verificationStatus = identity ? 'connected' : 'disconnected';
        if (identity) {
          row.verifiedAt = new Date().toISOString();
          row.verifiedHandle = identity.username;
          row.verifiedUserId = identity.userId;
          row.avatarUrl = identity.avatarUrl;
        } else {
          row.verifiedAt = undefined;
          row.verifiedHandle = undefined;
          row.verifiedUserId = undefined;
          row.avatarUrl = undefined;
        }
        return metadata(row);
      },
    },
  };
  return { rows, key, config };
}

test('account routes require internal token and authenticated owner header', async () => {
  const fixture = accountFixture(async () => null);
  const app = createApp(
    { postgres: async () => {}, redis: async () => {}, worker: async () => true },
    fixture.config,
  );
  assert.equal((await app.inject('/api/v1/accounts')).statusCode, 401);
  assert.equal(
    (
      await app.inject({
        method: 'GET',
        url: '/api/v1/accounts',
        headers: {
          ...headers,
          'x-internal-token': 'wrong',
        },
      })
    ).statusCode,
    401,
  );
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: '/api/v1/accounts/import',
        headers: {
          'x-internal-token': headers['x-internal-token'],
        },
        payload: { alias: 'Sample', curl: syntheticCurl },
      })
    ).statusCode,
    401,
  );
  assert.equal(fixture.rows.length, 0);
  await app.close();

  const unconfigured = createApp({
    postgres: async () => {},
    redis: async () => {},
    worker: async () => true,
  });
  assert.equal((await unconfigured.inject('/api/v1/accounts')).statusCode, 503);
  await unconfigured.close();
});

test('authenticated identity connects the account and stores only encrypted cookie', async () => {
  const fixture = accountFixture(async (cookieHeader, userAgent) => {
    assert.equal(cookieHeader, 'sessionid=fake-session-only');
    assert.equal(userAgent, 'Synthetic Test Browser');
    return {
      userId: '1234567890123456789',
      username: 'sample.user',
      avatarUrl: 'https://cdn.example/avatar',
    };
  });
  const app = createApp(
    { postgres: async () => {}, redis: async () => {}, worker: async () => true },
    fixture.config,
  );
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/accounts/import',
    headers,
    payload: { alias: '  Sample Account  ', curl: syntheticCurl },
  });
  assert.equal(response.statusCode, 201);
  assert.deepEqual(response.json().item, {
    id: fixture.rows[0].id,
    alias: 'Sample Account',
    claimedHandle: 'sample.user',
    verifiedHandle: 'sample.user',
    avatarUrl: 'https://cdn.example/avatar',
    verifiedAt: fixture.rows[0].verifiedAt,
    verificationStatus: 'connected',
    probe: 'not_run',
    probeHttpStatus: null,
    createdAt: fixture.rows[0].createdAt,
  });
  assert.equal(response.body.includes('fake-session-only'), false);
  assert.equal(response.body.includes('curl'), false);
  assert.equal(fixture.rows[0].ciphertext.includes(Buffer.from('fake-session-only')), false);
  assert.equal(fixture.rows[0].iv.length, 12);
  assert.equal(fixture.rows[0].tag.length, 16);
  assert.ok(fixture.rows[0].userAgent);
  assert.equal(
    fixture.rows[0].userAgent?.ciphertext.includes(Buffer.from('Synthetic Test Browser')),
    false,
  );

  assert.equal(
    decryptAccountCookie(fixture.rows[0], fixture.key, 'owner-1', fixture.rows[0].id),
    'sessionid=fake-session-only',
  );
  assert.equal(
    decryptAccountUserAgent(fixture.rows[0].userAgent!, fixture.key, 'owner-1', fixture.rows[0].id),
    'Synthetic Test Browser',
  );

  const list = await app.inject({ method: 'GET', url: '/api/v1/accounts', headers });
  assert.equal(list.statusCode, 200);
  assert.equal(list.json().items.length, 1);
  assert.equal(list.body.includes('fake-session-only'), false);
  const otherOwner = await app.inject({
    method: 'GET',
    url: '/api/v1/accounts',
    headers: {
      ...headers,
      'x-livehub-owner': 'owner-2',
    },
  });
  assert.deepEqual(otherOwner.json(), { items: [] });
  await app.close();
});

test('invalid cURL and unavailable identity never create a connected account', async () => {
  const fixture = accountFixture(async () => {
    throw new Error('fake-private-session-value');
  });
  const app = createApp(
    { postgres: async () => {}, redis: async () => {}, worker: async () => true },
    fixture.config,
  );
  const invalid = await app.inject({
    method: 'POST',
    url: '/api/v1/accounts/import',
    headers,
    payload: { alias: 'Bad', curl: syntheticCurl.replace('-X HEAD', '-X POST') },
  });
  assert.equal(invalid.statusCode, 400);
  assert.equal(invalid.body.includes('fake-session-only'), false);
  assert.equal(fixture.rows.length, 0);

  const unavailable = await app.inject({
    method: 'POST',
    url: '/api/v1/accounts/import',
    headers,
    payload: { alias: 'Sample', curl: syntheticCurl },
  });
  assert.equal(unavailable.statusCode, 503);
  assert.equal(unavailable.body.includes('fake-private-session-value'), false);
  assert.equal(fixture.rows.length, 0);
  await app.close();

  const unauthenticated = accountFixture(async () => null);
  const second = createApp(
    { postgres: async () => {}, redis: async () => {}, worker: async () => true },
    unauthenticated.config,
  );
  const response = await second.inject({
    method: 'POST',
    url: '/api/v1/accounts/import',
    headers,
    payload: { alias: 'Sample', curl: syntheticCurl },
  });
  assert.equal(response.statusCode, 422);
  assert.equal(unauthenticated.rows.length, 0);
  await second.close();
});

test('recheck uses the encrypted cookie and original User-Agent, then clears stale identity', async () => {
  let active = true;
  const fixture = accountFixture(async (cookieHeader, userAgent) => {
    assert.equal(cookieHeader, 'sessionid=fake-session-only');
    assert.equal(userAgent, 'Synthetic Test Browser');
    return active
      ? {
          userId: '1234567890123456789',
          username: 'sample.user',
          avatarUrl: 'https://cdn.example/avatar',
        }
      : null;
  });
  const app = createApp(
    { postgres: async () => {}, redis: async () => {}, worker: async () => true },
    fixture.config,
  );
  const imported = await app.inject({
    method: 'POST',
    url: '/api/v1/accounts/import',
    headers,
    payload: { alias: 'Sample', curl: syntheticCurl },
  });
  const id = imported.json().item.id as string;
  assert.equal(imported.statusCode, 201);
  const verifyUrl = `/api/v1/accounts/${id}/verify`;
  assert.equal((await app.inject({ method: 'POST', url: verifyUrl })).statusCode, 401);
  active = false;
  const result = await app.inject({ method: 'POST', url: verifyUrl, headers });
  assert.equal(result.statusCode, 200);
  assert.equal(result.json().item.verificationStatus, 'disconnected');
  assert.equal(result.json().item.verifiedHandle, undefined);
  assert.equal(result.json().item.avatarUrl, undefined);
  assert.equal(result.json().item.verifiedAt, undefined);
  assert.equal(result.body.includes('fake-session-only'), false);
  await app.close();
});

test('identity lookup accepts a successful numeric error_code of zero', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        data: {
          error_code: 0,
          user_id_str: '1234567890123456789',
          username: 'sample.user',
        },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  try {
    assert.deepEqual(await lookupTikTokIdentity('sessionid=fake-session'), {
      userId: '1234567890123456789',
      username: 'sample.user',
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
