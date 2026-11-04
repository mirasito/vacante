// Отклики без интерфейса: откуда вакансия и какими способами на неё откликнуться,
// отклики с телефона в том же виде, что с сервера, общая стадия поиска.
import type { Application, Goal, GoalValue, ImportItem, Method, SearchStage, Stage, Summary, VacancyCopy } from '../server';
import type { Liked, Vacancy } from '../types';

export type Source = 'channel' | 'bot' | 'hh' | 'other';

/** Откуда вакансия: пост в канале, наш бот или hh.kz. */
export function sourceOf(url: string | null | undefined): Source {
  if (!url) return 'other';
  if (/^https:\/\/t\.me\/vacantekz_bot\?start=apply_\d+$/.test(url)) return 'bot';
  if (/^https:\/\/t\.me\/[A-Za-z]\w{3,31}\/\d+$/.test(url)) return 'channel';
  if (/^https:\/\/([\w-]+\.)?hh\.(kz|ru)\//.test(url)) return 'hh';
  return 'other';
}

/** Копия вакансии для отклика: только то, что и так есть в открытой ленте. */
export const copyOf = (v: Vacancy, city: string | null): VacancyCopy => ({
  id: v.id,
  title: v.title,
  title_kk: v.title_kk ?? null,
  employer: v.employer ?? null,
  city,
  address: v.address ?? null,
  map: v.map ?? null,
  url: v.url ?? null,
  source_url: v.source_url ?? null,
  contact: v.contact ?? [],
});

/** Способы отклика: первый главный. Пост в канале открыть можно всегда. */
export function methodsFor(v: VacancyCopy): Method[] {
  const source = sourceOf(v.source_url);
  if (source === 'bot') return ['bot'];
  if (source === 'hh') return ['hh'];
  if (source !== 'channel') return ['post'];
  const kinds = v.contact;
  const out: Method[] = [];
  // Номер без пометки «WhatsApp» почти всегда мобильный, а WhatsApp есть почти у всех
  if (kinds.includes('whatsapp') || kinds.includes('phone')) out.push('whatsapp');
  if (kinds.includes('phone')) out.push('call');
  if (kinds.includes('telegram')) out.push('telegram');
  out.push('post');
  return out;
}

/** Нужен ли для способа номер или имя из поста (их даёт сервер в момент отклика). */
export const needsContact = (m: Method) => m === 'whatsapp' || m === 'call' || m === 'telegram';

export const waUrl = (phone: string, text: string) => `https://wa.me/${phone.replace(/\D/g, '')}?text=${encodeURIComponent(text)}`;

/** Вакансия, на которую ещё не откликнулись: просмотр и ответ работодателя двигают её вперёд. */
export const CLOSED: Stage[] = ['rejected', 'no_answer', 'not_interested'];
const SEARCH_OF: Record<Stage, number> = {
  liked: 0,
  sent: 1,
  seen: 1,
  invited: 2,
  interview: 2,
  offer: 3,
  hired: 4,
  rejected: 0,
  no_answer: 0,
  not_interested: 0,
};
export const SEARCH: SearchStage[] = ['looking', 'applying', 'interviews', 'choosing', 'working'];

/** Отклик с телефона в виде отклика с сервера. id отрицательный: на сервере такого ещё нет. */
export function fromLiked(l: Liked, i: number): Application {
  return {
    id: -(i + 1),
    vacancy: copyOf(l, l.city),
    method: l.method ?? null,
    stage: l.stage ?? 'liked',
    interview_at: l.interview_at ?? null,
    start_at: l.start_at ?? null,
    note: l.note ?? null,
    created_at: l.liked_at,
    updated_at: l.sent_at ?? l.liked_at,
    sent_at: l.sent_at ?? null,
    seen_at: null,
    views: 0,
    link: null,
  };
}

/** Что отправить на сервер, когда появился профиль. */
export const toImport = (l: Liked): ImportItem => ({
  vacancy: copyOf(l, l.city),
  liked_at: l.liked_at,
  sent_at: l.sent_at ?? null,
  ...(l.stage ? { stage: l.stage } : {}),
  ...(l.method ? { method: l.method } : {}),
  ...(l.interview_at ? { interview_at: l.interview_at } : {}),
  ...(l.start_at ? { start_at: l.start_at } : {}),
  ...(l.note ? { note: l.note } : {}),
});

/** Неделя с понедельника по времени Казахстана (UTC+5), как считает сервер. */
export function weekStart(now: number): number {
  const d = new Date(now + 5 * 3600_000);
  const sinceMonday = (d.getUTCDay() + 6) % 7;
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - sinceMonday) - 5 * 3600_000;
}

const WEEK = 7 * 86_400_000;
/** Понедельник недели, ГГГГ-ММ-ДД по времени Казахстана: так недели называет сервер. */
export const weekKey = (ms: number) => new Date(weekStart(ms) + 5 * 3600_000).toISOString().slice(0, 10);
const weekMs = (key: string) => Date.parse(`${key}T00:00:00Z`) - 5 * 3600_000;

