// HTTP adapter за strictly-local турнирния тестов режим. Единствената
// отговорност тук е guard-ване + (de)serialization — цялата бизнес логика
// живее в localTournamentTestService.ts (реалните store функции).
//
// Guard-ва СЕКВЕНЦИАЛНО: (1) pathname префикс, (2) isLocalTournamentTestRequestAllowed
// (флаг + loopback) — при провал връща 404, не 403, за да не издава дори
// съществуването на route-а извън строго локалния режим (виж §15 в task
// spec-а: "dev endpoint → 404").

import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  isLocalTournamentTestModeEnabled,
  isLocalTournamentTestRequestAllowed,
} from './localTournamentTestModeGuard.js'
import type {
  CreateLocalTestTournamentInput,
  LocalTournamentTestParticipantMode,
  LocalTournamentTestService,
  LocalTournamentTestTeamCapacity,
} from './localTournamentTestService.js'

const ROUTE_PREFIX = '/dev/tournament-test'

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

function sendHtml(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(html),
  })
  res.end(html)
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolvePromise, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      if (chunks.length === 0) {
        resolvePromise({})
        return
      }
      try {
        resolvePromise(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch (error) {
        reject(error)
      }
    })
    req.on('error', reject)
  })
}

const VALID_TEAM_CAPACITIES: readonly LocalTournamentTestTeamCapacity[] = [4, 8, 16]
const VALID_MODES: readonly LocalTournamentTestParticipantMode[] = ['one_human', 'all_bots', 'two_humans']

function parseCreateInput(body: unknown): CreateLocalTestTournamentInput | null {
  if (typeof body !== 'object' || body === null) return null
  const record = body as Record<string, unknown>
  const teamCapacity = record.teamCapacity
  const mode = record.mode
  const scenarioHint = record.scenarioHint
  if (
    typeof teamCapacity !== 'number' ||
    !VALID_TEAM_CAPACITIES.includes(teamCapacity as LocalTournamentTestTeamCapacity) ||
    typeof mode !== 'string' ||
    !VALID_MODES.includes(mode as LocalTournamentTestParticipantMode)
  ) {
    return null
  }
  return {
    teamCapacity: teamCapacity as LocalTournamentTestTeamCapacity,
    mode: mode as LocalTournamentTestParticipantMode,
    scenarioHint: typeof scenarioHint === 'string' ? scenarioHint : undefined,
  }
}

export async function handleLocalTournamentTestRequest(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  service: LocalTournamentTestService,
): Promise<boolean> {
  if (pathname !== ROUTE_PREFIX && !pathname.startsWith(`${ROUTE_PREFIX}/`)) return false

  if (!isLocalTournamentTestRequestAllowed(req)) {
    // Умишлено 404, не 403/401 — не издава дори съществуването на route-а
    // извън strictly-local режима (виж §15 в task spec-а).
    sendJson(res, 404, { ok: false, error: 'not_found' })
    return true
  }

  if (pathname === ROUTE_PREFIX && req.method === 'GET') {
    sendHtml(res, 200, renderLocalTournamentTestPanelHtml())
    return true
  }

  if (pathname === `${ROUTE_PREFIX}/api/health` && req.method === 'GET') {
    sendJson(res, 200, { ok: true, localTournamentTestModeEnabled: isLocalTournamentTestModeEnabled() })
    return true
  }

  if (pathname === `${ROUTE_PREFIX}/api/list` && req.method === 'GET') {
    sendJson(res, 200, { ok: true, tournaments: service.listTestTournaments() })
    return true
  }

  if (pathname === `${ROUTE_PREFIX}/api/state` && req.method === 'GET') {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const tournamentId = url.searchParams.get('tournamentId')
    if (tournamentId === null) {
      sendJson(res, 400, { ok: false, error: 'missing_tournament_id' })
      return true
    }
    const state = service.getTechnicalState(tournamentId)
    if (state === null) {
      sendJson(res, 404, { ok: false, error: 'tournament_not_found' })
      return true
    }
    sendJson(res, 200, { ok: true, state })
    return true
  }

  if (pathname === `${ROUTE_PREFIX}/api/create` && req.method === 'POST') {
    let rawBody: unknown
    try {
      rawBody = await readJsonBody(req)
    } catch {
      sendJson(res, 400, { ok: false, error: 'invalid_json' })
      return true
    }
    const input = parseCreateInput(rawBody)
    if (input === null) {
      sendJson(res, 400, { ok: false, error: 'invalid_input' })
      return true
    }
    const result = service.createTournament(input)
    sendJson(res, result.ok ? 200 : 400, result)
    return true
  }

  if (pathname === `${ROUTE_PREFIX}/api/reset` && req.method === 'POST') {
    const result = service.reset()
    sendJson(res, 200, { ok: true, ...result })
    return true
  }

  sendJson(res, 404, { ok: false, error: 'not_found' })
  return true
}

