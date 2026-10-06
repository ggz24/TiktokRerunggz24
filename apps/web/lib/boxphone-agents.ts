import { createHash, timingSafeEqual } from 'node:crypto';
import { BoxphoneError, boxphoneApi } from '@/lib/boxphone';
import type { AgentIdentity } from '@/lib/boxphone-relay';

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
type Cached = { agent: AgentIdentity | null; until: number };
const holder = globalThis as typeof globalThis & { __boxphoneAgentCache?: Map<string, Cached> };
const cache = () => (holder.__boxphoneAgentCache ??= new Map());

/** The old single-computer setup: one shared token from the server settings, owned by the site's user. */
function legacyAgent(token: string): AgentIdentity | null {
  const expected = process.env.BOXPHONE_AGENT_TOKEN ?? '';
  const owner = process.env.APP_USERNAME ?? '';
  if (expected.length < 32 || !owner) return null;
  const a = Buffer.from(token);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b)
    ? { id: 'legacy', owner, name: 'คอมเครื่องหลัก' }
    : null;
}

export const bearerToken = (request: Request): string =>
  /^Bearer (.+)$/.exec(request.headers.get('authorization') ?? '')?.[1] ?? '';

/** Who is calling the agent endpoints: a paired computer (verified by the API) or the legacy shared token. */
export async function authenticateAgent(request: Request): Promise<AgentIdentity | null> {
  if (process.env.BOXPHONE_REMOTE !== 'agent') return null;
  const token = bearerToken(request);
  if (!token || token.length > 200) return null;
  const legacy = legacyAgent(token);
  if (legacy) return legacy;
  const key = sha(token);
  const hit = cache().get(key);
  if (hit && hit.until > Date.now()) return hit.agent;
  let agent: AgentIdentity | null = null;
  try {
    const { status, data } = await boxphoneApi(
      '',
      'POST',
      '/api/v1/boxphone/agents/authenticate',
      { token },
      10000,
    );
    if (status === 200 && typeof data.id === 'string' && typeof data.owner === 'string')
      agent = { id: data.id, owner: data.owner, name: String(data.name ?? 'คอมพิวเตอร์') };
  } catch {
    return null; // do not cache a failure to reach the API
  }
  if (cache().size > 200) cache().clear();
  cache().set(key, { agent, until: Date.now() + (agent ? 60_000 : 3_000) });
  return agent;
}

/** A pairing code (installer) or a paired computer may download the package. */
export async function allowedPackageRequest(request: Request): Promise<boolean> {
  if (process.env.BOXPHONE_REMOTE !== 'agent') return false;
  if (await authenticateAgent(request)) return true;
  const code = request.headers.get('x-pairing-code') ?? '';
  if (!code || code.length > 32) return false;
  try {
    const { status, data } = await boxphoneApi(
      '',
      'POST',
      '/api/v1/boxphone/pairings/check',
      { code },
      10000,
    );
    return status === 200 && data.valid === true;
  } catch {
    if (!(process.env.INTERNAL_API_TOKEN ?? ''))
      throw new BoxphoneError('ระบบบัญชียังไม่พร้อม', 503);
    return false;
  }
}

export function forgetAgent(token: string): void {
  cache().delete(sha(token));
}
