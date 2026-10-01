import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createCloudTranscoder } from './cloud-transcode.js';

test('cloud transcoder uploads in chunks, runs a job, downloads the result and cleans up', async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'cloud-transcode-test-'));
  try {
    const source = join(dir, 'in.mp4');
    const destination = join(dir, 'out.mp4');
    const data = Buffer.alloc(600_000, 3);
    await fs.writeFile(source, data);
    const uploaded: Buffer[] = [];
    const calls: string[] = [];
    let polls = 0;
    let jobBody: Record<string, unknown> | null = null;
    const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      calls.push(`${method} ${url.split('?')[0]}`);
      if (url.includes('/service-accounts/default/token')) {
        return Response.json({ access_token: 'token', expires_in: 3600 });
      }
      if (url.endsWith('/project/project-id')) return new Response('proj-1');
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer token');
      if (url.includes('uploadType=resumable')) {
        return new Response(null, {
          status: 200,
          headers: { location: 'https://upload.example/session' },
        });
      }
      if (url === 'https://upload.example/session') {
        const body = init?.body as Buffer;
        uploaded.push(body);
        const range = new Headers(init?.headers).get('content-range') ?? '';
        const match = /bytes (\d+)-(\d+)\/(\d+)/.exec(range);
        const end = Number(match?.[2]);
        const total = Number(match?.[3]);
        return end + 1 >= total
          ? new Response('{}', { status: 200 })
          : new Response(null, { status: 308, headers: { range: `bytes=0-${end}` } });
      }
      if (url.includes('/jobs') && method === 'POST') {
        jobBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return Response.json({ name: 'projects/1/locations/asia-southeast1/jobs/abc' });
      }
      if (url.endsWith('/jobs/abc')) {
        polls += 1;
        return Response.json({ state: polls < 2 ? 'RUNNING' : 'SUCCEEDED' });
      }
      if (url.includes('alt=media')) return new Response(Buffer.from('converted-bytes'));
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    const convert = createCloudTranscoder({
      bucket: 'bucket-1',
      http: fakeFetch,
      uploadChunkBytes: 262_144,
      pollMs: 1,
      probeFrameRate: async () => 25,
      newId: () => 'id1',
    });
    await convert(source, destination);
    assert.deepEqual(Buffer.concat(uploaded), data);
    assert.equal(uploaded.length, 3);
    assert.equal((await fs.readFile(destination)).toString(), 'converted-bytes');
    const config = (
      jobBody as unknown as {
        config: { elementaryStreams: { videoStream?: { h264: { frameRate: number } } }[] };
      }
    ).config;
    assert.equal(config.elementaryStreams[0].videoStream?.h264.frameRate, 25);
    assert.equal((jobBody as unknown as { inputUri: string }).inputUri, 'gs://bucket-1/in/id1.mp4');
    assert.equal(calls.filter((call) => call.startsWith('DELETE')).length, 2);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('cloud transcoder reports a failed job and still cleans up', async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'cloud-transcode-test-'));
  try {
    const source = join(dir, 'in.mp4');
    await fs.writeFile(source, Buffer.alloc(1000, 1));
    let deletes = 0;
    const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/service-accounts/default/token')) {
        return Response.json({ access_token: 't', expires_in: 3600 });
      }
      if (url.endsWith('/project/project-id')) return new Response('p');
      if (url.includes('uploadType=resumable')) {
        return new Response(null, {
          status: 200,
          headers: { location: 'https://upload.example/s' },
        });
      }
      if (url === 'https://upload.example/s') return new Response('{}', { status: 200 });
      if (url.includes('/jobs') && init?.method === 'POST')
        return Response.json({ name: 'jobs/x' });
      if (url.endsWith('/jobs/x')) return Response.json({ state: 'FAILED' });
      if (init?.method === 'DELETE') deletes += 1;
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    const convert = createCloudTranscoder({
      bucket: 'b',
      http: fakeFetch,
      pollMs: 1,
      probeFrameRate: async () => 30,
    });
    await assert.rejects(convert(source, join(dir, 'out.mp4')), /Transcoder job failed/);
    assert.equal(deletes, 2);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
