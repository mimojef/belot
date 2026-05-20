export function dbDateToUtc(value: string): string {
  return value.endsWith('Z') ? value : value + 'Z'
}
