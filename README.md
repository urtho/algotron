# Algotron

Real-time Algorand network monitoring dashboard with an Encom boardroom aesthetic.

Discovers every relay and archiver node via DNS SRV records, geolocates them, and tracks their block heights live.

[![Watch the video](docs/screenshot.png)](https://youtu.be/VQqEQATW-7w)

Version 2 adds realtime chain statistics:

![Algotron 2 dashboard](docs/dashboard-v2.png)

## Features

- **Live block tracking**: every node is polled about twice a second, once for all clients
- **Realtime chain stats from the nodes themselves**: TPS, block time, transactions per block by type,
  block size, certificate votes, proposer payouts and top proposers, all decoded from the blocks the
  relays serve. No indexer, no algod API token
- **Block propagation**: how long relays take to show a block after the first one does
- **3D globe**: nodes plotted by location; each new block draws a ring at the first node and arcs to the next ones
- **Status**: synced / lagging / behind / no answer (with the reason), IPv6 reachability per host
- **Boot terminal**: Encom-style discovery sequence on first load
- **Permissionless**: DNS SRV records and the public block endpoint are all it needs

## Live instance

https://algotron.algo.green

## Stack

| Layer    | Tech                                                      |
| -------- | --------------------------------------------------------- |
| Runtime  | Bun 1.4 (one process: UI, `/ws`, `/health`, `/api/state`) |
| Backend  | `Bun.serve` with native WebSocket pub/sub, no framework   |
| Frontend | React 19, Three.js, canvas charts, bundled by Bun         |
| Tooling  | `tsgo` typecheck, Biome lint + format, `bun test`         |
| Geo      | ip-api.com batch (no key required)                        |
| DNS      | SRV, A and AAAA via `node:dns/promises`                   |

## Getting started

**Prerequisite:** Bun 1.4+

```bash
bun install
bun dev          # http://localhost:3001, hot reload for backend and frontend
```

```bash
bun run typecheck && bun run lint && bun test
bun run build    # dist/server.js + assets; run with: cd dist && bun server.js
docker compose up -d --build
```

## Configuration

Environment variables, all optional:

| Variable          | Default                                    | Meaning                                   |
| ----------------- | ------------------------------------------ | ----------------------------------------- |
| `RELAY_SRV`       | `_algobootstrap._tcp.mainnet.algorand.net` | Relay SRV record (`NONE` to skip)         |
| `ARCHIVER_SRV`    | `_archive._tcp.mainnet.algorand.net`       | Archiver SRV record (`NONE` to skip)      |
| `NETWORK_ID`      | `mainnet-v1.0`                             | Genesis ID used in the block URL          |
| `NETWORK_LABEL`   | `ALGORAND MAINNET`                         | Shown in the top bar                      |
| `EXPLORER`        | `https://allo.info`                        | Base URL for block and account links      |
| `HOST` / `PORT`   | `0.0.0.0` / `3001`                         | Listener                                  |
| `POLL_MS`         | `500`                                      | Pause between two polls of one node       |
| `BACKFILL_BLOCKS` | `240`                                      | Blocks loaded at start to fill the charts |

The label and explorer are sent to the browser at runtime, so one image serves any network.

## How the numbers are made

Everything comes from `http://{ip}:{port}/v1/{genesis-id}/block/{round in base 36}`:

- **Node height**: `HEAD` for the round after the node's last one. `200` means it has it; `404` carries
  the header `X-Latest-Round` with the node's newest round, so one request is enough and there is no search.
- **Block stats**: one `GET` per new block, decoded from msgpack. Header fields used: `rnd`, `ts` (time),
  `tc` (chain-wide transaction counter), `prp` (proposer), `fc` (fees collected), `pp` (proposer payout);
  plus the payset (transaction types) and the certificate (vote count).
- **TPS**: growth of `tc` over the last 10 blocks divided by the `ts` time they span. `tc` counts inner
  transactions too, so "inner" in the chart is `tc` growth minus the top-level payset.
- **Propagation**: for each round, the delay between the first node showing the block and every other
  node showing it. The resolution is the poll interval (±`POLL_MS`) plus the round trip to the node.

A node is marked **no answer** after three failed requests in a row. That is a statement about the path
from the machine running Algotron: a relay behind a firewall that drops this host looks the same as a
relay that is down. The card shows the reason (`timeout`, `refused`, `http 503`).

## Project structure

```
shared/types.ts          wire types used by both sides
backend/src/
  server.ts              Bun.serve: static UI, /ws, /health, /api/state
  discovery.ts           SRV -> addresses -> geolocation -> node list (repeated every 15 min)
  monitor.ts             poll loops, tip, propagation, block ring
  probe.ts               HEAD / GET against the block endpoint
  blocks.ts, msgpack.ts, address.ts   block decoding
frontend/src/
  state.ts               WebSocket feed + reducer
  stats.ts               TPS, block time, proposers, fleet summary
  components/            Globe, NodeStack, Chart, Kpis, BlockTape, Proposers ...
```

## Message protocol

| Type             | When                                                                          |
| ---------------- | ----------------------------------------------------------------------------- |
| `hello`          | On connect: config, boot log, all nodes, recent blocks, tip                   |
| `boot` / `ready` | Discovery log lines while the backend starts                                  |
| `nodes`          | Batched node changes (add / patch / remove) and the tip, at most every 250 ms |
| `block`          | A new block's figures                                                         |
| `block_patch`    | Propagation summary for a round, two rounds later                             |
| `log`            | Monitoring events                                                             |

## Node status

| Status    | Colour | Condition                                  |
| --------- | ------ | ------------------------------------------ |
| `synced`  | green  | lag ≤ 1 round                              |
| `lagging` | yellow | lag 2–3 rounds                             |
| `behind`  | orange | lag > 3 rounds                             |
| `offline` | red    | 3 requests in a row without an HTTP answer |
| `unknown` | grey   | not probed yet                             |

## DNS bootstrap

- Relay SRV: `_algobootstrap._tcp.mainnet.algorand.net`
- Archiver SRV: `_archive._tcp.mainnet.algorand.net`
- Block URL: `http://{ip}:{port}/v1/{network-id}/block/{block_base36}`
