import { useMemo } from "react";
import {
	AbsoluteFill,
	Audio,
	Easing,
	interpolate,
	spring,
	type CalculateMetadataFunction,
	useCurrentFrame,
	useVideoConfig,
} from "remotion";
import { z } from "zod";

const DEFAULT_DURATION_IN_FRAMES = 480;
const DEFAULT_BACKGROUND = "#0f172a";
const DEFAULT_ACCENT = "#38bdf8";
const DEFAULT_TEXT = "#e2e8f0";

export const helloWorldSchema = z.object({
	title: z.string().min(1).default("Hello from Cloudflare"),
	subtitle: z.string().min(1).default("Distributed Remotion render"),
	backgroundColor: z.string().default(DEFAULT_BACKGROUND),
	accentColor: z.string().default(DEFAULT_ACCENT),
	textColor: z.string().default(DEFAULT_TEXT),
	durationInFrames: z.number().int().positive().max(3600).default(DEFAULT_DURATION_IN_FRAMES),
});

export type HelloWorldProps = z.infer<typeof helloWorldSchema>;

export const calculateHelloWorldMetadata: CalculateMetadataFunction<HelloWorldProps> = async ({
	props,
}) => {
	const durationInFrames = Math.max(
		120,
		Math.min(props.durationInFrames ?? DEFAULT_DURATION_IN_FRAMES, 3600),
	);

	return {
		fps: 30,
		durationInFrames,
		width: 1280,
		height: 720,
	};
};

const clampByte = (value: number) => Math.max(0, Math.min(255, Math.round(value)));

const toBase64 = (bytes: Uint8Array) => {
	let binary = "";
	const chunkSize = 0x8000;
	for (let index = 0; index < bytes.length; index += chunkSize) {
		binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
	}

	return btoa(binary);
};

const createToneWavDataUri = (durationInSeconds: number) => {
	const sampleRate = 8_000;
	const sampleCount = Math.max(1, Math.ceil(durationInSeconds * sampleRate));
	const dataLength = sampleCount;
	const wav = new Uint8Array(44 + dataLength);
	const view = new DataView(wav.buffer);

	const writeAscii = (offset: number, value: string) => {
		for (let index = 0; index < value.length; index += 1) {
			view.setUint8(offset + index, value.charCodeAt(index));
		}
	};

	writeAscii(0, "RIFF");
	view.setUint32(4, 36 + dataLength, true);
	writeAscii(8, "WAVE");
	writeAscii(12, "fmt ");
	view.setUint32(16, 16, true);
	view.setUint16(20, 1, true);
	view.setUint16(22, 1, true);
	view.setUint32(24, sampleRate, true);
	view.setUint32(28, sampleRate, true);
	view.setUint16(32, 1, true);
	view.setUint16(34, 8, true);
	writeAscii(36, "data");
	view.setUint32(40, dataLength, true);

	for (let index = 0; index < sampleCount; index += 1) {
		const progress = index / sampleRate;
		const envelope = Math.sin(Math.PI * Math.min(1, progress / Math.max(durationInSeconds, 0.001)));
		const tone = Math.sin(2 * Math.PI * 220 * progress) * 0.12 * envelope;
		wav[44 + index] = clampByte(128 + tone * 127);
	}

	return `data:audio/wav;base64,${toBase64(wav)}`;
};

const pillStyle: React.CSSProperties = {
	display: "inline-flex",
	alignItems: "center",
	padding: "10px 18px",
	borderRadius: 999,
	fontSize: 20,
	fontWeight: 600,
	backdropFilter: "blur(12px)",
	backgroundColor: "rgba(15, 23, 42, 0.45)",
	border: "1px solid rgba(226, 232, 240, 0.18)",
	letterSpacing: "0.04em",
	textTransform: "uppercase",
};

