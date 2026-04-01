import { Config } from "@remotion/cli/config";

Config.setEntryPoint("./src/remotion-entry.tsx");
Config.setVideoImageFormat("jpeg");
Config.setOverwriteOutput(true);
Config.setPixelFormat("yuv420p");
