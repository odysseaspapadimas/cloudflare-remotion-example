const LOCAL_WORKER_HOST = "host.docker.internal";
const LOCAL_COORDINATOR_PREFIX = "/internal/coordinator";
const LOCAL_R2_PREFIX = "/internal/r2";
const COORDINATOR_HOST = "coordinator.internal";
const R2_HOST = "r2.internal";

export type TransportResolver = {
	localWorkerOrigin?: string;
	toCoordinatorProgressUrl: (renderJobId: string, chunkIndex: number) => string;
	toR2Url: (key: string) => string;
};

export const isLoopbackHostname = (hostname: string) =>
	hostname === "127.0.0.1" || hostname === "localhost";

export const deriveLocalWorkerOrigin = (requestUrl: string): string | undefined => {
	const url = new URL(requestUrl);
	if (!isLoopbackHostname(url.hostname)) {
		return undefined;
	}

	return `${url.protocol}//${LOCAL_WORKER_HOST}${url.port ? `:${url.port}` : ""}`;
};

export const isLocalWorkerTransportEnabled = (
	localWorkerOrigin: string | undefined,
): localWorkerOrigin is string => Boolean(localWorkerOrigin);

export const toLocalWorkerUrl = (
	pathname: string,
	localWorkerOrigin: string | undefined,
) => {
	if (!isLocalWorkerTransportEnabled(localWorkerOrigin)) {
		return null;
	}

	return new URL(pathname, localWorkerOrigin).toString();
};

export const toLocalCoordinatorProgressPath = (
	renderJobId: string,
	chunkIndex: number,
) =>
	`${LOCAL_COORDINATOR_PREFIX}/jobs/${encodeURIComponent(renderJobId)}/chunks/${chunkIndex}/progress`;

export const toLocalR2ObjectPath = (key: string) =>
	`${LOCAL_R2_PREFIX}/objects/${encodeURIComponent(key)}`;

export const toCoordinatorProgressTransportUrl = (
	renderJobId: string,
	chunkIndex: number,
	localWorkerOrigin: string | undefined,
) =>
	toLocalWorkerUrl(toLocalCoordinatorProgressPath(renderJobId, chunkIndex), localWorkerOrigin) ??
	`http://${COORDINATOR_HOST}/jobs/${encodeURIComponent(renderJobId)}/chunks/${chunkIndex}/progress`;

export const toR2TransportUrl = (key: string, localWorkerOrigin: string | undefined) =>
	toLocalWorkerUrl(toLocalR2ObjectPath(key), localWorkerOrigin) ??
	`http://${R2_HOST}/objects/${encodeURIComponent(key)}`;

export const createTransportResolver = (
	localWorkerOrigin: string | undefined,
): TransportResolver => ({
	localWorkerOrigin,
	toCoordinatorProgressUrl: (renderJobId, chunkIndex) =>
		toCoordinatorProgressTransportUrl(renderJobId, chunkIndex, localWorkerOrigin),
	toR2Url: (key) => toR2TransportUrl(key, localWorkerOrigin),
});

export const matchLocalCoordinatorProgressPath = (pathname: string) =>
	pathname.match(/^\/internal\/coordinator\/jobs\/([^/]+)\/chunks\/(\d+)\/progress$/);

export const isLocalR2ObjectPath = (pathname: string) =>
	pathname.startsWith(`${LOCAL_R2_PREFIX}/objects/`);

export const stripLocalR2Prefix = (pathname: string) => pathname.replace(/^\/internal\/r2/, "");
