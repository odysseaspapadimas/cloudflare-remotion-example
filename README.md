# Cloudflare Remotion Example

Backend-only distributed Remotion rendering on Cloudflare.

This example shows the smallest Cloudflare-native architecture that still supports distributed rendering:

- Cloudflare Containers run Remotion work
- a Durable Object coordinates chunk planning, progress, and retries
- R2 stores chunk artifacts and the final MP4
- local `wrangler dev` works through a small worker passthrough fallback

## Happy Path

### 1. Install dependencies

```bash
pnpm install
```

### 2. Create an R2 bucket

Use the bucket name from `wrangler.jsonc`, or update that file first.

```bash
pnpm wrangler r2 bucket create cloudflare-remotion-example
```

### 3. Start the worker and containers stack

```bash
pnpm wrangler:dev
```

### 4. Run one render job

```bash
pnpm test:pipeline
```

### 5. Download the output

```bash
curl -L http://127.0.0.1:8787/jobs/job:hello-world:123/output -o output.mp4
```

## API

### `POST /jobs`

Create a render job.

`compositionId` is optional because the example only ships one composition.

```bash
curl -X POST http://127.0.0.1:8787/jobs \
	-H 'Content-Type: application/json' \
	-d '{
	  "inputProps": {
	    "title": "Hello from Cloudflare",
	    "subtitle": "Distributed Remotion render",
	    "backgroundColor": "#0f172a",
	    "durationInFrames": 480
	  },
	  "outputKey": "renders/example-job/output.mp4",
	  "idempotencyKey": "job:hello-world",
	  "targetChunkCount": 4
	}'
```

Response:

```json
{
	"renderJobId": "job:hello-world",
	"status": "queued"
}
```

### `GET /jobs/:id`

Get aggregate status, progress, metrics, and output metadata.

```bash
curl http://127.0.0.1:8787/jobs/job:hello-world
```

### `GET /jobs/:id/output`

Stream the final MP4 after the render completes.

```bash
curl -L http://127.0.0.1:8787/jobs/job:hello-world/output -o output.mp4
```

If the job is still running, the endpoint returns `409`.

## How It Works

1. `POST /jobs` creates a render job.
2. The worker forwards the request to a `RenderCoordinator` Durable Object.
3. The coordinator starts a leader container.
4. The leader resolves composition metadata and plans chunk ranges.
5. The coordinator assigns queued chunks across a bounded worker pool.
6. Worker containers render frame ranges with `renderMedia()`.
7. Chunk video and audio artifacts are uploaded to R2.
8. The coordinator aggregates stable job progress.
9. The leader downloads all chunk artifacts and combines them into a final MP4.
10. The final MP4 is uploaded to R2 and exposed through `GET /jobs/:id/output`.

## Defaults

The example intentionally keeps defaults simple:

- default composition: `HelloWorld`
- default chunk count: `4`
- default worker cap: `2`
- worker pool sizing: `min(chunkCount, RENDER_WORKER_POOL_SIZE_MAX)`

For the demo composition, a worker cap of `2` is usually faster than starting one container per chunk.

## Local vs Deployed Transport

- deployed environments use Cloudflare outbound host routing for `coordinator.internal` and `r2.internal`
- local `wrangler dev` uses worker passthrough endpoints under `/internal/coordinator/...` and `/internal/r2/...`
- containers reach the local worker through `host.docker.internal:<wrangler-port>`

## Optional Tuning

The example works without tuning. If you need it, these env vars are the only ones worth caring about:

- `RENDER_TARGET_CHUNK_COUNT_DEFAULT`
- `RENDER_TARGET_CHUNK_COUNT_MAX`
- `RENDER_MIN_FRAMES_PER_CHUNK`
- `RENDER_WORKER_POOL_SIZE_MAX`
- `RENDER_MEDIA_CONCURRENCY`
- `PLANNING_TIMEOUT_MS`
- `STUCK_CHUNK_TIMEOUT_MS`

What they do:

- chunk count defaults to `RENDER_TARGET_CHUNK_COUNT_DEFAULT`, then clamps by `RENDER_TARGET_CHUNK_COUNT_MAX` and `RENDER_MIN_FRAMES_PER_CHUNK`
- worker pool size is `min(chunkCount, RENDER_WORKER_POOL_SIZE_MAX)`
- `RENDER_MEDIA_CONCURRENCY` controls Remotion concurrency inside each container
- the timeout values control stuck planning and stuck chunk recovery

## Verification

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm test:pipeline
```

## Limits

- requires Cloudflare Workers with Containers support and an R2 bucket
- depends on multiple Cloudflare primitives, not only Containers
- no frontend UI
- no auth, billing, or multi-tenant concerns
- local development depends on Docker resolving `host.docker.internal`

## Core Files

If you only skim three files, read these:

- `src/container.ts`
- `src/RenderCoordinator.ts`
- `src/server.ts`
