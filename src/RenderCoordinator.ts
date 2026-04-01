import { DurableObject } from "cloudflare:workers";
import { getContainer } from "@cloudflare/containers";
import {
	DEFAULT_RENDER_WORKER_POOL_SIZE_MAX,
	resolveWorkerPoolSize,
} from "./chunking.ts";
import type { RemotionContainer } from "./container.ts";
import { createInitialRenderJobRecord, recomputeJobAggregate } from "./render-job-state.ts";
import type {
	ChunkProgressUpdate,
	CreateRenderJobRequest,
	CreateRenderJobResponse,
	PlanRenderResponse,
	RenderJobRecord,
	RenderJobStatusResponse,
	RuntimeChunkResult,
	RuntimeCombineResult,
	RuntimeMetricSampleAccumulator,
	ContainerWorkerLease,
} from "./types.ts";

const artifactPrefixFor = (renderJobId: string) => `renders/${renderJobId}/chunks/`;

const resolveOutputAccess = (
	job: Pick<RenderJobRecord, "status" | "outputKey"> | null,
) => {
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

type CoordinatorEnv = Env;

type ContainerStub = DurableObjectStub<RemotionContainer> & {
	startAndWaitForPorts: typeof RemotionContainer.prototype.startAndWaitForPorts;
	getState: typeof RemotionContainer.prototype.getState;
	destroy: typeof RemotionContainer.prototype.destroy;
	stop: typeof RemotionContainer.prototype.stop;
	configureOutbound: (renderJobId: string) => Promise<void>;
};

const JOB_KEY = "job";
const CHUNK_RETRY_LIMIT = 2;
const COMBINE_RETRY_LIMIT = 1;
const DEFAULT_STUCK_CHUNK_TIMEOUT_MS = 300_000;
const DEFAULT_PLANNING_TIMEOUT_MS = 180_000;
const STUCK_CHECK_INTERVAL_MS = 60_000;

const parseIntegerVar = (
	value: string | number | undefined,
	fallback: number,
): number => {
	if (value === undefined || value === null || value === "") {
		return fallback;
	}

	const parsed = typeof value === "number" ? value : Number.parseInt(value, 10);
	return Number.isFinite(parsed) ? parsed : fallback;
};

const appendMetricSample = (
	accumulator: RuntimeMetricSampleAccumulator | undefined,
	value: number | undefined,
): RuntimeMetricSampleAccumulator | undefined => {
	if (value === undefined || !Number.isFinite(value)) {
		return accumulator;
	}

	if (!accumulator) {
		return {
			count: 1,
			totalMs: value,
			maxMs: value,
			lastMs: value,
		};
	}

	accumulator.count += 1;
	accumulator.totalMs += value;
	accumulator.maxMs = Math.max(accumulator.maxMs, value);
	accumulator.lastMs = value;
	return accumulator;
};

export const getLeaderContainerId = (renderJobId: string) => `render:${renderJobId}:leader`;

const getCoordinatorStub = (env: CoordinatorEnv, renderJobId: string) =>
	(
		env as CoordinatorEnv & {
			RENDER_COORDINATOR: DurableObjectNamespace<RenderCoordinator>;
		}
	).RENDER_COORDINATOR.get(
		(
			env as CoordinatorEnv & {
				RENDER_COORDINATOR: DurableObjectNamespace<RenderCoordinator>;
			}
		).RENDER_COORDINATOR.idFromName(renderJobId),
	);

export class RenderCoordinator extends DurableObject<CoordinatorEnv> {
	private job: RenderJobRecord | null = null;

	constructor(ctx: DurableObjectState, env: CoordinatorEnv) {
		super(ctx, env);
		this.ctx.blockConcurrencyWhile(async () => {
			this.job = (await this.ctx.storage.get<RenderJobRecord>(JOB_KEY)) ?? null;
		});
	}

	async alarm(): Promise<void> {
		if (!this.job) {
			return;
		}

		if (this.job.status === "completed" || this.job.status === "failed") {
			return;
		}

		if (this.job.status === "planning") {
			await this.checkStuckPlanning();
		}

		if (this.job.status === "rendering" || this.job.status === "combining") {
			await this.checkStuckChunks();
		}

		if (
			this.job.status === "rendering" ||
			this.job.status === "planning" ||
			this.job.status === "combining"
		) {
			this.ctx.storage.setAlarm(Date.now() + STUCK_CHECK_INTERVAL_MS);
		}
	}

	private async checkStuckPlanning(): Promise<void> {
		const job = this.job;
		if (!job || job.status !== "planning") {
			return;
		}

		const envWithVars = this.env as CoordinatorEnv & {
			PLANNING_TIMEOUT_MS?: string | number;
		};
		const timeout = parseIntegerVar(
			envWithVars.PLANNING_TIMEOUT_MS,
			DEFAULT_PLANNING_TIMEOUT_MS,
		);

		const elapsed = Date.now() - Date.parse(job.updatedAt);
		if (elapsed >= timeout) {
			await this.failJob(
				new Error(
					`Planning phase stuck for ${Math.round(elapsed / 1000)}s; leader container may have failed to start`,
				),
				{ cleanupArtifacts: false },
			);
		}
	}

	private async checkStuckChunks(): Promise<void> {
		const job = this.job;
		if (!job || !job.chunkPlan) {
			return;
		}

		const envWithVars = this.env as CoordinatorEnv & {
			STUCK_CHUNK_TIMEOUT_MS?: string | number;
		};
		const timeout = parseIntegerVar(
			envWithVars.STUCK_CHUNK_TIMEOUT_MS,
			DEFAULT_STUCK_CHUNK_TIMEOUT_MS,
		);

		const now = Date.now();
		let hasChanges = false;

		for (const chunk of job.chunkPlan) {
			if (chunk.status !== "rendering" || !chunk.startedAt) {
				continue;
			}

			const elapsed = now - Date.parse(chunk.startedAt);
			if (elapsed < timeout) {
				continue;
			}

			if (chunk.workerId) {
				const worker = job.workerPool.find((entry) => entry.workerId === chunk.workerId);
				if (worker) {
					worker.busy = false;
					worker.lastError = `Chunk ${chunk.chunkIndex} stuck after ${Math.round(elapsed / 1000)}s`;
					if (chunk.containerId) {
						this.ctx.waitUntil(this.getContainer(chunk.containerId).destroy().catch(() => undefined));
						worker.warmedAt = undefined;
					}
				}
			}

			if (chunk.retryCount < CHUNK_RETRY_LIMIT) {
				chunk.retryCount += 1;
				chunk.status = "queued";
				chunk.progress = 0;
				chunk.renderedFrames = 0;
				chunk.error = `Stuck after ${Math.round(elapsed / 1000)}s; retrying (attempt ${chunk.retryCount})`;
				chunk.workerId = undefined;
				chunk.startedAt = undefined;
				hasChanges = true;
			} else {
				chunk.status = "failed";
				chunk.error = `Stuck after ${Math.round(elapsed / 1000)}s; retry limit exhausted`;
				await this.failJob(
					new Error(
						`Chunk ${chunk.chunkIndex} stuck and exhausted retries after ${Math.round(elapsed / 1000)}s`,
					),
				);
				return;
			}
		}

		if (hasChanges) {
			this.recomputeAggregateProgress(job);
			await this.persistJob();
			this.enqueueChunkWork(job);
		}
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const pathname = url.pathname;

		if (request.method === "POST" && pathname === "/init") {
			const body = (await request.json()) as {
				renderJobId: string;
				request: CreateRenderJobRequest;
			};
			return Response.json(await this.initialize(body.renderJobId, body.request));
		}

		if (request.method === "GET" && pathname === "/status") {
			if (!this.job) {
				return Response.json({ error: "Render job not found" }, { status: 404 });
			}

			return Response.json(this.toStatusResponse(this.job));
		}

		if (request.method === "GET" && pathname === "/output") {
			const result = resolveOutputAccess(this.job);
			if (!result.ok) {
				return Response.json(
					{
						error: result.error,
						status: result.renderStatus,
					},
					{ status: result.status },
				);
			}

			return Response.json({ outputKey: result.outputKey });
		}

		const progressMatch = pathname.match(/^\/jobs\/([^/]+)\/chunks\/(\d+)\/progress$/);
		if (request.method === "POST" && progressMatch) {
			const body = (await request.json()) as ChunkProgressUpdate;
			await this.handleChunkProgress(body);
			return Response.json({ ok: true });
		}

		return new Response("Not found", { status: 404 });
	}

	private requireJob(): RenderJobRecord {
		if (!this.job) {
			throw new Error("Render job not initialized");
		}

		return this.job;
	}

	private async persistJob(): Promise<void> {
		if (!this.job) {
			return;
		}

		this.job.updatedAt = new Date().toISOString();
		await this.ctx.storage.put(JOB_KEY, this.job);
	}

	private toStatusResponse(job: RenderJobRecord): RenderJobStatusResponse {
		return {
			renderJobId: job.renderJobId,
			compositionId: job.compositionId,
			status: job.status,
			stage: job.stage,
			progress: job.progress,
			chunkCount: job.chunkCount,
			completedChunks: job.completedChunks,
			totalFrames: job.totalFrames,
			renderedFrames: job.renderedFrames,
			workerPoolSize: job.workerPool.length,
			activeWorkers: job.activeWorkers,
			outputKey: job.status === "completed" ? job.outputKey : undefined,
			message: job.message,
			error: job.error,
			metrics: job.metrics,
		};
	}

	private recomputeAggregateProgress(job: RenderJobRecord): void {
		recomputeJobAggregate(job);
	}

	private getConfiguredWorkerPoolSize(chunkCount: number): number {
		const envWithVars = this.env as CoordinatorEnv & {
			RENDER_WORKER_POOL_SIZE_MAX?: string | number;
		};

		const maxPoolSize = parseIntegerVar(
			envWithVars.RENDER_WORKER_POOL_SIZE_MAX,
			DEFAULT_RENDER_WORKER_POOL_SIZE_MAX,
		);

		return resolveWorkerPoolSize({
			chunkCount,
			maxPoolSize,
		});
	}

	private ensureWorkerPool(job: RenderJobRecord, chunkCount: number): void {
		const desiredSize = this.getConfiguredWorkerPoolSize(chunkCount);
		if (job.workerPool.length >= desiredSize) {
			return;
		}

		for (let index = job.workerPool.length; index < desiredSize; index += 1) {
			job.workerPool.push({
				workerId: `worker-${index}`,
				containerId: `${getLeaderContainerId(job.renderJobId)}:worker:${index}`,
				busy: false,
				createdAt: new Date().toISOString(),
				chunksRendered: 0,
			});
		}
	}

	private getAvailableWorker(
		job: RenderJobRecord,
		preferredWorkerId?: string,
	): ContainerWorkerLease | null {
		if (preferredWorkerId) {
			const preferredWorker = job.workerPool.find(
				(worker) => worker.workerId === preferredWorkerId && !worker.busy,
			);
			if (preferredWorker) {
				return preferredWorker;
			}
		}

		return (
			job.workerPool
				.filter((worker) => !worker.busy)
				.sort((left, right) => left.chunksRendered - right.chunksRendered)[0] ?? null
		);
	}

	private enqueueChunkWork(job: RenderJobRecord): void {
		const queuedChunks = job.chunkPlan?.filter((chunk) => chunk.status === "queued") ?? [];
		for (const chunk of queuedChunks) {
			const worker = this.getAvailableWorker(job, chunk.workerId);
			if (!worker) {
				return;
			}

			worker.busy = true;
			worker.lastAssignedAt = new Date().toISOString();
			chunk.workerId = worker.workerId;
			chunk.containerId = worker.containerId;
			this.ctx.waitUntil(this.executeChunk(chunk.chunkIndex, worker.workerId));
		}
	}

	private trackMetric(
		job: RenderJobRecord,
		metric:
			| "browserReadyMs"
			| "workerStartupMs"
			| "chunkRenderMs"
			| "chunkUploadMs"
			| "chunkEndToEndMs",
		value: number | undefined,
	): void {
		job.metricSamples[metric] = appendMetricSample(job.metricSamples[metric], value);
	}

	private async initialize(
		renderJobId: string,
		request: CreateRenderJobRequest,
	): Promise<CreateRenderJobResponse> {
		if (this.job) {
			return {
				renderJobId: this.job.renderJobId,
				status: this.job.status,
				workerPoolSize: this.job.workerPool.length,
			};
		}

		this.job = createInitialRenderJobRecord(renderJobId, request);
		await this.persistJob();
		this.ctx.storage.setAlarm(Date.now() + STUCK_CHECK_INTERVAL_MS);
		this.ctx.waitUntil(this.planRender());

		return {
			renderJobId,
			status: this.job.status,
			workerPoolSize: this.job.workerPool.length,
		};
	}

	private getContainer(containerId: string): ContainerStub {
		return getContainer(this.env.REMOTION_CONTAINER, containerId) as unknown as ContainerStub;
	}

	private async startContainer(containerId: string): Promise<ContainerStub> {
		const container = this.getContainer(containerId);
		const localWorkerOrigin = this.job?.request.localWorkerOrigin;
		await container.startAndWaitForPorts({
			ports: [8080],
			startOptions: {
				enableInternet: true,
				envVars: localWorkerOrigin ? { LOCAL_WORKER_ORIGIN: localWorkerOrigin } : undefined,
			},
			cancellationOptions: {
				instanceGetTimeoutMS: 30000,
				portReadyTimeoutMS: 120000,
				waitInterval: 500,
			},
		});
		return container;
	}

	private async planRender(): Promise<void> {
		const job = this.requireJob();
		if (job.status !== "queued") {
			return;
		}

		job.status = "planning";
		job.stage = "planning";
		job.message = "Preparing your composition...";
		this.recomputeAggregateProgress(job);
		await this.persistJob();

		const leaderContainerId = getLeaderContainerId(job.renderJobId);
		const planStarted = Date.now();

		try {
			const leaderStartupStarted = Date.now();
			const container = await this.startContainer(leaderContainerId);
			job.metrics.leaderStartupMs = Date.now() - leaderStartupStarted;
			await container.configureOutbound(job.renderJobId);
			const response = await container.fetch(
				new Request("https://container/internal/plan-render", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
					},
					body: JSON.stringify({
						renderJobId: job.renderJobId,
						compositionId: job.compositionId,
						inputProps: job.request.inputProps,
						outputKey: job.outputKey,
						targetChunkCount: job.targetChunkCount,
						idempotencyKey: job.idempotencyKey,
					}),
				}),
			);

			if (!response.ok) {
				throw new Error(await response.text());
			}

			const result = (await response.json()) as PlanRenderResponse;
			job.composition = result.composition;
			job.metrics.planDurationMs = Date.now() - planStarted;
			job.metrics.selectCompositionDurationMs = result.selectCompositionDurationMs;
			this.trackMetric(job, "browserReadyMs", result.browserReadyMs);
			job.chunkPlan = result.chunks.map((chunk) => ({ ...chunk }));
			this.ensureWorkerPool(job, job.chunkPlan.length);
			job.status = "rendering";
			job.stage = "rendering";
			job.message = "Rendering chunks...";
			this.recomputeAggregateProgress(job);
			await this.persistJob();

			this.ctx.storage.setAlarm(Date.now() + STUCK_CHECK_INTERVAL_MS);
			this.enqueueChunkWork(job);
		} catch (error) {
			await this.failJob(error, { cleanupArtifacts: false });
		}
	}

	private async executeChunk(chunkIndex: number, workerId: string): Promise<void> {
		const job = this.requireJob();
		if (job.status === "failed" || job.status === "completed") {
			return;
		}

		const worker = job.workerPool.find((entry) => entry.workerId === workerId);
		if (!worker) {
			return;
		}

		const chunk = job.chunkPlan?.find((entry) => entry.chunkIndex === chunkIndex);
		if (!chunk || !job.composition) {
			worker.busy = false;
			return;
		}

		chunk.status = "rendering";
		chunk.progress = Math.max(chunk.progress, 1);
		chunk.error = undefined;
		chunk.startedAt = new Date().toISOString();
		chunk.workerId = worker.workerId;
		chunk.containerId = worker.containerId;
		job.status = "rendering";
		job.stage = "rendering";
		job.message = "Rendering chunks...";
		this.recomputeAggregateProgress(job);
		await this.persistJob();

		const containerId = worker.containerId;
		chunk.containerId = containerId;
		const chunkStarted = Date.now();

		try {
			const workerStartupStarted = Date.now();
			const container = await this.startContainer(containerId);
			const startupDurationMs = Date.now() - workerStartupStarted;
			worker.warmedAt ??= new Date().toISOString();
			chunk.startupDurationMs = startupDurationMs;
			this.trackMetric(job, "workerStartupMs", startupDurationMs);
			await container.configureOutbound(job.renderJobId);
			const response = await container.fetch(
				new Request("https://container/internal/render-chunk", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
					},
					body: JSON.stringify({
						renderJobId: job.renderJobId,
						compositionId: job.compositionId,
						chunk,
						composition: job.composition,
						compositionStart: 0,
						inputProps: job.request.inputProps,
					}),
				}),
			);

			if (!response.ok) {
				throw new Error(await response.text());
			}

			const result = (await response.json()) as RuntimeChunkResult;
			chunk.status = "completed";
			chunk.progress = 100;
			chunk.renderedFrames = result.renderedFrames;
			chunk.completedAt = new Date().toISOString();
			chunk.durationMs = result.durationMs;
			chunk.uploadDurationMs = result.uploadDurationMs;
			chunk.videoFileKey = result.videoFileKey;
			chunk.audioFileKey = result.audioFileKey;
			worker.busy = false;
			worker.chunksRendered += 1;
			worker.lastCompletedAt = chunk.completedAt;
			this.trackMetric(job, "browserReadyMs", result.browserReadyMs);
			this.trackMetric(job, "chunkRenderMs", result.renderDurationMs);
			this.trackMetric(job, "chunkUploadMs", result.uploadDurationMs);
			this.trackMetric(job, "chunkEndToEndMs", Date.now() - chunkStarted);
			this.recomputeAggregateProgress(job);
			await this.persistJob();

			if (job.chunkPlan?.every((entry) => entry.status === "completed")) {
				this.ctx.waitUntil(this.combineChunks());
			} else {
				this.enqueueChunkWork(job);
			}
		} catch (error) {
			const container = this.getContainer(containerId);
			const state = await container.getState().catch(() => null);
			console.error("Chunk render failed", {
				renderJobId: job.renderJobId,
				chunkIndex,
				containerId,
				state,
				error,
			});
			worker.busy = false;
			worker.lastError = error instanceof Error ? error.message : String(error);
			await container.destroy().catch(() => undefined);
			worker.warmedAt = undefined;

			if (chunk.retryCount < CHUNK_RETRY_LIMIT) {
				chunk.retryCount += 1;
				chunk.status = "queued";
				chunk.progress = 0;
				chunk.renderedFrames = 0;
				chunk.error = error instanceof Error ? error.message : String(error);
				chunk.workerId = undefined;
				this.recomputeAggregateProgress(job);
				await this.persistJob();
				this.enqueueChunkWork(job);
				return;
			}

			await this.failJob(error);
		}
	}

	private async handleChunkProgress(update: ChunkProgressUpdate): Promise<void> {
		const job = this.requireJob();
		if (job.renderJobId !== update.renderJobId || !job.chunkPlan) {
			return;
		}

		const chunk = job.chunkPlan.find((entry) => entry.chunkIndex === update.chunkIndex);
		if (!chunk || chunk.status === "completed") {
			return;
		}

		if (update.status === "failed") {
			chunk.error = update.error;
			await this.persistJob();
			return;
		}

		chunk.status = update.status;
		chunk.progress = Math.max(chunk.progress, update.progress);
		chunk.renderedFrames = Math.max(
			chunk.renderedFrames,
			Math.min(update.renderedFrames, chunk.frameCount),
		);
		chunk.error = update.error;
		chunk.containerId = update.containerId;
		job.status = "rendering";
		job.stage = "rendering";
		job.message = "Rendering chunks...";
		this.recomputeAggregateProgress(job);
		await this.persistJob();
	}

	private async combineChunks(): Promise<void> {
		const job = this.requireJob();
		if (
			job.status === "completed" ||
			job.status === "failed" ||
			job.status === "combining"
		) {
			return;
		}

		if (!job.chunkPlan || !job.composition) {
			await this.failJob(new Error("Cannot combine without chunk plan"));
			return;
		}

		job.status = "combining";
		job.stage = "combining";
		job.message = "Combining chunks...";
		job.combineAttempts = (job.combineAttempts ?? 0) + 1;
		this.recomputeAggregateProgress(job);
		await this.persistJob();

		const leaderContainerId = getLeaderContainerId(job.renderJobId);

		try {
			const container = await this.startContainer(leaderContainerId);
			await container.configureOutbound(job.renderJobId);
			const response = await container.fetch(
				new Request("https://container/internal/combine-chunks", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
					},
					body: JSON.stringify({
						renderJobId: job.renderJobId,
						outputKey: job.outputKey,
						composition: job.composition,
						framesPerChunk: job.composition.framesPerChunk,
						chunks: job.chunkPlan.map((chunk) => ({
							chunkIndex: chunk.chunkIndex,
							videoFileKey: chunk.videoFileKey,
							audioFileKey: chunk.audioFileKey,
							frameRange: chunk.frameRange,
						})),
						artifactDir: `/tmp/${job.renderJobId}`,
					}),
				}),
			);

			if (!response.ok) {
				throw new Error(await response.text());
			}

			const result = (await response.json()) as RuntimeCombineResult;
			job.combineResult = result;
			job.metrics.combineDownloadMs = result.combineDownloadMs;
			job.metrics.combineRenderMs = result.combineRenderMs;
			job.metrics.finalUploadMs = result.finalUploadMs;
			job.status = "completed";
			job.stage = "completed";
			job.message = "Render complete";
			job.outputKey = result.outputKey;
			job.error = undefined;
			this.recomputeAggregateProgress(job);
			await this.persistJob();

			await this.cleanupArtifacts(job);
			await this.cleanupContainers(job);
		} catch (error) {
			if ((job.combineAttempts ?? 0) <= COMBINE_RETRY_LIMIT) {
				job.status = "rendering";
				job.stage = "rendering";
				job.message = "Retrying final combine...";
				await this.persistJob();
				this.ctx.waitUntil(this.combineChunks());
				return;
			}

			await this.failJob(error);
		}
	}

	private async cleanupArtifacts(job: RenderJobRecord): Promise<void> {
		const keys = job.chunkPlan?.flatMap((chunk) => [chunk.videoFileKey, chunk.audioFileKey]);
		if (!keys?.length) {
			return;
		}

		await this.env.R2_BUCKET.delete(keys).catch((error) => {
			console.warn("Failed to cleanup chunk artifacts", {
				renderJobId: job.renderJobId,
				error,
			});
		});

		await this.env.R2_BUCKET
			.delete(`${artifactPrefixFor(job.renderJobId)}manifest.json`)
			.catch(() => undefined);
	}

	private async cleanupContainers(job: RenderJobRecord): Promise<void> {
		const containerIds = new Set<string>([getLeaderContainerId(job.renderJobId)]);
		for (const worker of job.workerPool) {
			containerIds.add(worker.containerId);
		}

		await Promise.all(
			[...containerIds].map(async (containerId) => {
				await this.getContainer(containerId).destroy().catch(() => undefined);
			}),
		);
	}

	private async failJob(
		error: unknown,
		options?: { cleanupArtifacts?: boolean },
	): Promise<void> {
		const job = this.requireJob();
		for (const worker of job.workerPool) {
			worker.busy = false;
		}
		job.status = "failed";
		job.stage = "error";
		job.error = error instanceof Error ? error.message : String(error);
		job.message = job.error;
		this.recomputeAggregateProgress(job);
		await this.persistJob();

		if (options?.cleanupArtifacts !== false) {
			await this.cleanupArtifacts(job);
		}

		await this.cleanupContainers(job);
	}
}

export { getCoordinatorStub };
