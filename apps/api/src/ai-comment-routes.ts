import type { FastifyInstance } from 'fastify';
import { CommentReplyError, parseReplyForm, type CommentReplyService } from './ai-comments.js';

export function registerAiCommentRoutes(
  app: FastifyInstance,
  service: CommentReplyService,
  ownerFromHeaders: (headers: Record<string, unknown>) => string | null,
  accountExists: (owner: string, account: string) => Promise<boolean>,
) {
  const base = '/api/v1/ai-comments/:accountId';
  for (const action of [
    'state',
    'settings',
    'preview',
    'events',
    'models',
    'chat-session',
    'read-chat-session',
  ] as const) {
    const method =
      action === 'state' || action === 'read-chat-session'
        ? 'GET'
        : action === 'settings'
          ? 'PATCH'
          : 'POST';
    app.route({
      method,
      url:
        action === 'state'
          ? base
          : `${base}/${action === 'read-chat-session' ? 'chat-session' : action}`,
      bodyLimit: 40000,
      handler: async (request, reply) => {
        const owner = ownerFromHeaders(request.headers);
        if (!owner) return reply.status(401).send({ error: 'กรุณาเข้าสู่ระบบ' });
        const { accountId } = request.params as { accountId: string };
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(accountId))
          return reply.status(400).send({ error: 'บัญชีไม่ถูกต้อง' });
        try {
          if (!(await accountExists(owner, accountId)))
            return reply.status(404).send({ error: 'ไม่พบบัญชี' });
          reply.header('Cache-Control', 'no-store');
          if (action === 'read-chat-session') return await service.chatCapture(owner, accountId);
          if (action === 'state') return await service.state(owner, accountId);
          if (action === 'chat-session')
            return await service.configureChat(owner, accountId, request.body);
          if (action === 'settings') {
            await service.save(owner, accountId, request.body);
            return { ok: true };
          }
          if (action === 'models') {
            const body = (request.body ?? {}) as { apiKey?: unknown };
            if (
              !body ||
              typeof body !== 'object' ||
              Array.isArray(body) ||
              Object.keys(body).some((k) => k !== 'apiKey') ||
              (body.apiKey !== undefined &&
                (typeof body.apiKey !== 'string' ||
                  body.apiKey.length > 512 ||
                  /\s/.test(body.apiKey)))
            )
              return reply.status(400).send({ error: 'API key ไม่ถูกต้อง' });
            return await service.models(owner, accountId, body.apiKey as string | undefined);
          }
          const body = request.body as {
            comment?: unknown;
            eventId?: unknown;
            roomId?: unknown;
            settings?: unknown;
            apiKey?: unknown;
          } | null;
          if (
            !body ||
            typeof body !== 'object' ||
            Array.isArray(body) ||
            typeof body.comment !== 'string' ||
            (action === 'preview' &&
              Object.keys(body).some((k) => !['comment', 'settings', 'apiKey'].includes(k))) ||
            (action === 'events' &&
              (Object.keys(body).some((k) => !['comment', 'eventId', 'roomId'].includes(k)) ||
                typeof body.eventId !== 'string' ||
                typeof body.roomId !== 'string'))
          )
            return reply.status(400).send({ error: 'ข้อมูลคอมเมนต์ไม่ถูกต้อง' });
          const form =
            action === 'preview' && body.settings
              ? parseReplyForm({
                  ...(body.settings as Record<string, unknown>),
                  apiKey: body.apiKey,
                })
              : undefined;
          return await service.process(
            owner,
            accountId,
            {
              comment: body.comment,
              ...(action === 'events'
                ? { eventId: body.eventId as string, roomId: body.roomId as string }
                : {}),
            },
            action === 'preview',
            form?.settings,
            form?.apiKey,
          );
        } catch (error) {
          return reply.status(error instanceof CommentReplyError ? error.statusCode : 503).send({
            error:
              error instanceof CommentReplyError ? error.message : 'ระบบตอบคอมเมนต์ยังไม่พร้อม',
          });
        }
      },
    });
  }
}
