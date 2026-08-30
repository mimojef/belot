export function isPikaHostname(hostname: string | null): boolean {
  return hostname === 'pika.bg' || hostname?.endsWith('.pika.bg') === true
}
