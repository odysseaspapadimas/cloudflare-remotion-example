import express from "express";
import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import type { VideoConfig } from "remotion/no-react";
import { z } from "zod";
import { ensureBrowser, openBrowser, type ChromiumOptions } from "@remotion/renderer";
import {
	DEFAULT_MIN_FRAMES_PER_CHUNK,
	DEFAULT_RENDER_TARGET_CHUNK_COUNT,
	DEFAULT_RENDER_TARGET_CHUNK_COUNT_MAX,
	frameRangesFromTotalFrames,
	resolveChunkCount,
	validateChunkCoverage,
} from "./chunking.ts";
import {
	createTransportResolver,
} from "./transport.ts";
import type {
	InternalChunkRenderRequest,
	InternalCombineChunksRequest,
	JsonObject,
	PlanRenderRequest,
	PlanRenderResponse,
	RuntimeChunkAssignment,
	RuntimeCompositionMetadata,
} from "./types.ts";

const bundlePath = path.join(process.cwd(), "build");
const port = Number.parseInt(process.env.PORT ?? "8080", 10);
const localWorkerOrigin = process.env.LOCAL_WORKER_ORIGIN;
const transport = createTransportResolver(localWorkerOrigin);
const artifactPrefixFor = (renderJobId: string) => `renders/${renderJobId}/chunks/`;
const VIDEO_CODEC = "h264";
const CHUNK_VIDEO_CODEC = "h264-ts";
const AUDIO_CODEC = "aac";
const MULTIPART_THRESHOLD_BYTES = 5 * 1024 * 1024;
const MULTIPART_PART_SIZE = 8 * 1024 * 1024;
const PROGRESS_REPORT_MIN_INTERVAL_MS = 1200;
const PROGRESS_REPORT_MIN_DELTA = 4;
const PROGRESS_ERROR_LOG_INTERVAL_MS = 15000;
const DEFAULT_COMPOSITION_ID = "HelloWorld";
const DEFAULT_RENDER_CONCURRENCY = Math.max(
	1,
	Number.parseInt(process.env.RENDER_MEDIA_CONCURRENCY ?? "3", 10),
);
const chromiumOptions: ChromiumOptions = {
	enableMultiProcessOnLinux: true,
	gl: null,
};

type ChunkProgressStatus = "queued" | "rendering" | "completed" | "failed";

type ProgressDispatchState = {
	lastSentProgress: number;
	lastSentAt: number;
	lastStatus: ChunkProgressStatus | null;
	pending: Promise<void>;
	lastLoggedErrorAt?: number;
};

const progressDispatchState = new Map<string, ProgressDispatchState>();
let rendererModulePromise: Promise<typeof import("@remotion/renderer")> | null = null;
let browserPromise: Promise<Awaited<ReturnType<typeof openBrowser>>> | null = null;

const loadRendererRuntime = () => {
	if (!rendererModulePromise) {
		rendererModulePromise = import("@remotion/renderer");
	}

	return rendererModulePromise;
};

const getBrowser = async () => {
	if (!browserPromise) {
		browserPromise = (async () => {
			await ensureBrowser();
			return openBrowser("chrome", {
				chromiumOptions,
				logLevel: "info",
			});
		})().catch((error) => {
			browserPromise = null;
			throw error;
		});
	}

	return browserPromise;
};

const closeBrowser = async () => {
	if (!browserPromise) {
		return;
	}

	const browser = await browserPromise.catch(() => null);
	browserPromise = null;
	await browser?.close({ silent: true }).catch(() => undefined);
};

const warmRuntime = () => {
	void loadRendererRuntime().catch((error) => {
		console.error("Background Remotion runtime warmup failed:", error);
	});
	void getBrowser()
		.catch((error) => {
			console.error("Background browser warmup failed:", error);
		});
};

const planRenderSchema = z.object({
	renderJobId: z.string(),
	compositionId: z.string().min(1).default(DEFAULT_COMPOSITION_ID),
	inputProps: z.custom<JsonObject>(),
	outputKey: z.string().min(1),
	targetChunkCount: z.number().int().positive().optional(),
	idempotencyKey: z.string().min(1),
});

const chunkRangeSchema = z.object({
	from: z.number().int().nonnegative(),
	to: z.number().int().nonnegative(),
});

