# Gateway foundation: operating contract

Decision, 2026-11-23. Owner: Loop gateway maintainers. Keep one deployable gateway and one authoritative writer per workspace. Keep catalog facts, connection readiness, access decisions, and write outcomes separate. Do not adopt a second policy engine, workflow cluster, or global search service to implement these contracts.

- **Catalog** answers what exists and where to find it. An exact visible name wins over incidental description matches. Apply workspace/profile visibility before ranking. Search results are not grants.
- **Readiness** is a projection of the connection record, not a network health probe. No upstream fan-out on Home or on catalog reads. Hand off the connection ID and next step, never secrets. A successful provider call is stronger evidence than a cached tool list.
- **Authorization** belongs at execution. A visible tool, a provider's read-only annotation, a stored credential, a remembered preference, and an earlier successful call are not permission. Check the current agent, workspace, profile, tool restrictions and applicable approval before dispatch or returning a receipt. Memory corrections must not change permissions.
- **Retry identity** is caller-owned: generate an operation ID before dispatch and persist it with the user's intended write. Reuse it on approval, reconnect and transport retries. A lost response is not proof of failure. With the same caller/profile/ID, Loop reserves a receipt before calling out. A duplicate gets status, not the original private result. If uncertain, inspect provider state; never mint a fresh ID just to retry. Calls without an ID retain legacy behavior. Do not promise exactly-once effects across agents, regions or the 7-day retention boundary.

## Current capacity boundary

The hosted process routes credentials to workspace data directories, caches active workspaces and evicts idle ones. The SQLite write fence protects its own receipts; it does not make the rest of the gateway multi-writer. Do not put a load balancer in front of two processes sharing the same workspace files. Backups/restores must keep config, Vault and operation receipts together. After a restore, reconcile writes since the snapshot before enabling retries.

The receipt store holds 4,096 IDs per workspace for seven days, about 585 new IDs/day sustained. Once full, a new keyed operation fails before dispatch; existing receipts remain available. Size this against measured write traffic before a high-volume rollout. Do not solve saturation by deleting uncertain receipts.

## Repeatable check and next release gates

`node scripts/bench-gateway-foundation.mjs 1000 16 8` measures authenticated `tools/list` over real HTTP with 1,000 requests, concurrency 16 and 8 disposable workspace identities. It checks each response, prints throughput and latency percentiles, and removes its store. CI runs a smaller correctness smoke without a hardware-dependent latency threshold. This is a warm read benchmark, not a production SLO.

Before adding replicas: replay a staging workload mixing cold workspace loads, search over representative catalogs, approvals, draft writes, revocation and provider timeouts. Record throughput, RSS, event-loop delay, receipt saturation, uncertain outcomes and p95 by route without logging arguments or secrets. Include one noisy tenant and a backup/restore drill. If one host cannot meet the agreed latency/error budget, partition by workspace with explicit ownership and fencing, or migrate mutable state and queues to a transactional shared store first. Verify failover never runs two owners or retries an uncertain write. Keep the same gateway contracts and regression fixtures regardless of backend.
