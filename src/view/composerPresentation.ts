export interface ComposerPresentation {
  textareaDisabled: boolean;
  sendButtonText: "Send" | "Stop";
  sendButtonDisabled: boolean;
}

/** The rendered controls are a direct projection of the request lifecycle state. */
export function composerPresentation(streaming: boolean, draft: string, hasSecret: boolean): ComposerPresentation {
  return {
    textareaDisabled: streaming,
    sendButtonText: streaming ? "Stop" : "Send",
    sendButtonDisabled: !streaming && (!draft.trim() || !hasSecret),
  };
}
