import assert from 'node:assert/strict';
import test from 'node:test';
import { parseAccountImportCurl } from '../src';

const profileUrl = 'https://www.tiktok.com/api/update/profile/';
const fakeCookie = 'sessionid=fake-session; tt_csrf_token=fake-token; msToken=fake-token-two';

test('parses a raw DevTools profile HEAD command without executing it', () => {
  const input = [
    `curl --url '${profileUrl}' \\`,
    `-X 'HEAD' \\`,
    `-H 'accept: */*' \\`,
    `-b '${fakeCookie}' \\`,
    `-H 'referer: https://www.tiktok.com/@sample.user' \\`,
    `-H 'user-agent: Fake Browser/1.0' \\`,
    `-H 'sec-fetch-site: same-origin'`,
  ].join('\n');

  assert.deepEqual(parseAccountImportCurl(input), {
    method: 'HEAD',
    url: profileUrl,
    cookieHeader: fakeCookie,
    userAgent: 'Fake Browser/1.0',
    claimedHandle: 'sample.user',
  });
});

test('accepts the Cookie header form and harmless optional cURL syntax', () => {
  const input =
    `curl '${profileUrl}' --request=HEAD ` +
    `--header 'Cookie: ${fakeCookie}' --header 'Accept-Language: th,en;q=0.9' --compressed`;
  assert.deepEqual(parseAccountImportCurl(input), {
    method: 'HEAD',
    url: profileUrl,
    cookieHeader: fakeCookie,
  });
});

test('accepts matching Markdown links and escaped underscores in cookie names', () => {
  const referer = 'https://www.tiktok.com/@sample.user';
  const input = [
    `curl --url '[${profileUrl}](${profileUrl})' \\`,
    `-X 'HEAD' \\`,
    `-b '\\_ttp=fake_value; sessionid=fake-session' \\`,
    `-H 'referer: [${referer}](${referer})'`,
  ].join('\n');

  assert.deepEqual(parseAccountImportCurl(input), {
    method: 'HEAD',
    url: profileUrl,
    cookieHeader: '_ttp=fake_value; sessionid=fake-session',
    claimedHandle: 'sample.user',
  });
});

test('rejects other endpoints, methods, bodies, and duplicated options', () => {
  const baseline = `curl --url '${profileUrl}' -X HEAD -b '${fakeCookie}'`;
  for (const input of [
    baseline.replace(profileUrl, 'https://not-tiktok.example/api/update/profile/'),
    baseline.replace(profileUrl, 'http://www.tiktok.com/api/update/profile/'),
    baseline.replace(profileUrl, `${profileUrl}?token=fake`),
    baseline.replace(profileUrl, 'https://www.tiktok.com/api/update/%70rofile/'),
    baseline.replace('-X HEAD', '-X GET'),
    baseline.replace('-X HEAD', '-X HEAD -X HEAD'),
    baseline.replace(`-b '${fakeCookie}'`, `-b '${fakeCookie}' -H 'Cookie: ${fakeCookie}'`),
    `${baseline} --data-raw 'hello'`,
    `${baseline} --insecure`,
    `${baseline} --compressed=unexpected`,
    `${baseline} --compressed --compressed`,
    `${baseline} -H 'host: attacker.example'`,
    `${baseline} -H 'accept: */*' -H 'Accept: */*'`,
  ]) {
    assert.throws(() => parseAccountImportCurl(input));
  }
});

test('rejects malformed or mismatched Markdown links and shell syntax', () => {
  const baseline = `curl --url '${profileUrl}' -X HEAD -b '${fakeCookie}'`;
  const referer = 'https://www.tiktok.com/@sample.user';
  for (const input of [
    baseline.replace(profileUrl, `[${profileUrl}](https://bad.example/)`),
    baseline.replace(profileUrl, `[https://bad.example/](${profileUrl})`),
    baseline.replace(profileUrl, `[${profileUrl}](${profileUrl}`),
    `${baseline} -H 'referer: [${referer}](https://www.tiktok.com/@other.user)'`,
    `${baseline} -H 'referer: [https://bad.example/](${referer})'`,
    `${baseline} -H 'referer: [${referer}](${referer}'`,
    `${baseline} ; echo unsafe`,
    `${baseline} && echo unsafe`,
    `${baseline} | cat`,
    `${baseline} $(echo unsafe)`,
    `${baseline}\n-H 'accept: */*'`,
    `${baseline} ` + '`echo unsafe`',
    `curl --url '${profileUrl} -X HEAD -b '${fakeCookie}'`,
    `curl --url '${profileUrl}' -X HEAD -b 'tracking=fake'`,
  ]) {
    assert.throws(() => parseAccountImportCurl(input));
  }
});

test('rejects Markdown-escaped cookie values and unsupported cookie-name escapes', () => {
  const valueWithEscape = `curl --url '${profileUrl}' -X HEAD -b 'sessionid=fake\\_value'`;
  assert.throws(() => parseAccountImportCurl(valueWithEscape));

  for (const cookie of ['sessionid=fake; \\other=fake', 'sessionid=fake; \\\\_ttp=fake']) {
    assert.throws(() =>
      parseAccountImportCurl(`curl --url '${profileUrl}' -X HEAD -b '${cookie}'`),
    );
  }
});

test('errors never include copied credentials', () => {
  const fakeSecret = 'fake-private-session-value';
  const input = `curl --url 'https://bad.example/${fakeSecret}' -X HEAD -b 'sessionid=${fakeSecret}'`;
  let message = '';
  try {
    parseAccountImportCurl(input);
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  assert.ok(message.length > 0);
  assert.equal(message.includes(fakeSecret), false);
});