const runtimeChunkSchema = z.object({
	chunkIndex: z.number().int().nonnegative(),
	frameRange: chunkRangeSchema,
	frameCount: z.number().int().positive(),
	videoFileKey: z.string(),
	audioFileKey: z.string(),
	containerId: z.string(),
	status: z.enum(["queued", "rendering", "completed", "failed"]),
	retryCount: z.number().int().nonnegative(),
	renderedFrames: z.number().int().nonnegative(),
	progress: z.number().min(0).max(100),
	artifactDir: z.string(),
});

const compositionSchema = z.object({
	id: z.string(),
	width: z.number().int().positive(),
	height: z.number().int().positive(),
	fps: z.number().positive(),
	durationInFrames: z.number().int().positive(),
	defaultCodec: z.literal("h264"),
	defaultAudioCodec: z.union([z.literal("aac"), z.literal("pcm-16"), z.null()]),
	framesPerChunk: z.number().int().positive(),
	effectiveChunkCount: z.number().int().positive(),
	minFramesPerChunk: z.number().int().positive(),
});

const chunkRenderSchema = z.object({
	renderJobId: z.string(),
	compositionId: z.string().min(1).default(DEFAULT_COMPOSITION_ID),
	chunk: runtimeChunkSchema,
	composition: compositionSchema,
	compositionStart: z.number().int().nonnegative(),
	inputProps: z.custom<JsonObject>(),
});

const combineChunkSchema = z.object({
	chunkIndex: z.number().int().nonnegative(),
	videoFileKey: z.string(),
	audioFileKey: z.string(),
	frameRange: chunkRangeSchema,
});

const combineSchema = z.object({
	renderJobId: z.string(),
	outputKey: z.string(),
	composition: compositionSchema,
	framesPerChunk: z.number().int().positive(),
	chunks: z.array(combineChunkSchema).min(1),
	artifactDir: z.string(),
});

const app = express();
app.use(express.json({ limit: "10mb" }));

const parseIntegerEnv = (value: string | undefined, fallback: number) => {
	if (!value) {
		return fallback;
	}

	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) ? parsed : fallback;
};
const normalizeInputProps = (inputProps: JsonObject): JsonObject => {
	const normalized = { ...inputProps };
	if (typeof normalized.backgroundColor !== "string") {
		normalized.backgroundColor = "#0f172a";
	}
	if (typeof normalized.accentColor !== "string") {
		normalized.accentColor = "#38bdf8";
	}
	if (typeof normalized.textColor !== "string") {
		normalized.textColor = "#e2e8f0";
	}
	if (
		typeof normalized.durationInFrames !== "number" ||
		!Number.isFinite(normalized.durationInFrames) ||
		normalized.durationInFrames <= 0
	) {
		normalized.durationInFrames = 480;
	}

	for (const [key, value] of Object.entries(normalized)) {
		if (typeof value === "string") {
			if (value.startsWith("http://") || value.startsWith("https://")) {
				normalized[key] = `http://assets.internal/proxy?url=${encodeURIComponent(value)}`;
			}
		}
	}

	return normalized;
};

const ensureDirectory = async (directoryPath: string) => {
	await fs.mkdir(directoryPath, { recursive: true });
};

const describeFetchFailure = (error: unknown): string => {
	if (!(error instanceof Error)) {
		return String(error);
	}

	const details = [error.message];
	const cause = (error as Error & { cause?: unknown }).cause;
	if (cause instanceof Error) {
		details.push(cause.message);
	} else if (cause !== undefined) {
		details.push(String(cause));
	}

	return details.join(" | ");
};

const fetchInternal = async (
	url: string,
	init: RequestInit,
	label: string,
): Promise<Response> => {
	let lastError: unknown;
	try {
		return await fetch(url, init);
	} catch (error) {
		lastError = error;
	}

	throw new Error(
		`Failed to reach ${label}: ${describeFetchFailure(lastError)}`,
		lastError instanceof Error ? { cause: lastError } : undefined,
	);
};

const toArrayBuffer = (value: Uint8Array): ArrayBuffer => {
	const cloned = new Uint8Array(value.byteLength);
	cloned.set(value);
	return cloned.buffer;
};

