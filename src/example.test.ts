import assert from "node:assert/strict";
import test from "node:test";
import {
	DEFAULT_MIN_FRAMES_PER_CHUNK,
	frameRangesFromTotalFrames,
	resolveChunkCount,
	resolveWorkerPoolSize,
	validateChunkCoverage,
} from "./chunking.ts";
import { createInitialRenderJobRecord, recomputeJobAggregate } from "./render-job-state.ts";
import {
	deriveLocalWorkerOrigin,
	isLocalR2ObjectPath,
	isLocalWorkerTransportEnabled,
	matchLocalCoordinatorProgressPath,
	stripLocalR2Prefix,
	toCoordinatorProgressTransportUrl,
	toLocalCoordinatorProgressPath,
	toLocalR2ObjectPath,
	toR2TransportUrl,
} from "./transport.ts";
import type { CreateRenderJobRequest } from "./types.ts";

const resolveOutputAccess = (job: { status: string; outputKey?: string } | null) => {
	if (!job) {
		return {
			ok: false as const,
			status: 404,
			error: "Render job not found",
		};
	}

	if (job.status !== "completed") {
		return {
			ok: false as const,
			status: 409,
			error: "Render output is not ready yet",
			renderStatus: job.status,
		};
	}

	if (!job.outputKey) {
		return {
			ok: false as const,
			status: 500,
			error: "Completed render is missing output key",
			renderStatus: job.status,
		};
	}

	return {
		ok: true as const,
		outputKey: job.outputKey,
	};
};

const request: CreateRenderJobRequest = {
	compositionId: "HelloWorld",
	inputProps: {
		title: "Hello from Cloudflare",
		subtitle: "Distributed Remotion render",
		backgroundColor: "#0f172a",
		durationInFrames: 480,
	},
	outputKey: "renders/example-job/output.mp4",
	targetChunkCount: 4,
	idempotencyKey: "job:hello-world",
};

test("idempotent job creation seeds queued state", () => {
	const first = createInitialRenderJobRecord("job:hello-world", request, "now");
	const second = createInitialRenderJobRecord("job:hello-world", request, "now");

	assert.deepEqual(first, second);
	assert.equal(first.status, "queued");
	assert.equal(first.progress, 12);
	assert.deepEqual(first.workerPool, []);
});

test("aggregate progress sums rendered frames", () => {
	const job = createInitialRenderJobRecord("job:hello-world", request, "now");
	job.status = "rendering";
	job.stage = "rendering";
	job.composition = {
		id: "HelloWorld",
		width: 1280,
		height: 720,
		fps: 30,
		durationInFrames: 480,
		defaultCodec: "h264",
		defaultAudioCodec: "aac",
		framesPerChunk: 120,
		effectiveChunkCount: 4,
		minFramesPerChunk: 120,
	};
	job.chunkPlan = [
		{
			chunkIndex: 0,
			frameRange: { from: 0, to: 119 },
			frameCount: 120,
			videoFileKey: "renders/job:hello-world/chunks/0.ts",
			audioFileKey: "renders/job:hello-world/chunks/0.aac",
			containerId: "render:job:hello-world:chunk:0",
			status: "completed",
			retryCount: 0,
			renderedFrames: 120,
			progress: 100,
			durationMs: 1200,
			uploadDurationMs: 200,
			startupDurationMs: 400,
			workerId: "worker-0",
			artifactDir: "/tmp/job:hello-world",
		},
		{
			chunkIndex: 1,
			frameRange: { from: 120, to: 239 },
			frameCount: 120,
			videoFileKey: "renders/job:hello-world/chunks/1.ts",
			audioFileKey: "renders/job:hello-world/chunks/1.aac",
			containerId: "render:job:hello-world:chunk:1",
			status: "rendering",
			retryCount: 0,
			renderedFrames: 60,
			progress: 50,
			workerId: "worker-1",
			artifactDir: "/tmp/job:hello-world",
		},
	];
	job.workerPool = [
		{
			workerId: "worker-0",
			containerId: "render:job:hello-world:leader:worker:0",
			busy: false,
			createdAt: "2026-01-01T00:00:00.000Z",
			chunksRendered: 1,
		},
		{
			workerId: "worker-1",
			containerId: "render:job:hello-world:leader:worker:1",
			busy: true,
			createdAt: "2026-01-01T00:00:01.000Z",
			chunksRendered: 0,
		},
	];
	job.metricSamples.chunkRenderMs = {
		count: 2,
		totalMs: 4000,
		maxMs: 2500,
		lastMs: 2500,
	};
	job.createdAt = "2026-01-01T00:00:00.000Z";
	job.updatedAt = "2026-01-01T00:00:10.000Z";

	recomputeJobAggregate(job);

	assert.equal(job.chunkCount, 2);
	assert.equal(job.completedChunks, 1);
	assert.equal(job.renderedFrames, 180);
	assert.equal(job.progress, 48);
	assert.equal(job.activeWorkers, 1);
	assert.equal(job.metrics.totalElapsedMs, 10000);
	assert.equal(job.metrics.chunkRenderMs?.avgMs, 2000);
});

