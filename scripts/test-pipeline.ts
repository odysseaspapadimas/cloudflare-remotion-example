import process from "node:process";

const DEFAULT_BASE_URL = "http://127.0.0.1:8787";
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_POLL_INTERVAL_MS = 2_000;

type JobStatusResponse = {
	renderJobId: string;
	status: string;
	progress: number;
	chunkCount?: number;
	completedChunks?: number;
	outputKey?: string;
	error?: string;
	message?: string;
	metrics?: Record<string, unknown>;
};

const parseArg = (flag: string) => {
	const index = process.argv.indexOf(flag);
	if (index === -1) {
		return undefined;
	}

	return process.argv[index + 1];
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const baseUrl = parseArg("--base-url") ?? DEFAULT_BASE_URL;
const targetChunkCount = parseArg("--chunks");
const timeoutMs = Number.parseInt(parseArg("--timeout-ms") ?? `${DEFAULT_TIMEOUT_MS}`, 10);
const pollIntervalMs = Number.parseInt(
	parseArg("--poll-interval-ms") ?? `${DEFAULT_POLL_INTERVAL_MS}`,
	10,
);
const uniqueSuffix = Date.now().toString();
const idempotencyKey = parseArg("--idempotency-key") ?? `job:hello-world:${uniqueSuffix}`;
const outputKey = parseArg("--output-key") ?? `renders/${idempotencyKey}/output.mp4`;

const createPayload = {
	inputProps: {
		title: "Hello from Cloudflare",
		subtitle: "Distributed Remotion render",
		backgroundColor: "#0f172a",
		accentColor: "#38bdf8",
		durationInFrames: 480,
	},
	outputKey,
	idempotencyKey,
	...(targetChunkCount
		? { targetChunkCount: Number.parseInt(targetChunkCount, 10) }
		: {}),
};

const createJob = async () => {
	const response = await fetch(`${baseUrl}/jobs`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
		},
		body: JSON.stringify(createPayload),
	});

	if (!response.ok) {
		throw new Error(`Create job failed: ${response.status} ${await response.text()}`);
	}

	return (await response.json()) as { renderJobId: string; status: string };
};

const getJob = async (renderJobId: string) => {
	const response = await fetch(`${baseUrl}/jobs/${encodeURIComponent(renderJobId)}`);
	if (!response.ok) {
		throw new Error(`Get job failed: ${response.status} ${await response.text()}`);
	}

	return (await response.json()) as JobStatusResponse;
};

const main = async () => {
	console.log("Submitting render job", { baseUrl, outputKey, targetChunkCount });
	const created = await createJob();
	console.log("Render job created", created);

	const startedAt = Date.now();
	while (Date.now() - startedAt < timeoutMs) {
		const job = await getJob(created.renderJobId);
		console.log(
			`Status=${job.status} progress=${job.progress}% chunks=${job.completedChunks ?? 0}/${job.chunkCount ?? 0}`,
		);

		if (job.status === "completed") {
			console.log("Render completed", {
				renderJobId: job.renderJobId,
				outputKey: job.outputKey,
				metrics: job.metrics,
			});
			return;
		}

		if (job.status === "failed") {
			throw new Error(job.error ?? "Render job failed");
		}

		await sleep(pollIntervalMs);
	}

	throw new Error(`Timed out after ${timeoutMs}ms waiting for render completion`);
};

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
