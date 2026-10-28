# Backlog (deliberately deferred)

Real but deferred work, grouped by area. Each line says where it came from and what would trigger it. The owner's v2.1 requests live in the plan (§4.8), not here.

## Security / robustness
- **Unauthenticated socket handshakes** – handshakes are limited per user and presence broadcasts are coalesced (ADR 0011), but a handshake without a valid token is only refused after a JWT check, with no per-address limit (engine.io answers before the HTTP throttler). A Cloudflare rate-limiting rule on `/socket.io/*` if such floods show up.
- **Decode concurrency for uploads** – `UPLOAD_MAX_PIXELS` is 25 MP; add a small semaphore (or `sharp.concurrency(1)`) if memory spikes are observed.

## Contract / docs
- **Email follow-ups** – an admin view of unverified accounts; a revert link in the "address changed" notice (today the old address is only told). (Changing the address and the sessions list shipped as D1 on 2026-10-20, ADR 0010 amendment; accounts never verified are removed after 30 days since C6.)
- **Pre-D2 picture fields** – posts, quote embeds and messages still answer `imageUrl` next to `images`/`image`, and `POST /posts` still takes a single `imageKey`, so tabs opened before the D2 deploy keep working. Drop both (shared schemas, `toPost`, `toMessage`, `PostsService.create`, one int test) with the next change to the post shape, or a release after D2.
- **`message:new` for an unknown conversation** – a push for a conversation the client has never listed triggers a refetch of the list (`upsertConversation`); push the conversation itself if that round trip shows up.

## Operations
- **Shutdown** – `enableShutdownHooks({ useProcessExit: true })` so pino flushes on SIGTERM.
- **Access log volume** – 5xx are logged by both the filter (with stack) and pino-http; drop one if logs get noisy.
- **Log retention vs the privacy notice** (raised 2026-10-22 with L26, owner decision pending) – the notice says server logs are kept "a few days", but Docker's json-file rotation is by size (5 × 20 MB per container), so at low traffic request lines, which carry the visitor's address since L26, live for weeks. Either reword the notice ("until overwritten by newer entries, at most about 100 MB per service", bump `LEGAL_UPDATED_ON`) or make it true by time (journald logging driver plus `MaxRetentionSec` on the box).
- **Off-box backup copies** (A1) – rclone of `$BACKUP_DIR` to a remote of the owner's choice, as a second step of the backup unit; the remote lives in the runbook, not in the repository.
- **Cloudflare Bot Fight Mode** once the socket.io polling fallback is confirmed unaffected. An origin certificate for Caddy only matters if the tunnel is ever replaced by a direct origin.

## Monitoring and alerting (owner, 2026-10-22: deferred, in this order when picked up)
Nothing tells anyone today when something breaks. Docker health checks only mark a container unhealthy (nothing restarts it or alerts); the obvious outside probe, `GET /api/v1/auth/me` → 401, never touches the database (the guard answers first), and the real `GET /health` is internal (Caddy proxies only `/api/*` and `/socket.io/*`).
1. **Uptime** – an outside checker (UptimeRobot or Better Stack free tier, 5-minute interval) on the public site and on a health route that reaches the database (expose `/health` through Caddy or add a public `GET /api/v1/health`); Cloudflare's tunnel health notification as a second signal if the plan offers it. Catches: box, power, line, tunnel, API or database down.
2. **Dead man's switch** (closes the alerting half of review L27) – healthchecks.io pings on success from `backup.sh`, `update.sh` and `JobsService.runDaily` (URLs from env), a failure ping from each, and a small disk check (a timer that pings past ~85 %; Frigate may record to the same disk, and a full disk stops Postgres). `backup.sh` must also stop leaving a 0-byte dump behind. Catches: silent backup, update, migration and job failures, a filling disk.
3. **Error tracking** (= E3 in `IMPLEMENTATION_PLAN.md`) – Sentry free tier in its EU region for the API and the web app, with IP addresses and request bodies scrubbed, the request id attached; one sentence in the privacy notice (a processor receives error reports). Catches: the 500s and browser crashes members do not report.
4. **Metrics dashboards** (Prometheus + Grafana, Loki for logs) – only when a question needs trends (unexplained slowness, capacity, a second box), or as a deliberate showcase. Costs 4–6 containers and roughly 0.5–1.5 GB of RAM on a box shared with Frigate, plus a login to secure; Grafana Cloud's free tier avoids the hosting but ships logs, with addresses, to a third party. Until then Cloudflare's analytics show traffic and `docker stats` the box.

