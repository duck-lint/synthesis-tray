import { buildResponsesRequest } from "../src/openai/requestBuilder";
import { Message, PluginSettings, TrayItem } from "../src/state/types";

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) throw new Error("OPENAI_API_KEY is required for the live prompt-cache probe.");

// A fresh thread namespace makes request 1 a cold-cache write on every probe run.
const threadId = `prompt-cache-probe-${Date.now()}`;
const stableSystemPrompt = Array.from({ length: 180 }, () => "Stable synthesis instruction remains identical across probe requests.").join(" ");
const stablePrefixA = Array.from({ length: 520 }, (_, index) => `stable-prefix-A-${index}`).join(" ");
const extensionB = Array.from({ length: 260 }, (_, index) => `extension-B-${index}`).join(" ");
const settings: PluginSettings = {
  secretName: "probe",
  model: "gpt-5.6-luna",
  systemPrompt: stableSystemPrompt,
  maxOutputTokens: 256,
  promptCachingEnabled: true,
};

function message(role: Message["role"], content: string, turnId: string): Message {
  return { id: `${turnId}-${role}`, threadId, turnId, role, content, createdAt: "2026-08-21T00:00:00.000Z" };
}

function tray(contentSnapshot: string): TrayItem[] {
  return [{ id: "probe-tray", sourcePath: "probe.md", scope: "whole_note", headingPath: null, contentSnapshot, addedAt: "2026-08-21T00:00:00.000Z" }];
}

async function run(label: string, priorMessages: Message[], trayItems: TrayItem[], draft: string): Promise<void> {
  const request = buildResponsesRequest(settings, threadId, priorMessages, trayItems, draft);
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });
  const raw = await response.text();
  if (!response.ok) throw new Error(`Probe request failed (${response.status}): ${raw}`);
  const events = raw.split(/\r?\n\r?\n/).map((chunk) => chunk.split(/\r?\n/).find((line) => line.startsWith("data:"))).filter((line): line is string => Boolean(line)).map((line) => JSON.parse(line.slice(5).trim()) as { type?: string; response?: { usage?: unknown; incomplete_details?: unknown }; incomplete_details?: unknown });
  const terminal = events.find((event) => event.type === "response.completed" || event.type === "response.incomplete" || event.type === "response.failed");
  const breakpointIndices = request.input.flatMap((item, index) => Array.isArray(item.content) && item.content.some((block) => "prompt_cache_breakpoint" in block) ? [index] : []);
  console.log(JSON.stringify({
    label,
    request: {
      model: request.model,
      prompt_cache_key: request.prompt_cache_key,
      prompt_cache_options: request.prompt_cache_options,
      input_count: request.input.length,
      breakpoint_indices: breakpointIndices,
      current_suffix_lengths: { tray: trayItems[0]?.contentSnapshot.length ?? 0, draft: draft.length },
    },
    event_types: events.map((event) => event.type),
    terminal_details: terminal?.response?.incomplete_details ?? terminal?.incomplete_details ?? null,
    usage: terminal?.response?.usage ?? null,
  }, null, 2));
}

await run(
  "request-1-prefix-A-suffix-X",
  [message("user", "Visible user turn A", "turn-a"), message("assistant", stablePrefixA, "turn-a")],
  tray("variable tray X"),
  "variable suffix X",
);

await run(
  "request-2-prefix-A-suffix-Y",
  [message("user", "Visible user turn A", "turn-a"), message("assistant", stablePrefixA, "turn-a")],
  tray("variable tray Y"),
  "variable suffix Y",
);

await run(
  "request-3-prefix-A-extension-B-suffix-Z",
  [
    message("user", "Visible user turn A", "turn-a"),
    message("assistant", stablePrefixA, "turn-a"),
    message("user", "Visible user turn B", "turn-b"),
    message("assistant", extensionB, "turn-b"),
  ],
  tray("variable tray Z"),
  "variable suffix Z",
);
