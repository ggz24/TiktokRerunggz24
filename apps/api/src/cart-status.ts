export type CartState = 'added' | 'removed' | 'rejected' | 'unverified';
export type CartSource = 'manual' | 'live-start' | 'round';

/** What Live Hub last did to the live cart of one account. TikTok offers no way to read the cart back. */
export interface CartRecord {
  state: CartState;
  /** The LIVE room this account was in when the request was sent; null when none was open. */
  roomId: string | null;
  setName: string;
  productCount: number;
  source: CartSource;
  at: string;
}

const LIMIT = 5000;

export class CartStatusTracker {
  private readonly records = new Map<string, CartRecord>();

  record(ownerId: string, accountId: string, record: CartRecord): void {
    const key = `${ownerId}:${accountId}`;
    this.records.delete(key);
    this.records.set(key, record);
    if (this.records.size > LIMIT) {
      const oldest = this.records.keys().next().value;
      if (oldest !== undefined) this.records.delete(oldest);
    }
  }

  get(ownerId: string, accountId: string): CartRecord | null {
    return this.records.get(`${ownerId}:${accountId}`) ?? null;
  }
}

export function cartStateFor(
  outcome: 'accepted' | 'rejected' | 'unverified' | 'none',
  removing = false,
): CartState | null {
  if (outcome === 'none') return null;
  if (outcome === 'accepted') return removing ? 'removed' : 'added';
  if (removing) return null; // a failed removal leaves the earlier record true
  return outcome === 'rejected' ? 'rejected' : 'unverified';
}

/** The record only describes the current LIVE when it was made in the same room. */
export function cartForRoom(record: CartRecord | null, roomId: string | null): CartRecord | null {
  if (!record || !roomId || record.roomId !== roomId) return null;
  return record;
}
