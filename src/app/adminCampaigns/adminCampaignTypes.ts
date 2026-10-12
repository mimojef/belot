export type AdminCampaignStatus = 'draft' | 'scheduled' | 'active' | 'finished' | 'stopped'
export type AdminCampaignGameKind = 'belot' | 'ludo'
export type AdminCampaignRewardType = 'yellow_coins' | 'vip_days' | 'gift_item'
export type AdminCampaignThemeAssetKind = 'unit_icon' | 'table_bg_desktop' | 'table_bg_mobile' | 'card_back'

// ─── Фаза 11 — "Приключили кампании" архив ───

export type AdminCampaignArchiveListRow = {
  campaignId: string
  name: string
  status: 'finished' | 'stopped'
  startsAt: string
  endsAt: string
  unitNameSingular: string
  unitNamePlural: string
  archivedAt: string | null
  totalUnits: number | null
  participantsCount: number | null
}

export type AdminCampaignArchivalReadiness = {
  pendingBelotWin: number
  pendingBelotLegacy: number
  pendingLudoWin: number
  pendingPurchaseCoin: number
  pendingPurchaseBundle: number
  pendingPurchaseVip: number
  pendingGiftRewardGaps: number
}

export type AdminCampaignArchiveSummary = {
  campaignId: string
  endedReason: 'expired' | 'stopped'
  participantsCount: number
  totalUnits: number
  unitsFromBelot: number
  unitsFromLudo: number
  unitsFromPurchases: number
  unitsFromAdminAdjustments: number
  rewardsGrantedCount: number
  unitIconUrlAtArchive: string | null
  archivedAt: string
}

export type AdminCampaignArchiveTop10Entry = {
  rank: number
  profileId: string | null
  displayNameAtArchive: string
  rankTitleAtArchive: string | null
  unitsTotal: number
}

export type AdminCampaignArchiveDetail = {
  campaignId: string
  name: string
  startsAt: string
  endsAt: string
  unitNameSingular: string
  unitNamePlural: string
  summary: AdminCampaignArchiveSummary
  top10: AdminCampaignArchiveTop10Entry[]
}

export type AdminCampaignArchiveDetailResponse =
  | { ok: true; archived: true; detail: AdminCampaignArchiveDetail }
  | { ok: true; archived: false; readiness: AdminCampaignArchivalReadiness; ready: boolean }
  | { ok: false; message?: string; reason?: string }

export type AdminCampaignEarnRule = {
  gameKind: AdminCampaignGameKind
  stakeAmount: number
  unitsPerWin: number
}

export type AdminCampaignPackageEarnRule = {
  packageKey: string
  unitsPerPurchase: number
}

export type AdminCampaignTierReward =
  | { rewardType: 'yellow_coins'; amount: number }
  | { rewardType: 'vip_days'; days: number }
  | { rewardType: 'gift_item'; giftItemId: string }

export type AdminCampaignRewardTier = {
  tierId: string | null
  thresholdUnits: number
  rewards: AdminCampaignTierReward[]
}

export type AdminCampaignRow = {
  campaignId: string
  name: string
  status: AdminCampaignStatus
  startsAt: string
  endsAt: string
  unitNameSingular: string
  unitNamePlural: string
  unitIconUrl: string | null
  tableBgDesktopUrl: string | null
  tableBgMobileUrl: string | null
  cardBackUrl: string | null
  giftSenderProfileId: string | null
  archivedAt: string | null
  deletedAt: string | null
  createdAt: string
  updatedAt: string
  earnRules: AdminCampaignEarnRule[]
  packageEarnRules: AdminCampaignPackageEarnRule[]
  rewardTiers: AdminCampaignRewardTier[]
}

export type AdminCampaignMarketingProfile = {
  profileId: string
  displayName: string
}

export type AdminCampaignPurchasePackage = {
  packageKey: string
  title: string
  kind: 'coins' | 'bundle' | 'vip'
  yellowCoinsAmount: number
  vipDays: number | null
  status: 'active' | 'inactive'
}

export type AdminCampaignGiftItem = {
  giftItemId: string
  name: string
  imageUrl: string
  price: number
  isActive: boolean
}

export type AdminCampaignReferenceData = {
  allowedStakes: {
    belot: number[]
    ludo: number[]
  }
  purchasePackages: AdminCampaignPurchasePackage[]
  giftItems: AdminCampaignGiftItem[]
  marketingProfiles: AdminCampaignMarketingProfile[]
}

export type AdminCampaignEditorDraft = {
  campaignId: string | null
  name: string
  startsAt: string
  endsAt: string
  unitNameSingular: string
  unitNamePlural: string
  giftSenderProfileId: string | null
  earnRules: AdminCampaignEarnRule[]
  packageEarnRules: AdminCampaignPackageEarnRule[]
  rewardTiers: AdminCampaignRewardTier[]
}

export type AdminCampaignSnapshotResponse = {
  ok: true
  campaigns: AdminCampaignRow[]
  referenceData: AdminCampaignReferenceData
  campaign?: AdminCampaignRow | null
}

export type AdminCampaignMutationInput = AdminCampaignEditorDraft
