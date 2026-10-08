import type { FastifyInstance, FastifyReply } from 'fastify';
import { StatsSourceError, type StatsSourceService } from './stats-sources.js';

function fail(reply: FastifyReply, error: unknown) {
  if (error instanceof StatsSourceError)
    return reply.status(error.status).send({ error: error.message });
  return reply.status(503).send({ error: 'ระบบสถิติยังไม่พร้อม' });
}
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** Saved statistics page requests, replayed with the signed-in owner's own TikTok session. */
export function registerStatsSourceRoutes(
  app: FastifyInstance,
  service: StatsSourceService,
  ownerFromHeaders: (headers: Record<string, unknown>) => string | null,
): void {
  const base = '/api/v1/stats-sources';
  const route = (
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    work: (
      owner: string,
      body: Record<string, unknown>,
      params: Record<string, string>,
    ) => Promise<unknown>,
  ) =>
    app.route({
      method,
      url: `${base}${url}`,
      bodyLimit: 130_000,
      handler: async (request, reply) => {
        const owner = ownerFromHeaders(request.headers);
        if (!owner) return reply.status(401).send({ error: 'กรุณาเข้าสู่ระบบ' });
        try {
          reply.header('Cache-Control', 'no-store');
          return await work(
            owner,
            record(request.body),
            record(request.params) as Record<string, string>,
          );
        } catch (error) {
          return fail(reply, error);
        }
      },
    });
  route('GET', '', async (owner) => ({ items: await service.list(owner) }));
  route('POST', '', async (owner, body) => ({ item: await service.create(owner, body) }));
  route('PATCH', '/:id', async (owner, body, params) => ({
    item: await service.update(owner, params.id, body),
  }));
  route('DELETE', '/:id', async (owner, _body, params) => {
    await service.remove(owner, params.id);
    return { ok: true };
  });
  route('POST', '/:id/run', (owner, _body, params) => service.run(owner, params.id));
}
