import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { audioWindow } from './boxphone-audio.js';
import { registerLiveRoutes } from './live-routes.js';
import { LiveError, type LiveService } from './live-service.js';

test('looping audio aligns with elapsed playback and rejects oversized or invalid windows', () => {
  assert.deepEqual(audioWindow(120, 255, 30, true), { start: 15, seconds: 30, duration: 120 });
  assert.throws(() => audioWindow(120, 120, 30, false));
  for (const seconds of [-1, 0, 61, NaN]) assert.throws(() => audioWindow(120, 0, seconds, true));
  assert.throws(() => audioWindow(0, 0, 30, true));
});
test('audio extraction rejects unauthorized and unowned files before launching FFmpeg', async () => {
  const app = Fastify();
  let ownerChecked = '';
  const service = {
    stopAll: async () => {},
    videoFile: async (owner: string) => {
      ownerChecked = owner;
      throw new LiveError(404, 'Video not found.');
    },
  } as unknown as LiveService;
  registerLiveRoutes(app, service, (h) => (h['x-owner'] === 'alice' ? 'alice' : null));
  const url = '/api/v1/live/boxphone/audio';
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url,
        payload: { videoId: '00000000-0000-4000-8000-000000000001' },
      })
    ).statusCode,
    401,
  );
  assert.equal(ownerChecked, '');
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url,
        headers: { 'x-owner': 'alice' },
        payload: { videoId: '../../etc/passwd' },
      })
    ).statusCode,
    400,
  );
  assert.equal(ownerChecked, '');
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url,
        headers: { 'x-owner': 'alice' },
        payload: { videoId: '00000000-0000-4000-8000-000000000001' },
      })
    ).statusCode,
    404,
  );
  assert.equal(ownerChecked, 'alice');
  await app.close();
});
test('channel audio waits when offline or before enough audio has been played', async () => {
  const app = Fastify();
  let status = 'idle';
  let fileReads = 0;
  const service = {
    stopAll: async () => {},
    session: async () => ({
      status,
      videoId: '00000000-0000-4000-8000-000000000001',
      startedAt: new Date().toISOString(),
    }),
    videoFile: async () => {
      fileReads++;
    },
  } as unknown as LiveService;
  registerLiveRoutes(app, service, () => 'alice');
  const query = {
    method: 'POST' as const,
    url: '/api/v1/live/boxphone/audio',
    payload: { accountId: '00000000-0000-4000-8000-000000000002' },
  };
  assert.equal((await app.inject(query)).statusCode, 409);
  status = 'live';
  assert.equal((await app.inject(query)).statusCode, 409);
  assert.equal(fileReads, 0);
  await app.close();
});
