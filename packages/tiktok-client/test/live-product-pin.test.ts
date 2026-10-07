import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseLiveProductPinCurl,
  prepareLiveProductRequest,
  createLiveProductPinRequest,
} from '../src/live-product-pin';
import { parseLiveProductAddCurl } from '../src/live-product-curl';
const curl = `curl 'https://shop.tiktok.com/api/v1/streamer_desktop/live_product/pin?aid=253642&X-Bogus=synthetic&X-Gnarly=synthetic' -H 'content-type: application/json' --data-raw '{"room_id":"123456789","product_id":"987654321","is_pinned":true}'`;
test('pin templates are data with a fixed Shop origin and recognized explicit action', () => {
  assert.equal(parseLiveProductPinCurl(curl).productId, '987654321');
  for (const altered of [
    curl.replace('shop.tiktok.com', 'localhost'),
    curl.replace('/pin?', '/delete?'),
    curl.replace('"is_pinned":true', '"is_pinned":false'),
    curl.replace('"is_pinned":true', '"op":2'),
    curl.replace('987654321', 'wrong'),
    curl + ' -o file',
  ])
    assert.throws(() => parseLiveProductPinCurl(altered));
});

test('session pin builds the verified Shop action without requiring captured pin curl or stale signatures', () => {
  const add = parseLiveProductAddCurl(
    `curl 'https://shop.tiktok.com/api/v1/streamer_desktop/live_product/add?aid=253642&X-Bogus=old&msToken=old' -H 'content-type: application/json' -b 'sessionid=synthetic' --data-raw '{"room_id":"123456789","product_info":[{"product_id":"987654321"}]}'`,
  );
  const pin = createLiveProductPinRequest(add, '123456789', '987654321');
  assert.equal(
    pin.url,
    'https://shop.tiktok.com/api/v1/streamer_desktop/live_product/pin?aid=253642',
  );
  assert.deepEqual(JSON.parse(pin.body), { room_id: '123456789', product_id: '987654321', op: 1 });
  assert.equal(pin.cookieHeader, 'sessionid=synthetic');
  assert.throws(() =>
    createLiveProductPinRequest(
      { ...add, url: 'https://evil.invalid/add' },
      '123456789',
      '987654321',
    ),
  );
});
test('new round targets strip old body signatures; unchanged templates stay byte-for-byte', () => {
  const request = parseLiveProductPinCurl(curl);
  assert.equal(prepareLiveProductRequest(request, '123456789', '987654321'), request);
  const next = prepareLiveProductRequest(request, '555555555', '666666666');
  assert.equal(next.roomId, '555555555');
  assert.equal(next.productId, '666666666');
  assert.equal(JSON.parse(next.body).room_id, '555555555');
  assert.equal(JSON.parse(next.body).product_id, '666666666');
  assert.equal(new URL(next.url).searchParams.get('aid'), '253642');
  assert.equal(next.url.includes('X-Bogus'), false);
  assert.equal(next.url.includes('X-Gnarly'), false);
});
