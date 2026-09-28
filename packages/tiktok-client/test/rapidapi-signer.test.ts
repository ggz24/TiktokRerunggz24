import assert from 'node:assert/strict';
import test from 'node:test';
import { createRapidApiRoomSigner } from '../src';

const input = {
  timestamp: 1780000000,
  aid: '8311' as const,
  device_id: '1234567890',
  params: { aid: '8311', device_id: '1234567890' },
  query: 'aid=8311&device_id=1234567890',
  stub: '0123456789abcdef0123456789abcdef',
};

test('sends only signing fields to the fixed RapidAPI host', async () => {
  const sign = createRapidApiRoomSigner('fake-test-key', async (url, init) => {
    assert.equal(
      new URL(String(url)).href,
      'https://tiktok-live-studio-api-signer1.p.rapidapi.com/signatures',
    );
    assert.equal(init?.method, 'POST');
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('x-rapidapi-key'), 'fake-test-key');
    assert.equal(headers.get('x-rapidapi-host'), 'tiktok-live-studio-api-signer1.p.rapidapi.com');
    assert.deepEqual(JSON.parse(String(init?.body)), {
      timestamp: input.timestamp,
      aid: input.aid,
      device_id: input.device_id,
      license_id: 1877999593,
      params: input.params,
      stub: input.stub,
    });
    return Response.json({
      headers: { 'x-khronos': '1780000000', 'x-ladon': 'ladon', 'x-argus': 'argus' },
    });
  });
  assert.deepEqual(await sign(input), {
    'x-khronos': '1780000000',
    'x-ladon': 'ladon',
    'x-argus': 'argus',
  });
});

test('rejects missing key and incomplete signatures without revealing API responses', async () => {
  assert.throws(() => createRapidApiRoomSigner(''), /not configured/);
  const sign = createRapidApiRoomSigner('fake-test-key', async () =>
    Response.json({ headers: { 'x-khronos': '1780000000', 'x-ladon': 'secret' } }),
  );
  await assert.rejects(sign(input), (error: Error) => !error.message.includes('secret'));
  const failed = createRapidApiRoomSigner(
    'fake-test-key',
    async () => new Response('private error details', { status: 403 }),
  );
  await assert.rejects(failed(input), (error: Error) => !error.message.includes('private'));
});
