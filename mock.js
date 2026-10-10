'use strict';
/**
 * Sample data that mimics the shape of Sportradar Soccer v4 responses
 * (schedules/live/summaries, schedules/{date}/summaries, sport_events/{id}/timeline).
 * It runs a simulated match clock so the UI behaves like a real live feed.
 * Team names are real, but players and events are invented.
 */

const SPEED = 15;                 // game seconds per real second
const CYCLE = 480;                // real seconds before a simulated match restarts
const H1_END = 47 * 60;           // first half incl. 2 min stoppage (clock seconds)
const HT_LEN = 15 * 60;
const H2_LEN = 49 * 60;           // 45:00 -> 94:00
const H2_START = H1_END + HT_LEN; // game seconds when 2nd half kicks off
const FT_AT = H2_START + H2_LEN;  // game seconds when full time is reached
const PUBLISH_DELAY_G = 4 * SPEED; // events show up 4 real seconds after they happen
const gameTimeOf = (e) => (e.h === 1 ? e.at * 60 : H2_START + (e.at - 45) * 60);

const ENG = { id: 'sr:category:1', name: 'England', country_code: 'ENG' };
const ESP = { id: 'sr:category:32', name: 'Spain', country_code: 'ESP' };
const PL = { id: 'sr:competition:17', name: 'Premier League' };
const CH = { id: 'sr:competition:18', name: 'Championship' };
const LL = { id: 'sr:competition:8', name: 'LaLiga' };

const SEASONS = {
  'sr:competition:17': { id: 'sr:season:100001', name: 'Premier League 25/26', year: '25/26' },
  'sr:competition:18': { id: 'sr:season:100002', name: 'Championship 25/26', year: '25/26' },
  'sr:competition:8': { id: 'sr:season:100003', name: 'LaLiga 25/26', year: '25/26' },
};
const team = (name, id, abbreviation) => ({ id: `sr:competitor:${id}`, name, abbreviation });
const p = (name, type) => ({ id: `sr:player:${Math.abs(hash(name))}`, name, type });
const hash = (s) => [...s].reduce((a, c) => (a * 31 + c.charCodeAt(0)) | 0, 7);

// E(half, clockMinute, type, side, players, extra)
const E = (h, at, type, side, players = [], extra = {}) => ({ h, at, type, side, players, extra });
const goal = (h, at, side, scorer, assist) =>
  E(h, at, 'score_change', side, [p(scorer, 'scorer'), ...(assist ? [p(assist, 'assist')] : [])]);
const yellow = (h, at, side, name) => E(h, at, 'yellow_card', side, [p(name, 'booked')]);
const red = (h, at, side, name) => E(h, at, 'red_card', side, [p(name, 'booked')]);
const sub = (h, at, side, on, off) =>
  E(h, at, 'substitution', side, [p(on, 'substituted_in'), p(off, 'substituted_out')]);
const firstHalf = E(1, 0, 'period_start', null);
const kickoff = E(1, 0, 'match_started', null);
const ht = E(1, 47, 'break_start', null);
const secondHalf = E(2, 45, 'period_start', null);
const fullTime = E(2, 94, 'match_ended', null);

