import type { ModelCard } from "../types.js";
import {
  buildCapability,
  hasSourceType,
  uniqueCapabilities,
} from "./source.js";
import type { ModelOperationCapability, ModelSourceShape } from "./types.js";

const TEXT_TYPE_OPERATIONS = new Map<string, string>([
  ["chat", "chat"],
  ["chat-completions", "chat"],
  ["text-to-text", "chat"],
  ["conversational", "chat"],
  ["responses", "responses"],
  ["completion", "completion"],
  ["completions", "completion"],
  ["text-generation", "completion"],
  ["search", "search"],
  ["deep-research", "deep-research"],
  ["question-answering", "question-answering"],
  ["summarization", "summarization"],
  ["translation", "translation"],
  ["moderation", "moderation"],
  ["text-classification", "classification"],
  ["token-classification", "classification"],
  ["zero-shot-classification", "classification"],
]);

export function classifyTextModel(model: ModelCard, source: ModelSourceShape): ModelOperationCapability[] {
  const capabilities: ModelOperationCapability[] = [];

  for (const sourceType of source.sourceTypes) {
    const operation = TEXT_TYPE_OPERATIONS.get(sourceType);
    if (operation) {
      capabilities.push(buildCapability(model, source, "text", operation, true));
    }
  }

  if (hasSourceType(source, ["image-text-to-text"])) {
    capabilities.push(buildCapability(model, source, "text", "vision-chat", true));
  }

  return uniqueCapabilities(capabilities);
}
