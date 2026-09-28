import { proxyLive } from '../_proxy';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  return proxyLive(request, '/api/v1/live/sessions', 'GET');
}