## Web

- Bulgarian interface (owner, 2026-10-22: not for now): an i18n layer for every string, the emails, the API's error messages and the legal pages, with `<html lang>` following the choice. Trigger: members who would rather read Bulgarian.
- Posts: link previews (SSRF-safe fetching, a cache and a queue, left out of D2 on purpose); alt text written by the author for each picture (today every picture says who posted it and its position). (Several pictures per post and the lightbox shipped as D2 on 2026-10-21.)
- Lightbox (D2): pinch to zoom (the stage takes the touch for swiping today), the phone's Back button closing it (needs a history entry per open viewer), paging through all the pictures of a chat thread rather than one.
- Search (ADR 0014): results are newest first; relevance ranking (`ts_rank` with a ranked cursor), highlighting of matched words and a stemmed per-language column are the upgrades when the volume asks for them. People search stays `ILIKE`.
- Tags (ADR 0013): `GET /tags/trending` is a live `GROUP BY` over the indexed 7-day window with no cache; add a 60 s in-memory cache if it shows up in the query log. Hashtags in comments were left out on purpose. (`#` autocomplete is B6 in the plan since 2026-10-20.)
- Chat: voice notes; a long-press reaction gesture on phones (the picker button is always visible there since C5). (Editing, reactions, the missing system lines and the sound rule shipped as C5 on 2026-10-20; notifications with the tab closed are E2.)
- Performance (Lighthouse mobile: feed 64, profile 74): `zod/mini` build of the shared schemas for the browser (≈ 25 kB gz of the first paint), `srcset` for post images (the sizes are stored since D2, which already set `width`/`height`; LCP), `fetchpriority="high"` on the first feed image, `<link rel=preload>` for the Latin Inter subset, prefetching route chunks on link hover.
- API logging: aborted client connections surface as raw `Error: read ECONNRESET` / `write EPIPE` lines on stderr (seen while Playwright closes contexts); route them through pino at debug level or ignore them.
- E2E: a Firefox/WebKit project once the suite is stable in CI; visual snapshots for the main pages. A smoke run against the production images (Caddy in front of the API, as on the box): Playwright goes through `vite preview`, so a Caddy rule that shadows an API route goes unnoticed — the ready-made pictures were 404 on the site after R7 because Caddy answered `/api/v1/uploads/*` from the volume (fixed 2026-10-23 in the Caddyfile, checked against Caddy 2.11.7).
- Images: multi-arch (`linux/arm64`) builds if the box is ever ARM. (The one-shot `migrate` image shipped with E4 on 2026-10-22, ADR 0018.) The migrate image is 719 MB because the Prisma 7 CLI hard-depends on Studio, effect and pglite; nothing to trim without patching the CLI.

## Ideas not in the agreed order (2026-10-22)
- **Weekly digest** (F4 in `IMPLEMENTATION_PLAN.md`, owner 2026-10-23: not for now) – the Monday mail for members away three days, as planned there. Open points when picked up: the Resend plan's daily cap (every digest falls on Monday morning), the fallback for members without a time zone, the privacy-notice line. The frequent jobs it runs on exist since F3.
From the ideas round that produced Track F of `IMPLEMENTATION_PLAN.md` (the newcomer experience that stood here is F1 and F2's Getting started checklist now). Trigger for each: members asking, or a gap between slices.
- **Chat**: forward, pin a message, search inside a thread; voice notes stay under Web. (Replies to a message shipped as R6 on 2026-10-23.)
- **Posts and profiles**: content warnings and spoilers, drafts and scheduled posts. (The pinned post and double tap to like shipped as R6 on 2026-10-23.)
- **Communities**: groups with their own feed, members and moderators, once one shared feed gets crowded (XL).
- **Games beyond F6**: ratings and leaderboards; checkers, backgammon, a daily word puzzle, battleship (listed in F6 as the later games).
- **Stories**: highlights that outlive the 24 hours; video (needs Cloudflare Stream or R2, not the box).
- **Calls**: group calls and live audio rooms (a media server: LiveKit or Jitsi, managed or with open ports).
- **Emoji** (ADR 0023, 2026-10-28): a skin tone preference in `users.settings` (frimousse has the selector); an in-place emoji panel on phones at the keyboard's measured height, as Telegram Web does it, should the keyboard's own panel not be enough.
