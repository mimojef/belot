export type AdminCampaignStatus = 'draft' | 'scheduled' | 'active' | 'finished' | 'stopped'
export type AdminCampaignGameKind = 'belot' | 'ludo'
export type AdminCampaignRewardType = 'yellow_coins' | 'vip_days' | 'gift_item'

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
