'use strict';
require('dotenv').config();
const express = require('express');
const path = require('path');
const mock = require('./mock');

// ---------- Config ----------
const PORT = Number(process.env.PORT || 3000);
const API_KEY = (process.env.SPORTRADAR_API_KEY || '').trim();
const useMockEnv = (process.env.USE_MOCK || '').trim().toLowerCase();
const USE_MOCK = useMockEnv ? useMockEnv === 'true' : !API_KEY;
const ACCESS = process.env.SPORTRADAR_ACCESS_LEVEL || 'trial';
const VERSION = process.env.SPORTRADAR_VERSION || 'v4';
const LANG = process.env.SPORTRADAR_LANG || 'en';
const BASE = `https://api.sportradar.com/soccer/${ACCESS}/${VERSION}/${LANG}`;
const MIN_INTERVAL = Number(process.env.MIN_REQUEST_INTERVAL_MS || 1100);
const POLL_SECONDS = Math.max(10, Number(process.env.POLL_SECONDS || 30));
const MAX_WATCHERS = Number(process.env.MAX_WATCHERS || 3);

if (!USE_MOCK && !API_KEY) {
  console.error('USE_MOCK is false but SPORTRADAR_API_KEY is empty. Add your key to .env.');
  process.exit(1);
}

// ---------- Measurement store ----------
const startedAt = Date.now();
const MAX_LOG = 2000;
const push = (arr, x) => { arr.push(x); if (arr.length > MAX_LOG) arr.shift(); };
const calls = [];          // every request to Sportradar: timing and status
const lagLog = [];         // key events: provider timestamp vs when we first saw them
const accLog = [];         // consistency check failures and recoveries
const checkState = new Map(); // `${matchId}|${check}` -> latest result
const seenEvents = new Set();
const lastFetchOf = new Map();  // matchId -> time of previous timeline fetch
const lastSummary = new Map();  // matchId -> score from the live list
let upstreamCalls = 0;

function stats(nums) {
  const a = nums.filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return { n: 0 };
  const q = (p) => a[Math.min(a.length - 1, Math.max(0, Math.ceil(p * a.length) - 1))];
  return { n: a.length, min: a[0], avg: Math.round(a.reduce((s, x) => s + x, 0) / a.length), p50: q(0.5), p95: q(0.95), max: a[a.length - 1] };
}

// ---------- Upstream client: throttled, cached, retried ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let chain = Promise.resolve();

function throttled(fn) {
  const run = chain.then(fn);
  chain = run.catch(() => {}).then(() => sleep(MIN_INTERVAL));
  return run;
}

async function attemptFetch(pathname, kind) {
  upstreamCalls++;
  const ts = Date.now();
  const t0 = performance.now();
  try {
    const res = await fetch(`${BASE}${pathname}`, {
      headers: { 'x-api-key': API_KEY, accept: 'application/json' },
      signal: AbortSignal.timeout(12000),
    });
    const ttfbMs = Math.round(performance.now() - t0);
    let data = null, bytes = 0;
    if (res.ok) { const text = await res.text(); bytes = text.length; data = JSON.parse(text); }
    push(calls, { ts, kind, ms: Math.round(performance.now() - t0), ttfbMs, status: res.status, ok: res.ok, bytes });
    return { ok: res.ok, status: res.status, data };
  } catch (err) {
    push(calls, { ts, kind, ms: Math.round(performance.now() - t0), status: 0, ok: false, error: err.name });
    throw err;
  }
}

// Retries live outside throttled(), otherwise a retry would wait on the call that is waiting for it.
async function upstream(pathname, kind) {
  for (let attempt = 0; ; attempt++) {
    const r = await throttled(() => attemptFetch(pathname, kind));
    if (r.status === 429 && attempt < 2) { await sleep(2000 * (attempt + 1)); continue; }
    if (!r.ok) { const err = new Error(`Sportradar responded ${r.status}`); err.status = r.status; throw err; }
    return r.data;
  }
}

async function mockCall(kind, fn) {
  const ms = Math.round(120 + Math.random() * 280);
  await sleep(ms);
  push(calls, { ts: Date.now(), kind, ms, ttfbMs: Math.round(ms * 0.7), status: 200, ok: true, simulated: true });
  return fn();
}