const DEFS = [
  {
    id: 'sr:sport_event:90000001', comp: PL, cat: ENG, round: 8, offset: 150,
    home: team('Arsenal', 42, 'ARS'), away: team('Liverpool', 44, 'LIV'), bias: 3,
    events: [
      firstHalf,
      kickoff,
      goal(1, 12, 'home', 'Alder, James', 'Moss, Kai'),
      yellow(1, 23, 'away', 'Varga, Tomas'),
      goal(1, 38, 'away', 'Haddad, Omar', null),
      yellow(1, 44, 'home', 'Brandt, Leon'),
      ht,
      secondHalf,
      sub(2, 58, 'home', 'Okoro, Dele', 'Moss, Kai'),
      sub(2, 61, 'away', 'Pinto, Rui', 'Varga, Tomas'),
      goal(2, 67, 'home', 'Okoro, Dele', 'Alder, James'),
      E(2, 72, 'video_assistant_referee', 'away', [], { outcome: 'goal disallowed' }),
      red(2, 79, 'away', 'Haddad, Omar'),
      E(2, 90, 'injury_time_shown', null, [], { injury_time_announced: 4 }),
      goal(2, 90.5, 'home', 'Alder, James', null),
      fullTime,
    ],
  },
  {
    id: 'sr:sport_event:90000002', comp: PL, cat: ENG, round: 8, offset: 340,
    home: team('Chelsea', 38, 'CHE'), away: team('Manchester City', 17, 'MCI'), bias: -4,
    events: [
      firstHalf,
      kickoff,
      yellow(1, 9, 'home', 'Reyes, Marco'),
      goal(1, 27, 'away', 'Lindqvist, Axel', 'Duarte, Nuno'),
      goal(1, 45.5, 'away', 'Duarte, Nuno', null),
      ht,
      secondHalf,
      goal(2, 53, 'home', 'Reyes, Marco', 'Cole, Ethan'),
      sub(2, 64, 'home', 'Webb, Callum', 'Cole, Ethan'),
      yellow(2, 70, 'away', 'Santos, Ivo'),
      E(2, 83, 'penalty_awarded', 'home', []),
      goal(2, 85, 'home', 'Reyes, Marco', null),
      fullTime,
    ],
  },
  {
    id: 'sr:sport_event:90000003', comp: CH, cat: ENG, round: 12, offset: 60,
    home: team('Leeds United', 34, 'LEE'), away: team('Sunderland', 8, 'SUN'), bias: 0,
    events: [
      firstHalf,
      kickoff,
      goal(1, 31, 'home', 'Frost, Jamie', null),
      yellow(1, 40, 'away', 'Nolan, Sean'),
      ht,
      secondHalf,
      sub(2, 60, 'away', 'Ito, Ren', 'Nolan, Sean'),
      goal(2, 74, 'away', 'Ito, Ren', null),
      fullTime,
    ],
  },
  {
    id: 'sr:sport_event:90000004', comp: PL, cat: ENG, round: 8, force: 'FT',
    home: team('Everton', 48, 'EVE'), away: team('Brighton & Hove Albion', 30, 'BHA'), bias: 2,
    events: [
      firstHalf,
      kickoff,
      goal(1, 18, 'home', 'Doyle, Cian', 'Marsh, Billy'),
      yellow(1, 33, 'away', 'Kato, Haru'),
      ht,
      secondHalf,
      goal(2, 56, 'away', 'Kato, Haru', null),
      goal(2, 81, 'home', 'Marsh, Billy', null),
      fullTime,
    ],
  },
  {
    id: 'sr:sport_event:90000005', comp: PL, cat: ENG, round: 8, force: 'pre',
    home: team('Newcastle United', 39, 'NEW'), away: team('Aston Villa', 7, 'AVL'), bias: 0,
    events: [],
  },
  {
    id: 'sr:sport_event:90000006', comp: LL, cat: ESP, round: 9, offset: 200,
    home: team('Real Madrid', 2829, 'RMA'), away: team('FC Barcelona', 2817, 'BAR'), bias: 1,
    events: [
      firstHalf,
      kickoff,
      goal(1, 21, 'home', 'Vidal, Mateo', null),
      goal(2, 63, 'away', 'Ferrer, Pau', null),
      ht, secondHalf, fullTime,
    ],
  },
];

function phaseOf(def, nowMs) {
  if (def.force === 'pre') return { phase: 'pre', played: 0, g: 0 };
  if (def.force === 'FT') return { phase: 'FT', played: 94 * 60, g: FT_AT + 3 * 3600 * SPEED };
  const g = (((nowMs / 1000) + def.offset) % CYCLE) * SPEED;
  if (g < H1_END) return { phase: '1H', played: g, g };
  if (g < H2_START) return { phase: 'HT', played: 45 * 60, g };
  if (g < FT_AT) return { phase: '2H', played: 45 * 60 + (g - H2_START), g };
  return { phase: 'FT', played: 94 * 60, g };
}

