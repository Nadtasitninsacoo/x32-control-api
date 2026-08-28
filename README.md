# x32-control-api

REST + WebSocket control API for **Behringer X32 / Midas M32** consoles, speaking OSC over UDP.

Self-contained: its own `package.json`, `.env`, Dockerfile and git repository. It has no
workspace, no shared folder and no dependency on any file outside this directory. A frontend
talks to it over HTTP/WS only, and learns its types from the exported `openapi.json`.

> **Status — Phases 1–5 of 7 complete.** The OSC core, console management, the mixer REST
> surface (Swagger + exported `openapi.json`), metering over WebSocket, console scenes with
> `.scn` import/export, and venue presets with fader ramping and version history are done
> and green, with the X32 emulator behind their tests. Phases 6–7 (room EQ, auth/safety)
> are not built yet. See [Roadmap](#roadmap).

---

## Quick start

```bash
npm install
cp .env.example .env        # then set X32_HOST, or leave it empty and use discovery
npm run start:dev
```

No console on the desk? Run the emulator in one terminal and point the API at it:

```bash
npm run emulator            # UDP 127.0.0.1:10023
# .env:  X32_HOST=127.0.0.1
```

### Tests

```bash
npm test              # unit + emulator integration + REST — no console, no database
npm run test:e2e      # boots the real AppModule over HTTP
npm run typecheck
npm run lint
```

### The frontend contract

```bash
npm run openapi:export      # -> openapi.json at the repository root
```

That file is the only thing a frontend needs from this project — there is no shared package
and no shared folder. Swagger UI is at **`/api/docs`** while the API is running.

Every test runs against the built-in emulator, so the whole suite is CI-safe.

### Docker

```bash
docker compose up --build
```

Brings up the API and its own PostgreSQL 17. Note that console **discovery broadcasts to
255.255.255.255, which does not cross a Docker bridge network** — on a Linux host add
`network_mode: host` to the `api` service; on Docker Desktop set `X32_HOST` explicitly.

---

## Design rule: the API speaks human units

The console works in raw `0.0–1.0` floats. **Nothing above the OSC layer is allowed to see
them.** REST, WebSocket, the database and the frontend deal exclusively in dB, Hz, ratio,
milliseconds and percent; every conversion happens in
[`src/osc/units/x32-units.ts`](src/osc/units/x32-units.ts) and nowhere else.

| Parameter | API unit | Raw taper |
| --- | --- | --- |
| Fader / send level | dB, −90 … +10 (−90 = −∞) | 4-segment piecewise linear |
| Head amp gain | dB, −12 … +60 | linear |
| Pan | −100 … +100 | linear |
| EQ band gain | dB, −15 … +15 | linear |
| EQ band frequency | Hz, 20 … 20 000 | logarithmic |
| EQ band Q | 10 … 0.3 | logarithmic, **inverted** |
| Low-cut frequency | Hz, 20 … 400 | logarithmic |
| Compressor threshold | dB, −60 … 0 | linear |
| Gate threshold / range | dB, −80 … 0 / 3 … 60 | linear |
| Attack | ms, 0 … 120 | linear |
| Hold | ms, 0.02 … 2000 | logarithmic |
| Release | ms, 5 … 4000 | logarithmic |
| Compressor ratio | 1.1 … 100 | int32 index into a fixed list |
| Meters | dBFS, −90 … 0 | `20·log10(sample)` |

Two polarity traps are encoded once, with names that cannot be misread:
`/mix/on` is **1 when the channel is un-muted** (`mutedToOnInt`), and EQ `q` runs *downwards*
(0.0 = Q 10, 1.0 = Q 0.3).

---

## Architecture

```
src/osc/
  codec/       OSC 1.0 encoder/decoder — int32, float32, string, blob, bundles
  units/       raw float  <->  dB / Hz / ratio / ms   (the only place that knows raw values)
  schema/      what each parameter is: type, taper, and how /node prints it
  addresses/   how many strips exist and how their roots are spelled
  rate-limit/  priority send queue: ≤50 msg/s, ≥2 ms apart, never drops
  transport/   one UDP socket per console, DRY_RUN aware
  broker/      request → reply correlation (the X32 has no message ids)
  heartbeat/   /xremote renewal every 8 s
  client/      OscClient = transport + pacing + broker, one per consoleId

src/console/
  discovery/   broadcast /info and collect whoever answers
  connection/  one supervised link: identify, sync, probe, reconnect with backoff
  state/       the in-memory mirror, /node dump parser, sync staging
  console-manager.service.ts   every link in the process, keyed by consoleId
```

Four facts about the X32 shape all of this:

1. **It has no message ids.** A reply arrives on the *same address* as the query, so requests
   are keyed by address and served FIFO — except `/node`, which is answered on the bare
   address `node` with no leading slash. The decoder is permissive about that; the transport
   still refuses to *send* a malformed address.
2. **It drops packets when flooded**, silently. Every datagram goes through the rate limiter:
   ≤50 msg/s with a ≥2 ms gap, three priorities (operator commands > housekeeping > polling),
   and no discarding — a 500-command burst is spread out, not thinned.
3. **`/xremote` expires after 10 seconds.** Miss a renewal and the parameter feed stops with
   no error at all. Renewal runs at 8 s, leaving a full period of margin.
4. **Meter blobs are little-endian inside**, while the OSC framing around them is big-endian.

---

## Staying connected, and the state mirror

UDP has no broken connection to detect, so liveness is inferred: an `/xinfo` probe goes out
every 2 s, and two unanswered probes move the link to `reconnecting`, where it retries with
backoff capped at 5 s. Detection plus recovery therefore stays inside the 10-second
requirement -- and a test asserts that arithmetic against the shipped defaults themselves,
so lowering a default can never quietly break the guarantee.

Coming back is not just re-opening a socket: `/xremote` is re-subscribed and the mirror is
re-synced, because every change made while the link was down was pushed to nobody.

**The mirror is filled once and then never re-polled.** A full sweep is roughly 1500 `/node`
queries; at the pacing the console tolerates, that is half a minute of traffic which would
starve operator commands. So the sync is staged, and the link is usable after the first stage:

| Stage | Contents | Queries |
| --- | --- | --- |
| `surface` | names, colours, faders, mutes, pan, head amps | ~160 |
| `sends` | every bus send on every input strip | ~770 |
| `full` | preamp, gate, dynamics, EQ | ~580 |

After that the `/xremote` feed carries every change -- including moves made on the physical
surface -- straight into the mirror.

### The `/node` decoding risk, and what is done about it

`/node` answers in *display* units (`/ch/01/mix ON -6.0 ON +0 OFF -oo`), so values are decoded
by position against [the schema](src/osc/schema/x32-schema.ts). That field ordering comes from
unofficial documentation, not from hardware on this desk. A line whose value count does not
match the schema is therefore **never decoded by position** -- one extra field would shift
every value onto the wrong parameter, and a wrong fader is a wrong show. Those containers are
reported and re-read parameter by parameter instead: slower, always correct.
`SyncReport.unparsed` names them, so a firmware mismatch surfaces as a log line and a number
rather than as silent corruption.

---

## Supported OSC addresses

The transport and the state mirror cover all of these; the REST surface arrives in Phase 3.

| Address | Direction | Notes |
| --- | --- | --- |
| `/info` | request → reply | server version, name, model, firmware |
| `/xinfo` | request → reply | IP, name, model, firmware |
| `/status` | request → reply | state, IP, name |
| `/xremote` | send, every 8 s | subscribes to the parameter feed for 10 s |
| `/unsubscribe` | send | drops all subscriptions for this socket |
| `/renew` | send | extends a meter subscription |
| `/node ,s <path>` | request → **`node`** | subtree dump in *display* units |
| `/subscribe ,s <path>` | send | starts a meter stream |
| `/batchsubscribe ,s <alias> ,s <path> …` | send | meter stream under an alias |
| `/meters/0 \| /1 \| /2 \| /13` | request → blob | 70 / 96 / 49 / 24 float32 LE samples |
| `/ch/01…32/…` | get / set | `config/{name,icon,color}`, `mix/{on,fader,st,pan,mono,mlevel}`, `mix/01…16/{on,level,pan}`, `preamp/{trim,invert,hpon,hpf}`, `gate/*`, `dyn/*`, `eq/1…4/{type,f,g,q}` |
| `/auxin/01…08/…`, `/fxrtn/01…08/…` | get / set | as channels |
| `/bus/01…16/…`, `/mtx/01…06/…` | get / set | strip + processing |
| `/main/st`, `/main/m` | get / set | strip + processing |
| `/dca/1…8/{on,fader,config/*}` | get / set | |
| `/headamp/000…031/{gain,phantom}` | get / set | head amps are global, not per-strip |

---

## The X32 emulator

[`test/emulator/x32-emulator.ts`](test/emulator/x32-emulator.ts) is a UDP stand-in used by the
test suite and runnable on its own (`npm run emulator [address] [port]`).

It reproduces the behaviours that break naive clients: same-address replies, the bare `node`
reply address, 10-second subscription expiry, little-endian meter blobs, display-unit `/node`
dumps, and silence for addresses it does not know. It can also inject packet loss (`dropRate`)
and latency (`latencyMs`) so reconnect and pacing paths can be exercised without touching a
cable.

Useful handles for tests: `emulator.get(address)`, `emulator.setFromConsole(address, args)`
(simulates someone moving a physical fader), `emulator.receivedOn(address)`,
`emulator.dropSubscriptions()` (simulates a console reboot), `emulator.xremoteSubscriberCount`.

Not modelled: routing matrix, effects rack, USB recorder, show/cue file contents.

---

## The REST surface

Base path `/api`. Interactive docs at `/api/docs`, machine-readable at
[`openapi.json`](openapi.json).

| Method | Path | What it does |
| --- | --- | --- |
| `GET` | `/api/health` | Liveness, plus how many consoles are connected |
| `GET` | `/api/consoles` | Every managed console and its link state |
| `POST` | `/api/consoles/discover` | Broadcast `/info` and report who answers |
| `POST` | `/api/consoles` | Connect to a console |
| `GET` | `/api/consoles/{id}` | One console's status |
| `DELETE` | `/api/consoles/{id}` | Disconnect (the console itself is untouched) |
| `POST` | `/api/consoles/{id}/resync` | Re-read the console into the mirror |
| `GET` | `/api/consoles/{id}/state` | Raw mirror contents under a prefix (troubleshooting) |
| `GET` | `/api/consoles/{id}/strips` | All 80 strips: name, colour, fader, mute |
| `GET` | `/api/consoles/{id}/strips/{kind}/{index}` | One strip in full |
| `PATCH` | `/api/consoles/{id}/strips/{kind}/{index}` | Change part of a strip |
| `GET` | `/api/consoles/{id}/meters` | Latest meter frame (a snapshot; use the socket to draw) |
| `GET` | `/api/consoles/{id}/meters/raw` | One meter bank, unmapped — the calibration tool |
| `GET` | `/api/consoles/{id}/show/{scene\|cue\|snippet}` | Occupied slots in the console show file |
| `POST` | `/api/consoles/{id}/show/{kind}/recall` | Recall a scene, cue or snippet |
| `POST` | `/api/consoles/{id}/show/scene/save` | Write the current state into a console slot |
| `GET` | `/api/consoles/{id}/show/export.scn` | Export the mixing state as a `.scn` file |
| `POST` | `/api/consoles/{id}/show/import` | Read a `.scn` file, and optionally load it |
| `GET/POST` | `/api/venues`, `/api/bands` | Rooms and acts, with notes and input lists |
| `POST` | `/api/bands/{id}/apply-input-list` | Write names, colours and gains onto a console |
| `GET/POST` | `/api/presets` | List and save venue presets |
| `POST` | `/api/presets/{id}/preview` | What applying it would change — sends nothing |
| `POST` | `/api/presets/{id}/apply` | Apply it, ramping levels |
| `GET/POST` | `/api/presets/{id}/versions` | History, and saving a new version |
| `POST` | `/api/presets/{id}/rollback` | Make an earlier version current again |

`kind` is `ch`, `auxin`, `fxrtn`, `bus`, `mtx`, `main` or `dca`. Indices may be padded or not
(`ch/1` == `ch/01`), and the mains answer to `main/st` (or `main/lr`) and `main/m`.

```bash
# Set channel 1 to -6 dB, name it, and send it to bus 5
curl -X PATCH localhost:3000/api/consoles/default/strips/ch/1   -H 'content-type: application/json'   -d '{"mix":{"faderDb":-6},"config":{"name":"Kick In","color":"GN"},
       "sends":[{"to":5,"on":true,"levelDb":-12}]}'
```

Three things this layer refuses to do quietly:

- **It does not clamp.** `faderDb: 20` is a 400, not a silent +10. An operator finds out that
  the console cannot do it before the show rather than during it.
- **It does not accept unknown fields.** A typo like `faderDB` is a 400, not a no-op.
- **It does not offer sections a strip lacks.** A DCA has no EQ, a bus has no gate; asking for
  one is a 400 with a reason, rather than a write the console ignores.

Reads are served from the state mirror, so they cost nothing on the wire and reflect moves
made on the physical surface. Writes go out immediately and are applied to the mirror
optimistically; the console's own echo confirms them milliseconds later.

---

## Metering and the WebSocket stream

Socket.IO namespace **`/realtime`**. Two streams, both opt-in per client:

```js
const socket = io('http://localhost:3000/realtime');

socket.on('hello', ({ consoles, streams, meterFps }) => { /* what is available */ });

await socket.emitWithAck('subscribe', { consoleId: 'default', streams: ['meters', 'state'] });

socket.on('meters', ({ channels, mains, at }) => { /* dBFS, 20 fps */ });
socket.on('state',  ({ changes }) => { /* [{ address, value }], batched */ });
socket.on('console', ({ state }) => { /* connected / reconnecting / ... */ });
```

- **Meters are coalesced, never queued.** The console can push far faster than any UI can
  draw; the newest values are kept and published on a fixed tick, so a slow client sees
  current meters instead of a growing backlog of stale ones. `METER_FPS` sets the tick.
- **Parameter changes are batched on the same tick and keyed by address.** Recalling a scene
  changes hundreds of values at once, and riding a fader produces one update per tick rather
  than sixty — a client gets one message either way.
- **The console is only asked for meters while someone is listening.** Subscriptions are
  reference-counted across clients, and dropped when the last listener leaves.
- **`/unsubscribe` is never sent.** On the X32 it drops *every* subscription for the socket,
  including the `/xremote` feed the entire state mirror depends on. Meter subscriptions are
  stopped by simply not renewing them, and the console forgets us within ten seconds.

### What the meter slots mean, and what is still unknown

Each bank arrives as a flat array of numbers with no labels. The bank addresses and their
sample counts are well established; exactly which slot carries which strip is documented only
unofficially and is **not verified against hardware here**. So this project maps only the
leading segment of each bank — `/meters/1` slots 0–31 are input channels 1–32, `/meters/13`
slots 0–2 are main L, R and mono — and leaves the rest alone rather than inventing a mapping.

`GET /api/consoles/{id}/meters/raw?bank=/meters/1` returns every slot in dBFS so the rest can
be pinned down on a real desk in a couple of minutes: send signal into one input, see which
index moves, then extend `CHANNEL_SEGMENT` in
[`src/metering/meter-banks.ts`](src/metering/meter-banks.ts).

---

## Venue presets

A scene on the console belongs to the console: one show file, overwritten by whoever touched
it last, gone when the desk is swapped. A **venue preset** belongs to the engineer. It is
versioned, it records who saved it, it can be rolled back, and it can be applied to whichever
console is in the room tonight.

```bash
# Save the room's base mix, scoped to what matters for this preset
curl -X POST localhost:3000/api/presets -H 'content-type: application/json' -d '{
  "name": "Rock Night - FOH", "venueId": "...", "consoleId": "default",
  "capture": { "sections": ["mix", "config", "eq"] } }'

# See what it would do before it does it
curl -X POST localhost:3000/api/presets/<id>/preview -d '{"consoleId":"default"}'

# Apply it
curl -X POST localhost:3000/api/presets/<id>/apply -d '{"consoleId":"default"}'
```

**Applying is a diff, not a rewrite.** The state mirror already knows what the console holds,
so only values that actually differ are sent — applying a preset the console already matches
sends nothing at all. `preview` runs the same diff and sends nothing ever, which makes
"what is this about to do to my mix" a safe question to ask during a show.

**Levels are walked, not jumped.** A fader that snaps clicks, and a recall that moves twenty
of them at once clicks twenty times. Level changes are ramped over a few hundred milliseconds
while mutes, EQ and routing go out immediately, so the recall feels instant without being
audible. The ramp is *budgeted* against the console's ~50 msg/s: steps per fader are derived
from how many faders are moving, because twenty faders at twenty steps each is 400 datagrams
— eight seconds of wire time that would starve operator commands. `immediate: true` skips
ramping for when speed matters more than smoothness.

**Interpolation is in fader position, not dB.** Half way through a −90 → 0 dB move the fader
sits half way up its travel, which is what a hand on the fader does; half way in dB would be
−45 dB, which is still silence.

A band's **input list** is the other half: channel names, colours, head amp gains and phantom
power, written onto the desk in one request. That is the fifteen minutes before doors when the
console still says "Ch01".

### Where presets are stored

With `DATABASE_URL` set, presets live in PostgreSQL through Prisma:

```bash
npm run db:migrate      # apply migrations (docker compose does this on start)
npm run db:generate     # regenerate the client after a schema change
```

Without it, they live in memory. Everything works, nothing survives a restart, and the log
says so at boot. That is deliberate: a fresh clone has to run with `npm install &&
npm run start:dev` and no infrastructure, and the test suite has to run in CI without a
database. Both use the same interface, so the storage choice is not a code path that only
production ever exercises.

---

## Environment variables

| Variable | Default | Meaning |
| --- | --- | --- |
| `NODE_ENV` | `development` | `development` \| `test` \| `production` |
| `PORT` | `3000` | HTTP port |
| `X32_HOST` | *(empty)* | Console IP. Empty = rely on discovery |
| `X32_PORT` | `10023` | Console OSC port (X32 firmware uses 10023) |
| `OSC_LOCAL_PORT` | `0` | Local UDP port to bind; 0 = OS-assigned |
| `OSC_BROADCAST_ADDRESS` | `255.255.255.255` | Target of the discovery sweep |
| `OSC_MAX_MSG_PER_SEC` | `50` | Sustained send ceiling — raising it invites packet loss |
| `OSC_MIN_GAP_MS` | `2` | Minimum gap between two datagrams |
| `OSC_MAX_QUEUE_LENGTH` | `5000` | Send-queue depth before backpressure; 0 = unbounded |
| `OSC_REQUEST_TIMEOUT_MS` | `1000` | Reply timeout for a query |
| `XREMOTE_INTERVAL_MS` | `8000` | `/xremote` renewal period (console expiry is 10 000) |
| `DRY_RUN` | `false` | Log state-changing OSC instead of sending it; queries still work |
| `CONSOLE_AUTO_CONNECT` | `true` | Connect to `X32_HOST` at boot when one is set |
| `CONSOLE_PROBE_INTERVAL_MS` | `2000` | Liveness probe period |
| `CONSOLE_PROBE_TIMEOUT_MS` | `1000` | Probe reply timeout |
| `CONSOLE_MAX_MISSED_PROBES` | `2` | Unanswered probes before the link counts as lost |
| `CONSOLE_RECONNECT_MIN_MS` | `500` | First reconnect delay |
| `CONSOLE_RECONNECT_MAX_MS` | `5000` | Reconnect backoff ceiling — keep it low |
| `CONSOLE_SYNC_DEPTH` | `full` | `surface` \| `sends` \| `full` |
| `DISCOVERY_TIMEOUT_MS` | `1500` | How long a discovery sweep listens |
| `METER_FPS` | `20` | Frames per second pushed to WebSocket clients |
| `METER_RENEW_MS` | `5000` | Meter subscription renewal (console expiry is 10 000) |
| `METER_TIME_FACTOR` | `1` | Console-side meter rate divider; 1 ≈ every 50 ms |
| `RAMP_DEFAULT_MS` | `400` | Ramp time for level changes |
| `RAMP_MIN_MS` / `RAMP_MAX_MS` | `300` / `800` | Window a requested ramp is clamped into |
| `DATABASE_URL` | *(empty)* | PostgreSQL for venue presets. Empty = in-memory, lost on restart |

`DATABASE_URL` and `JWT_SECRET` arrive with Phases 5 and 7.

Configuration is validated at boot by `class-validator`
([`src/config/env.validation.ts`](src/config/env.validation.ts)) — a bad value fails fast with a
readable message instead of misbehaving on stage.

---

## Roadmap

| Phase | Scope | Status |
| --- | --- | --- |
| 1 | OscModule + emulator + tests | **done** |
| 2 | ConsoleModule, discovery, reconnect, StateCache | **done** |
| 3 | MixerModule, REST, Swagger, `npm run openapi:export` | **done** |
| 4 | Metering + WebSocket at 20 fps | **done** |
| 5 | Scenes/snapshots/cues, `.scn` import/export, VenuePreset + fader ramping | **done** |
| 6 | RoomEq (REW/CSV import, auto PEQ) | next |
| 7 | Auth (JWT, admin/engineer/observer) + Safety (panic, read-only, audit log) | pending |

Acceptance criteria 3 (set −6 dB, read back −6 dB ±0.1) and 5 (500-command burst, nothing
dropped) are covered by
[`test/integration/osc-console-link.spec.ts`](test/integration/osc-console-link.spec.ts);
criterion 4 (reconnect within 10 s of a replug) by
[`test/integration/console-connection.spec.ts`](test/integration/console-connection.spec.ts),
which stops the emulator mid-test and restarts it on the same port. Criteria 1 and 2 complete
when Swagger lands in Phase 3.

## Deviations from the original spec

- **NestJS 12 + Vitest**, not NestJS 11 + Jest: the repository was already scaffolded that way,
  decorator metadata verifiably works under Vitest, and downgrading a fresh scaffold buys
  nothing. Say the word and it can be moved to Nest 11 + Jest.
- Meter bank sizes (`/meters/0` 70, `/meters/1` 96, `/meters/2` 49, `/meters/13` 24) follow the
  unofficial protocol notes and should be confirmed against the appendix or real hardware
  before Phase 4 maps blob indices to strips.
- `/node` container field orders (particularly `dyn`, which the notes are inconsistent about)
  are unverified against hardware. The parser refuses rather than guesses on a mismatch, so the
  cost of being wrong is a slower sync, not bad data -- but the orders are worth confirming.
- `DRY_RUN` suppresses state-changing messages and lets queries through, so a read-only UI
  still works against a live console. Say so if it should mean total silence instead.
