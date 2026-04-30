import type {
  ServerDeclarationLabelSource,
  ServerDeclarationPublicLabel,
} from './serverDeclarationTypes.js'

const LABEL_ORDER: ServerDeclarationPublicLabel[] = [
  'Каре',
  'Терца',
  '50',
  '100',
  'Белот',
]

function formatCountLabel(
  label: ServerDeclarationPublicLabel,
  count: number,
): string {
  if (count <= 1) {
    return label
  }

  if (label === 'Терца') return `${count} терци`
  if (label === 'Каре') return `${count} карета`
  if (label === 'Белот') return `${count} белота`

  return `${count} ${label}`
}

export function buildServerDeclarationLabels(
  declarations: ServerDeclarationLabelSource[],
): string[] {
  const counts = new Map<ServerDeclarationPublicLabel, number>()

  for (const declaration of declarations) {
    counts.set(
      declaration.publicLabel,
      (counts.get(declaration.publicLabel) ?? 0) + 1,
    )
  }

  return LABEL_ORDER.flatMap((label) => {
    const count = counts.get(label) ?? 0

    if (count === 0) {
      return []
    }

    return [formatCountLabel(label, count)]
  })
}