const cache = new Map(); // key -> { at, ttl, data, inflight }
async function cached(key, ttl, loader, fresh = false) {
  const hit = cache.get(key);
  if (!fresh && hit) {
    if (hit.data && Date.now() - hit.at < hit.ttl) return hit.data;
    if (hit.inflight) return hit.inflight;
  }
  const inflight = loader()
    .then((data) => {
      cache.set(key, { at: Date.now(), ttl: typeof ttl === 'function' ? ttl(data) : ttl, data });
      return data;
    })
    .catch((err) => {
      const stale = cache.get(key);
      if (stale && stale.data) { cache.set(key, { ...stale, inflight: null }); return stale.data; }
      cache.delete(key);
      throw err;
    });
  cache.set(key, { ...(hit || {}), inflight });
  return inflight;
}

// ---------- Fetchers ----------
const todayUTC = () => new Date().toISOString().slice(0, 10);

async function fetchLive() {
  const data = USE_MOCK ? await mockCall('live', () => mock.liveSummaries()) : await upstream('/schedules/live/summaries.json', 'live');
  const now = Date.now();
  (data.summaries || []).forEach((s) => {
    const st = s.sport_event_status || {};
    lastSummary.set(s.sport_event?.id, { home: st.home_score ?? 0, away: st.away_score ?? 0, at: now });
  });
  return data;
}
const getLive = () => (USE_MOCK ? fetchLive() : cached('live', 15000, fetchLive));

const getDaily = (date) =>
  USE_MOCK
    ? mockCall('daily', () => mock.dailySummaries())
    : cached(`daily:${date}`, 60000, () => upstream(`/schedules/${date}/summaries.json`, 'daily'));

async function fetchTimeline(id) {
  const data = USE_MOCK ? await mockCall('timeline', () => mock.timeline(id)) : await upstream(`/sport_events/${id}/timeline.json`, 'timeline');
  if (data) observeTimeline(id, data);
  return data;
}
const getTimeline = (id, fresh = false) =>
  USE_MOCK
    ? fetchTimeline(id)
    : cached(`tl:${id}`, (d) => (classify(d?.sport_event_status).state === 'finished' ? 300000 : 15000), () => fetchTimeline(id), fresh);

// ---------- Normalizers ----------
const LIVE_STATES = new Set(['live', '1st_half', '2nd_half', 'overtime', 'extra_time', '1st_extra', '2nd_extra', 'penalties']);
const DONE_STATES = new Set(['closed', 'ended', 'aet', 'ap']);
const OTHER_STATES = new Set(['postponed', 'cancelled', 'abandoned', 'delayed', 'suspended', 'interrupted']);
const PHASE_LABEL = {
  not_started: 'Not started', '1st_half': 'First half', halftime: 'Half-time', '2nd_half': 'Second half',
  awaiting_extra_time: 'Awaiting extra time', overtime: 'Extra time', '1st_extra': 'Extra time, first half',
  '2nd_extra': 'Extra time, second half', penalties: 'Penalty shootout', ended: 'Full time', closed: 'Full time',
  aet: 'Full time, after extra time', ap: 'Full time, after penalties', live: 'Live',
};

function classify(s = {}) {
  const st = s.status, ms = s.match_status;
  let state = 'upcoming';
  if (ms === 'halftime') state = 'halftime';
  else if (DONE_STATES.has(st) || DONE_STATES.has(ms)) state = 'finished';
  else if (LIVE_STATES.has(st) || LIVE_STATES.has(ms)) state = 'live';
  else if (OTHER_STATES.has(st) || OTHER_STATES.has(ms)) state = 'other';
  const label = state === 'other' ? pretty(OTHER_STATES.has(st) ? st : ms) : PHASE_LABEL[ms] || PHASE_LABEL[st] || pretty(ms || st);
  return { state, label };
}

function pretty(t) {
  return String(t || '').replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
}

function shortName(n) {
  if (!n) return '';
  if (!n.includes(',')) return n;
  const [last, first] = n.split(',').map((s) => s.trim());
  return first ? `${first[0]}. ${last}` : last;
}

function parseClock(played) {
  if (!played || typeof played !== 'string') return null;
  const [m, s] = played.split(':').map(Number);
  return Number.isFinite(m) ? m * 60 + (Number.isFinite(s) ? s : 0) : null;
}

