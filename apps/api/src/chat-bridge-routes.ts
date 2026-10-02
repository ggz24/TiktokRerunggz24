import type { FastifyInstance } from 'fastify';
import { CommentReplyError } from './ai-comments.js';
import type { ChatBridge } from './chat-bridge.js';

export function registerChatBridgeRoutes(
  app: FastifyInstance,
  bridge: ChatBridge,
  ownerFromHeaders: (headers: Record<string, unknown>) => string | null,
  accountExists: (owner: string, account: string) => Promise<boolean>,
) {
  for (const action of ['pair', 'status', 'revoke'] as const) {
    app.route({
      method: action === 'status' ? 'GET' : 'POST',
      url: `/api/v1/ai-comments/:accountId/bridge/${action}`,
      bodyLimit: 1000,
      handler: async (request, reply) => {
        const owner = ownerFromHeaders(request.headers);
        if (!owner) return reply.status(401).send({ error: 'กรุณาเข้าสู่ระบบ' });
        const { accountId } = request.params as { accountId: string };
        if (!/^[0-9a-f-]{36}$/i.test(accountId) || !(await accountExists(owner, accountId)))
          return reply.status(404).send({ error: 'ไม่พบบัญชี' });
        try {
          if (action === 'status') return await bridge.status(owner, accountId);
          if (action === 'pair') return await bridge.pair(owner, accountId);
          bridge.revoke(owner, accountId);
          return { ok: true };
        } catch (error) {
          return reply.status(error instanceof CommentReplyError ? error.statusCode : 503).send({
            error: error instanceof CommentReplyError ? error.message : 'ส่วนเชื่อมแชทไม่พร้อม',
          });
        }
      },
    });
  }
  app.post('/api/v1/chat-bridge/relay', { bodyLimit: 1500000 }, async (request, reply) => {
    const authorization = request.headers.authorization;
    if (!authorization?.startsWith('Bearer '))
      return reply.status(401).send({ error: 'กรุณาจับคู่ส่วนเชื่อม' });
    try {
      return await bridge.relay(authorization.slice(7), request.body);
    } catch (error) {
      return reply.status(error instanceof CommentReplyError ? error.statusCode : 503).send({
        error: error instanceof CommentReplyError ? error.message : 'ส่วนเชื่อมแชทไม่พร้อม',
      });
    }
  });
}
