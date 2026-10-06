import { createReadStream } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import type { Readable } from 'node:stream';
import { LiveError, LiveService } from './live-service.js';
import type { AutoLiveManager } from './auto-live.js';
import { resolveBoxphoneAudio } from './boxphone-audio.js';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function failure(
  reply: { status: (statusCode: number) => { send: (body: object) => unknown } },
  error: unknown,
) {
  const statusCode = error instanceof LiveError ? error.statusCode : 503;
  const message = error instanceof LiveError ? error.message : 'Live service is unavailable.';
  return reply.status(statusCode).send({ error: message });
}

export function registerLiveRoutes(
  app: FastifyInstance,
  service: LiveService,
  ownerFromHeaders: (headers: Record<string, unknown>) => string | null,
  onRoomStarted?: (
    ownerId: string,
    accountId: string,
    roomId: string,
  ) => Promise<'accepted' | 'rejected' | 'unverified' | 'none'>,
  autoLive?: AutoLiveManager,
): void {
  app.addContentTypeParser(['video/mp4', 'application/octet-stream'], (_request, payload, done) =>
    done(null, payload),
  );

  app.get('/api/v1/live/sessions/:accountId/boxphone-target', async (request, reply) => {
    const ownerId = ownerFromHeaders(request.headers);
    if (!ownerId) return reply.status(401).send({ error: 'Unauthorized.' });
    const { accountId } = request.params as { accountId: string };
    if (!uuidPattern.test(accountId))
      return reply.status(400).send({ error: 'Invalid account ID.' });
    try {
      return {
        item: await service.session(ownerId, accountId),
        roomId: await service.currentRoomId(ownerId, accountId),
      };
    } catch (error) {
      return failure(reply, error);
    }
  });

  app.post('/api/v1/live/boxphone/audio', { bodyLimit: 4096 }, async (request, reply) => {
    const ownerId = ownerFromHeaders(request.headers);
    if (!ownerId) return reply.status(401).send({ error: 'Unauthorized.' });
    const body = (request.body ?? {}) as {
      videoId?: unknown;
      accountId?: unknown;
      startSeconds?: unknown;
      seconds?: unknown;
    };
    try {
      const resolved = await resolveBoxphoneAudio(service, ownerId, body);
      reply.header('Cache-Control', 'no-store');
      return resolved;
    } catch (error) {
      return failure(reply, error);
    }
  });

  app.get('/api/v1/live/videos', async (request, reply) => {
    const ownerId = ownerFromHeaders(request.headers);
    if (!ownerId) return reply.status(401).send({ error: 'Unauthorized.' });
    try {
      return { items: await service.listVideos(ownerId) };
    } catch (error) {
      return failure(reply, error);
    }
  });

  app.post('/api/v1/live/videos', async (request, reply) => {
    const ownerId = ownerFromHeaders(request.headers);
    if (!ownerId) return reply.status(401).send({ error: 'Unauthorized.' });
    const rawName = request.headers['x-file-name'];
    if (typeof rawName !== 'string') {
      return reply.status(400).send({ error: 'Video file name is required.' });
    }
    let name: string;
    try {
      name = decodeURIComponent(rawName);
    } catch {
      return reply.status(400).send({ error: 'Invalid video file name.' });
    }
    if (!request.body || typeof (request.body as Readable).pipe !== 'function') {
      return reply.status(415).send({ error: 'Upload an MP4 file.' });
    }
    try {
      const item = await service.uploadVideo(ownerId, name, request.body as Readable);
      return reply.status(201).send({ item });
    } catch (error) {
      return failure(reply, error);
    }
  });

  app.get('/api/v1/live/videos/:videoId/file', async (request, reply) => {
    const ownerId = ownerFromHeaders(request.headers);
    if (!ownerId) return reply.status(401).send({ error: 'Unauthorized.' });
    const { videoId } = request.params as { videoId: string };
    let file: { path: string; size: number };
    try {
      file = await service.videoFile(ownerId, videoId);
    } catch (error) {
      return failure(reply, error);
    }
    const header = request.headers.range;
    let start = 0;
    let end = file.size - 1;
    let status = 200;
    if (typeof header === 'string') {
      const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
      if (!match || (match[1] === '' && match[2] === '')) {
        return reply.status(416).header('content-range', `bytes */${file.size}`).send();
      }
      if (match[1] === '') {
        const suffix = Number(match[2]);
        start = Math.max(0, file.size - suffix);
      } else {
        start = Number(match[1]);
        if (match[2] !== '') end = Math.min(Number(match[2]), file.size - 1);
      }
      if (!(start <= end) || start >= file.size) {
        return reply.status(416).header('content-range', `bytes */${file.size}`).send();
      }
      status = 206;
    }
    reply
      .status(status)
      .header('content-type', 'video/mp4')
      .header('accept-ranges', 'bytes')
      .header('content-length', String(end - start + 1))
      .header('cache-control', 'private, no-store');
    if (status === 206) reply.header('content-range', `bytes ${start}-${end}/${file.size}`);
    return reply.send(createReadStream(file.path, { start, end }));
  });

  app.post('/api/v1/live/uploads', { bodyLimit: 4_096 }, async (request, reply) => {
    const ownerId = ownerFromHeaders(request.headers);
    if (!ownerId) return reply.status(401).send({ error: 'Unauthorized.' });
    const body = (request.body ?? {}) as { name?: unknown; size?: unknown };
    try {
      return reply.status(201).send(await service.createUpload(ownerId, body.name, body.size));
    } catch (error) {
      return failure(reply, error);
    }
  });

  app.get('/api/v1/live/uploads/:uploadId', async (request, reply) => {
    const ownerId = ownerFromHeaders(request.headers);
    if (!ownerId) return reply.status(401).send({ error: 'Unauthorized.' });
    const { uploadId } = request.params as { uploadId: string };
    try {
      return await service.uploadStatus(ownerId, uploadId);
    } catch (error) {
      return failure(reply, error);
    }
  });

  app.put('/api/v1/live/uploads/:uploadId/chunks/:index', async (request, reply) => {
    const ownerId = ownerFromHeaders(request.headers);
    if (!ownerId) return reply.status(401).send({ error: 'Unauthorized.' });
    const { uploadId, index } = request.params as { uploadId: string; index: string };
    if (!request.body || typeof (request.body as Readable).pipe !== 'function') {
      return reply.status(415).send({ error: 'Send the chunk as application/octet-stream.' });
    }
    try {
      await service.writeUploadChunk(ownerId, uploadId, Number(index), request.body as Readable);
      return reply.status(200).send({ ok: true });
    } catch (error) {
      return failure(reply, error);
    }
  });

  app.post('/api/v1/live/uploads/:uploadId/complete', async (request, reply) => {
    const ownerId = ownerFromHeaders(request.headers);
    if (!ownerId) return reply.status(401).send({ error: 'Unauthorized.' });
    const { uploadId } = request.params as { uploadId: string };
    try {
      return reply.status(202).send(await service.completeUpload(ownerId, uploadId));
    } catch (error) {
      return failure(reply, error);
    }
  });

  app.delete('/api/v1/live/uploads/:uploadId', async (request, reply) => {
    const ownerId = ownerFromHeaders(request.headers);
    if (!ownerId) return reply.status(401).send({ error: 'Unauthorized.' });
    const { uploadId } = request.params as { uploadId: string };
    try {
      await service.cancelUpload(ownerId, uploadId);
      return reply.status(204).send();
    } catch (error) {
      return failure(reply, error);
    }
  });

  app.delete('/api/v1/live/videos/:videoId', async (request, reply) => {
    const ownerId = ownerFromHeaders(request.headers);
    if (!ownerId) return reply.status(401).send({ error: 'Unauthorized.' });
    const { videoId } = request.params as { videoId: string };
    if (!uuidPattern.test(videoId)) return reply.status(400).send({ error: 'Invalid video ID.' });
    try {
      await service.deleteVideo(ownerId, videoId);
      return reply.status(204).send();
    } catch (error) {
      return failure(reply, error);
    }
  });

  app.get('/api/v1/live/sessions', async (request, reply) => {
    const ownerId = ownerFromHeaders(request.headers);
    if (!ownerId) return reply.status(401).send({ error: 'Unauthorized.' });
    try {
      return { items: await service.listSessions(ownerId) };
    } catch (error) {
      return failure(reply, error);
    }
  });

  app.get('/api/v1/live/sessions/:accountId/status', async (request, reply) => {
    const ownerId = ownerFromHeaders(request.headers);
    if (!ownerId) return reply.status(401).send({ error: 'Unauthorized.' });
    const { accountId } = request.params as { accountId: string };
    if (!uuidPattern.test(accountId))
      return reply.status(400).send({ error: 'Invalid account ID.' });
    try {
      return { item: await service.session(ownerId, accountId) };
    } catch (error) {
      return failure(reply, error);
    }
  });

  if (autoLive) {
    app.get('/api/v1/live/sessions/:accountId/auto-settings', async (request, reply) => {
      const ownerId = ownerFromHeaders(request.headers);
      if (!ownerId) return reply.status(401).send({ error: 'Unauthorized.' });
      const { accountId } = request.params as { accountId: string };
      if (!uuidPattern.test(accountId))
        return reply.status(400).send({ error: 'Invalid account ID.' });
      try {
        return { item: await autoLive.get(ownerId, accountId) };
      } catch (error) {
        return failure(reply, error);
      }
    });
    app.put('/api/v1/live/sessions/:accountId/auto-settings', async (request, reply) => {
      const ownerId = ownerFromHeaders(request.headers);
      if (!ownerId) return reply.status(401).send({ error: 'Unauthorized.' });
      const { accountId } = request.params as { accountId: string };
      if (!uuidPattern.test(accountId))
        return reply.status(400).send({ error: 'Invalid account ID.' });
      try {
        return { item: await autoLive.save(ownerId, accountId, request.body) };
      } catch (error) {
        return failure(reply, error);
      }
    });
  }

  app.put('/api/v1/live/sessions/:accountId/config', async (request, reply) => {
    const ownerId = ownerFromHeaders(request.headers);
    if (!ownerId) return reply.status(401).send({ error: 'Unauthorized.' });
    const { accountId } = request.params as { accountId: string };
    if (!uuidPattern.test(accountId))
      return reply.status(400).send({ error: 'Invalid account ID.' });
    const body = request.body;
    if (
      !body ||
      typeof body !== 'object' ||
      Array.isArray(body) ||
      Object.keys(body).length !== 3 ||
      Object.keys(body).some((key) => !['rtmpUrl', 'streamKey', 'videoId'].includes(key))
    ) {
      return reply.status(400).send({ error: 'Invalid live configuration.' });
    }
    const values = body as Record<string, unknown>;
    try {
      const item = await service.configure(ownerId, accountId, {
        rtmpUrl: values.rtmpUrl,
        streamKey: values.streamKey,
        videoId: values.videoId,
      });
      return { item };
    } catch (error) {
      return failure(reply, error);
    }
  });

  app.post('/api/v1/live/sessions/:accountId/auto-destination', async (request, reply) => {
    const ownerId = ownerFromHeaders(request.headers);
    if (!ownerId) return reply.status(401).send({ error: 'Unauthorized.' });
    const { accountId } = request.params as { accountId: string };
    if (!uuidPattern.test(accountId))
      return reply.status(400).send({ error: 'Invalid account ID.' });
    const body = request.body;
    if (
      !body ||
      typeof body !== 'object' ||
      Array.isArray(body) ||
      Object.keys(body).length !== 2 ||
      Object.keys(body).some((key) => !['videoId', 'title'].includes(key))
    ) {
      return reply.status(400).send({ error: 'Invalid room request.' });
    }
    const values = body as Record<string, unknown>;
    try {
      const result = await service.autoFetchDestination(
        ownerId,
        accountId,
        values.videoId,
        values.title,
      );
      return { item: result.session, roomId: result.roomId };
    } catch (error) {
      return failure(reply, error);
    }
  });

  app.put('/api/v1/live/sessions/:accountId/video', async (request, reply) => {
    const ownerId = ownerFromHeaders(request.headers);
    if (!ownerId) return reply.status(401).send({ error: 'Unauthorized.' });
    const { accountId } = request.params as { accountId: string };
    if (!uuidPattern.test(accountId))
      return reply.status(400).send({ error: 'Invalid account ID.' });
    const body = request.body;
    if (
      !body ||
      typeof body !== 'object' ||
      Array.isArray(body) ||
      Object.keys(body).length !== 1 ||
      !Object.prototype.hasOwnProperty.call(body, 'videoId')
    ) {
      return reply.status(400).send({ error: 'Invalid video selection.' });
    }
    try {
      const item = await service.selectVideo(
        ownerId,
        accountId,
        (body as { videoId: unknown }).videoId,
      );
      return { item };
    } catch (error) {
      return failure(reply, error);
    }
  });

  app.post('/api/v1/live/sessions/:accountId/start', async (request, reply) => {
    const ownerId = ownerFromHeaders(request.headers);
    if (!ownerId) return reply.status(401).send({ error: 'Unauthorized.' });
    const { accountId } = request.params as { accountId: string };
    if (!uuidPattern.test(accountId))
      return reply.status(400).send({ error: 'Invalid account ID.' });
    try {
      const item = await service.start(ownerId, accountId);
      if (item.hasOpenRoom) await autoLive?.onStarted(ownerId, accountId);
      return { item };
    } catch (error) {
      return failure(reply, error);
    }
  });

  app.post('/api/v1/live/sessions/:accountId/start-auto', async (request, reply) => {
    const ownerId = ownerFromHeaders(request.headers);
    if (!ownerId) return reply.status(401).send({ error: 'Unauthorized.' });
    const { accountId } = request.params as { accountId: string };
    if (!uuidPattern.test(accountId))
      return reply.status(400).send({ error: 'Invalid account ID.' });
    const body = request.body;
    if (
      !body ||
      typeof body !== 'object' ||
      Array.isArray(body) ||
      Object.keys(body).length !== 1 ||
      typeof (body as { title?: unknown }).title !== 'string'
    ) {
      return reply.status(400).send({ error: 'Invalid LIVE title.' });
    }
    try {
      const result = await service.startAuto(ownerId, accountId, (body as { title: string }).title);
      await autoLive?.onStarted(ownerId, accountId);
      const productsOutcome = onRoomStarted
        ? await onRoomStarted(ownerId, accountId, result.roomId).catch(() => 'unverified' as const)
        : 'none';
      return { item: result.session, roomId: result.roomId, productsOutcome };
    } catch (error) {
      return failure(reply, error);
    }
  });

  app.post('/api/v1/live/sessions/:accountId/stop', async (request, reply) => {
    const ownerId = ownerFromHeaders(request.headers);
    if (!ownerId) return reply.status(401).send({ error: 'Unauthorized.' });
    const { accountId } = request.params as { accountId: string };
    if (!uuidPattern.test(accountId))
      return reply.status(400).send({ error: 'Invalid account ID.' });
    try {
      await autoLive?.onStopped(ownerId, accountId);
      const result = await service.stopAndEnd(ownerId, accountId);
      return { item: result.session, roomEnd: result.roomEnd };
    } catch (error) {
      return failure(reply, error);
    }
  });

  app.addHook('onClose', async () => service.stopAll());
}