function normMatch(item = {}) {
  const ev = item.sport_event || {};
  const st = item.sport_event_status || {};
  const ctx = ev.sport_event_context || {};
  const comps = ev.competitors || [];
  const pick = (q, i) => comps.find((c) => c.qualifier === q) || comps[i] || {};
  const toTeam = (c) => ({
    id: c.id || null,
    name: c.name || 'To be confirmed',
    abbr: c.abbreviation || (c.name || 'TBC').slice(0, 3).toUpperCase(),
  });
  const { state, label } = classify(st);
  return {
    id: ev.id,
    startTime: ev.start_time || null,
    competition: ctx.competition?.name || 'Soccer',
    competitionId: ctx.competition?.id || null,
    country: ctx.category?.name || null,
    isEngland: ctx.category?.country_code === 'ENG' || ctx.category?.name === 'England',
    round: ctx.round?.number ?? null,
    home: toTeam(pick('home', 0)),
    away: toTeam(pick('away', 1)),
    homeScore: st.home_score ?? (state === 'upcoming' ? null : 0),
    awayScore: st.away_score ?? (state === 'upcoming' ? null : 0),
    periodScores: (st.period_scores || []).map((p) => ({ home: p.home_score, away: p.away_score, number: p.number, type: p.type })),
    state,
    phase: st.match_status || st.status || null,
    phaseLabel: label,
    clockSeconds: parseClock(st.clock?.played),
  };
}

const KEY_TYPES = new Set([
  'score_change', 'yellow_card', 'red_card', 'yellow_red_card', 'substitution', 'penalty_awarded',
  'penalty_missed', 'penalty_shootout', 'video_assistant_referee', 'video_assistant_referee_over',
  'match_started', 'break_start', 'period_start', 'match_ended', 'injury_time_shown',
]);

function normEvent(e, i) {
  const players = (e.players || []).map((p) => ({ name: shortName(p.name), role: p.type || '' }));
  const hint = `${e.method || ''} ${e.outcome || ''} ${players.map((p) => p.role).join(' ')}`.toLowerCase();
  return {
    id: e.id ?? i,
    type: e.type,
    key: KEY_TYPES.has(e.type),
    minute: e.match_time ?? null,
    stoppage: e.stoppage_time ?? null,
    side: e.competitor || null,
    players,
    homeScore: e.home_score ?? null,
    awayScore: e.away_score ?? null,
    ownGoal: /own/.test(hint),
    penalty: /penalty/.test(hint),
    detail: e.outcome || e.method || (e.injury_time_announced ? `${e.injury_time_announced} minutes added` : null),
  };
}

const STAT_DEFS = [
  ['ball_possession', 'Possession', '%'],
  ['shots_total', 'Shots', ''],
  ['shots_on_target', 'Shots on target', ''],
  ['corner_kicks', 'Corners', ''],
  ['fouls', 'Fouls', ''],
  ['offsides', 'Offsides', ''],
  ['yellow_cards', 'Yellow cards', ''],
  ['red_cards', 'Red cards', ''],
];

function normStats(raw) {
  const comps = raw?.statistics?.totals?.competitors || [];
  const home = comps.find((c) => c.qualifier === 'home')?.statistics;
  const away = comps.find((c) => c.qualifier === 'away')?.statistics;
  if (!home || !away) return [];
  return STAT_DEFS
    .filter(([k]) => home[k] !== undefined || away[k] !== undefined)
    .map(([key, label, unit]) => ({ key, label, unit, home: home[key] ?? 0, away: away[key] ?? 0 }));
}

// ---------- Latency and accuracy measurement ----------
const label = (m) => `${m.home.name} v ${m.away.name}`;

function observeTimeline(id, raw) {
  const now = Date.now();
  const prev = lastFetchOf.get(id);
  lastFetchOf.set(id, now);
  const m = normMatch(raw);
  // Events already present on our first look have an unknown arrival time, so they are not timed.
  for (const e of raw.timeline || []) {
    const key = `${id}:${e.id}`;
    if (seenEvents.has(key)) continue;
    seenEvents.add(key);
    if (!prev || !KEY_TYPES.has(e.type) || !e.time) continue;
    const eventMs = Date.parse(e.time);
    if (!Number.isFinite(eventMs)) continue;
    const gap = now - prev;
    const lagMs = now - eventMs;
    push(lagLog, {
      matchId: id, match: label(m), eventId: e.id, type: e.type, minute: e.match_time ?? null,
      eventTime: e.time, seenAt: new Date(now).toISOString(),
      lagMs, sincePrevPollMs: gap, lowerBoundMs: Math.max(0, lagMs - gap),
    });
  }
  runChecks(id, m, raw);
}