function renderLocalTournamentTestPanelHtml(): string {
  return `<!doctype html>
<html lang="bg">
<head>
<meta charset="utf-8">
<title>Belot V2 — Local Tournament Test Panel</title>
<meta name="robots" content="noindex,nofollow">
<style>
  body { font-family: system-ui, sans-serif; max-width: 960px; margin: 24px auto; padding: 0 16px; background: #0f172a; color: #e2e8f0; }
  h1 { font-size: 20px; }
  h2 { font-size: 15px; margin-top: 28px; border-bottom: 1px solid #334155; padding-bottom: 4px; }
  fieldset { border: 1px solid #334155; border-radius: 8px; padding: 12px 16px; margin-bottom: 12px; }
  label { display: block; margin: 8px 0 4px; font-size: 13px; color: #94a3b8; }
  select, button { font-size: 14px; padding: 6px 10px; border-radius: 6px; border: 1px solid #334155; background: #1e293b; color: #e2e8f0; }
  button { cursor: pointer; background: #2563eb; border-color: #2563eb; margin-right: 8px; }
  button.secondary { background: #1e293b; border-color: #475569; }
  button:hover { filter: brightness(1.1); }
  pre { background: #1e293b; padding: 12px; border-radius: 8px; overflow: auto; max-height: 420px; font-size: 12px; }
  .banner { padding: 8px 12px; border-radius: 6px; margin-bottom: 12px; font-size: 13px; }
  .banner.ok { background: #14532d; }
  .banner.err { background: #7f1d1d; }
  .muted { color: #64748b; font-size: 12px; }
  code { background: #1e293b; padding: 1px 5px; border-radius: 4px; }
</style>
</head>
<body>
<h1>🧪 Belot V2 — Local Tournament Test Panel</h1>
<p class="muted">Активен само при <code>BELOT_LOCAL_TOURNAMENT_TEST_MODE=1</code> + не-production + localhost. Никога не докосва production DB.</p>

<div id="banner"></div>

<h2>A. Създай тестов турнир</h2>
<fieldset>
  <label>Формат (брой отбори)</label>
  <select id="teamCapacity">
    <option value="4">4 отбора (8 играчи)</option>
    <option value="8">8 отбора (16 играчи)</option>
    <option value="16">16 отбора (32 играчи)</option>
  </select>

  <label>Режим</label>
  <select id="mode">
    <option value="one_human">1. Един реален играч + всички останали ботове</option>
    <option value="all_bots">2. Всички участници са ботове</option>
    <option value="two_humans">3. Двама реални играчи в един отбор + останалите ботове</option>
  </select>

  <label>Бележка за сценарий (опционално, само за твоя справка — виж guidance текста след създаване)</label>
  <select id="scenarioHint">
    <option value="">Нормален турнир</option>
    <option value="semifinal_walkover">Служебна победа на единия полуфинал (не влизай в мача)</option>
    <option value="round_missing_one_each">Липсва по един играч от двата отбора (влез само с една от твоите връзки)</option>
    <option value="final_walkover">Служебен резултат на финала (не влизай във финалния мач)</option>
  </select>

  <div style="margin-top:12px">
    <button onclick="createTournament()">Създай + стартирай (fill)</button>
  </div>
</fieldset>

<h2>B/C/D. Управление</h2>
<fieldset>
  <button class="secondary" onclick="listTournaments()">Покажи техническо състояние (последен списък)</button>
  <button class="secondary" onclick="resetAll()">Нулирай теста</button>
</fieldset>

<h2>Резултат</h2>
<pre id="output">—</pre>

<script>
function banner(kind, text) {
  document.getElementById('banner').innerHTML = '<div class="banner ' + kind + '">' + text + '</div>';
}
function out(obj) {
  document.getElementById('output').textContent = JSON.stringify(obj, null, 2);
}
async function createTournament() {
  const teamCapacity = Number(document.getElementById('teamCapacity').value);
  const mode = document.getElementById('mode').value;
  const scenarioHint = document.getElementById('scenarioHint').value;
  banner('ok', 'Създавам турнир…');
  try {
    const res = await fetch('/dev/tournament-test/api/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ teamCapacity, mode, scenarioHint }),
    });
    const body = await res.json();
    out(body);
    if (body.ok) {
      banner('ok', 'Турнир създаден: ' + body.tournamentId + ' (runId ' + body.runId + '). Отвори /tournaments в реалния клиент, докато си логнат с показаните credentials.');
      await showState(body.tournamentId);
    } else {
      banner('err', 'Грешка: ' + (body.reason || body.error));
    }
  } catch (err) {
    banner('err', 'Грешка: ' + err);
  }
}
async function listTournaments() {
  const res = await fetch('/dev/tournament-test/api/list');
  const body = await res.json();
  out(body);
  if (body.ok && body.tournaments.length > 0) {
    const last = body.tournaments[0];
    await showState(last.tournamentId);
  }
}
async function showState(tournamentId) {
  const res = await fetch('/dev/tournament-test/api/state?tournamentId=' + encodeURIComponent(tournamentId));
  const body = await res.json();
  out(body);
}
async function resetAll() {
  banner('ok', 'Нулирам…');
  const res = await fetch('/dev/tournament-test/api/reset', { method: 'POST' });
  const body = await res.json();
  out(body);
  banner('ok', 'Нулирано: ' + body.tournamentsRemoved + ' турнира, ' + body.profilesRemoved + ' тестови профила.');
}
</script>
</body>
</html>`
}