/**
 * Серия недель с выполненной целью, как на сервере (server/src/progress.ts): недели от старых к идущей.
 * Идущая неделя прибавляет, когда цель уже выполнена, и не обрывает. Неделя без цели обрывает,
 * невыполненная прощается, если в 3 соседние недели прощённых не было: один пропуск в месяц.
 */
export function streakOf(weeks: { goal: number; sent: number }[]): { streak: number; forgiven: boolean } {
  const current = weeks.length - 1;
  let streak = 0;
  let pass: number | null = null;
  let atLastWeek: number | null = null;
  for (let i = current; i >= 0; i--) {
    const w = weeks[i]!;
    if (!w.goal) break;
    if (w.sent >= w.goal) streak++;
    else if (i === current) continue;
    else if (pass === null || pass - i >= 4) {
      pass = i;
      if (i === current - 1) atLastWeek = streak;
    } else break;
  }
  return { streak, forgiven: atLastWeek !== null && streak > atLastWeek };
}

/** Цель без профиля: с какой недели какая цель (0 — выключена). Хранится на телефоне. */
export type GoalHistory = { week: string; goal: number }[];

/** Цель с этой недели: прежняя запись этой недели заменяется. */
export function withGoal(history: GoalHistory, goal: GoalValue | null, now = Date.now()): GoalHistory {
  const week = weekKey(now);
  return [...history.filter((h) => h.week < week), { week, goal: goal ?? 0 }].slice(-60);
}

/** Цель и серия по откликам с телефона. */
export function localGoal(items: Application[], history: GoalHistory, now = Date.now()): Goal {
  const counts = new Map<string, number>();
  for (const a of items) {
    if (!a.sent_at) continue;
    const key = weekKey(Date.parse(a.sent_at));
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const current = weekStart(now);
  const sorted = [...history].sort((x, y) => (x.week < y.week ? -1 : 1));
  if (!sorted.length) return { goal: null, sent: counts.get(weekKey(now)) ?? 0, streak: 0, forgiven: false };
  const weeks: { goal: number; sent: number }[] = [];
  let goal = 0;
  let i = 0;
  for (let w = Math.max(weekMs(sorted[0]!.week), current - 52 * WEEK); w <= current; w += WEEK) {
    const key = weekKey(w);
    while (i < sorted.length && sorted[i]!.week <= key) goal = sorted[i++]!.goal;
    weeks.push({ goal, sent: counts.get(key) ?? 0 });
  }
  const thisWeek = weeks[weeks.length - 1]!;
  return { goal: thisWeek.goal ? (thisWeek.goal as GoalValue) : null, sent: thisWeek.sent, ...streakOf(weeks) };
}

/** Сводка для откликов с телефона: без просмотров, их видит только сервер. */
export function localSummary(items: Application[], history: GoalHistory = [], now = Date.now()): Summary {
  const from = new Date(weekStart(now)).toISOString();
  const counts = Object.fromEntries(Object.keys(SEARCH_OF).map((s) => [s, 0])) as Record<Stage, number>;
  let furthest = 0;
  for (const a of items) {
    counts[a.stage]++;
    if (!CLOSED.includes(a.stage)) furthest = Math.max(furthest, SEARCH_OF[a.stage]);
  }
  const soon = items
    .filter((a) => a.stage === 'interview' && a.interview_at && Date.parse(a.interview_at) > now - 2 * 3_600_000)
    .sort((a, b) => Date.parse(a.interview_at!) - Date.parse(b.interview_at!))[0];
  return {
    stage: SEARCH[furthest] ?? 'looking',
    week: {
      from,
      sent: items.filter((a) => a.sent_at && Date.parse(a.sent_at) >= Date.parse(from)).length,
      seen: 0,
      invited: 0,
    },
    next_interview: soon
      ? { id: soon.id, at: soon.interview_at!, title: soon.vacancy.title, employer: soon.vacancy.employer, address: soon.vacancy.address }
      : null,
    counts,
    goal: localGoal(items, history, now),
    // Достижения записывает сервер: без профиля их нет
    achievements: [],
  };
}

/** Как отклик меняется от правки, так же как на сервере: дата собеседования ставит «Собеседование». */
export function applyPatch<T extends { stage?: Stage; sent_at?: string | null; interview_at?: string | null }>(
  item: T,
  patch: Partial<Application>,
  now = new Date().toISOString(),
): T {
  const stageNow = item.stage ?? 'liked';
  let stage = patch.stage ?? stageNow;
  if (patch.interview_at && patch.stage === undefined && ['liked', 'sent', 'seen', 'invited'].includes(stageNow)) {
    stage = 'interview';
  }
  const sent = item.sent_at ?? (stage !== 'liked' && !CLOSED.includes(stage) ? now : null);
  return { ...item, ...patch, stage, sent_at: sent };
}