function setCheck(id, m, name, ok, detail) {
  const k = `${id}|${name}`;
  const prev = checkState.get(k);
  const now = Date.now();
  if (prev && prev.ok === ok && (ok || prev.detail === detail)) return;
  const since = prev && !prev.ok && !ok ? prev.since : now;
  checkState.set(k, { id, name, ok, detail: ok ? null : detail, since });
  if (!ok || (prev && !prev.ok)) {
    push(accLog, {
      at: new Date(now).toISOString(), matchId: id, match: label(m), check: name, ok, detail: ok ? 'Back in agreement' : detail,
      ...(ok && prev ? { failedForMs: now - prev.since } : {}),
    });
  }
}

function runChecks(id, m, raw) {
  const evs = raw.timeline || [];
  const st = raw.sport_event_status || {};
  const sh = st.home_score ?? 0, sa = st.away_score ?? 0;

  // 1. The match score equals the running score on the latest goal event.
  if (m.state !== 'upcoming' && !['penalties', 'ap'].includes(m.phase)) {
    const goals = evs.filter((e) => e.type === 'score_change' && e.home_score != null);
    const last = goals[goals.length - 1];
    const eh = last ? last.home_score : 0, ea = last ? last.away_score : 0;
    setCheck(id, m, 'score_matches_events', eh === sh && ea === sa, `Status says ${sh}-${sa}, goal events say ${eh}-${ea}`);
  }

  // 2. Within each half, the event clock never runs backwards by more than a minute.
  const prevByPeriod = new Map(); let backwards = null;
  for (const e of evs) {
    if (e.match_time == null || ['period_start', 'break_start', 'match_started', 'match_ended'].includes(e.type)) continue;
    const t = e.match_time + (e.stoppage_time || 0);
    const p = e.period ?? 0;
    const prevT = prevByPeriod.get(p) ?? -1;
    if (prevT - t > 1 && !backwards) backwards = `${e.type} at ${t}' follows an event at ${prevT}'`;
    prevByPeriod.set(p, Math.max(prevT, t));
  }
  setCheck(id, m, 'events_in_order', !backwards, backwards);

  // 3. No key event is listed twice.
  const seen = new Set(); let dup = null;
  for (const e of evs) {
    if (!KEY_TYPES.has(e.type) || ['period_start', 'break_start', 'match_started', 'match_ended'].includes(e.type)) continue;
    const k = [e.type, e.match_time, e.stoppage_time, e.competitor, (e.players || []).map((p) => p.name).join('/')].join('|');
    if (seen.has(k) && !dup) dup = `${e.type} at ${e.match_time}' appears twice`;
    seen.add(k);
  }
  setCheck(id, m, 'no_duplicate_events', !dup, dup);

  // 4. Half scores add up to the final score (two regular periods only).
  const periods = st.period_scores || [];
  if (m.state === 'finished' && periods.length === 2 && periods.every((p) => p.type === 'regular_period')) {
    const ph = periods.reduce((s, p) => s + (p.home_score || 0), 0), pa = periods.reduce((s, p) => s + (p.away_score || 0), 0);
    setCheck(id, m, 'period_scores_sum', ph === sh && pa === sa, `Periods add to ${ph}-${pa}, final is ${sh}-${sa}`);
  }

  // 5. A live match has a plausible clock.
  if (m.state === 'live') {
    const sec = m.clockSeconds;
    setCheck(id, m, 'clock_sane', sec != null && sec >= 0 && sec <= 150 * 60, sec == null ? 'Live match has no clock' : `Clock reads ${Math.round(sec / 60)} minutes`);
  }

  // 6. The live list agrees with the timeline, if both were fetched within 20 seconds.
  const sum = lastSummary.get(id);
  if (sum && m.state === 'live' && Math.abs(Date.now() - sum.at) < 20000) {
    setCheck(id, m, 'summary_vs_timeline', sum.home === sh && sum.away === sa, `Live list says ${sum.home}-${sum.away}, timeline says ${sh}-${sa}`);
  }
}

