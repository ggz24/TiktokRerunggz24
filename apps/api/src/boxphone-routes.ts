import type { FastifyInstance, FastifyReply } from 'fastify';
import { BoxphoneInputError } from './boxphone-ai.js';
import { resolveBoxphoneAudio } from './boxphone-audio.js';
import type { BoxphoneService } from './boxphone.js';
import { LiveError, type LiveService } from './live-service.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fail(reply: FastifyReply, error: unknown) {
  if (error instanceof BoxphoneInputError)
    return reply.status(error.status).send({ error: error.message });
  if (error instanceof LiveError)
    return reply.status(error.statusCode).send({ error: error.message });
  return reply.status(503).send({ error: 'ระบบ Boxphone ยังไม่พร้อม' });
}

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/**
 * AI and computer pairing for Boxphone. Owner routes need the signed-in owner header; the three
 * installer/agent routes carry no user session and need only the internal token.
 */
export function registerBoxphoneRoutes(
  app: FastifyInstance,
  service: BoxphoneService,
  live: LiveService,
  ownerFromHeaders: (headers: Record<string, unknown>) => string | null,
  internalOk: (headers: Record<string, unknown>) => boolean,
): void {
  const base = '/api/v1/boxphone';
  const owned = (
    path: string,
    method: 'GET' | 'POST' | 'DELETE',
    work: (
      owner: string,
      body: Record<string, unknown>,
      params: Record<string, string>,
    ) => Promise<unknown>,
    bodyLimit = 1024 * 1024,
  ) =>
    app.route({
      method,
      url: `${base}${path}`,
      bodyLimit,
      handler: async (request, reply) => {
        const owner = ownerFromHeaders(request.headers);
        if (!owner) return reply.status(401).send({ error: 'กรุณาเข้าสู่ระบบ' });
        try {
          reply.header('Cache-Control', 'no-store');
          return await work(
            owner,
            asRecord(request.body),
            asRecord(request.params) as Record<string, string>,
          );
        } catch (error) {
          return fail(reply, error);
        }
      },
    });
  const internal = (path: string, work: (body: Record<string, unknown>) => Promise<unknown>) =>
    app.route({
      method: 'POST',
      url: `${base}${path}`,
      bodyLimit: 8192,
      handler: async (request, reply) => {
        if (!internalOk(request.headers))
          return reply.status(401).send({ error: 'ไม่ได้รับอนุญาต' });
        try {
          reply.header('Cache-Control', 'no-store');
          return await work(asRecord(request.body));
        } catch (error) {
          return fail(reply, error);
        }
      },
    });

  owned('/ai-settings', 'POST', async (owner, body) => {
    if (body.operation === 'load') return service.settings(owner);
    if (body.operation === 'save') return service.saveSettings(owner, body);
    if (body.operation === 'delete') return service.clearSettings(owner);
    throw new BoxphoneInputError('คำสั่งบันทึกคีย์ไม่ถูกต้อง');
  });

  owned(
    '/transcribe',
    'POST',
    async (owner, body) => {
      const audio = Buffer.from(String(body.audio ?? ''), 'base64');
      return service.transcribe(
        owner,
        audio,
        String(body.name ?? 'audio.webm'),
        String(body.mime ?? ''),
        body.transcriptionKey,
      );
    },
    40 * 1024 * 1024,
  );

  // Extract audio of a library video (or what a channel is playing) and transcribe it, all on the server.
  owned('/transcribe-video', 'POST', async (owner, body) => {
    const resolved = await resolveBoxphoneAudio(live, owner, body);
    const heard = await service.transcribe(
      owner,
      Buffer.from(resolved.audio, 'base64'),
      resolved.name,
      resolved.mime,
      body.transcriptionKey,
    );
    return {
      text: heard.text,
      model: heard.model,
      videoId: resolved.videoId,
      videoName: resolved.videoName,
      startSeconds: resolved.startSeconds,
      durationSeconds: resolved.durationSeconds,
      seconds: resolved.seconds,
      target: resolved.target,
    };
  });

  owned('/questions', 'POST', (owner, body) => service.questions(owner, body));
  owned('/plan-questions', 'POST', (owner, body) => service.plan(owner, body));

  owned('/pairings', 'POST', (owner) => service.createPairing(owner));
  owned('/agents', 'GET', async (owner) => ({ items: await service.listAgents(owner) }));
  app.delete(`${base}/agents/:id`, async (request, reply) => {
    const owner = ownerFromHeaders(request.headers);
    if (!owner) return reply.status(401).send({ error: 'กรุณาเข้าสู่ระบบ' });
    const { id } = request.params as { id: string };
    if (!uuid.test(id)) return reply.status(400).send({ error: 'คอมไม่ถูกต้อง' });
    if (!(await service.removeAgent(owner, id)))
      return reply.status(404).send({ error: 'ไม่พบคอมเครื่องนี้' });
    return { ok: true };
  });

  internal('/pairings/check', async (body) => ({ valid: await service.checkPairing(body.code) }));
  internal('/pairings/redeem', (body) => service.redeemPairing(body.code, body.name));
  internal('/agents/authenticate', async (body) => {
    const agent = await service.authenticateAgent(body.token);
    if (!agent) throw new BoxphoneInputError('ไม่ได้รับอนุญาต', 401);
    return agent;
  });
}