function isVisible(e, ph) {
  if (ph.phase === 'pre') return false;
  if (ph.phase === 'FT') return true;
  if (e.h === 1) return ph.phase !== '1H' || e.at * 60 + PUBLISH_DELAY_G <= ph.played;
  if (e.h === 2) return ph.phase === '2H' && e.at * 60 + PUBLISH_DELAY_G <= ph.played;
  return false;
}

function matchTime(e) {
  if (e.h === 1 && e.at > 45) return { mt: 45, st: Math.floor(e.at - 45) };
  if (e.h === 2 && e.at > 90) return { mt: 90, st: Math.floor(e.at - 90) };
  return { mt: Math.floor(e.at), st: null };
}

const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

function statusFor(phase) {
  switch (phase) {
    case 'pre': return { status: 'not_started', match_status: 'not_started' };
    case '1H': return { status: 'live', match_status: '1st_half' };
    case 'HT': return { status: 'live', match_status: 'halftime' };
    case '2H': return { status: 'live', match_status: '2nd_half' };
    default: return { status: 'closed', match_status: 'ended' };
  }
}

function build(def, nowMs = Date.now()) {
  const ph = phaseOf(def, nowMs);
  const visible = def.events.filter((e) => isVisible(e, ph));
  let home = 0, away = 0, h1 = [0, 0];
  const timeline = visible.map((e, i) => {
    if (e.type === 'score_change') e.side === 'home' ? home++ : away++;
    if (e.h === 1) h1 = [home, away];
    const { mt, st } = matchTime(e);
    return {
      id: i + 1, type: e.type, time: new Date(nowMs - Math.max(0, (ph.g - gameTimeOf(e)) / SPEED) * 1000).toISOString(),
      match_time: mt, ...(st ? { stoppage_time: st } : {}),
      match_clock: mmss(e.at * 60), ...(e.side ? { competitor: e.side } : {}),
      period: e.h, period_name: e.h === 1 ? 'first half' : 'second half',
      home_score: home, away_score: away,
      ...(e.players.length ? { players: e.players } : {}), ...e.extra,
    };
  });

  const startMs = ph.phase === 'pre'
    ? Math.ceil((nowMs + 2 * 3600e3) / 1800e3) * 1800e3
    : nowMs - (ph.phase === 'FT' ? 3 * 3600e3 : ph.played * 1000 / SPEED + (ph.phase === '2H' ? HT_LEN * 1000 / SPEED : 0));

  const status = statusFor(ph.phase);
  const summary = {
    sport_event: {
      id: def.id, start_time: new Date(startMs).toISOString(), start_time_confirmed: true,
      sport_event_context: {
        sport: { id: 'sr:sport:1', name: 'Soccer' }, category: def.cat, competition: def.comp,
        season: { ...SEASONS[def.comp.id], competition_id: def.comp.id },
        round: { type: 'group', number: def.round },
      },
      competitors: [
        { ...def.home, country: def.cat.name, qualifier: 'home' },
        { ...def.away, country: def.cat.name, qualifier: 'away' },
      ],
    },
    sport_event_status: {
      ...status, home_score: home, away_score: away,
      ...(ph.phase === 'pre' ? {} : {
        clock: { played: mmss(ph.played) },
        period_scores: ph.phase === '1H' ? [] : [
          { home_score: h1[0], away_score: h1[1], number: 1, type: 'regular_period' },
          ...(ph.phase === 'FT' ? [{ home_score: home - h1[0], away_score: away - h1[1], number: 2, type: 'regular_period' }] : []),
        ],
      }),
    },
  };

  const mins = ph.played / 60;
  const poss = Math.round(50 + (def.bias || 0) + 5 * Math.sin(mins / 11));
  const stat = (rate, k) => Math.floor((mins * rate) / 10 + k);
  const count = (type, side) => visible.filter((e) => e.type === type && e.side === side).length;
  const mk = (side, pos, rate) => ({
    qualifier: side, name: (side === 'home' ? def.home : def.away).name,
    statistics: {
      ball_possession: pos, shots_total: stat(rate, 0), shots_on_target: Math.floor(stat(rate, 0) / 3),
      corner_kicks: Math.floor(mins * rate / 60), fouls: Math.floor(mins / 8) + (side === 'home' ? 1 : 2),
      yellow_cards: count('yellow_card', side), red_cards: count('red_card', side),
    },
  });
  const statistics = ph.phase === 'pre' ? undefined
    : { totals: { competitors: [mk('home', poss, 1.4 + (def.bias || 0) / 10), mk('away', 100 - poss, 1.2 - (def.bias || 0) / 10)] } };

  return { summary, timeline, statistics };
}

