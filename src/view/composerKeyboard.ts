export interface ComposerKeyEventLike {
  key: string;
  keyCode?: number;
  shiftKey: boolean;
  isComposing?: boolean;
}

/** Plain Enter sends only when the composer can actually send. */
export function shouldSendOnEnter(event: ComposerKeyEventLike, canSend: boolean): boolean {
  return event.key === "Enter" && !event.shiftKey && !event.isComposing && event.keyCode !== 229 && canSend;
}
