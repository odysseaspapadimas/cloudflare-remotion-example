---
title: Cloudflare Remotion Example
sidebar_label: Overview
crumb: Cloudflare
---

This repository is a backend-only reference implementation for running distributed Remotion renders on Cloudflare.

It uses:

- Cloudflare Containers for render execution
- Durable Objects for coordination and persisted job state
- R2 for chunk artifacts and final outputs

Use this example if you want a backend-only render pipeline with job submission, progress polling, chunk coordination, and final output retrieval.

## Pages

- [`setup-and-deployment.md`](./setup-and-deployment.md)
- [`render-flow.md`](./render-flow.md)
- [`cloudflare-vs-portable.md`](./cloudflare-vs-portable.md)

For the quickest path, start with the root [`README.md`](../README.md), run `pnpm wrangler:dev`, then run `pnpm test:pipeline`.