const isLive = (def, now) => ['1H', 'HT', '2H'].includes(phaseOf(def, now).phase);

// ---- sample lineups and standings ----
const SURNAMES = ['Alder', 'Moss', 'Okoro', 'Varga', 'Haddad', 'Brandt', 'Pinto', 'Reyes', 'Cole', 'Webb', 'Santos', 'Lindqvist', 'Duarte', 'Frost', 'Nolan', 'Ito', 'Doyle', 'Marsh', 'Kato', 'Ferrer', 'Vidal', 'Stone', 'Hale', 'Ward', 'Price', 'Quinn', 'Rowe', 'Dunn', 'Bell', 'Cruz', 'Novak', 'Hart', 'Lowe', 'Sato', 'Ruiz', 'Berg'];
const FIRSTS = ['James', 'Kai', 'Dele', 'Tomas', 'Omar', 'Leon', 'Rui', 'Marco', 'Ethan', 'Callum', 'Axel', 'Nuno', 'Ivo', 'Jamie', 'Sean', 'Ren', 'Cian', 'Billy', 'Haru', 'Pau', 'Mateo'];
const FORMATIONS = ['4-3-3', '4-4-2', '3-5-2', '4-2-3-1'];
const num = (id) => Number(String(id).replace(/\D/g, '')) || 1;

function squad(t, formation) {
  const seed = num(t.id);
  const nm = (i) => `${SURNAMES[(seed + i * 7) % SURNAMES.length]}, ${FIRSTS[(seed + i * 3) % FIRSTS.length]}`;
  const parts = formation.split('-').map(Number);
  const def = parts[0], fwd = parts[parts.length - 1], mid = 10 - def - fwd;
  const types = ['goalkeeper', ...Array(def).fill('defender'), ...Array(mid).fill('midfielder'), ...Array(fwd).fill('forward')];
  const shirt = [1, 2, 5, 4, 3, 8, 6, 10, 7, 9, 11];
  const players = types.map((type, i) => ({ id: `sr:player:${seed}${i}`, name: nm(i), type, jersey_number: shirt[i] || i + 1, starter: true, order: i + 1 }));
  const benchTypes = ['goalkeeper', 'defender', 'defender', 'midfielder', 'midfielder', 'forward', 'forward'];
  benchTypes.forEach((type, i) => players.push({ id: `sr:player:${seed}${20 + i}`, name: nm(20 + i), type, jersey_number: 12 + i, starter: false, order: 12 + i }));
  return players;
}

const SEASONS_BY_ID = Object.fromEntries(Object.values(SEASONS).map((x) => [x.id, x.name]));
const CLUBS = {
  'sr:season:100001': ['Arsenal', 'Liverpool', 'Chelsea', 'Manchester City', 'Everton', 'Brighton & Hove Albion', 'Newcastle United', 'Aston Villa', 'Tottenham Hotspur', 'Manchester United', 'West Ham United', 'Brentford', 'Fulham', 'Crystal Palace', 'Wolverhampton Wanderers', 'AFC Bournemouth', 'Nottingham Forest', 'Burnley', 'Leeds United', 'Sunderland'],
  'sr:season:100002': ['Leeds United', 'Sunderland', 'Burnley', 'Sheffield United', 'Norwich City', 'Middlesbrough', 'Coventry City', 'Watford', 'West Bromwich Albion', 'Bristol City', 'Millwall', 'Swansea City'],
  'sr:season:100003': ['Real Madrid', 'FC Barcelona', 'Atletico Madrid', 'Sevilla', 'Real Sociedad', 'Villarreal', 'Athletic Club', 'Valencia', 'Real Betis', 'Girona'],
};
const TEAM_IDS = Object.fromEntries(DEFS.flatMap((d) => [[d.home.name, d.home.id], [d.away.name, d.away.id]]));

