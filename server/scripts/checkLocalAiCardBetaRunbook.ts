/**
 * checkLocalAiCardBetaRunbook.ts
 *
 * Local check script за docs/local-ai-card-beta-runbook.md (и по избор
 * scripts/local-ai/start-local-ai-card-beta.ps1) — валидира, че runbook-ът
 * съдържа нужните env vars/пътища/команди и НЕ съдържа production
 * deploy/SSH инструкции или сурови secrets.
 *
 * Не пипа production .env, не прави network/SSH/deploy.
 */

import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const repoRoot = join(import.meta.dirname, '..', '..')
const runbookPath = join(repoRoot, 'docs', 'local-ai-card-beta-runbook.md')
const helperScriptPath = join(repoRoot, 'scripts', 'local-ai', 'start-local-ai-card-beta.ps1')

let passed = 0
let failed = 0

function check(label: string, cond: boolean, detail?: string): void {
  if (cond) {
    passed++
    console.log(`  PASS  ${label}`)
  } else {
    failed++
    console.error(`  FAIL  ${label}${detail ? `: ${detail}` : ''}`)
  }
}

// Dangerous / production-only patterns that must NEVER appear in a local-only runbook.
const FORBIDDEN_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  { name: 'ssh command', pattern: /\bssh\s+[\w.-]+@/i },
  { name: 'scp command', pattern: /\bscp\s/i },
  { name: 'rsync to remote host', pattern: /\brsync\s.*:.+/i },
  { name: 'production deploy command', pattern: /\bnpm run deploy\b|\bpm2\s+(start|reload|deploy)\b|\bdocker\s+push\b/i },
  { name: 'systemctl remote service control', pattern: /\bsystemctl\s+(restart|start|stop)\b/i },
  { name: 'production server literal', pattern: /production\s+server\s+(is|at|:)\s*\S/i },
  { name: 'raw IP address', pattern: /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/ },
]

// Secret-shaped values: KEY=<something that looks like a real assigned secret>, not blank/placeholder.
const RAW_SECRET_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  { name: 'assigned STRIPE_SECRET_KEY value', pattern: /STRIPE_SECRET_KEY\s*[=:]\s*["']?sk_/i },
  { name: 'assigned TRAINING_RECORDER_HASH_SECRET value', pattern: /TRAINING_RECORDER_HASH_SECRET\s*[=:]\s*["']?[A-Za-z0-9_-]{8,}/i },
  { name: 'generic long hex/base64 secret literal', pattern: /\b(secret|token|password|api[_-]?key)\b\s*[=:]\s*["']?[A-Za-z0-9+/_-]{20,}["']?/i },
]

async function main(): Promise<void> {
  console.log('\ncheckLocalAiCardBetaRunbook\n')

  check('runbook file exists at docs/local-ai-card-beta-runbook.md', existsSync(runbookPath), runbookPath)
  if (!existsSync(runbookPath)) {
    console.log(`\n${passed + failed} checks: ${passed} passed, ${failed} failed\n`)
    process.exit(1)
  }

  const runbook = await readFile(runbookPath, 'utf8')

  const requiredEnvVars = [
    'LOCAL_AI_CARD_BETA_ENABLED',
    'LOCAL_AI_CARD_BETA_TRACE_ENABLED',
    'LOCAL_AI_CARD_BETA_MODEL_PATH',
    'LOCAL_AI_CARD_BETA_TRACE_PATH',
  ]
  for (const envVar of requiredEnvVars) {
    check(`runbook mentions ${envVar}`, runbook.includes(envVar))
  }

  check(
    'runbook mentions model artifact path (training-output/models/card-model-v1/model.json)',
    /training-output[\\/]models[\\/]card-model-v1[\\/]model\.json/.test(runbook),
  )
  check(
    'runbook mentions trace log path (training-output/local-ai-beta/card-decisions.jsonl)',
    /training-output[\\/]local-ai-beta[\\/]card-decisions\.jsonl/.test(runbook),
  )
  check(
    'runbook mentions summarize command (npm run summarize:local-ai-card-beta-trace)',
    runbook.includes('npm run summarize:local-ai-card-beta-trace'),
  )

  for (const { name, pattern } of FORBIDDEN_PATTERNS) {
    check(`runbook does NOT contain ${name}`, !pattern.test(runbook))
  }
  for (const { name, pattern } of RAW_SECRET_PATTERNS) {
    check(`runbook does NOT contain ${name}`, !pattern.test(runbook))
  }

  if (existsSync(helperScriptPath)) {
    const helper = await readFile(helperScriptPath, 'utf8')
    check('helper script mentions LOCAL_AI_CARD_BETA_ENABLED', helper.includes('LOCAL_AI_CARD_BETA_ENABLED'))
    check('helper script mentions model.json path', /card-model-v1\\model\.json/.test(helper))
    for (const { name, pattern } of FORBIDDEN_PATTERNS) {
      check(`helper script does NOT contain ${name}`, !pattern.test(helper))
    }
    for (const { name, pattern } of RAW_SECRET_PATTERNS) {
      check(`helper script does NOT contain ${name}`, !pattern.test(helper))
    }
  } else {
    console.log('  (info)  no helper script found at scripts/local-ai/start-local-ai-card-beta.ps1 — skipping its checks')
  }

  console.log(`\n${passed + failed} checks: ${passed} passed, ${failed} failed\n`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error('Unexpected error:', e)
  process.exit(2)
})
