import {
	Container,
	ContainerProxy,
	type OutboundHandlerContext,
	outboundParams,
} from "@cloudflare/containers";
import { z } from "zod";
import {
	DEFAULT_RENDER_TARGET_CHUNK_COUNT,
	DEFAULT_RENDER_TARGET_CHUNK_COUNT_MAX,
} from "./chunking.ts";
import { getCoordinatorStub, type RenderCoordinator } from "./RenderCoordinator.ts";
import {
	deriveLocalWorkerOrigin,
	isLocalR2ObjectPath,
	matchLocalCoordinatorProgressPath,
	stripLocalR2Prefix,
} from "./transport.ts";
import type { CreateRenderJobRequest, JsonObject } from "./types.ts";

export { RenderCoordinator } from "./RenderCoordinator.ts";
export { ContainerProxy };

type WorkerEnv = Env & {
	RENDER_COORDINATOR: DurableObjectNamespace<RenderCoordinator>;
};

type PublicCreateRenderJobRequest = Omit<CreateRenderJobRequest, "compositionId"> & {
	compositionId?: string;
};

const DEFAULT_COMPOSITION_ID = "HelloWorld";
const OUTBOUND_HOSTS = {
	assets: "assets.internal",
	coordinator: "coordinator.internal",
	r2: "r2.internal",
} as const;

const createRenderJobSchema = z.object({
	compositionId: z.string().min(1).optional(),
	inputProps: z.custom<JsonObject>(),
	outputKey: z.string().min(1),
	targetChunkCount: z.number().int().positive().optional(),
	idempotencyKey: z.string().min(1),
});

const parseIntegerVar = (
	value: string | number | undefined,
	fallback: number,
): number => {
	if (!value) {
		return fallback;
	}

	const parsed = typeof value === "number" ? value : Number.parseInt(value, 10);
	return Number.isFinite(parsed) ? parsed : fallback;
};
const normalizeCreateRequest = (
	env: WorkerEnv,
	request: PublicCreateRenderJobRequest,
): CreateRenderJobRequest => {
	const envWithVars = env as WorkerEnv & {
		RENDER_TARGET_CHUNK_COUNT_DEFAULT?: string | number;
		RENDER_TARGET_CHUNK_COUNT_MAX?: string | number;
	};
	const defaultChunkCount = parseIntegerVar(
		envWithVars.RENDER_TARGET_CHUNK_COUNT_DEFAULT,
		DEFAULT_RENDER_TARGET_CHUNK_COUNT,
	);
	const maxChunkCount = parseIntegerVar(
		envWithVars.RENDER_TARGET_CHUNK_COUNT_MAX,
		DEFAULT_RENDER_TARGET_CHUNK_COUNT_MAX,
	);

	return {
		...request,
		compositionId: request.compositionId ?? DEFAULT_COMPOSITION_ID,
		targetChunkCount: Math.max(
			1,
			Math.min(maxChunkCount, request.targetChunkCount ?? defaultChunkCount),
		),
	};
};

const renderJobIdFor = (request: CreateRenderJobRequest) => request.idempotencyKey;