function standingsFor(seasonId, scale = 1, flip = 0) {
  const names = CLUBS[seasonId];
  if (!names) return null;
  const rows = names.map((name, i) => {
    const played = Math.max(1, Math.floor(8 * scale));
    const win0 = Math.max(0, 6 - Math.floor(i * 6 / names.length) - ((i + flip) % 2));
    const draw = Math.min(played, ((i + flip) * 2 + 1) % 3);
    const win = Math.min(played - draw, Math.floor(win0 * scale));
    const loss = Math.max(0, played - win - draw);
    const gf = win * 2 + draw + ((i + flip) % 4);
    const ga = loss * 2 + draw + ((i + flip) % 3);
    const letters = [...Array(5)].map((_, k) => 'WDL'[(i * 7 + k * 3 + flip) % 3]).join('');
    return { name, id: TEAM_IDS[name] || `sr:competitor:${7000 + i}`, played, win, draw, loss, gf, ga, points: win * 3 + draw, form: letters };
  }).sort((a, b) => b.points - a.points || (b.gf - b.ga) - (a.gf - a.ga) || b.gf - a.gf);
  return rows.map((r, i) => ({
    rank: i + 1, played: r.played, win: r.win, loss: r.loss, draw: r.draw,
    goals_for: r.gf, goals_against: r.ga, goals_diff: r.gf - r.ga,
    competitor: { id: r.id, name: r.name, form: r.form }, points: r.points,
    ...(i < 1 ? { current_outcome: 'Champions League' } : i < 4 ? { current_outcome: 'Champions League Qualification' } : i < 5 ? { current_outcome: 'UEFA Europa League Qualification' }
      : i >= rows.length - 3 ? { current_outcome: 'Relegation' } : {}),
    change: 0,
  }));
}

module.exports = {
  lineups(id) {
    const def = DEFS.find((d) => d.id === id);
    if (!def) return null;
    const mk = (t, q) => ({
      id: t.id, name: t.name, abbreviation: t.abbreviation, qualifier: q,
      formation: { type: FORMATIONS[num(t.id) % FORMATIONS.length] },
      manager: { name: `${SURNAMES[num(t.id) % SURNAMES.length]}, ${FIRSTS[num(t.id) % FIRSTS.length]}` },
      players: squad(t, FORMATIONS[num(t.id) % FORMATIONS.length]),
    });
    return { generated_at: new Date().toISOString(), sport_event: build(def).summary.sport_event, lineups: { confirmed: true, competitors: [mk(def.home, 'home'), mk(def.away, 'away')] } };
  },
  standings(seasonId) {
    const total = standingsFor(seasonId);
    if (!total) return null;
    const block = (type, rows) => ({
      type, round: 8,
      groups: [{ stage: { order: 1, type: 'league', phase: 'regular season', year: '25/26' }, id: 'sr:league:1', name: SEASONS_BY_ID[seasonId], live: true, standings: rows }],
    });
    return {
      generated_at: new Date().toISOString(),
      standings: [block('total', total), block('home', standingsFor(seasonId, 0.5, 1)), block('away', standingsFor(seasonId, 0.5, 2))],
    };
  },

  liveSummaries() {
    const now = Date.now() - 8000; // the live list trails the timeline by about 8 seconds
    return { generated_at: new Date(now).toISOString(), summaries: DEFS.filter((d) => isLive(d, now)).map((d) => build(d, now).summary) };
  },
  dailySummaries() {
    const now = Date.now();
    return { generated_at: new Date(now).toISOString(), summaries: DEFS.map((d) => build(d, now).summary) };
  },
  timeline(id) {
    const def = DEFS.find((d) => d.id === id);
    if (!def) return null;
    const { summary, timeline, statistics } = build(def);
    return { generated_at: new Date().toISOString(), ...summary, ...(statistics ? { statistics } : {}), timeline };
  },
};
