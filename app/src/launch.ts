/**
 * Разбор ссылки запуска t.me/vacantekz_bot?startapp=<параметр>. Telegram передаёт одно значение,
 * поэтому источник перехода, город и вакансия собраны в одну строку. Собирает её сбор
 * (vacante/launch.py), формат общий:
 *
 *   [s<метка>_] v_<город>_<id вакансии>   вакансия открыта сразу
 *   [s<метка>_] c_<город>                 лента города
 *   [s<метка>_] ref_<код>                 приглашение друга
 *   [s<метка>_] beta                      тестовая ссылка
 *
 * Старые ссылки без префикса (almaty, ref_abc123, beta) работают как раньше.
 */
export type Launch = {
  /** Откуда пришёл человек: «tg» — свои каналы, метка рекламы, видео и так далее. */
  source?: string;
  city?: string;
  vacancyId?: string;
  ref?: string;
  beta?: boolean;
};

const SOURCE = /^s([a-z0-9]{1,8})_(.+)$/;
const VACANCY = /^v_([a-z-]{2,30})_([A-Za-z0-9_-]+)$/;
const CITY = /^c_([a-z-]{2,30})$/;
const REF = /^ref_([a-z0-9]{6})$/;
const OLD_CITY = /^[a-z][a-z-]{1,30}$/;

function body(value: string): Launch | undefined {
  if (value === 'beta') return { beta: true };
  const vacancy = VACANCY.exec(value);
  if (vacancy) return { city: vacancy[1], vacancyId: vacancy[2] };
  const city = CITY.exec(value);
  if (city) return { city: city[1] };
  const ref = REF.exec(value);
  if (ref) return { ref: ref[1] };
  return undefined;
}

export function parseLaunch(raw: string | undefined): Launch {
  if (!raw) return {};
  const tagged = SOURCE.exec(raw);
  if (tagged) {
    const rest = body(tagged[2]);
    if (rest) return { source: tagged[1], ...rest };
  }
  return body(raw) ?? (OLD_CITY.test(raw) ? { city: raw } : {});
}
