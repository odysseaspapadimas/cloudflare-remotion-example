export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject {
	[key: string]: JsonValue;
}

export type RenderStage =
	| "queued"
	| "planning"
	| "rendering"
	| "combining"
	| "completed"
	| "error";

export type RenderJobStatus =
	| "queued"
	| "planning"
	| "rendering"
	| "combining"
	| "completed"
	| "failed";

export type RenderChunkStatus = "queued" | "rendering" | "completed" | "failed";

export interface RenderFrameRange {
	from: number;
	to: number;
}

export interface RenderCompositionMetadata {
	id: string;
	width: number;
	height: number;
	fps: number;
	durationInFrames: number;
	defaultCodec: "h264";
	defaultAudioCodec: "aac" | "pcm-16" | null;
}

export interface RenderMetricSample {
	count: number;
	totalMs: number;
	avgMs: number;
	maxMs: number;
	lastMs: number;
}

export interface RenderJobMetrics {
	queueWaitMs?: number;
	totalElapsedMs?: number;
	planDurationMs?: number;
	selectCompositionDurationMs?: number;
	leaderStartupMs?: number;
	browserReadyMs?: RenderMetricSample;
	workerStartupMs?: RenderMetricSample;
	chunkRenderMs?: RenderMetricSample;
	chunkUploadMs?: RenderMetricSample;
	chunkEndToEndMs?: RenderMetricSample;
	combineDownloadMs?: number;
	combineRenderMs?: number;
	finalUploadMs?: number;
}

export interface RenderChunkPlan {
	chunkIndex: number;
	frameRange: RenderFrameRange;
	frameCount: number;
	videoFileKey: string;
	audioFileKey: string;
	containerId: string;
	status: RenderChunkStatus;
	retryCount: number;
	renderedFrames: number;
	error?: string;
	startedAt?: string;
	completedAt?: string;
}

export interface CreateRenderJobRequest {
	compositionId: string;
	inputProps: JsonObject;
	outputKey: string;
	targetChunkCount?: number;
	idempotencyKey: string;
	localWorkerOrigin?: string;
}

export interface CreateRenderJobResponse {
	renderJobId: string;
	status: RenderJobStatus;
	workerPoolSize?: number;
}

export interface RenderJobStatusResponse {
	renderJobId: string;
	compositionId: string;
	status: RenderJobStatus;
	stage: RenderStage;
	progress: number;
	chunkCount?: number;
	completedChunks?: number;
	totalFrames?: number;
	renderedFrames?: number;
	workerPoolSize?: number;
	activeWorkers?: number;
	outputKey?: string;
	message?: string;
	error?: string;
	metrics?: RenderJobMetrics;
}

export interface ChunkProgressUpdate {
	renderJobId: string;
	chunkIndex: number;
	status: RenderChunkStatus;
	progress: number;
	renderedFrames: number;
	totalFrames: number;
	containerId: string;
	error?: string;
	videoFileKey?: string;
	audioFileKey?: string;
}

export interface ChunkRenderPayload {
	renderJobId: string;
	compositionId: string;
	chunk: RenderChunkPlan;
	composition: RenderCompositionMetadata;
	compositionStart: number;
	inputProps: JsonObject;
}

export interface ChunkRenderResult {
	renderJobId: string;
	chunkIndex: number;
	containerId: string;
	videoFileKey: string;
	audioFileKey: string;
	renderedFrames: number;
	totalFrames: number;
	durationMs: number;
	renderDurationMs?: number;
	uploadDurationMs?: number;
	browserReadyMs?: number;
}

export interface CombineChunksPayload {
	renderJobId: string;
	outputKey: string;
	composition: RenderCompositionMetadata;
	framesPerChunk: number;
	chunks: Array<
		Pick<
			RenderChunkPlan,
			"chunkIndex" | "videoFileKey" | "audioFileKey" | "frameRange"
		>
	>;
}

export interface CombineChunksResult {
	renderJobId: string;
	outputKey: string;
	fileSize: number;
	durationMs: number;
	combineDownloadMs?: number;
	combineRenderMs?: number;
	finalUploadMs?: number;
}

export interface RuntimeCompositionMetadata extends RenderCompositionMetadata {
	framesPerChunk: number;
	effectiveChunkCount: number;
	minFramesPerChunk: number;
}

export interface RuntimeChunkAssignment extends RenderChunkPlan {
	status: RenderChunkStatus;
	progress: number;
	durationMs?: number;
	uploadDurationMs?: number;
	startupDurationMs?: number;
	workerId?: string;
	artifactDir: string;
}

export interface RuntimeChunkProgress extends ChunkProgressUpdate {}

export interface RuntimeChunkResult extends ChunkRenderResult {}

export interface RuntimeCombineInput extends CombineChunksPayload {
	artifactDir: string;
}

export interface RuntimeCombineResult extends CombineChunksResult {}

export interface ContainerWorkerLease {
	workerId: string;
	containerId: string;
	busy: boolean;
	createdAt: string;
	warmedAt?: string;
	lastAssignedAt?: string;
	lastCompletedAt?: string;
	chunksRendered: number;
	lastError?: string;
}

export interface RuntimeMetricSampleAccumulator {
	count: number;
	totalMs: number;
	maxMs: number;
	lastMs: number;
}

export interface RenderJobRecord {
	renderJobId: string;
	compositionId: string;
	idempotencyKey: string;
	status: RenderJobStatus;
	stage: RenderStage;
	message?: string;
	error?: string;
	outputKey: string;
	targetChunkCount?: number;
	request: CreateRenderJobRequest;
	composition?: RuntimeCompositionMetadata;
	chunkPlan?: RuntimeChunkAssignment[];
	completedChunks: number;
	chunkCount?: number;
	totalFrames?: number;
	renderedFrames: number;
	progress: number;
	combineAttempts?: number;
	combineResult?: RuntimeCombineResult;
	workerPool: ContainerWorkerLease[];
	activeWorkers: number;
	metrics: RenderJobMetrics;
	metricSamples: {
		browserReadyMs?: RuntimeMetricSampleAccumulator;
		workerStartupMs?: RuntimeMetricSampleAccumulator;
		chunkRenderMs?: RuntimeMetricSampleAccumulator;
		chunkUploadMs?: RuntimeMetricSampleAccumulator;
		chunkEndToEndMs?: RuntimeMetricSampleAccumulator;
	};
	createdAt: string;
	updatedAt: string;
}

export interface PlanRenderRequest {
	renderJobId: string;
	compositionId: string;
	inputProps: JsonObject;
	outputKey: string;
	targetChunkCount?: number;
	idempotencyKey: string;
}

export interface PlanRenderResponse {
	composition: RuntimeCompositionMetadata;
	chunks: RuntimeChunkAssignment[];
	framesPerChunk: number;
	selectCompositionDurationMs: number;
	browserReadyMs?: number;
}

export interface InternalChunkRenderRequest extends ChunkRenderPayload {}

export interface InternalCombineChunksRequest extends RuntimeCombineInput {}
