import type { RenderFrameRange } from "./types.ts";

export const DEFAULT_RENDER_TARGET_CHUNK_COUNT = 4;
export const DEFAULT_RENDER_TARGET_CHUNK_COUNT_MAX = 64;
export const DEFAULT_MIN_FRAMES_PER_CHUNK = 120;
export const DEFAULT_RENDER_WORKER_POOL_SIZE_MAX = 2;

export const clampRequestedChunkCount = (
	targetChunkCount: number | undefined,
	maxChunkCount: number,
): number | undefined => {
	if (targetChunkCount === undefined) {
		return undefined;
	}

	if (!Number.isFinite(targetChunkCount)) {
		return undefined;
	}

	return Math.max(1, Math.min(maxChunkCount, Math.floor(targetChunkCount)));
};

export const resolveChunkCount = ({
	targetChunkCount,
	defaultChunkCount,
	maxChunkCount,
	totalFrames,
	minFramesPerChunk,
}: {
	targetChunkCount?: number;
	defaultChunkCount: number;
	maxChunkCount: number;
	totalFrames: number;
	minFramesPerChunk: number;
}): number => {
	const requested = clampRequestedChunkCount(
		targetChunkCount ?? defaultChunkCount,
		maxChunkCount,
	);
	const baseChunkCount = requested ?? 1;
	const byFrameBudget = Math.max(
		1,
		Math.floor(totalFrames / minFramesPerChunk),
	);
	return Math.max(1, Math.min(baseChunkCount, byFrameBudget || 1, totalFrames));
};

export const frameRangesFromTotalFrames = (
	totalFrames: number,
	chunkCount: number,
): RenderFrameRange[] => {
	if (totalFrames <= 0) {
		throw new Error("totalFrames must be positive");
	}

	if (chunkCount <= 0) {
		throw new Error("chunkCount must be positive");
	}

	const framesPerChunk = Math.ceil(totalFrames / chunkCount);
	const ranges: RenderFrameRange[] = [];
	for (let from = 0; from < totalFrames; from += framesPerChunk) {
		const to = Math.min(totalFrames - 1, from + framesPerChunk - 1);
		ranges.push({ from, to });
	}

	return ranges;
};

export const resolveWorkerPoolSize = ({
	chunkCount,
	maxPoolSize,
}: {
	chunkCount: number;
	maxPoolSize: number;
}): number => {
	if (chunkCount <= 0) {
		throw new Error("chunkCount must be positive");
	}

	return Math.max(1, Math.min(chunkCount, maxPoolSize));
};

export const validateChunkCoverage = (
	totalFrames: number,
	ranges: RenderFrameRange[],
): void => {
	if (ranges.length === 0) {
		throw new Error("Expected at least one chunk range");
	}

	let expectedFrame = 0;
	for (const range of ranges) {
		if (range.from !== expectedFrame) {
			throw new Error(`Chunk coverage gap at frame ${expectedFrame}`);
		}

		if (range.to < range.from) {
			throw new Error(`Invalid chunk range ${range.from}-${range.to}`);
		}

		expectedFrame = range.to + 1;
	}

	if (expectedFrame !== totalFrames) {
		throw new Error(
			`Chunk coverage ended at frame ${expectedFrame - 1}, expected ${totalFrames - 1}`,
		);
	}
};
