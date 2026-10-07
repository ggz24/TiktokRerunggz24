import { createRequire } from 'node:module';
import { decryptAccountCookie, type AccountConfig } from './accounts.js';
import { LiveError, type LiveService } from './live-service.js';
import type { ProductSetStore } from './product-set-store.js';
import type { ProductPinStore } from './product-pin-store.js';
import type { ProductAddSender } from './live-product-add.js';
import type { RoundActions, RoundPlan } from './live-rounds.js';
const require = createRequire(import.meta.url);
const { parseLiveProductAddCurl, createLiveProductPinRequest, prepareLiveProductRequest } =
  require('@live-hub/tiktok-client') as typeof import('@live-hub/tiktok-client');

export function createRoundProductActions(
  sets: ProductSetStore,
  _pins: ProductPinStore,
  accounts: AccountConfig,
  live: LiveService,
  send: ProductAddSender,
  pause: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): RoundActions {
  async function selected(owner: string, account: string, plan: RoundPlan) {
    const id =
      plan.productSetId ??
      (await sets.list(owner)).find((s) => s.accountId === account && s.autoApply)?.id;
    if (!id) return null;
    const set = await sets.find(owner, id);
    if (!set || (set.accountId !== null && set.accountId !== account))
      throw new LiveError(422, 'ชุดสินค้าถูกลบหรือผูกกับบัญชีอื่น');
    return set;
  }
  async function cookie(owner: string, account: string, captured?: string) {
    const secret = await accounts.store.findEncrypted(owner, account);
    if (!secret) throw new LiveError(404, 'ไม่พบบัญชี');
    const saved = decryptAccountCookie(secret, accounts.encryptionKey, owner, account);
    const session = (value: string) => /(?:^|;\s*)(?:sessionid|sid_tt)=([^;]+)/.exec(value)?.[1];
    if (captured && session(captured) && session(saved) && session(captured) !== session(saved))
      throw new LiveError(409, 'session ในคำขอสินค้าไม่ตรงกับบัญชีนี้ กรุณาบันทึก cURL ใหม่');
    return captured ?? saved;
  }
  return {
    async validate(owner, account, settings) {
      const owned = await sets.list(owner);
      if (
        (settings.productSetRotation || []).some(
          (id) =>
            !owned.some((s) => s.id === id && (s.accountId === account || s.accountId === null)),
        )
      )
        throw new LiveError(422, 'เลือกชุดของบัญชีนี้หรือชุดที่ยังไม่ผูกบัญชีเท่านั้น');
      if (settings.autoAddProducts !== false || settings.autoPinProduct) {
        for (const id of new Set(settings.productSetRotation || [])) {
          const set = await selected(owner, account, {
            index: 0,
            productSetId: id,
            addProducts: true,
            pinProduct: false,
          });
          const request = parseLiveProductAddCurl(set!.curl);
          await cookie(owner, account, request.cookieHeader);
        }
      }
      if (settings.autoPinProduct) {
        if (
          !settings.productSetRotation?.length &&
          !owned.some((s) => s.accountId === account && s.autoApply)
        )
          throw new LiveError(422, 'เลือกชุดสินค้าสำหรับปักหมุดก่อน');
      }
      for (const [id, product] of Object.entries(settings.productPinSelections || {})) {
        const set = await selected(owner, account, {
          index: 0,
          productSetId: id,
          addProducts: false,
          pinProduct: true,
        });
        if (!set?.productIds.includes(product))
          throw new LiveError(422, 'สินค้าที่เลือกปักหมุดไม่ได้อยู่ในชุดนี้');
      }
    },
    async beforeStream(owner, account, room, plan) {
      if (!plan.addProducts) return 'none';
      const set = await selected(owner, account, plan);
      if (!set) return 'none';
      const request = parseLiveProductAddCurl(set.curl);
      return send(
        prepareLiveProductRequest(request, room),
        await cookie(owner, account, request.cookieHeader),
      );
    },
    async afterStream(owner, account, room, plan, added) {
      if (!plan.pinProduct) return 'none';
      if (plan.addProducts && added !== 'accepted') return 'unverified';
      await pause(5000);
      const session = await live.session(owner, account);
      if (
        (session.status !== 'live' && session.status !== 'starting') ||
        (await live.currentRoomId(owner, account)) !== room
      )
        return 'unverified';
      const set = await selected(owner, account, plan);
      if (!set?.productIds[0]) return 'unverified';
      const product = plan.pinProductId ?? set.productIds[0];
      if (!set.productIds.includes(product))
        throw new LiveError(422, 'สินค้าที่เลือกปักหมุดไม่ได้อยู่ในชุดนี้');
      const source = parseLiveProductAddCurl(set.curl);
      return send(
        createLiveProductPinRequest(source, room, product),
        await cookie(owner, account, source.cookieHeader),
      );
    },
  };
}

/** Manual pin: target only the owned account's current LIVE, never a client-supplied room. */
export async function pinSelectedProduct(
  sets: ProductSetStore,
  accounts: AccountConfig,
  live: LiveService,
  send: ProductAddSender,
  owner: string,
  account: string,
  setId: string,
  productId: string,
) {
  const secret = await accounts.store.findEncrypted(owner, account);
  if (!secret) throw new LiveError(404, 'ไม่พบบัญชี');
  const set = await sets.find(owner, setId);
  if (!set || (set.accountId !== null && set.accountId !== account))
    throw new LiveError(422, 'ชุดสินค้าถูกลบหรือผูกกับบัญชีอื่น');
  if (!set.productIds.includes(productId))
    throw new LiveError(422, 'สินค้าที่เลือกปักหมุดไม่ได้อยู่ในชุดนี้');
  const source = parseLiveProductAddCurl(set.curl);
  const saved = decryptAccountCookie(secret, accounts.encryptionKey, owner, account);
  const sid = (value: string) => /(?:^|;\s*)(?:sessionid|sid_tt)=([^;]+)/.exec(value)?.[1];
  if (
    source.cookieHeader &&
    sid(source.cookieHeader) &&
    sid(saved) &&
    sid(source.cookieHeader) !== sid(saved)
  )
    throw new LiveError(409, 'session ในคำขอสินค้าไม่ตรงกับบัญชีนี้ กรุณาบันทึก cURL ใหม่');
  const session = await live.session(owner, account);
  const room = await live.currentRoomId(owner, account);
  if (!room || (session.status !== 'live' && session.status !== 'starting'))
    throw new LiveError(409, 'เริ่ม LIVE ของบัญชีนี้ก่อนปักหมุด');
  return send(createLiveProductPinRequest(source, room, productId), source.cookieHeader ?? saved);
}
