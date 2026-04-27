import type { ModelCard } from "../types.js";
import {
  buildCapability,
  hasInput,
  hasOutput,
  hasSourceType,
  uniqueCapabilities,
} from "./source.js";
import type { ModelOperationCapability, ModelSourceShape } from "./types.js";

export function classifyAudioModel(model: ModelCard, source: ModelSourceShape): ModelOperationCapability[] {
  const capabilities: ModelOperationCapability[] = [];

  if (hasSourceType(source, ["text-to-speech", "speech-generation"])) {
    capabilities.push(buildCapability(model, source, "audio", "text-to-speech", false));
  }

  if (hasSourceType(source, ["speech-to-text", "transcription", "automatic-speech-recognition"])) {
    capabilities.push(buildCapability(model, source, "audio", "speech-to-text", false));
  }

  if (hasSourceType(source, ["speech-to-speech"])) {
    capabilities.push(buildCapability(model, source, "audio", "speech-to-speech", false));
  }

  if (hasSourceType(source, ["text-to-audio", "music-generation"])) {
    capabilities.push(buildCapability(model, source, "audio", "text-to-audio", false));
  }

  if (hasSourceType(source, ["audio-classification"])) {
    capabilities.push(buildCapability(model, source, "audio", "audio-classification", false));
  }

  if (hasSourceType(source, ["dumb-pipe"]) && (hasInput(source, "audio") || hasOutput(source, "audio"))) {
    capabilities.push(buildCapability(model, source, "audio", "dumb-pipe", false));
  }

  return uniqueCapabilities(capabilities);
}