export const HelloWorld: React.FC<HelloWorldProps> = ({
	title,
	subtitle,
	backgroundColor = DEFAULT_BACKGROUND,
	accentColor = DEFAULT_ACCENT,
	textColor = DEFAULT_TEXT,
	durationInFrames = DEFAULT_DURATION_IN_FRAMES,
}) => {
	const frame = useCurrentFrame();
	const { fps, durationInFrames: compositionDuration } = useVideoConfig();
	const entrance = spring({
		fps,
		frame,
		config: {
			damping: 200,
			stiffness: 120,
			mass: 0.8,
		},
	});
	const orbit = interpolate(frame, [0, compositionDuration], [0, 1], {
		easing: Easing.inOut(Easing.cubic),
		extrapolateLeft: "clamp",
		extrapolateRight: "clamp",
	});
	const shimmer = interpolate(frame % 120, [0, 119], [0.4, 1]);
	const cardOffset = interpolate(entrance, [0, 1], [48, 0]);
	const scale = interpolate(entrance, [0, 1], [0.92, 1]);
	const progress = interpolate(frame, [0, compositionDuration - 1], [0.08, 1], {
		extrapolateLeft: "clamp",
		extrapolateRight: "clamp",
	});
	const audioSrc = useMemo(
		() => createToneWavDataUri(durationInFrames / fps),
		[durationInFrames, fps],
	);

	return (
		<AbsoluteFill
			style={{
				background: `linear-gradient(145deg, ${backgroundColor} 0%, #020617 100%)`,
				color: textColor,
				fontFamily:
					'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
			}}
		>
			<Audio src={audioSrc} volume={0.08} />

			<AbsoluteFill
				style={{
					background: `radial-gradient(circle at ${20 + orbit * 60}% ${30 + orbit * 15}%, ${accentColor}66 0%, transparent 30%), radial-gradient(circle at ${80 - orbit * 40}% ${20 + orbit * 55}%, rgba(59, 130, 246, 0.20) 0%, transparent 28%)`,
				}}
			/>

			<AbsoluteFill
				style={{
					justifyContent: "center",
					alignItems: "center",
					padding: 72,
				}}
			>
				<div
					style={{
						width: "100%",
						maxWidth: 980,
						padding: "56px 64px",
						borderRadius: 40,
						backgroundColor: "rgba(15, 23, 42, 0.68)",
						border: `1px solid ${accentColor}33`,
						boxShadow: `0 40px 120px ${accentColor}22`,
						transform: `translateY(${cardOffset}px) scale(${scale})`,
					}}
				>
					<div style={{ display: "flex", gap: 16, marginBottom: 28 }}>
						<div style={pillStyle}>Cloudflare Containers</div>
						<div style={pillStyle}>Durable Objects</div>
						<div style={pillStyle}>R2</div>
					</div>

					<h1
						style={{
							fontSize: 86,
							lineHeight: 1,
							margin: 0,
							letterSpacing: "-0.06em",
							maxWidth: 760,
						}}
					>
						{title}
					</h1>

					<p
						style={{
							fontSize: 34,
							lineHeight: 1.3,
							marginTop: 28,
							marginBottom: 44,
							maxWidth: 760,
							color: `${textColor}cc`,
						}}
					>
						{subtitle}
					</p>

					<div
						style={{
							height: 12,
							width: "100%",
							borderRadius: 999,
							backgroundColor: "rgba(148, 163, 184, 0.18)",
							overflow: "hidden",
						}}
					>
						<div
							style={{
								height: "100%",
								width: `${Math.round(progress * 100)}%`,
								borderRadius: 999,
								background: `linear-gradient(90deg, ${accentColor} 0%, #f8fafc ${40 + shimmer * 20}%, ${accentColor} 100%)`,
							}}
						/>
					</div>

					<div
						style={{
							display: "flex",
							justifyContent: "space-between",
							alignItems: "center",
							marginTop: 22,
							fontSize: 24,
							color: `${textColor}b3`,
						}}
					>
						<span>Chunked render in progress</span>
						<span>
							Frame {frame + 1} / {compositionDuration}
						</span>
					</div>
				</div>
			</AbsoluteFill>
		</AbsoluteFill>
	);
};