const startMultipartUpload = async (key: string, contentType: string) => {
		const response = await fetchInternal(
			`${transport.toR2Url(key)}?action=mpu-create`,
			{
				method: "POST",
			headers: {
				"Content-Type": contentType,
		},
		},
		`R2 multipart create for ${key}`,
	);

	if (!response.ok) {
		const responseText = await response.text().catch(() => "");
		throw new Error(
			`Failed to start multipart upload ${key}: ${response.status} ${response.statusText}${responseText ? ` - ${responseText}` : ""}`,
		);
	}

	return (await response.json()) as { uploadId: string };
};

const abortMultipartUpload = async (key: string, uploadId: string) => {
	await fetchInternal(
		`${transport.toR2Url(key)}?action=mpu-abort&uploadId=${encodeURIComponent(uploadId)}`,
		{ method: "DELETE" },
		`R2 multipart abort for ${key}`,
	).catch(() => undefined);
};

const uploadMultipartParts = async ({
	key,
	uploadId,
	contentType,
	parts,
}: {
	key: string;
	uploadId: string;
	contentType: string;
	parts: Uint8Array[];
}) => {
	const uploadedParts: Array<{ partNumber: number; etag: string }> = [];

	for (const [index, part] of parts.entries()) {
		const partNumber = index + 1;
		const response = await fetchInternal(
			`${transport.toR2Url(key)}?action=mpu-uploadpart&uploadId=${encodeURIComponent(uploadId)}&partNumber=${partNumber}`,
			{
				method: "PUT",
				headers: {
					"Content-Type": contentType,
					"Content-Length": part.byteLength.toString(),
				},
				body: toArrayBuffer(part),
			},
			`R2 multipart part ${partNumber} for ${key}`,
		);

		if (!response.ok) {
			const responseText = await response.text().catch(() => "");
			throw new Error(
				`Failed to upload multipart part for ${key}: ${response.status} ${response.statusText}${responseText ? ` - ${responseText}` : ""}`,
			);
		}

		uploadedParts.push((await response.json()) as { partNumber: number; etag: string });
	}

	const completeResponse = await fetchInternal(
		`${transport.toR2Url(key)}?action=mpu-complete&uploadId=${encodeURIComponent(uploadId)}`,
		{
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ parts: uploadedParts }),
		},
		`R2 multipart complete for ${key}`,
	);

	if (!completeResponse.ok) {
		const responseText = await completeResponse.text().catch(() => "");
		throw new Error(
			`Failed to complete multipart upload ${key}: ${completeResponse.status} ${completeResponse.statusText}${responseText ? ` - ${responseText}` : ""}`,
		);
	}
};

const putObject = async (
	key: string,
	body: ArrayBuffer | Uint8Array,
	contentType: string,
): Promise<void> => {
	const requestBody = body instanceof Uint8Array ? body : new Uint8Array(body);

	if (requestBody.byteLength < MULTIPART_THRESHOLD_BYTES) {
		const response = await fetchInternal(
			transport.toR2Url(key),
			{
				method: "PUT",
				headers: {
					"Content-Type": contentType,
				"Content-Length": requestBody.byteLength.toString(),
			},
			body: toArrayBuffer(requestBody),
			},
			`R2 upload for ${key}`,
		);

		if (!response.ok) {
			const responseText = await response.text().catch(() => "");
			throw new Error(
				`Failed to upload ${key}: ${response.status} ${response.statusText}${responseText ? ` - ${responseText}` : ""}`,
			);
		}

		return;
	}

	const { uploadId } = await startMultipartUpload(key, contentType);
	const parts: Uint8Array[] = [];
	for (let offset = 0; offset < requestBody.byteLength; offset += MULTIPART_PART_SIZE) {
		parts.push(
			requestBody.subarray(
				offset,
				Math.min(offset + MULTIPART_PART_SIZE, requestBody.byteLength),
			),
		);
	}

	try {
		await uploadMultipartParts({ key, uploadId, contentType, parts });
	} catch (error) {
		await abortMultipartUpload(key, uploadId);
		throw error;
	}
};

