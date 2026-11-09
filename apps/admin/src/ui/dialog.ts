// GTM-agents: the confirmation dialog every dashboard action goes through. It is a native modal
// <dialog>, so focus stays inside it and Escape cancels; focus returns to the control that opened
// it. Fields (a pause reason, a confirm code) are validated before the action can be confirmed.
import { LitElement, css, html, nothing } from "lit";
import type { TemplateResult } from "lit";
import { sharedStyles } from "../styles.ts";

export interface ConfirmField {
  name: string;
  label: string;
  required?: boolean;
  multiline?: boolean;
  value?: string;
  hint?: string;
  type?: "text" | "number";
  options?: readonly string[];
}

export interface ConfirmOptions {
  title: string;
  body?: TemplateResult | string;
  confirmLabel: string;
  danger?: boolean;
  fields?: readonly ConfirmField[];
  /** Returns a message when the values cannot be confirmed yet. */
  validate?: (values: Record<string, string>) => string | null;
}

export interface ConfirmResult {
  confirmed: boolean;
  values: Record<string, string>;
}

function deepActiveElement(): HTMLElement | null {
  let active: Element | null = document.activeElement;
  while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
  return active instanceof HTMLElement ? active : null;
}

/** Opens the dialog and resolves when the operator confirms or cancels. */
export function confirmAction(options: ConfirmOptions): Promise<ConfirmResult> {
  return new Promise((resolve) => {
    const element = document.createElement("gtm-confirm") as GtmConfirm;
    element.options = options;
    element.returnFocus = deepActiveElement();
    element.done = (result) => {
      element.remove();
      element.returnFocus?.focus();
      resolve(result);
    };
    document.body.append(element);
  });
}

export class GtmConfirm extends LitElement {
  static override properties = {
    message: { state: true },
  };

  static override styles = [
    sharedStyles,
    css`
      dialog {
        border: 1px solid var(--border);
        border-radius: var(--radius);
        background: var(--surface);
        color: var(--text);
        padding: 1.25rem;
        width: min(36rem, calc(100vw - 2rem));
        max-height: calc(100vh - 2rem);
        overflow: auto;
      }
      dialog::backdrop {
        background: rgb(0 0 0 / 45%);
      }
      .fields {
        display: grid;
        gap: 0.75rem;
        margin: 1rem 0;
      }
      .fields label {
        display: flex;
      }
      .actions {
        display: flex;
        justify-content: flex-end;
        gap: 0.5rem;
        margin-top: 1rem;
      }
      .body {
        max-height: 50vh;
        overflow: auto;
      }
    `,
  ];

  declare message: string;
  options: ConfirmOptions = { title: "", confirmLabel: "Confirm" };
  returnFocus: HTMLElement | null = null;
  done: (result: ConfirmResult) => void = () => {};
  #finished = false;

  constructor() {
    super();
    this.message = "";
  }

  override firstUpdated(): void {
    const dialog = this.renderRoot.querySelector("dialog");
    dialog?.showModal();
    const first = this.renderRoot.querySelector<HTMLElement>("input, textarea, select") ?? this.renderRoot.querySelector<HTMLElement>("button.cancel");
    first?.focus();
  }

  #values(): Record<string, string> {
    const values: Record<string, string> = {};
    for (const field of this.options.fields ?? []) {
      const input = this.renderRoot.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(`[name="${field.name}"]`);
      values[field.name] = input?.value.trim() ?? "";
    }
    return values;
  }

  #finish(confirmed: boolean): void {
    if (this.#finished) return;
    const values = this.#values();
    if (confirmed) {
      const missing = (this.options.fields ?? []).find((field) => field.required && !values[field.name]);
      if (missing) {
        this.message = `${missing.label} is required.`;
        this.renderRoot.querySelector<HTMLElement>(`[name="${missing.name}"]`)?.focus();
        return;
      }
      const problem = this.options.validate?.(values) ?? null;
      if (problem) {
        this.message = problem;
        return;
      }
    }
    this.#finished = true;
    this.renderRoot.querySelector("dialog")?.close();
    this.done({ confirmed, values });
  }

  #field(field: ConfirmField) {
    const id = `f-${field.name}`;
    const hint = field.hint ? html`<span class="small muted" id="${id}-hint">${field.hint}</span>` : nothing;
    const describedBy = field.hint ? `${id}-hint` : undefined;
    let control: TemplateResult;
    if (field.options) {
      control = html`<select id=${id} name=${field.name} aria-describedby=${describedBy ?? nothing} ?required=${field.required ?? false}>
        ${field.options.map((option) => html`<option value=${option} ?selected=${option === field.value}>${option}</option>`)}
      </select>`;
    } else if (field.multiline) {
      control = html`<textarea id=${id} name=${field.name} aria-describedby=${describedBy ?? nothing} ?required=${field.required ?? false} .value=${field.value ?? ""}></textarea>`;
    } else {
      control = html`<input id=${id} name=${field.name} type=${field.type ?? "text"} autocomplete="off" aria-describedby=${describedBy ?? nothing} ?required=${field.required ?? false} .value=${field.value ?? ""} />`;
    }
    return html`<label for=${id}>${field.label}${field.required ? " (required)" : ""} ${control} ${hint}</label>`;
  }

  override render() {
    const options = this.options;
    return html`<dialog
      aria-labelledby="title"
      @cancel=${(event: Event) => {
        event.preventDefault();
        this.#finish(false);
      }}
    >
      <form
        @submit=${(event: Event) => {
          event.preventDefault();
          this.#finish(true);
        }}
      >
        <h2 id="title">${options.title}</h2>
        ${options.body ? html`<div class="body" tabindex="0" role="region" aria-label="Content to review">${options.body}</div>` : nothing}
        ${options.fields?.length ? html`<div class="fields">${options.fields.map((field) => this.#field(field))}</div>` : nothing}
        <p class="error" role="alert">${this.message}</p>
        <div class="actions">
          <button type="button" class="cancel" @click=${() => this.#finish(false)}>Cancel</button>
          <button type="submit" class=${options.danger ? "danger" : "primary"}>${options.confirmLabel}</button>
        </div>
      </form>
    </dialog>`;
  }
}

customElements.define("gtm-confirm", GtmConfirm);
