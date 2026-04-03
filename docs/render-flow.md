---
title: Render flow
sidebar_label: Render flow
crumb: Cloudflare
---

This example splits the render lifecycle across three Cloudflare primitives:

- Cloudflare Containers run Remotion planning, chunk rendering, and final combine work
- a Durable Object coordinates job state, retries, and progress aggregation
- R2 stores chunk artifacts and final outputs

## Architecture

### Worker API

The Worker in `src/container.ts` exposes the backend API:

- `POST /jobs`
- `GET /jobs/:id`
- `GET /jobs/:id/output`

It also handles local passthrough routes used by containers during `wrangler dev`.

### RenderCoordinator Durable Object

`src/RenderCoordinator.ts` is the control plane for each render job.

It is responsible for:

- initializing persisted job state
- starting the leader container
- planning chunk assignments
- leasing work across a bounded worker pool
- receiving chunk progress updates
- retrying failed or stuck work
- triggering final combine
- cleaning up chunk artifacts and containers

### Remotion Container Runtime

`src/server.ts` runs inside the container image and performs the actual rendering work:

- select composition metadata
- render a chunk's frame range
- upload chunk artifacts to R2
- download all chunk artifacts for final combine
- combine chunk outputs into the final MP4
- upload the final output to R2

## Flow

### 1. Job creation

`POST /jobs` validates input, normalizes defaults, and forwards the request to a `RenderCoordinator` Durable Object keyed by `idempotencyKey`.

### 2. Planning

The coordinator starts a leader container and calls `/internal/plan-render` inside it.

The leader:

- loads the Remotion bundle
- resolves composition metadata with `selectComposition()`
- calculates effective chunk count
- creates contiguous frame ranges

The coordinator stores the resulting chunk plan and moves the job to `rendering`.

### 3. Chunk rendering

The coordinator assigns queued chunks to a bounded worker pool. Each worker container calls `/internal/render-chunk`.

For each chunk, the runtime:

- renders only the assigned frame range with `renderMedia()`
- emits progress updates back to the coordinator
- uploads video and audio chunk artifacts to R2

The coordinator aggregates chunk-level progress into stable job-level progress exposed by `GET /jobs/:id`.

### 4. Retry and stuck-work recovery

The Durable Object uses alarms to detect planning or chunk work that appears stuck.

If a chunk stalls:

- the worker lease is released
- the backing container can be destroyed
- the chunk is retried up to the configured retry limit

If retries are exhausted, the whole job fails and surfaces the error through the status API.

### 5. Final combine

Once all chunks complete, the coordinator reuses the leader container and calls `/internal/combine-chunks`.

The leader:

- downloads chunk artifacts from R2 into temporary storage
- combines them into one MP4
- uploads the final MP4 to the configured `outputKey`

### 6. Output serving and cleanup

`GET /jobs/:id/output` resolves the final `outputKey` through the coordinator and streams the file from R2.

After success, the coordinator:

- deletes intermediate chunk artifacts from R2
- destroys leader and worker containers

## Why this is more than a Containers demo

This example adds the backend concerns needed for a reference architecture:

- persisted job coordination
- distributed chunk scheduling
- progress polling
- retries and stuck-job handling
- intermediate artifact management
- final output serving through a stable API