test("completed jobs expose their output key", () => {
	assert.deepEqual(
		resolveOutputAccess({
			status: "completed",
			outputKey: "renders/job:hello-world/output.mp4",
		}),
		{
			ok: true,
			outputKey: "renders/job:hello-world/output.mp4",
		},
	);
});

test("chunking splits frames into contiguous ranges", () => {
	const ranges = frameRangesFromTotalFrames(10, 3);
	assert.deepEqual(ranges, [
		{ from: 0, to: 3 },
		{ from: 4, to: 7 },
		{ from: 8, to: 9 },
	]);
	validateChunkCoverage(10, ranges);
});

test("chunk count clamps by minimum frames per chunk", () => {
	const effective = resolveChunkCount({
		targetChunkCount: 32,
		defaultChunkCount: 4,
		maxChunkCount: 64,
		totalFrames: 180,
		minFramesPerChunk: DEFAULT_MIN_FRAMES_PER_CHUNK,
	});

	assert.equal(effective, 1);
});

test("chunk coverage validation fails on gaps", () => {
	assert.throws(
		() =>
			validateChunkCoverage(5, [
				{ from: 0, to: 1 },
				{ from: 3, to: 4 },
			]),
		/coverage gap/i,
	);
});

test("worker pool size is capped by the configured max", () => {
	assert.equal(
		resolveWorkerPoolSize({
			chunkCount: 12,
			maxPoolSize: 2,
		}),
		2,
	);

	assert.equal(
		resolveWorkerPoolSize({
			chunkCount: 3,
			maxPoolSize: 2,
		}),
		2,
	);

	assert.equal(
		resolveWorkerPoolSize({
			chunkCount: 2,
			maxPoolSize: 4,
		}),
		2,
	);
});

test("deriveLocalWorkerOrigin maps loopback hosts to host.docker.internal", () => {
	assert.equal(
		deriveLocalWorkerOrigin("http://127.0.0.1:8787/jobs"),
		"http://host.docker.internal:8787",
	);
	assert.equal(
		deriveLocalWorkerOrigin("http://localhost:8798/jobs"),
		"http://host.docker.internal:8798",
	);
	assert.equal(
		deriveLocalWorkerOrigin("https://cloudflare-remotion-example.example.workers.dev/jobs"),
		undefined,
	);
});

test("local transport helpers switch to worker passthrough URLs when enabled", () => {
	const localOrigin = "http://host.docker.internal:8787";

	assert.equal(isLocalWorkerTransportEnabled(localOrigin), true);
	assert.equal(
		toLocalCoordinatorProgressPath("job:hello-world", 2),
		"/internal/coordinator/jobs/job%3Ahello-world/chunks/2/progress",
	);
	assert.equal(
		toLocalR2ObjectPath("renders/job:hello-world/output.mp4"),
		"/internal/r2/objects/renders%2Fjob%3Ahello-world%2Foutput.mp4",
	);
	assert.equal(
		toCoordinatorProgressTransportUrl("job:hello-world", 2, localOrigin),
		"http://host.docker.internal:8787/internal/coordinator/jobs/job%3Ahello-world/chunks/2/progress",
	);
	assert.equal(
		toR2TransportUrl("renders/job:hello-world/output.mp4", localOrigin),
		"http://host.docker.internal:8787/internal/r2/objects/renders%2Fjob%3Ahello-world%2Foutput.mp4",
	);
});

test("transport helpers keep internal host routing when local passthrough is disabled", () => {
	assert.equal(isLocalWorkerTransportEnabled(undefined), false);
	assert.equal(
		toCoordinatorProgressTransportUrl("job:hello-world", 2, undefined),
		"http://coordinator.internal/jobs/job%3Ahello-world/chunks/2/progress",
	);
	assert.equal(
		toR2TransportUrl("renders/job:hello-world/output.mp4", undefined),
		"http://r2.internal/objects/renders%2Fjob%3Ahello-world%2Foutput.mp4",
	);
});

test("local passthrough matchers recognize worker routes", () => {
	const coordinatorMatch = matchLocalCoordinatorProgressPath(
		"/internal/coordinator/jobs/job%3Ahello-world/chunks/2/progress",
	);
	assert.ok(coordinatorMatch);
	assert.equal(coordinatorMatch?.[1], "job%3Ahello-world");
	assert.equal(coordinatorMatch?.[2], "2");
	assert.equal(
		isLocalR2ObjectPath("/internal/r2/objects/renders%2Fjob%3Ahello-world%2Foutput.mp4"),
		true,
	);
	assert.equal(
		stripLocalR2Prefix("/internal/r2/objects/renders%2Fjob%3Ahello-world%2Foutput.mp4"),
		"/objects/renders%2Fjob%3Ahello-world%2Foutput.mp4",
	);
});
