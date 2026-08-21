import { Message, PluginSettings, TrayItem } from "../state/types";
import { serializeTray } from "./sourceSerializer";

export interface ResponsesInputMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ResponsesRequest {
  model: string;
  instructions: string;
  input: ResponsesInputMessage[];
  max_output_tokens: number;
  stream: true;
}

export interface RequestTextParts {
  conversation: string;
  tray: string;
  currentUser: string;
}

export function buildRequestText(priorMessages: Message[], tray: TrayItem[], draft: string): RequestTextParts {
  const conversation = priorMessages.map((message) => `${message.role === "user" ? "USER" : "ASSISTANT"}:\n${message.content}`).join("\n\n");
  const trayText = serializeTray(tray);
  const currentUser = trayText ? `${trayText}\n\nUSER MESSAGE:\n\n${draft}` : draft;
  return { conversation, tray: trayText, currentUser };
}

export function buildResponsesRequest(settings: PluginSettings, priorMessages: Message[], tray: TrayItem[], draft: string): ResponsesRequest {
  const { currentUser } = buildRequestText(priorMessages, tray, draft);
  return {
    model: settings.model.trim(),
    instructions: settings.systemPrompt,
    input: [
      ...priorMessages.map((message) => ({ role: message.role, content: message.content })),
      { role: "user", content: currentUser },
    ],
    max_output_tokens: settings.maxOutputTokens,
    stream: true,
  };
}