const resolveOutputAccess = (
	job: Pick<import("./types.ts").RenderJobRecord, "status" | "outputKey"> | null,
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

const HOP_BY_HOP_HEADERS = [
	"connection",
	"keep-alive",
	"proxy-authenticate",
	"proxy-authorization",
	"proxy-connection",
	"te",
	"trailer",
	"transfer-encoding",
	"upgrade",
	"host",
	"content-length",
] as const;

const cloneForwardHeaders = (headers: Headers): Headers => {
	const forwarded = new Headers(headers);
	for (const header of HOP_BY_HOP_HEADERS) {
		forwarded.delete(header);
	}

	return forwarded;
};

const resolveObjectRange = (object: Pick<R2Object, "size" | "range">) => {
	if (!object.range) {
		return null;
	}

	if ("suffix" in object.range) {
		const length = Math.max(0, Math.min(object.range.suffix, object.size));
		if (length === 0) {
			return null;
		}

		const start = Math.max(0, object.size - length);
		return {
			start,
			end: object.size - 1,
			length,
		};
	}

	const start = Math.max(0, object.range.offset ?? 0);
	const remainingBytes = Math.max(0, object.size - start);
	const requestedLength = object.range.length ?? remainingBytes;
	const length = Math.max(0, Math.min(requestedLength, remainingBytes));

	if (length === 0) {
		return null;
	}

	return {
		start,
		end: start + length - 1,
		length,
	};
};

const createR2Response = (
	object: R2Object | R2ObjectBody,
	method: string,
): Response => {
	const headers = new Headers();
	const range = resolveObjectRange(object);
	const isPartialContent =
		range !== null && (range.start > 0 || range.length < object.size);

	if (object.httpMetadata?.contentType) {
		headers.set("Content-Type", object.httpMetadata.contentType);
	} else {
		headers.set("Content-Type", "application/octet-stream");
	}

	if (object.httpMetadata?.cacheControl) {
		headers.set("Cache-Control", object.httpMetadata.cacheControl);
	}

	headers.set("ETag", object.httpEtag);
	headers.set(
		"Content-Length",
		(isPartialContent ? range.length : object.size).toString(),
	);
	headers.set("Accept-Ranges", "bytes");
	headers.set("Access-Control-Allow-Origin", "*");
	headers.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
	headers.set("Access-Control-Allow-Headers", "Range, Content-Type");
	headers.set(
		"Access-Control-Expose-Headers",
		"Content-Length, Content-Range, Accept-Ranges",
	);

	if (isPartialContent) {
		headers.set(
			"Content-Range",
			`bytes ${range.start}-${range.end}/${object.size}`,
		);
	}

	return new Response(method === "HEAD" || !("body" in object) ? null : object.body, {
		status: isPartialContent ? 206 : 200,
		headers,
	});
};

export class RemotionContainer extends Container {
	defaultPort = 8080;
	requiredPorts = [8080];
	sleepAfter = "10m";
	enableInternet = true;

	onStart(): void {
		console.log("Remotion container started");
	}

	onStop(): void {
		console.log("Remotion container stopped");
	}

	onError(error: unknown): void {
		console.error("Remotion container error", error);
	}

	async configureOutbound(renderJobId: string): Promise<void> {
		await this.setOutboundByHosts({
			[OUTBOUND_HOSTS.assets]: "assets",
			[OUTBOUND_HOSTS.coordinator]: {
				method: "coordinator",
				params: outboundParams(
					(RemotionContainer.outboundHandlers?.coordinator ??
						(() => {
							throw new Error("coordinator outbound handler not registered");
						})) as never,
					{ renderJobId } as never,
				),
			},
			[OUTBOUND_HOSTS.r2]: "r2",
		});
	}

	async fetch(request: Request): Promise<Response> {
		return super.containerFetch(request);
	}
}

RemotionContainer.outboundHandlers = {
	async coordinator(
		req: Request,
		env: Env,
		ctx: OutboundHandlerContext<{ renderJobId: string }>,
	) {
		const renderJobId = ctx.params?.renderJobId;
		if (!renderJobId) {
			return new Response("Missing renderJobId", { status: 400 });
		}

		try {
			const stub = getCoordinatorStub(env as WorkerEnv, renderJobId);
			const forwardUrl = new URL(req.url);
			const headers = cloneForwardHeaders(req.headers);
			const body =
				req.method === "GET" || req.method === "HEAD"
					? undefined
					: await req.arrayBuffer();

			return stub.fetch(
				new Request(`https://coordinator${forwardUrl.pathname}${forwardUrl.search}`, {
					method: req.method,
					headers,
					body,
				}),
			);
		} catch (error) {
			console.error("Coordinator outbound handler failed", {
				renderJobId,
				url: req.url,
				error,
			});

			return Response.json(
				{
					error: "Coordinator outbound handler failed",
					details: error instanceof Error ? error.message : String(error),
				},
				{ status: 500 },
			);
		}
	},
	async r2(req: Request, env: Env) {
		const workerEnv = env as WorkerEnv;
		const url = new URL(req.url);
		const key = decodeURIComponent(url.pathname.replace(/^\/objects\//, ""));
		const action = url.searchParams.get("action");

		if (!key) {
			return new Response("Missing object key", { status: 400 });
		}

		try {
			if (req.method === "GET" && action === null) {
				const object = await workerEnv.R2_BUCKET.get(key, {
					range: req.headers,
				});
				if (!object) {
					return new Response("Not found", { status: 404 });
				}

				return createR2Response(object, req.method);
			}

			if (req.method === "HEAD" && action === null) {
				const object = await workerEnv.R2_BUCKET.head(key);
				return object
					? createR2Response(object, req.method)
					: new Response(null, { status: 404 });
			}

			if (req.method === "POST" && action === "mpu-create") {
				const upload = await workerEnv.R2_BUCKET.createMultipartUpload(key, {
					httpMetadata: {
						contentType: req.headers.get("content-type") ?? undefined,
					},
				});

				return Response.json({
					key: upload.key,
					uploadId: upload.uploadId,
				});
			}

			if (req.method === "PUT" && action === "mpu-uploadpart") {
				const uploadId = url.searchParams.get("uploadId");
				const partNumber = Number.parseInt(url.searchParams.get("partNumber") ?? "", 10);

				if (!uploadId || !Number.isFinite(partNumber) || partNumber < 1) {
					return new Response("Missing uploadId or valid partNumber", {
						status: 400,
					});
				}

				const body = await req.arrayBuffer();
				const upload = workerEnv.R2_BUCKET.resumeMultipartUpload(key, uploadId);
				const part = await upload.uploadPart(partNumber, body);

				return Response.json(part);
			}

			if (req.method === "POST" && action === "mpu-complete") {
				const uploadId = url.searchParams.get("uploadId");
				if (!uploadId) {
					return new Response("Missing uploadId", { status: 400 });
				}

				const body = (await req.json()) as {
					parts: Array<{ partNumber: number; etag: string }>;
				};
				if (!body?.parts?.length) {
					return new Response("Missing uploaded parts", { status: 400 });
				}

				const upload = workerEnv.R2_BUCKET.resumeMultipartUpload(key, uploadId);
				const object = await upload.complete(body.parts as R2UploadedPart[]);

				return Response.json({
					key: object.key,
					size: object.size,
					etag: object.httpEtag,
				});
			}

			if (req.method === "DELETE" && action === "mpu-abort") {
				const uploadId = url.searchParams.get("uploadId");
				if (!uploadId) {
					return new Response("Missing uploadId", { status: 400 });
				}

				const upload = workerEnv.R2_BUCKET.resumeMultipartUpload(key, uploadId);
				await upload.abort();
				return new Response(null, { status: 204 });
			}

			if (req.method === "PUT" && action === null) {
				const body = req.body ? await req.arrayBuffer() : new ArrayBuffer(0);
				const object = await workerEnv.R2_BUCKET.put(key, body, {
					httpMetadata: {
						contentType: req.headers.get("content-type") ?? undefined,
					},
				});

				return Response.json({
					key: object?.key ?? key,
					size: object?.size ?? body.byteLength,
					etag: object?.httpEtag,
				});
			}

			if (req.method === "DELETE" && action === null) {
				await workerEnv.R2_BUCKET.delete(key);
				return new Response(null, { status: 204 });
			}

			return new Response("Method not allowed", { status: 405 });
		} catch (error) {
			console.error("R2 outbound handler failed", {
				method: req.method,
				action,
				key,
				url: req.url,
				error,
			});

			return new Response(error instanceof Error ? error.message : String(error), {
				status: 500,
			});
		}
	},
	async assets(req: Request) {
		const url = new URL(req.url);
		const targetUrl = url.searchParams.get("url");

		if (!targetUrl) {
			return new Response("Missing target url", { status: 400 });
		}

		const upstream = await fetch(targetUrl, {
			method: req.method,
			headers: new Headers({
				Range: req.headers.get("range") ?? "",
			}),
			body: req.method === "GET" || req.method === "HEAD" ? undefined : req.body,
			redirect: "follow",
		});

		const headers = new Headers(upstream.headers);
		headers.set("Access-Control-Allow-Origin", "*");
		headers.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
		headers.set("Access-Control-Allow-Headers", "Range, Content-Type");
		headers.set(
			"Access-Control-Expose-Headers",
			"Content-Length, Content-Range, Accept-Ranges",
		);
		headers.delete("x-frame-options");
		headers.delete("content-security-policy");
		headers.delete("content-security-policy-report-only");
		headers.delete("cross-origin-resource-policy");
		headers.delete("cross-origin-opener-policy");
		headers.delete("cross-origin-embedder-policy");

		return new Response(upstream.body, {
			status: upstream.status,
			headers,
		});
	},
};

export default {
	async fetch(request: Request, env: WorkerEnv): Promise<Response> {
		const url = new URL(request.url);

		if (isLocalR2ObjectPath(url.pathname)) {
			const r2Handler = RemotionContainer.outboundHandlers?.r2;
			if (!r2Handler) {
				return new Response("R2 outbound handler not registered", { status: 500 });
			}

			const forwardUrl = new URL(request.url);
			forwardUrl.protocol = "http:";
			forwardUrl.host = OUTBOUND_HOSTS.r2;
			forwardUrl.pathname = stripLocalR2Prefix(forwardUrl.pathname);
			const body =
				request.method === "GET" || request.method === "HEAD"
					? undefined
					: await request.arrayBuffer();

			return r2Handler(
				new Request(forwardUrl, {
					method: request.method,
					headers: request.headers,
					body,
				}),
				env,
				{
				className: "RemotionContainer",
				containerId: "local-worker",
				},
			);
		}

		const localCoordinatorMatch = matchLocalCoordinatorProgressPath(url.pathname);
		if (request.method === "POST" && localCoordinatorMatch) {
			const renderJobId = decodeURIComponent(localCoordinatorMatch[1]);
			const chunkIndex = localCoordinatorMatch[2];
			const coordinator = getCoordinatorStub(env, renderJobId);
			return coordinator.fetch(
				new Request(
					`https://coordinator/jobs/${encodeURIComponent(renderJobId)}/chunks/${chunkIndex}/progress`,
					request,
				),
			);
		}

		if (request.method === "GET" && url.pathname === "/health") {
			return Response.json({
				status: "ok",
				timestamp: new Date().toISOString(),
			});
		}

		const outputMatch = url.pathname.match(/^\/jobs\/([^/]+)\/output$/);
		if ((request.method === "GET" || request.method === "HEAD") && outputMatch) {
			const renderJobId = decodeURIComponent(outputMatch[1]);
			const coordinator = getCoordinatorStub(env, renderJobId);
			const outputResponse = await coordinator.fetch(new Request("https://coordinator/output"));

			if (!outputResponse.ok) {
				return outputResponse;
			}

			const { outputKey } = (await outputResponse.json()) as { outputKey: string };
			const object = request.method === "HEAD"
				? await env.R2_BUCKET.head(outputKey)
				: await env.R2_BUCKET.get(outputKey, {
					range: request.headers,
				});

			if (!object) {
				return Response.json(
					{
						error: "Render output not found in R2",
						outputKey,
					},
					{ status: 404 },
				);
			}

			return createR2Response(object, request.method);
		}

		if (request.method === "POST" && url.pathname === "/jobs") {
			const parsed =
				createRenderJobSchema.parse(await request.json()) satisfies PublicCreateRenderJobRequest;
			const normalized = normalizeCreateRequest(env, {
				...parsed,
				localWorkerOrigin: deriveLocalWorkerOrigin(request.url),
			});
			const renderJobId = renderJobIdFor(normalized);
			const coordinator = getCoordinatorStub(env, renderJobId);
			return coordinator.fetch(
				new Request("https://coordinator/init", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
					},
					body: JSON.stringify({
						renderJobId,
						request: normalized,
					}),
				}),
			);
		}

		const jobMatch = url.pathname.match(/^\/jobs\/([^/]+)$/);
		if (request.method === "GET" && jobMatch) {
			const renderJobId = decodeURIComponent(jobMatch[1]);
			const coordinator = getCoordinatorStub(env, renderJobId);
			return coordinator.fetch(new Request("https://coordinator/status"));
		}

		return new Response("Not found", { status: 404 });
	},
};