// ---------- Watchers: poll chosen matches at a fixed interval, bypassing the cache ----------
const watchers = new Map();
const watchHistory = [];

function describeWatcher(w) {
  return {
    id: w.id, label: w.label, intervalSec: w.intervalSec, polls: w.polls, startedAt: new Date(w.startedAt).toISOString(),
    matchState: w.matchState || null, lastError: w.lastError || null, callsPerHour: Math.round(3600 / w.intervalSec),
  };
}

function stopWatch(id, reason) {
  const w = watchers.get(id);
  if (!w) return false;
  clearTimeout(w.timer);
  watchers.delete(id);
  push(watchHistory, { ...describeWatcher(w), stoppedAt: new Date().toISOString(), reason });
  return true;
}

function startWatch(id, intervalSec) {
  if (watchers.has(id)) return watchers.get(id);
  const w = { id, intervalSec, startedAt: Date.now(), polls: 0, label: id, timer: null };
  watchers.set(id, w);
  const tick = async () => {
    let next = w.intervalSec * 1000;
    try {
      const raw = await getTimeline(id, true);
      w.polls++; w.lastError = null;
      if (!raw) return void stopWatch(id, 'Match not found');
      const m = normMatch(raw);
      w.label = label(m); w.matchState = m.state;
      if (m.state === 'finished') return void stopWatch(id, 'Match finished');
      if (m.state === 'upcoming') next = Math.max(next, 60000); // do not burn quota before kick-off
    } catch (err) {
      w.lastError = err.message;
      if (err.status === 401 || err.status === 403) return void stopWatch(id, err.message);
    }
    if (watchers.get(id) === w) w.timer = setTimeout(tick, next);
  };
  tick();
  return w;
}

// ---------- HTTP ----------
const app = express();
app.disable('x-powered-by');
app.use(express.static(path.join(__dirname, 'public')));

const meta = () => ({
  source: USE_MOCK ? 'sample' : 'sportradar',
  upstreamCalls,
  fetchedAt: new Date().toISOString(),
  watching: [...watchers.keys()],
});

const HINTS = {
  401: 'Sportradar rejected the key. Check SPORTRADAR_API_KEY in .env.',
  403: 'Your key is not allowed to use this endpoint. Check that it belongs to the Soccer package and that the access level (trial or production) matches.',
  404: 'Sportradar has no data for this request yet.',
  429: 'Sportradar rate limit or quota reached. Wait a moment, raise POLL_SECONDS, or check your plan quota.',
};

function sendError(res, err) {
  const status = err.status && err.status >= 400 ? err.status : 502;
  res.status(status).json({
    error: err.name === 'TimeoutError' ? 'Sportradar did not respond in time.' : err.message,
    hint: HINTS[status] || 'Try again in a few seconds.',
    meta: meta(),
  });
}

app.get('/api/config', (req, res) => res.json({ ...meta(), pollSeconds: POLL_SECONDS }));

app.get('/api/matches', async (req, res) => {
  const scope = req.query.scope === 'today' ? 'today' : 'live';
  const englandOnly = req.query.england === '1'; // all leagues unless asked otherwise
  try {
    let items;
    if (scope === 'live') {
      items = (await getLive()).summaries || [];
    } else {
      const [daily, live] = await Promise.all([getDaily(todayUTC()), getLive().catch(() => ({ summaries: [] }))]);
      const byId = new Map((daily.summaries || []).map((s) => [s.sport_event?.id, s]));
      (live.summaries || []).forEach((s) => byId.set(s.sport_event?.id, s));
      items = [...byId.values()];
    }
    let matches = items.map(normMatch).filter((m) => m.id);
    if (englandOnly) matches = matches.filter((m) => m.isEngland);
    res.json({ matches, meta: meta() });
  } catch (err) {
    sendError(res, err);
  }
});

const validId = (id) => /^sr:sport_event:\d+$/.test(id);

app.get('/api/matches/:id', async (req, res) => {
  const { id } = req.params;
  if (!validId(id)) return res.status(400).json({ error: 'Invalid match id.' });
  try {
    const raw = await getTimeline(id);
    if (!raw) return res.status(404).json({ error: 'Match not found.', hint: HINTS[404], meta: meta() });
    res.json({ match: normMatch(raw), events: (raw.timeline || []).map(normEvent), stats: normStats(raw), meta: meta() });
  } catch (err) {
    sendError(res, err);
  }
});

