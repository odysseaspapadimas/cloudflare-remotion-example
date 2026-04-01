import type { CreateRenderJobRequest, RenderJobRecord, RuntimeMetricSampleAccumulator } from "./types.ts";

const toMetricSample = (sample?: RuntimeMetricSampleAccumulator) => {
	if (!sample || sample.count === 0) {
		return undefined;
	}

	return {
		count: sample.count,
		totalMs: sample.totalMs,
		avgMs: Math.round(sample.totalMs / sample.count),
		maxMs: sample.maxMs,
		lastMs: sample.lastMs,
	};
};

const safeDiffMs = (from: string | undefined, to: string | undefined) => {
	if (!from || !to) {
		return undefined;
	}

	const fromMs = Date.parse(from);
	const toMs = Date.parse(to);
	if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) {
		return undefined;
	}

	return Math.max(0, toMs - fromMs);
};

export const createInitialRenderJobRecord = (
	renderJobId: string,
	request: CreateRenderJobRequest,
	now = new Date().toISOString(),
): RenderJobRecord => ({
	renderJobId,
	compositionId: request.compositionId,
	idempotencyKey: request.idempotencyKey,
	status: "queued",
	stage: "queued",
	message: "Getting everything ready...",
	outputKey: request.outputKey,
	targetChunkCount: request.targetChunkCount,
	request,
	completedChunks: 0,
	renderedFrames: 0,
	progress: 12,
	combineAttempts: 0,
	workerPool: [],
	activeWorkers: 0,
	metrics: {},
	metricSamples: {},
	createdAt: now,
	updatedAt: now,
});

export const recomputeJobAggregate = (job: RenderJobRecord): RenderJobRecord => {
	const previousProgress = job.progress;
	const chunks = job.chunkPlan ?? [];
	job.chunkCount = chunks.length;
	job.completedChunks = chunks.filter((chunk) => chunk.status === "completed").length;
	job.totalFrames = job.composition?.durationInFrames;
	job.renderedFrames = chunks.reduce(
		(total, chunk) => total + Math.min(chunk.renderedFrames, chunk.frameCount),
		0,
	);
	job.activeWorkers = job.workerPool.filter((worker) => worker.busy).length;
	job.metrics.browserReadyMs = toMetricSample(job.metricSamples.browserReadyMs);
	job.metrics.workerStartupMs = toMetricSample(job.metricSamples.workerStartupMs);
	job.metrics.chunkRenderMs = toMetricSample(job.metricSamples.chunkRenderMs);
	job.metrics.chunkUploadMs = toMetricSample(job.metricSamples.chunkUploadMs);
	job.metrics.chunkEndToEndMs = toMetricSample(job.metricSamples.chunkEndToEndMs);
	job.metrics.totalElapsedMs = safeDiffMs(job.createdAt, job.updatedAt);
	if (chunks.some((chunk) => chunk.startedAt)) {
		const startedAt = chunks
			.map((chunk) => chunk.startedAt)
			.filter((value): value is string => Boolean(value))
			.sort()[0];
		job.metrics.queueWaitMs = safeDiffMs(job.createdAt, startedAt);
	}

	if (job.status === "queued") {
		job.progress = 12;
		return job;
	}

	if (job.status === "planning") {
		job.progress = 18;
		return job;
	}

	if (job.status === "rendering") {
		const totalFrames = job.totalFrames ?? 0;
		const renderRatio = totalFrames > 0 ? job.renderedFrames / totalFrames : 0;
		job.progress = Math.max(
			previousProgress,
			Math.max(22, Math.min(92, 22 + Math.round(renderRatio * 70))),
		);
		return job;
	}

	if (job.status === "combining") {
		const baseProgress = Math.max(job.progress, 92);
		job.progress = job.combineResult ? 98 : Math.max(baseProgress, 93);
		return job;
	}

	if (job.status === "completed") {
		job.progress = 100;
		job.stage = "completed";
		return job;
	}

	if (job.status === "failed") {
		job.stage = "error";
	}

	return job;
};
