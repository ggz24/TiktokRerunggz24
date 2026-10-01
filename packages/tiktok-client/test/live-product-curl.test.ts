import assert from 'node:assert/strict';
import test from 'node:test';
import {
  forLiveProductRoom,
  parseLiveProductAddCurl,
  parseLiveProductDeleteCurl,
} from '../src/live-product-curl';

const body = JSON.stringify({
  room_id: '7681699623552076564',
  product_info: [{ product_id: '1732490821698225758', product_type: 4 }],
  need_product_info: true,
});
const url =
  'https://shop.tiktok.com/api/v1/streamer_desktop/live_product/add?msToken=sample&X-Bogus=sample';
const command = `curl --url '${url}' -H 'Content-Type: application/json' -H 'User-Agent: Test Browser' --data-raw '${body}'`;

test('previews a product-add cURL without exposing signed query or requiring a cookie', () => {
  const parsed = parseLiveProductAddCurl(command);
  assert.equal(parsed.roomId, '7681699623552076564');
  assert.deepEqual(parsed.productIds, ['1732490821698225758']);
  assert.equal(parsed.cookieHeader, undefined);
  assert.equal(parsed.url, url);
});

test('binds saved product details to the newly created LIVE room', () => {
  const saved = parseLiveProductAddCurl(command.replace('7681699623552076564', ''));
  const bound = forLiveProductRoom(saved, '7690886057457437492');
  assert.equal(saved.roomId, '');
  assert.equal(bound.roomId, '7690886057457437492');
  assert.equal(JSON.parse(bound.body).room_id, '7690886057457437492');
  assert.deepEqual(JSON.parse(bound.body).product_info, JSON.parse(saved.body).product_info);
  assert.equal(bound.url, saved.url);
  assert.throws(() => forLiveProductRoom(saved, 'invalid'));
});

test('accepts a pasted cookie but rejects other destinations and shell syntax', () => {
  assert.equal(
    parseLiveProductAddCurl(`${command} -b 'sessionid=sample'`).cookieHeader,
    'sessionid=sample',
  );
  assert.throws(() => parseLiveProductAddCurl(command.replace('shop.tiktok.com', 'example.com')));
  assert.throws(() => parseLiveProductAddCurl(`${command}; echo unsafe`));
  assert.throws(() =>
    parseLiveProductAddCurl(command.replace('live_product/add', 'live_product/pin')),
  );
});

test('accepts the pre-LIVE Streamer Desktop request with an empty room ID', () => {
  const preLiveBody = JSON.stringify({
    room_id: '',
    product_info: [
      { product_id: '1732490821698225758', product_type: 4, labels: [] },
      { product_id: '1734094432896517726', product_type: 4, labels: [] },
    ],
    need_product_info: true,
  });
  const preLiveCurl = `curl --url '${url}' -H 'Content-Type: application/json' -b 'sessionid=sample' --data-raw '${preLiveBody}'`;
  const parsed = parseLiveProductAddCurl(preLiveCurl);
  assert.equal(parsed.roomId, '');
  assert.equal(parsed.productIds.length, 2);
  assert.equal(parsed.cookieHeader, 'sessionid=sample');
});

const deleteUrl =
  'https://shop.tiktok.com/api/v1/streamer_desktop/live_product/delete?msToken=sample&X-Bogus=sample';
const deleteBody = JSON.stringify({
  product_ids: ['1732490821698225758', '1732490821698225759'],
  promotion_ids: [],
  product_to_parent_id: {},
});
const deleteCommand = `curl --url '${deleteUrl}' -H 'Content-Type: application/json' -b 'sessionid=sample' --data-raw '${deleteBody}'`;

test('parses a product-delete cURL without touching the signed request', () => {
  const parsed = parseLiveProductDeleteCurl(deleteCommand);
  assert.deepEqual(parsed.productIds, ['1732490821698225758', '1732490821698225759']);
  assert.equal(parsed.url, deleteUrl);
  assert.equal(parsed.body, deleteBody);
  assert.equal(parsed.cookieHeader, 'sessionid=sample');
});

test('delete cURL rejects the add endpoint, other hosts, duplicates and shell syntax', () => {
  assert.throws(() => parseLiveProductDeleteCurl(command));
  assert.throws(() => parseLiveProductAddCurl(deleteCommand));
  assert.throws(() =>
    parseLiveProductDeleteCurl(deleteCommand.replace('shop.tiktok.com', 'example.com')),
  );
  assert.throws(() => parseLiveProductDeleteCurl(`${deleteCommand}; echo unsafe`));
  assert.throws(() =>
    parseLiveProductDeleteCurl(deleteCommand.replace('1732490821698225759', '1732490821698225758')),
  );
  assert.throws(() =>
    parseLiveProductDeleteCurl(deleteCommand.replace('"product_ids"', '"products"')),
  );
});
