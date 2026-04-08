---
title: Setup and deployment
sidebar_label: Setup and deployment
crumb: Cloudflare
---

This example runs as a backend-only Remotion rendering service on Cloudflare Workers with Containers, Durable Objects, and R2.

## Requirements

- Node.js 22+
- `pnpm`
- Docker
- Cloudflare account with Workers paid plan and Containers access
- `wrangler` authenticated with `wrangler login`

If this is your first time setting up Wrangler, run:

```bash
pnpm wrangler login
pnpm wrangler whoami
```

If `wrangler whoami` does not show the expected account, fix that first.

## Setup

Before you start:

- make sure Docker is running
- make sure `wrangler whoami` shows the Cloudflare account you want to use
- local `wrangler dev` uses local R2 storage by default

### 1. Install dependencies

```bash
pnpm install
```

### 2. Start the worker

```bash
pnpm wrangler:dev
```

This starts the Worker locally and lets Cloudflare Containers run the renderer image.

In local development, R2 operations go to local storage by default, so you do not need to create a real R2 bucket first.

### 3. Submit and poll a render

```bash
pnpm test:pipeline
```

The script:

- submits a job with `POST /jobs`
- polls `GET /jobs/:id`
- exits non-zero if the render fails or times out

Example status response while work is in progress:

```json
{
  "renderJobId": "job:hello-world:1712345678901",
  "compositionId": "HelloWorld",
  "status": "rendering",
  "stage": "rendering",
  "progress": 46,
  "chunkCount": 4,
  "completedChunks": 1,
  "totalFrames": 480,
  "renderedFrames": 168,
  "workerPoolSize": 2,
  "activeWorkers": 2,
  "message": "Rendering chunks...",
  "metrics": {
    "queueWaitMs": 2400,
    "totalElapsedMs": 18750
  }
}
```

Example status response after completion:

```json
{
  "renderJobId": "job:hello-world:1712345678901",
  "compositionId": "HelloWorld",
  "status": "completed",
  "stage": "completed",
  "progress": 100,
  "chunkCount": 4,
  "completedChunks": 4,
  "totalFrames": 480,
  "renderedFrames": 480,
  "workerPoolSize": 2,
  "activeWorkers": 0,
  "outputKey": "renders/job:hello-world:1712345678901/output.mp4",
  "message": "Render complete"
}
```

### 4. Download the output

```bash
curl -L http://127.0.0.1:8787/jobs/job:hello-world:123/output -o output.mp4
```

Use the actual job ID returned by the create request or printed by `pnpm test:pipeline`.

## Deployment

### 1. Review `wrangler.jsonc`

For deployment, you do need a real R2 bucket.

Confirm the following bindings and settings match your account and environment:

- `r2_buckets`
- `containers`
- `durable_objects`
- `migrations`

This example keeps Cloudflare configuration in `wrangler.jsonc` instead of environment secrets.

If you want to use a different bucket name, update both `bucket_name` and `preview_bucket_name` in `wrangler.jsonc` before creating the bucket.

### 2. Create the R2 bucket

```bash
pnpm wrangler r2 bucket create cloudflare-remotion-example
```

### 3. Deploy

```bash
pnpm run deploy
```

### 4. Verify the deployment

Run the pipeline script against the deployed Worker URL:

```bash
pnpm test:pipeline --base-url https://<your-worker-url>
```

Then inspect job status directly:

```bash
curl https://<your-worker-url>/jobs/<render-job-id>
```

## Verification

Run these commands before considering the example ready:

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm test:pipeline
```

## Configuration

The example works with defaults, but these environment variables are supported:

- `RENDER_TARGET_CHUNK_COUNT_DEFAULT`
- `RENDER_TARGET_CHUNK_COUNT_MAX`
- `RENDER_MIN_FRAMES_PER_CHUNK`
- `RENDER_WORKER_POOL_SIZE_MAX`
- `RENDER_MEDIA_CONCURRENCY`
- `PLANNING_TIMEOUT_MS`
- `STUCK_CHUNK_TIMEOUT_MS`

## Limitations

- This example is backend-only and does not include a frontend UI.
- Authentication, authorization, billing, and multi-tenant isolation are out of scope.
- Local development depends on Docker and `host.docker.internal` support.
- Deployment requires Cloudflare Workers with Containers support and a real R2 bucket.
- The example is intended as a reference implementation, not a complete production SaaS backend.

## Notes

- `.dev.vars.example` is intentionally minimal because local development does not require secrets.
- Local `wrangler dev` uses worker passthrough endpoints for coordinator and R2 access.
- Containers reach the local worker through `host.docker.internal`, so Docker networking must support that hostname.
- Local development depends on Docker because the renderer runs inside a container image.

## Troubleshooting

- Container startup fails:
  Check Docker is running and that your Cloudflare account has Containers enabled.
- Output never appears:
  Check the R2 bucket name in `wrangler.jsonc` and inspect `GET /jobs/:id` for job errors.
- Local pipeline cannot reach coordinator or R2:
  Confirm Docker resolves `host.docker.internal`.
- Remote deployment renders but polling fails:
  Confirm the deployed Worker URL is the one passed to `pnpm test:pipeline --base-url`.
