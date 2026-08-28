import { classifyHttpRequestPath } from '../src/monitoring/httpCategoryClassifier.js'

let passed = 0
let failed = 0

function assert(condition: boolean, label: string): void {
  if (condition) {
    console.log(`  ✓ ${label}`)
    passed++
  } else {
    console.error(`  ✗ FAIL: ${label}`)
    failed++
  }
}

function assertEqual<T>(actual: T, expected: T, label: string): void {
  assert(actual === expected, `${label} (got ${String(actual)}, expected ${String(expected)})`)
}

console.log('\n[1] Known prefixes map to their fixed category')
{
  assertEqual(classifyHttpRequestPath('/api/topics'), 'topics', '/api/topics -> topics')
  assertEqual(classifyHttpRequestPath('/api/support/messages'), 'support', '/api/support/messages -> support')
  assertEqual(classifyHttpRequestPath('/api/admin/tournaments'), 'admin', '/api/admin/tournaments -> admin (not monitoring)')
  assertEqual(classifyHttpRequestPath('/api/admin/monitoring/current'), 'monitoring', '/api/admin/monitoring/* -> monitoring (more specific than admin)')
  assertEqual(classifyHttpRequestPath('/api/auth/login'), 'auth', '/api/auth/login -> auth')
  assertEqual(classifyHttpRequestPath('/api/chat/vip-dm/start'), 'chat', '/api/chat/vip-dm/start -> chat')
  assertEqual(classifyHttpRequestPath('/api/tournaments/abc-123/join'), 'tournaments', '/api/tournaments/:id/join -> tournaments')
  assertEqual(classifyHttpRequestPath('/uploads/some-file.png'), 'uploads', '/uploads/* -> uploads')
  assertEqual(classifyHttpRequestPath('/health'), 'health', '/health -> health')
}

console.log('\n[2] Unknown/unmapped paths fall back to "other" — never throw, never unbounded')
{
  assertEqual(classifyHttpRequestPath('/this/does/not/exist'), 'other', 'unknown path -> other')
  assertEqual(classifyHttpRequestPath('/'), 'other', 'root path -> other')
  assertEqual(classifyHttpRequestPath(''), 'other', 'empty path -> other')
}

console.log('\n[3] Dynamic UUID/ID segments never leak into the category label (bounded cardinality)')
{
  const uuidPath = '/api/topics/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/messages/ffffffff-1111-2222-3333-444444444444/replies'
  const category = classifyHttpRequestPath(uuidPath)
  assertEqual(category, 'topics', 'UUID-heavy path still resolves to the fixed "topics" category')
  assert(!category.includes('-'), 'category label never contains a raw UUID fragment')
}

console.log('\n[4] Category set is small and finite (fixed cardinality — the whole point of this classifier)')
{
  const samplePaths = [
    '/api/topics', '/api/support/x', '/api/admin/y', '/api/admin/monitoring/z', '/api/auth/a',
    '/api/profile/b', '/api/profiles/c', '/api/friends/d', '/api/blocks', '/api/chat/e',
    '/api/players', '/api/leaderboards', '/api/shop/f', '/api/vip/g', '/api/tournaments/h',
    '/api/missions', '/api/daily-rewards', '/api/contact/guest', '/api/guest-trial-status',
    '/uploads/i', '/api/public-settings', '/api/public/j', '/health', '/random/unmapped',
  ]
  const categories = new Set(samplePaths.map((p) => classifyHttpRequestPath(p)))
  assert(categories.size <= 20, `category cardinality stays small (got ${categories.size} distinct categories for ${samplePaths.length} sample paths)`)
}

console.log('\n[5] Prefix matching does not false-positive on similar-but-different paths')
{
  assertEqual(classifyHttpRequestPath('/api/topicsomething'), 'other', 'lookalike prefix without a path separator does not match "topics"')
  assertEqual(classifyHttpRequestPath('/api/topics-extra'), 'other', 'lookalike prefix with a dash does not match "topics"')
}

// ─── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(60)}`)
console.log(`Passed: ${passed}  Failed: ${failed}`)

if (failed > 0) {
  process.exit(1)
}
