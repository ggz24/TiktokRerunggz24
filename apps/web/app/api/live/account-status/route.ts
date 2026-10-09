import { NextResponse } from 'next/server';
import { accountIdPattern, liveAuthorization, liveError, noStore } from '../_proxy';

export const dynamic = 'force-dynamic';

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

const text = (value: unknown) => (typeof value === 'string' ? value.slice(0, 120) : '');
const date = (value: unknown) => (typeof value === 'string' ? value.slice(0, 40) : null);
const count = (value: unknown) =>
  Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : 0;
const minutes = (value: unknown) => (Number.isSafeInteger(value) ? Number(value) : null);

function safeItem(entry: unknown) {
  const item = record(entry);
  const cart = item.cart ? record(item.cart) : null;
  const auto = item.autoSet ? record(item.autoSet) : null;
  const ai = item.ai ? record(item.ai) : null;
  const rounds = item.auto ? record(item.auto) : null;
  const last = ai?.lastReply ? record(ai.lastReply) : null;
  return {
    accountId: typeof item.accountId === 'string' ? item.accountId : '',
    hasOpenRoom: item.hasOpenRoom === true,
    cart:
      cart && ['added', 'removed', 'rejected', 'unverified'].includes(String(cart.state))
        ? {
            state: cart.state,
            setName: text(cart.setName),
            productCount: count(cart.productCount),
            source: ['manual', 'live-start', 'round'].includes(String(cart.source))
              ? cart.source
              : 'manual',
            at: date(cart.at),
          }
        : null,
    autoSet: auto ? { name: text(auto.name), productCount: count(auto.productCount) } : null,
    ai: ai
      ? {
          enabled: ai.enabled === true,
          aiReady: ai.aiReady === true,
          chatConnected: ai.chatConnected === true,
          chatMessage: text(ai.chatMessage),
          model: text(ai.model),
          answerWhen: ai.answerWhen === 'questions' ? 'questions' : 'all',
          sentCount: count(ai.sentCount),
          lastReply: last
            ? {
                status: ['processing', 'draft', 'sent', 'skipped', 'failed'].includes(
                  String(last.status),
                )
                  ? last.status
                  : 'skipped',
                at: date(last.at),
              }
            : null,
        }
      : null,
    auto: rounds
      ? {
          phase: ['idle', 'live', 'resting'].includes(String(rounds.phase)) ? rounds.phase : 'idle',
          phaseStartedAt: date(rounds.phaseStartedAt),
          completedRounds: count(rounds.completedRounds),
          lastError: typeof rounds.lastError === 'string' ? rounds.lastError.slice(0, 160) : null,
          endAfterMinutes: minutes(rounds.endAfterMinutes),
          restartAfterMinutes: minutes(rounds.restartAfterMinutes),
          dailyStartTime:
            typeof rounds.dailyStartTime === 'string' && /^\d{2}:\d{2}$/.test(rounds.dailyStartTime)
              ? rounds.dailyStartTime
              : null,
          recoverStream: rounds.recoverStream === true,
          autoAddProducts: rounds.autoAddProducts === true,
          autoPinProduct: rounds.autoPinProduct === true,
          videoCount: count(rounds.videoCount),
          setCount: count(rounds.setCount),
        }
      : null,
  };
}

export async function GET(request: Request) {
  const authorization = await liveAuthorization(request, false);
  if ('response' in authorization) return authorization.response;
  try {
    const base = process.env.API_INTERNAL_URL ?? 'http://127.0.0.1:4000';
    const response = await fetch(new URL('/api/v1/live/account-status', base), {
      headers: authorization.headers,
      cache: 'no-store',
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return liveError('ตรวจสถานะบัญชีไม่ได้ กรุณาลองอีกครั้ง', 503);
    const data = record(await response.json());
    const items = (Array.isArray(data.items) ? data.items : [])
      .map(safeItem)
      .filter((item) => accountIdPattern.test(item.accountId));
    return NextResponse.json({ items }, { headers: noStore });
  } catch {
    return liveError('ตรวจสถานะบัญชีไม่ได้ กรุณาลองอีกครั้ง', 503);
  }
}
