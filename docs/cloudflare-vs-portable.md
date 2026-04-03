---
title: Cloudflare-specific vs portable parts
sidebar_label: Cloudflare-specific vs portable parts
crumb: Cloudflare
---

This example is intentionally Cloudflare-native, but not every part of it is tied to Cloudflare.

## Cloudflare-specific pieces

These parts depend directly on Cloudflare platform primitives:

- Worker entrypoint and HTTP API wiring in `src/container.ts`
- Durable Object coordination and alarms in `src/RenderCoordinator.ts`
- Container lifecycle management through `@cloudflare/containers`
- R2 bindings and outbound handlers for object access
- `wrangler.jsonc` configuration for bindings, containers, and migrations

If you move this design to another platform, these are the main seams that need replacing.

## Portable pieces

These parts encode rendering behavior more than Cloudflare behavior:

- chunk sizing and frame range logic in `src/chunking.ts`
- aggregate progress calculation in `src/render-job-state.ts`
- request and runtime types in `src/types.ts`
- the Remotion runtime inside `src/server.ts`
- the end-to-end test script in `scripts/test-pipeline.ts`

The container runtime is the most portable major unit because it already speaks plain HTTP internally.

## Porting strategy

To move this example off Cloudflare, keep the following concepts and swap the infrastructure layer:

- replace the Durable Object with another job coordinator and state store
- replace Cloudflare Containers with another container runner or queue worker model
- replace R2 with another object store such as S3-compatible storage
- keep the chunk planning, rendering, progress model, and final combine flow mostly intact

## Practical boundaries

The easiest way to think about the codebase is:

- `src/RenderCoordinator.ts` and the Worker-side transport are platform-specific
- `src/server.ts` and the render pipeline shape are architecture-specific but largely portable
- `src/chunking.ts`, `src/render-job-state.ts`, and `scripts/test-pipeline.ts` are almost entirely portable

## Non-goals

Even with the portability split above, this repository is still an example, not a full SaaS backend.

It does not implement:

- authentication
- authorization
- billing
- tenant isolation
- queue fairness across customers
- quota management
