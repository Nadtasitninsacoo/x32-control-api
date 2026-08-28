# x32-control-api

REST + WebSocket control API for **Behringer X32 / Midas M32** consoles, speaking OSC over UDP.

Self-contained: its own `package.json`, `.env`, Dockerfile and git repository. It has no
workspace, no shared folder and no dependency on any file outside this directory. A frontend
talks to it over HTTP/WS only, and learns its types from the exported `openapi.json`.

> **Status — Phases 1–2 of 7 complete.** The OSC core (codec, transport, pacing, request
> correlation, `/xremote` heartbeat) and console management (discovery, supervised
> connections with automatic reconnect, the in-memory state mirror) are done and green,
> with the X32 emulator behind their tests. Phases 3–7 (mixer REST, metering, scenes,
> venue presets, room EQ, auth/safety) are not built yet. See [Roadmap](#roadmap).

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
npm test          # unit + emulator integration — needs no console, no database
npm run typecheck
npm run lint
```

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
| 3 | MixerModule, REST, Swagger, `npm run openapi:export` | next |
| 4 | Metering + WebSocket at 20 fps | pending |
| 5 | Scenes/snapshots/cues, `.scn` import/export, VenuePreset + fader ramping | pending |
| 6 | RoomEq (REW/CSV import, auto PEQ) | pending |
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
