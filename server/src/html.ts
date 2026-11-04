// HTML без шаблонизатора: всё, что подставляется в шаблон html`…`, экранируется,
// кроме уже готовых кусков html`…` и raw(). Так данные из анкеты не превратятся в разметку.

export class Html {
  readonly value: string;
  constructor(value: string) {
    this.value = value;
  }
  toString() {
    return this.value;
  }
}

export const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] as string);

type Part = Html | string | number | null | undefined | false | Part[];

function render(part: Part): string {
  if (part === null || part === undefined || part === false) return "";
  if (Array.isArray(part)) return part.map(render).join("");
  if (part instanceof Html) return part.value;
  return escapeHtml(String(part));
}

export function html(strings: TemplateStringsArray, ...values: Part[]): Html {
  let out = strings[0] ?? "";
  values.forEach((v, i) => {
    out += render(v) + (strings[i + 1] ?? "");
  });
  return new Html(out);
}

/** Готовая разметка без экранирования: только для своих строк, не для данных людей. */
export const raw = (s: string) => new Html(s);
