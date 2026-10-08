import assert from 'node:assert/strict';
import test from 'node:test';
import { parseStatsCurl } from '../src';

const url =
  'https://shop.tiktok.com/api/v1/creator/live/overview?start=1&end=2&X-Bogus=fake&msToken=fake';

test('parses a GET page request as data and keeps only safe headers', () => {
  const r = parseStatsCurl(
    `curl '${url}' -H 'accept: application/json' -H 'user-agent: test-browser' -H 'referer: https://shop.tiktok.com/x' ` +
      `-H 'x-tt-store-region: th' -H 'sec-fetch-mode: cors' -H 'content-length: 9' -b 'sessionid=fake-cookie' --compressed`,
  );
  assert.equal(r.method, 'GET');
  assert.equal(r.url, url);
  assert.equal(r.host, 'shop.tiktok.com');
  assert.equal(r.path, '/api/v1/creator/live/overview');
  assert.deepEqual(r.headers, { accept: 'application/json', 'x-tt-store-region': 'th' });
  assert.equal(r.cookieHeader, 'sessionid=fake-cookie');
  assert.equal(r.userAgent, 'test-browser');
  assert.equal(r.referer, 'https://shop.tiktok.com/x');
});

test('a body makes it a POST, and the cookie may come as a header', () => {
  const r = parseStatsCurl(
    `curl --url '${url}' -H 'content-type: application/json' -H 'cookie: a=b' --data-raw '{"range":"7d"}'`,
  );
  assert.equal(r.method, 'POST');
  assert.equal(r.body, '{"range":"7d"}');
  assert.equal(r.cookieHeader, 'a=b');
  assert.equal(r.headers['content-type'], 'application/json');
});

test('only TikTok hosts over https are accepted, never IPs, ports or credentials', () => {
  for (const bad of [
    'https://evil.example/api',
    'http://shop.tiktok.com/api',
    'https://shop.tiktok.com.evil.example/api',
    'https://nottiktok.com/api',
    'https://127.0.0.1/api',
    'https://shop.tiktok.com:8443/api',
    'https://user:pass@shop.tiktok.com/api',
    'https://shop.tiktok.com/api#frag',
  ])
    assert.throws(() => parseStatsCurl(`curl '${bad}'`), /Invalid TikTok statistics cURL/, bad);
  assert.equal(
    parseStatsCurl("curl 'https://seller-th.tiktok.com/api'").host,
    'seller-th.tiktok.com',
  );
  assert.equal(
    parseStatsCurl("curl 'https://affiliate.tiktokshop.com/api'").host,
    'affiliate.tiktokshop.com',
  );
});

test('shell syntax, file uploads, unknown flags and odd methods are rejected', () => {
  for (const bad of [
    `curl '${url}'; rm -rf x`,
    `curl '${url}' | sh`,
    `curl '${url}' $(whoami)`,
    `curl '${url}' --data-binary @secrets.txt`,
    `curl '${url}' -F a=b`,
    `curl '${url}' -o out.txt`,
    `curl '${url}' -X DELETE`,
    `curl '${url}' -X GET --data-raw 'x'`,
    `curl '${url}' -X POST`,
    `curl '${url}' -H 'a: 1' -H 'a: 2'`,
    `curl '${url}' -H 'referer: https://evil.example/'`,
    `wget '${url}'`,
    `curl '${url}' 'https://shop.tiktok.com/second'`,
  ])
    assert.throws(() => parseStatsCurl(bad), /Invalid TikTok statistics cURL/, bad);
});

test('errors never contain the copied credentials', () => {
  try {
    parseStatsCurl(`curl 'https://evil.example/api' -b 'sessionid=super-secret-cookie'`);
    assert.fail('should throw');
  } catch (error) {
    assert.equal(String((error as Error).message).includes('super-secret'), false);
  }
});
