export type RoundSettings = {
  videoRotation?: string[];
  productSetRotation?: string[];
  autoAddProducts?: boolean;
  autoPinProduct?: boolean;
  productPinSelections?: Record<string, string>;
};
export type RoundPlan = {
  index: number;
  videoId?: string;
  productSetId?: string;
  pinProductId?: string;
  addProducts: boolean;
  pinProduct: boolean;
};
export type RoundProductOutcome = 'accepted' | 'rejected' | 'unverified' | 'none';
export interface RoundActions {
  validate(owner: string, account: string, settings: RoundSettings): Promise<void>;
  beforeStream(
    owner: string,
    account: string,
    room: string,
    plan: RoundPlan,
  ): Promise<RoundProductOutcome>;
  afterStream(
    owner: string,
    account: string,
    room: string,
    plan: RoundPlan,
    added: RoundProductOutcome,
  ): Promise<RoundProductOutcome>;
}
export function roundPlan(settings: RoundSettings, completed: number): RoundPlan {
  const index = Number.isSafeInteger(completed) && completed >= 0 ? completed : 0;
  const videos = settings.videoRotation || [],
    sets = settings.productSetRotation || [];
  return {
    index,
    videoId: videos.length ? videos[index % videos.length] : undefined,
    productSetId: sets.length ? sets[index % sets.length] : undefined,
    ...(sets.length && settings.productPinSelections?.[sets[index % sets.length]]
      ? { pinProductId: settings.productPinSelections[sets[index % sets.length]] }
      : {}),
    addProducts: settings.autoAddProducts !== false,
    pinProduct: settings.autoPinProduct === true,
  };
}
