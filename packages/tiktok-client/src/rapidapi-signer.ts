import type { RoomSignInput, RoomSignature, RoomSigner } from './live-room';

const signerOrigin = 'https://tiktok-live-studio-api-signer1.p.rapidapi.com';
const signerHost = 'tiktok-live-studio-api-signer1.p.rapidapi.com';
const studioLicenseId = 1877999593;

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function header(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !/[\r\n]/.test(value);
}

/** Only the signing payload is sent to RapidAPI; account cookies stay on our API server. */
export function createRapidApiRoomSigner(apiKey: string, http: typeof fetch = fetch): RoomSigner {
  const key = apiKey.trim();
  if (!key || /[\r\n]/.test(key)) throw new Error('RapidAPI signer key is not configured.');
  return async (input: RoomSignInput): Promise<RoomSignature> => {
    let response: Response;
    try {
      response = await http(new URL('/signatures', signerOrigin), {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          'x-rapidapi-host': signerHost,
          'x-rapidapi-key': key,
        },
        body: JSON.stringify({
          timestamp: input.timestamp,
          aid: input.aid,
          device_id: input.device_id,
          license_id: studioLicenseId,
          params: input.params,
          stub: input.stub,
        }),
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw new Error('RapidAPI signer is unavailable.');
    }
    if (!response.ok) throw new Error(`RapidAPI signer returned HTTP ${response.status}.`);
    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      throw new Error('RapidAPI signer returned invalid JSON.');
    }
    const root = object(parsed);
    if (!root || root.success === false) throw new Error('RapidAPI signer rejected the request.');
    const signed = object(root.headers) ?? root;
    const khronos = signed['x-khronos'];
    const ladon = signed['x-ladon'];
    const argus = signed['x-argus'];
    if (!header(khronos) || !header(ladon) || !header(argus)) {
      throw new Error('RapidAPI signer returned incomplete headers.');
    }
    return { 'x-khronos': khronos, 'x-ladon': ladon, 'x-argus': argus };
  };
}
