import { App, Modal } from "obsidian";

export interface ModalAction<T> {
  label: string;
  value: T;
  cls?: string;
}

export type ModalCloseRegistration = (close: () => void) => void;
export type ModalActionValidation<T> = (action: ModalAction<T>) => Promise<boolean>;

/** Small Obsidian-native action modal; it never calls focus or browser dialogs. */
export function chooseAction<T>(app: App, title: string, message: string, actions: ModalAction<T>[], cancelValue: T, registerClose?: ModalCloseRegistration, validateAction?: ModalActionValidation<T>): Promise<T> {
  return new Promise((resolve) => {
    let settled = false;
    let validationPending = false;
    const finish = (value: T): void => {
      if (settled) return;
      settled = true;
      resolve(value);
      modal.close();
    };
    const modal = new class extends Modal {
      override onOpen(): void {
        this.setTitle(title);
        this.contentEl.createEl("p", { text: message });
        const buttons = this.contentEl.createDiv("synthesis-modal-actions");
        for (const action of actions) {
          const button = buttons.createEl("button", { text: action.label, cls: action.cls });
          button.onclick = () => {
            if (!validateAction || action.cls !== "mod-cta") return finish(action.value);
            if (validationPending || settled) return;
            validationPending = true;
            void validateAction(action).then((valid) => {
              validationPending = false;
              if (valid) finish(action.value);
              else finish(cancelValue);
            }).catch(() => {
              validationPending = false;
              finish(cancelValue);
            });
          };
        }
      }

      override onClose(): void {
        if (!settled) {
          settled = true;
          resolve(cancelValue);
        }
      }
    }(app);
    registerClose?.(() => finish(cancelValue));
    modal.open();
  });
}

export function confirmAction(app: App, title: string, message: string): Promise<boolean> {
  return chooseAction(app, title, message, [{ label: "Cancel", value: false }, { label: "Confirm", value: true, cls: "mod-cta" }], false);
}

export function requestText(app: App, title: string, message: string, initialValue: string): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: string | null): void => {
      if (settled) return;
      settled = true;
      resolve(value);
      modal.close();
    };
    const modal = new class extends Modal {
      override onOpen(): void {
        this.setTitle(title);
        this.contentEl.createEl("p", { text: message });
        const input = this.contentEl.createEl("input", { type: "text", value: initialValue });
        input.addEventListener("keydown", (event) => {
          if (event.key === "Enter") finish(input.value.trim() || null);
        });
        const buttons = this.contentEl.createDiv("synthesis-modal-actions");
        buttons.createEl("button", { text: "Cancel" }).onclick = () => finish(null);
        buttons.createEl("button", { text: "Save", cls: "mod-cta" }).onclick = () => finish(input.value.trim() || null);
      }

      override onClose(): void {
        if (!settled) {
          settled = true;
          resolve(null);
        }
      }
    }(app);
    modal.open();
  });
}
