import { proxyProductSet } from './_proxy';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  return proxyProductSet(request, '', 'GET');
}

export async function POST(request: Request) {
  return proxyProductSet(request, '', 'POST');
}
