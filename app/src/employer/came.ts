/**
 * Откуда работодатель пришёл на форму размещения. Эти две метки приложение передаёт боту с каждым запросом формы,
 * а бот считает по ним воронку числами за день (bot/src/webpost.js, таблица form_events):
 *
 *   from   кнопка, с которой открыли форму: ?tab=post&from=site_header (её же бот пишет в jobs.came_from)
 *   via    источник визита на сайт (google, chatgpt, tg, direct…): сайт сам дописывает &via=… к ссылке на форму
 *
 * О человеке и его устройстве в метках ничего нет. В Telegram и в приложении via нет: форма работает и без него.
 */
export type Came = { from?: string; via?: string };

const VIA = /^[a-z0-9]{1,8}$/;

/** via из адреса страницы: пустая строка, если метки нет или она не по формату. */
export const viaOf = (value: string | null | undefined): string => (value && VIA.test(value) ? value : '');

/** Метки для запросов формы: пустые не передаём. */
export const cameOf = (from?: string, via?: string): Came => ({ ...(from ? { from } : {}), ...(via ? { via } : {}) });

/** Адрес запроса с метками: …/api/post?from=site_header&via=google. Без меток адрес не меняется. */
export function withCame(url: string, { from, via }: Came): string {
  const query = [from ? `from=${encodeURIComponent(from)}` : '', via ? `via=${encodeURIComponent(via)}` : ''].filter(Boolean).join('&');
  return query ? `${url}?${query}` : url;
}