app.post('/api/watch/:id', (req, res) => {
  const { id } = req.params;
  if (!validId(id)) return res.status(400).json({ error: 'Invalid match id.' });
  if (!watchers.has(id) && watchers.size >= MAX_WATCHERS) {
    return res.status(409).json({ error: `You can measure up to ${MAX_WATCHERS} matches at once.`, hint: 'Stop one first, or raise MAX_WATCHERS in .env. Each watched match uses API quota.', meta: meta() });
  }
  const interval = Math.min(300, Math.max(10, Number(req.query.interval) || 15));
  startWatch(id, interval);
  res.json({ watchers: [...watchers.values()].map(describeWatcher), meta: meta() });
});

app.delete('/api/watch/:id', (req, res) => {
  stopWatch(req.params.id, 'Stopped by you');
  res.json({ watchers: [...watchers.values()].map(describeWatcher), meta: meta() });
});

app.get('/api/metrics', (req, res) => {
  const by = (kind) => calls.filter((c) => c.kind === kind);
  const callStats = (list) => ({
    ...stats(list.filter((c) => c.ok).map((c) => c.ms)),
    ttfb: stats(list.filter((c) => c.ok && c.ttfbMs != null).map((c) => c.ttfbMs)),
    total: list.length,
    errors: list.filter((c) => !c.ok).length,
    avgKb: list.length ? Math.round(list.reduce((s, c) => s + (c.bytes || 0), 0) / list.length / 1024) : 0,
  });
  const types = [...new Set(lagLog.map((l) => l.type))];
  const checks = {};
  for (const st of checkState.values()) {
    const c = (checks[st.name] ||= { matches: 0, failingNow: 0, failuresLogged: 0, recoveries: [] });
    c.matches++;
    if (!st.ok) c.failingNow++;
  }
  for (const l of accLog) {
    const c = (checks[l.check] ||= { matches: 0, failingNow: 0, failuresLogged: 0, recoveries: [] });
    if (!l.ok) c.failuresLogged++;
    else if (l.failedForMs != null) c.recoveries.push(l.failedForMs);
  }
  Object.values(checks).forEach((c) => { c.recoveryStats = stats(c.recoveries); delete c.recoveries; });

  res.json({
    meta: { ...meta(), startedAt: new Date(startedAt).toISOString(), now: new Date().toISOString() },
    latency: {
      overall: callStats(calls),
      byEndpoint: { live: callStats(by('live')), daily: callStats(by('daily')), timeline: callStats(by('timeline')) },
      recent: calls.slice(-15).reverse(),
    },
    eventLag: {
      overall: stats(lagLog.map((l) => l.lagMs)),
      lowerBound: stats(lagLog.map((l) => l.lowerBoundMs)),
      pollGap: stats(lagLog.map((l) => l.sincePrevPollMs)),
      byType: Object.fromEntries(types.map((t) => [t, stats(lagLog.filter((l) => l.type === t).map((l) => l.lagMs))])),
      recent: lagLog.slice(-25).reverse(),
    },
    accuracy: { checks, recent: accLog.slice(-25).reverse(), matchesChecked: new Set([...checkState.values()].map((s) => s.id)).size },
    watchers: [...watchers.values()].map(describeWatcher),
    watchHistory: watchHistory.slice(-10).reverse(),
  });
});

app.get('/api/metrics/export', (req, res) => {
  res.setHeader('Content-Disposition', `attachment; filename="sportradar-measurements-${Date.now()}.json"`);
  res.json({
    generatedAt: new Date().toISOString(), source: USE_MOCK ? 'sample' : 'sportradar',
    note: 'lagMs = time between Sportradar\'s own event timestamp and our first sighting. lowerBoundMs subtracts the polling gap.',
    calls, eventLag: lagLog, accuracyLog: accLog,
  });
});

app.listen(PORT, () => {
  console.log(`\nSoccer live POC running at http://localhost:${PORT}`);
  console.log(USE_MOCK ? 'Mode: SAMPLE DATA (no API calls are made)' : `Mode: LIVE via ${BASE}`);
  if (!USE_MOCK) console.log(`Throttle: one request every ${MIN_INTERVAL} ms`);
});
