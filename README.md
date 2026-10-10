# Matchday: live soccer POC (Sportradar Soccer API)

## Run it
1. Install Node.js 18 or newer.
2. In this folder run `npm install`.
3. Run `npm start` and open http://localhost:3000

With no API key it starts in **sample data** mode (simulated matches with a running clock), so you can see the UI straight away.

## Switch to live data
1. Copy `.env.example` to `.env`.
2. Put your key in `SPORTRADAR_API_KEY=` (the key stays on your machine, in the server only).
3. Restart with `npm start`. The badge at the top changes from "Sample data" to "Live feed".

## What calls what (Soccer v4)
| UI | Sportradar endpoint |
|---|---|
| Live tab | `/schedules/live/summaries.json` |
| Today tab | `/schedules/{date}/summaries.json` (date is UTC), overlaid with the live feed |
| Match detail | `/sport_events/{id}/timeline.json` (events, status, stats) |

The server throttles to one request per `MIN_REQUEST_INTERVAL_MS`, caches responses for 15 to 60 seconds, retries on 429, and serves the last good data if a call fails.

## Lineups and table
Open a match, then use the Match / Lineups / Table switch under the scoreboard. Lineups come from `/sport_events/{id}/lineups.json` (cached 2 minutes) and the table from `/seasons/{season_id}/standings.json` (cached 5 minutes, season id taken from the match). Each is fetched only when you open its tab, to save quota. The pitch layout is approximate. If your feed uses different field names, check `normLineups` and `normStandings` in `server.js`.

## Measuring latency and accuracy
Open http://localhost:3000/monitor.html (or the "API performance" button).

1. Open a live match on the main page and choose "Start measuring". The server then fetches that match every 10 to 60 seconds, skipping its own cache, and logs what it sees.
2. The performance page shows:
   - **Response time:** median, 95th percentile and slowest response for each endpoint.
   - **Event delay:** for each new goal, card, substitution or VAR event, the gap between Sportradar's own timestamp and when we first saw it. A "best case" figure subtracts the polling gap, so the real delay lies between the two.
   - **Data consistency:** automatic checks that the score matches the goal events, events are in order and not duplicated, half scores add up, the clock is plausible, and the live list agrees with the timeline.
3. "Download raw log (JSON)" exports every request, timed event and issue so you can compare against another source.

Limits: the consistency checks find contradictions inside the feed, not facts that are wrong everywhere. To judge real-world accuracy and delay, compare the log with a broadcast or a second data provider. Measurements reset when the server restarts.

## Do I have player photos?
Player headshots come from Sportradar's separate Images API, which usually needs its own key. To test your key, open
`http://localhost:3000/api/images/check?league=epl` (add `&year=2025` or `&provider=getty` to narrow it).
Status 200 means it works, 401 or 403 means your package does not include images, 404 means that provider has no manifest for that league or year.
Each provider tested uses one API call.

## Trial quota tip
Trial keys usually have a small monthly call limit. The header shows how many API calls this session has used. Use "Pause auto-refresh" when you are not watching, and keep `POLL_SECONDS` at 30 or higher.

## If something looks off with real data
Open `server.js` and look at `normMatch`, `normEvent` and `normStats`. These are the only places that read Sportradar's field names, so any difference in your package's response is fixed there. Check `GET /api/matches/{id}` in the browser to see what the UI receives.