const putObjectFromFile = async ({
	key,
	filePath,
	contentType,
}: {
	key: string;
	filePath: string;
	contentType: string;
}): Promise<void> => {
	const stat = await fs.stat(filePath);
	if (stat.size < MULTIPART_THRESHOLD_BYTES) {
		await putObject(key, await fs.readFile(filePath), contentType);
		return;
	}

	const fileHandle = await fs.open(filePath, "r");
	const { uploadId } = await startMultipartUpload(key, contentType);
	const parts: Uint8Array[] = [];

	try {
		let offset = 0;
		while (offset < stat.size) {
			const length = Math.min(MULTIPART_PART_SIZE, stat.size - offset);
			const buffer = Buffer.allocUnsafe(length);
			const { bytesRead } = await fileHandle.read(buffer, 0, length, offset);
			parts.push(buffer.subarray(0, bytesRead));
			offset += bytesRead;
		}

		await uploadMultipartParts({ key, uploadId, contentType, parts });
	} catch (error) {
		await abortMultipartUpload(key, uploadId);
		throw error;
	} finally {
		await fileHandle.close().catch(() => undefined);
	}
};

const downloadObjectToFile = async ({
	key,
	filePath,
}: {
	key: string;
	filePath: string;
}) => {
	const response = await fetchInternal(
		transport.toR2Url(key),
		{},
		`R2 download for ${key}`,
	);
	if (!response.ok || !response.body) {
		const responseText = await response.text().catch(() => "");
		throw new Error(`Failed to fetch ${key}: ${responseText}`);
	}

	await pipeline(
		Readable.fromWeb(response.body as unknown as NodeReadableStream<Uint8Array>),
		createWriteStream(filePath),
	);
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const progressStateKey = (renderJobId: string, chunkIndex: number) => `${renderJobId}:${chunkIndex}`;

const shouldForceProgressDispatch = (status: ChunkProgressStatus) =>
	status === "completed" || status === "failed";

const postChunkProgress = async ({
	renderJobId,
	chunkIndex,
	status,
	progress,
	renderedFrames,
	totalFrames,
	containerId,
	error,
}: {
	renderJobId: string;
	chunkIndex: number;
	status: ChunkProgressStatus;
	progress: number;
	renderedFrames: number;
	totalFrames: number;
	containerId: string;
	error?: string;
}): Promise<void> => {
	const key = progressStateKey(renderJobId, chunkIndex);
	const now = Date.now();
	const currentState = progressDispatchState.get(key) ?? {
		lastSentProgress: -1,
		lastSentAt: 0,
		lastStatus: null,
		pending: Promise.resolve(),
	};
	const forced = shouldForceProgressDispatch(status) || currentState.lastStatus !== status;
	if (
		!forced &&
		progress < currentState.lastSentProgress + PROGRESS_REPORT_MIN_DELTA &&
		now - currentState.lastSentAt < PROGRESS_REPORT_MIN_INTERVAL_MS
	) {
		return;
	}

	const payload = {
		renderJobId,
		chunkIndex,
		status,
		progress,
		renderedFrames,
		totalFrames,
		containerId,
		error,
	};

	const nextState: ProgressDispatchState = {
		...currentState,
		pending: currentState.pending
			.catch(() => undefined)
			.then(async () => {
				for (let attempt = 0; attempt < 3; attempt += 1) {
					try {
						const response = await fetchInternal(
							transport.toCoordinatorProgressUrl(renderJobId, chunkIndex),
							{
								method: "POST",
								headers: {
									"Content-Type": "application/json",
								},
								body: JSON.stringify(payload),
							},
							`coordinator progress for ${renderJobId} chunk ${chunkIndex}`,
						);

						if (!response.ok) {
							const responseText = await response.text().catch(() => "");
							throw new Error(`Coordinator returned ${response.status}: ${responseText}`);
						}

						nextState.lastSentProgress = progress;
						nextState.lastSentAt = Date.now();
						nextState.lastStatus = status;
						return;
					} catch (fetchError) {
						if (attempt < 2) {
							await sleep(150 * (attempt + 1));
							continue;
						}

						const logNow = Date.now();
						if (
							forced ||
							nextState.lastLoggedErrorAt === undefined ||
							logNow - nextState.lastLoggedErrorAt >= PROGRESS_ERROR_LOG_INTERVAL_MS
						) {
							nextState.lastLoggedErrorAt = logNow;
							console.warn("Chunk progress transport unavailable", {
								url: transport.toCoordinatorProgressUrl(renderJobId, chunkIndex),
								payload,
								error: fetchError,
							});
						}
					}
				}
			})
			.finally(() => {
				if (shouldForceProgressDispatch(status)) {
					progressDispatchState.delete(key);
					return;
				}

				progressDispatchState.set(key, nextState);
			}),
	};

	progressDispatchState.set(key, nextState);
	return nextState.pending;
};

const toRendererInputProps = (inputProps: JsonObject): Record<string, unknown> => ({
	...normalizeInputProps(inputProps),
});

const selectMetadata = async (request: PlanRenderRequest) => {
	const { selectComposition } = await loadRendererRuntime();
	const browserReadyStarted = Date.now();
	const browser = await getBrowser();
	const browserReadyMs = Date.now() - browserReadyStarted;
	const selectStarted = Date.now();
	const composition = (await selectComposition({
		serveUrl: bundlePath,
		id: request.compositionId,
		inputProps: toRendererInputProps(request.inputProps),
		timeoutInMilliseconds: 60000,
		logLevel: "info",
		puppeteerInstance: browser,
		chromiumOptions,
	})) as VideoConfig;

	const defaultCodec = composition.defaultCodec ?? VIDEO_CODEC;
	if (defaultCodec !== VIDEO_CODEC) {
		throw new Error(`Unexpected composition codec ${defaultCodec}`);
	}

	const totalFrames = composition.durationInFrames;
	const maxChunkCount = parseIntegerEnv(
		process.env.RENDER_TARGET_CHUNK_COUNT_MAX,
		DEFAULT_RENDER_TARGET_CHUNK_COUNT_MAX,
	);
	const defaultChunkCount = parseIntegerEnv(
		process.env.RENDER_TARGET_CHUNK_COUNT_DEFAULT,
		DEFAULT_RENDER_TARGET_CHUNK_COUNT,
	);
	const minFramesPerChunk = parseIntegerEnv(
		process.env.RENDER_MIN_FRAMES_PER_CHUNK,
		DEFAULT_MIN_FRAMES_PER_CHUNK,
	);
	const effectiveChunkCount = resolveChunkCount({
		targetChunkCount: request.targetChunkCount,
		defaultChunkCount,
		maxChunkCount,
		totalFrames,
		minFramesPerChunk,
	});

	return {
		composition: {
			id: composition.id,
			width: composition.width,
			height: composition.height,
			fps: composition.fps,
			durationInFrames: totalFrames,
			defaultCodec: VIDEO_CODEC,
			defaultAudioCodec: AUDIO_CODEC,
			framesPerChunk: Math.ceil(totalFrames / effectiveChunkCount),
			effectiveChunkCount,
			minFramesPerChunk,
		} satisfies RuntimeCompositionMetadata,
		selectCompositionDurationMs: Date.now() - selectStarted,
		browserReadyMs,
	};
};

const createChunkAssignments = (
	request: PlanRenderRequest,
	composition: RuntimeCompositionMetadata,
): RuntimeChunkAssignment[] => {
	const ranges = frameRangesFromTotalFrames(
		composition.durationInFrames,
		composition.effectiveChunkCount,
	);
	validateChunkCoverage(composition.durationInFrames, ranges);

	const artifactDir = `/tmp/${request.renderJobId}`;
	const artifactPrefix = artifactPrefixFor(request.renderJobId);
	return ranges.map((range, chunkIndex) => ({
		chunkIndex,
		frameRange: range,
		frameCount: range.to - range.from + 1,
		videoFileKey: `${artifactPrefix}${chunkIndex}.ts`,
		audioFileKey: `${artifactPrefix}${chunkIndex}.aac`,
		containerId: `render:${request.renderJobId}:chunk:${chunkIndex}`,
		status: "queued",
		retryCount: 0,
		renderedFrames: 0,
		progress: 0,
		artifactDir,
	}));
};

const renderChunkArtifacts = async ({
	payload,
	outputDirectory,
}: {
	payload: InternalChunkRenderRequest;
	outputDirectory: string;
}) => {
	const { renderMedia } = await loadRendererRuntime();
	const videoOutputLocation = path.join(
		outputDirectory,
		`chunk-${payload.chunk.chunkIndex}.ts`,
	);
	const audioOutputLocation = path.join(
		outputDirectory,
		`chunk-${payload.chunk.chunkIndex}.aac`,
	);
	const browserReadyStarted = Date.now();
	const browser = await getBrowser();
	const browserReadyMs = Date.now() - browserReadyStarted;
	const renderStarted = Date.now();
	let lastProgress = -1;

	await renderMedia({
		composition: {
			id: payload.composition.id,
			width: payload.composition.width,
			height: payload.composition.height,
			fps: payload.composition.fps,
			durationInFrames: payload.composition.durationInFrames,
			defaultProps: {},
			props: toRendererInputProps(payload.inputProps),
			defaultCodec: payload.composition.defaultCodec,
			defaultOutName: null,
			defaultPixelFormat: null,
			defaultProResProfile: null,
			defaultVideoImageFormat: null,
		},
		inputProps: toRendererInputProps(payload.inputProps),
		codec: CHUNK_VIDEO_CODEC,
		audioCodec: AUDIO_CODEC,
		outputLocation: videoOutputLocation,
		separateAudioTo: audioOutputLocation,
		serveUrl: bundlePath,
		frameRange: [payload.chunk.frameRange.from, payload.chunk.frameRange.to],
		compositionStart: payload.compositionStart,
		enforceAudioTrack: true,
		forSeamlessAacConcatenation: true,
		timeoutInMilliseconds: 300000,
		concurrency: DEFAULT_RENDER_CONCURRENCY,
		logLevel: "info",
		puppeteerInstance: browser,
		chromiumOptions,
		onProgress: ({ progress, renderedFrames }) => {
			const nextProgress = Math.max(1, Math.min(99, Math.round(progress * 100)));
			if (nextProgress <= lastProgress) {
				return;
			}

			lastProgress = nextProgress;
			void postChunkProgress({
				renderJobId: payload.renderJobId,
				chunkIndex: payload.chunk.chunkIndex,
				status: "rendering",
				progress: nextProgress,
				renderedFrames: Math.min(renderedFrames, payload.chunk.frameCount),
				totalFrames: payload.chunk.frameCount,
				containerId: payload.chunk.containerId,
			});
		},
	});

	return {
		videoOutputLocation,
		audioOutputLocation,
		renderDurationMs: Date.now() - renderStarted,
		browserReadyMs,
	};
};

app.get("/health", (_req, res) => {
	res.json({
		status: "ok",
		timestamp: new Date().toISOString(),
		bundlePath,
	});
});

app.post("/internal/plan-render", async (req, res) => {
	try {
		const request = planRenderSchema.parse(req.body) satisfies PlanRenderRequest;
		const { composition, selectCompositionDurationMs, browserReadyMs } = await selectMetadata(request);
		const chunks = createChunkAssignments(request, composition);
		const response: PlanRenderResponse = {
			composition,
			chunks,
			framesPerChunk: composition.framesPerChunk,
			selectCompositionDurationMs,
			browserReadyMs,
		};
		res.json(response);
	} catch (error) {
		console.error("Plan render failed", error);
		res.status(400).json({
			error: error instanceof Error ? error.message : String(error),
			stack: error instanceof Error ? error.stack : undefined,
		});
	}
});

app.post("/internal/render-chunk", async (req, res) => {
	try {
		const payload = chunkRenderSchema.parse(req.body) satisfies InternalChunkRenderRequest;
		const outputDirectory = path.join(payload.chunk.artifactDir, `${payload.chunk.chunkIndex}`);
		await ensureDirectory(outputDirectory);
		await postChunkProgress({
			renderJobId: payload.renderJobId,
			chunkIndex: payload.chunk.chunkIndex,
			status: "rendering",
			progress: 1,
			renderedFrames: 0,
			totalFrames: payload.chunk.frameCount,
			containerId: payload.chunk.containerId,
		});

		const startTime = Date.now();
		const { videoOutputLocation, audioOutputLocation, renderDurationMs, browserReadyMs } =
			await renderChunkArtifacts({
				payload,
				outputDirectory,
			});

		const uploadStarted = Date.now();
		await putObjectFromFile({
			key: payload.chunk.videoFileKey,
			filePath: videoOutputLocation,
			contentType: "video/mp2t",
		});
		await putObjectFromFile({
			key: payload.chunk.audioFileKey,
			filePath: audioOutputLocation,
			contentType: "audio/aac",
		});
		const uploadDurationMs = Date.now() - uploadStarted;

		await Promise.all([
			fs.unlink(videoOutputLocation).catch(() => undefined),
			fs.unlink(audioOutputLocation).catch(() => undefined),
		]);

		await postChunkProgress({
			renderJobId: payload.renderJobId,
			chunkIndex: payload.chunk.chunkIndex,
			status: "completed",
			progress: 100,
			renderedFrames: payload.chunk.frameCount,
			totalFrames: payload.chunk.frameCount,
			containerId: payload.chunk.containerId,
		});

		res.json({
			renderJobId: payload.renderJobId,
			chunkIndex: payload.chunk.chunkIndex,
			containerId: payload.chunk.containerId,
			videoFileKey: payload.chunk.videoFileKey,
			audioFileKey: payload.chunk.audioFileKey,
			renderedFrames: payload.chunk.frameCount,
			totalFrames: payload.chunk.frameCount,
			durationMs: Date.now() - startTime,
			renderDurationMs,
			uploadDurationMs,
			browserReadyMs,
		});
	} catch (error) {
		console.error("Chunk render failed", error);
		res.status(400).json({
			error: error instanceof Error ? error.message : String(error),
			stack: error instanceof Error ? error.stack : undefined,
		});
	}
});

app.post("/internal/combine-chunks", async (req, res) => {
	try {
		const payload = combineSchema.parse(req.body) satisfies InternalCombineChunksRequest;
		const [{ combineChunks }] = await Promise.all([loadRendererRuntime()]);
		await ensureDirectory(payload.artifactDir);
		const orderedChunks = [...payload.chunks].sort((a, b) => a.chunkIndex - b.chunkIndex);
		const outputLocation = path.join(payload.artifactDir, "combined.mp4");

		const downloadStarted = Date.now();
		await Promise.all(
			orderedChunks.map(async (chunk) => {
				const chunkDir = path.join(payload.artifactDir, `${chunk.chunkIndex}`);
				await ensureDirectory(chunkDir);
				await Promise.all([
					downloadObjectToFile({
						key: chunk.videoFileKey,
						filePath: path.join(chunkDir, `chunk-${chunk.chunkIndex}.ts`),
					}),
					downloadObjectToFile({
						key: chunk.audioFileKey,
						filePath: path.join(chunkDir, `chunk-${chunk.chunkIndex}.aac`),
					}),
				]);
			}),
		);
		const combineDownloadMs = Date.now() - downloadStarted;

		const combineStarted = Date.now();
		await combineChunks({
			outputLocation,
			videoFiles: orderedChunks.map((chunk) =>
				path.join(payload.artifactDir, `${chunk.chunkIndex}`, `chunk-${chunk.chunkIndex}.ts`),
			),
			audioFiles: orderedChunks.map((chunk) =>
				path.join(payload.artifactDir, `${chunk.chunkIndex}`, `chunk-${chunk.chunkIndex}.aac`),
			),
			codec: VIDEO_CODEC,
			audioCodec: AUDIO_CODEC,
			fps: payload.composition.fps,
			framesPerChunk: payload.framesPerChunk,
			preferLossless: false,
			compositionDurationInFrames: payload.composition.durationInFrames,
			frameRange: [0, payload.composition.durationInFrames - 1],
			logLevel: "info",
		});
		const combineRenderMs = Date.now() - combineStarted;

		const stat = await fs.stat(outputLocation);
		const uploadStarted = Date.now();
		await putObjectFromFile({
			key: payload.outputKey,
			filePath: outputLocation,
			contentType: "video/mp4",
		});
		const finalUploadMs = Date.now() - uploadStarted;

		await fs.rm(payload.artifactDir, { recursive: true, force: true }).catch(() => undefined);

		res.json({
			renderJobId: payload.renderJobId,
			outputKey: payload.outputKey,
			fileSize: stat.size,
			durationMs: combineDownloadMs + combineRenderMs + finalUploadMs,
			combineDownloadMs,
			combineRenderMs,
			finalUploadMs,
		});
	} catch (error) {
		console.error("Combine chunks failed", error);
		res.status(400).json({
			error: error instanceof Error ? error.message : String(error),
			stack: error instanceof Error ? error.stack : undefined,
		});
	}
});

const shutdown = async (signal: string) => {
	console.log(`Received ${signal}, closing renderer browser`);
	await closeBrowser().catch(() => undefined);
	process.exit(0);
};

process.once("SIGINT", () => {
	void shutdown("SIGINT");
});

process.once("SIGTERM", () => {
	void shutdown("SIGTERM");
});

app.listen(port, () => {
	console.log(`Distributed renderer runtime listening on ${port}`);
	warmRuntime();
});
