import { Composition } from "remotion";
import {
	calculateHelloWorldMetadata,
	HelloWorld,
	helloWorldSchema,
} from "./compositions/HelloWorld/index.tsx";

const COMPOSITION_ID = "HelloWorld";

export const RemotionRoot: React.FC = () => {
	return (
		<Composition
			id={COMPOSITION_ID}
			component={HelloWorld}
			fps={30}
			width={1280}
			height={720}
			durationInFrames={480}
			schema={helloWorldSchema}
			calculateMetadata={calculateHelloWorldMetadata}
			defaultProps={{
				title: "Hello from Cloudflare",
				subtitle: "Distributed Remotion render",
				backgroundColor: "#0f172a",
				accentColor: "#38bdf8",
				textColor: "#e2e8f0",
				durationInFrames: 480,
			}}
		/>
	);
};

export default RemotionRoot;
