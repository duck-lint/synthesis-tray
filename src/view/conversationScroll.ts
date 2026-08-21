/** Scroll only the conversation viewport so the target message starts at its visible top. */
export function scrollConversationToMessageStart(container: HTMLElement, message: HTMLElement): void {
  const containerTop = container.getBoundingClientRect().top;
  const messageTop = message.getBoundingClientRect().top;
  container.scrollTop = Math.max(0, container.scrollTop + messageTop - containerTop);
}
