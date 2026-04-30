export type {
  ServerDeclarationCandidate,
  ServerDeclarationCandidateType,
  ServerDeclarationComparisonGroup,
  ServerDeclarationConflictResolution,
  ServerDeclarationDetectionContract,
  ServerDeclarationLabelSource,
  ServerDeclarationPrivateMetadata,
  ServerDeclarationPublicLabel,
} from './serverDeclarationTypes.js'
export { buildServerDeclarationLabels } from './buildServerDeclarationLabels.js'
export { detectServerDeclarationsInHand } from './detectServerDeclarationsInHand.js'
export { resolveServerDeclarationConflicts } from './resolveServerDeclarationConflicts.js'
