import { Message, Thread } from "./types";
import { newId, nowIso } from "./ids";

export function titleFromFirstMessage(content: string): string {
  const firstLine = content.trim().split(/\r?\n/)[0].replace(/\s+/g, " ");
  if (!firstLine) return "New synthesis thread";
  return firstLine.length > 48 ? `${firstLine.slice(0, 45).trimEnd()}…` : firstLine;
}

export function makeMessage(thread: Thread, role: Message["role"], content: string, turnId: string): Message {
  return { id: newId("message"), threadId: thread.id, turnId, role, content, createdAt: nowIso() };
}
