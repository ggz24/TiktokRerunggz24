import { parseShopCurl } from './live-product-curl';
import type { ParsedLiveProductAddCurl } from './live-product-curl';

/** Shop Streamer Desktop PinLiveProduct: op 1 = Pin, 2 = Unpin.
 * Verified against TikTok's creator dashboard main.b8c4a585.js (2026-10-07).
 * Reuses account routing/headers, never signatures from a different action/body.
 */
export function createLiveProductPinRequest(
  source: ParsedLiveProductAddCurl,
  roomId: string,
  productId: string,
) {
  if (!/^\d{8,24}$/.test(roomId) || !/^\d{8,24}$/.test(productId))
    throw Error('Invalid product target.');
  const routed = prepareLiveProductRequest(source, roomId, productId);
  const original = new URL(routed.url);
  const url = new URL('/api/v1/streamer_desktop/live_product/pin', original.origin);
  for (const key of [
    'aid',
    'app_name',
    'device_platform',
    'user_language',
    'locale',
    'page_scene',
    'carrier_region',
  ]) {
    const value = original.searchParams.get(key);
    if (value) url.searchParams.set(key, value);
  }
  if (url.origin !== 'https://shop.tiktok.com') throw Error('Invalid product target.');
  return {
    ...routed,
    url: url.href,
    roomId,
    productId,
    body: JSON.stringify({ room_id: roomId, product_id: productId, op: 1 }),
  };
}

/** A user-supplied Shop pin/explain request. These paths are accepted templates, not verified fixtures. */
export function parseLiveProductPinCurl(curl: string) {
  for (const path of [
    '/api/v1/streamer_desktop/live_product/pin',
    '/api/v1/streamer_desktop/live_product/explain',
  ]) {
    try {
      const parsed = parseShopCurl(curl, path);
      const body = parsed.data;
      if (
        typeof body.room_id !== 'string' ||
        !/^\d{8,24}$/.test(body.room_id) ||
        typeof body.product_id !== 'string' ||
        !/^\d{8,24}$/.test(body.product_id) ||
        body.is_explaining === false ||
        body.is_pinned === false ||
        body.pin_status === 0 ||
        body.op === 2
      )
        continue;
      return { ...parsed, roomId: body.room_id, productId: body.product_id };
    } catch {
      // Not a usable pin request; try the next candidate.
    }
  }
  throw Error('Invalid TikTok Shop product pin cURL.');
}

/** Rebuild routing after changing a body; never reuse signatures bound to the captured body. */
export function prepareLiveProductRequest<T extends { url: string; body: string }>(
  request: T,
  roomId: string,
  productId?: string,
): T {
  if (!/^\d{8,24}$/.test(roomId) || (productId !== undefined && !/^\d{8,24}$/.test(productId)))
    throw Error('Invalid product target.');
  const original = JSON.parse(request.body);
  if (original.room_id === roomId && (!productId || original.product_id === productId))
    return request;
  const source = new URL(request.url),
    url = new URL(source.pathname, source.origin);
  for (const key of [
    'aid',
    'app_name',
    'device_platform',
    'user_language',
    'locale',
    'page_scene',
    'carrier_region',
  ]) {
    const value = source.searchParams.get(key);
    if (value) url.searchParams.set(key, value);
  }
  return {
    ...request,
    url: url.href,
    ...('roomId' in request ? { roomId } : {}),
    ...(productId && 'productId' in request ? { productId } : {}),
    body: JSON.stringify({
      ...original,
      room_id: roomId,
      ...(productId ? { product_id: productId } : {}),
    }),
  };
}
