// Кабинет работодателя: его вакансии и смены из бота, отклики, оплата размещения, тариф Про и пакеты.
// Данные живут в базе бота (bot/src/cabinet.js), вход — подписанные данные Telegram (initData), как у профиля.
// На сайте вне Telegram вход через бота (src/Login.tsx, bot/src/login.js): тот же ключ, что у профиля соискателя.
// Вакансию размещают прямо здесь, формой PostForm.tsx (вставить текст или ссылку, проверить, оплатить).
// Смену на день пока ведёт анкета в боте.
import { useCallback, useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Icon } from '../icons';
import { Login } from '../Login';
import { BOT, confirm, openUrl } from '../platform';
import { authHeader, initData, setSession } from '../session';
import type { Colors } from '../theme';
import type { Lang } from '../types';
import { Badge, Button, Loading, styles as ui } from '../ui';
import { AuthError, call, money, type Action, type CabinetState } from './api';
import { PayBox } from './PayBox';
import { PostForm } from './PostForm';

export type { CabinetJob, CabinetState } from './api';
export { CABINET_URL } from './api';

/** «1 вакансия», «3 вакансии», «10 вакансий» */
const vacancies = (n: number) => {
  const d = n % 10;
  const h = n % 100;
  return d === 1 && h !== 11 ? 'вакансия' : d >= 2 && d <= 4 && (h < 12 || h > 14) ? 'вакансии' : 'вакансий';
};

const T = {
  ru: {
    title: 'Кабинет работодателя',
    back: 'Назад',
    hello: (name: string) => `Здравствуйте, ${name}!`,
    lead: 'Здесь ваши вакансии и смены, отклики и оплата. Отклики кандидатов приходят вам в Telegram, в чат с ботом @vacantekz_bot.',
    post: 'Разместить вакансию',
    shift: 'Смена на день',
    draft: (title: string) => `Продолжить черновик${title ? ` «${title}»` : ''}`,
    empty: 'Вакансий пока нет. Разместите первую: это пара минут, можно просто вставить готовый текст объявления.',
    noTelegram: 'Войдите, чтобы видеть свои вакансии, отклики и оплату.',
    logout: 'Выйти',
    openBot: 'Открыть бота',
    error: 'Не получилось загрузить кабинет. Проверьте интернет и попробуйте ещё раз.',
    retry: 'Попробовать снова',
    loading: 'Загружаем ваши вакансии…',
    apps: (n: number) => (n ? `Отклики: ${n}` : 'Откликов пока нет'),
    shiftTaken: (c: number, need: number) => `Взяли ${c} из ${need}`,
    site: 'На сайте',
    close: 'Закрыть',
    closeAsk: 'Закрыть вакансию? Она уйдёт с сайта и из приложения в течение часа.',
    yes: 'Закрыть',
    no: 'Отмена',
    pro: (price: string) => `🔥 Про: ${price}`,
    proMore: (price: string) => `Продлить Про: ${price}`,
    proUntil: (d: string) => `🔥 Про до ${d}`,
    proWhat: (days: number, shift: boolean) =>
      shift
        ? 'Смена первой в разделе «Подработка и смены» города до её начала, с пометкой «🔥 Срочно» и закрепом в канале.'
        : `${days} дней первой в списке города с пометкой «🔥 Срочно», закреп в канале и повтор через неделю, в конце итог по откликам.`,
    fromPack: (n: number) => `Про из пакета (осталось ${n})`,
    pending: 'На проверке, обычно до часа (с 8:00 до 22:00).',
    rejected: 'Не опубликована. Причину бот написал в чате, можно исправить и отправить снова.',
    payTitle: (tariff: string, price: string) => `Оплата размещения, тариф ${tariff}: ${price}`,
    payHow: 'Переведите сумму на Kaspi и в комментарии напишите',
    copy: 'Скопировать',
    copied: 'Скопировано',
    paid: 'Я оплатил',
    waiting: 'Сверяем перевод, обычно до пары часов днём. Напишем в чат с ботом.',
    basic: 'Базовый',
    proName: 'Про',
    packs: 'Пакеты Про',
    packsLead: 'Для сетей и тех, кто нанимает часто: каждая вакансия из пакета получает тариф Про.',
    pack: (count: number, price: string, one: string, days: number) => `${count} ${vacancies(count)} за ${price} · ${one} за одну · на ${days} дней`,
    packBuy: 'Купить',
    credits: (n: number) => `Осталось Про в пакетах: ${n}`,
    packWaiting: 'Сверяем перевод за пакет. Напишем в чат с ботом, как только включим.',
    tariffs: 'Тарифы',
    tariffBasic: (price: string) => `Базовый ${price}: сайт, приложение, подборки и канал города на 30 дней.`,
    tariffPro: (price: string, days: number) => `Про ${price} на ${days} дней: первой в городе, закреп и повтор в канале.`,
    free: 'Вы модератор каналов vacante: видите оплату, как работодатели, а без оплаты можно разместить отдельной кнопкой «🛡 Без оплаты».',
  },
  kk: {
    title: 'Жұмыс беруші кабинеті',
    back: 'Артқа',
    hello: (name: string) => `Сәлеметсіз бе, ${name}!`,
    lead: 'Мұнда @vacantekz_bot ботындағы вакансиялар мен ауысымдарыңыз, жауаптар және төлем. Жауаптар бот чатына келеді.',
    post: 'Вакансия орналастыру',
    shift: 'Бір күнге ауысым',
    draft: (title: string) => `Жобаны жалғастыру${title ? ` «${title}»` : ''}`,
    empty: 'Әзірге вакансия жоқ. Біріншісін орналастырыңыз: бірнеше минут, дайын хабарландыру мәтінін қоюға болады.',
    noTelegram: 'Вакансияларыңызды, жауаптар мен төлемді көру үшін кіріңіз.',
    logout: 'Шығу',
    openBot: 'Ботты ашу',
    error: 'Кабинетті жүктеу мүмкін болмады. Интернетті тексеріп, қайталап көріңіз.',
    retry: 'Қайталау',
    loading: 'Вакансияларыңызды жүктеп жатырмыз…',
    apps: (n: number) => (n ? `Жауаптар: ${n}` : 'Әзірге жауап жоқ'),
    shiftTaken: (c: number, need: number) => `${need}-ден ${c} алынды`,
    site: 'Сайтта',
    close: 'Жабу',
    closeAsk: 'Вакансияны жабу керек пе? Ол бір сағат ішінде сайт пен қосымшадан кетеді.',
    yes: 'Жабу',
    no: 'Болдырмау',
    pro: (price: string) => `🔥 Про: ${price}`,
    proMore: (price: string) => `Про ұзарту: ${price}`,
    proUntil: (d: string) => `🔥 Про ${d} дейін`,
    proWhat: (days: number, shift: boolean) =>
      shift
        ? 'Ауысым басталғанға дейін қаланың «Қосымша жұмыс және ауысымдар» бөлімінде «🔥 Шұғыл» белгісімен бірінші, арнада бекітіледі.'
        : `${days} күн қала тізімінде «🔥 Шұғыл» белгісімен бірінші, арнада бекітілген пост пен бір аптадан кейін қайта пост, соңында жауаптар қорытындысы.`,
    fromPack: (n: number) => `Пакеттен Про (қалды ${n})`,
    pending: 'Тексеруде, әдетте бір сағатқа дейін (8:00–22:00).',
    rejected: 'Жарияланбады. Себебін бот чатта жазды, түзетіп қайта жіберуге болады.',
    payTitle: (tariff: string, price: string) => `Орналастыру төлемі, ${tariff} тарифі: ${price}`,
    payHow: 'Соманы Kaspi-ге аударыңыз, түсініктемеге жазыңыз',
    copy: 'Көшіру',
    copied: 'Көшірілді',
    paid: 'Төледім',
    waiting: 'Аударымды тексеріп жатырмыз, күндіз әдетте екі сағатқа дейін. Бот чатына жазамыз.',
    basic: 'Базалық',
    proName: 'Про',
    packs: 'Про пакеттері',
    packsLead: 'Желілер мен жиі жалдайтындарға: пакеттегі әр вакансия Про тарифін алады.',
    pack: (count: number, price: string, one: string, days: number) => `${count} вакансия ${price} · біреуі ${one} · ${days} күнге`,
    packBuy: 'Сатып алу',
    credits: (n: number) => `Пакеттерде қалған Про: ${n}`,
    packWaiting: 'Пакет аударымын тексеріп жатырмыз. Қосқан бойда бот чатына жазамыз.',
    tariffs: 'Тарифтер',
    tariffBasic: (price: string) => `Базалық ${price}: сайт, қосымша, іріктемелер және қала арнасы 30 күнге.`,
    tariffPro: (price: string, days: number) => `Про ${price}, ${days} күнге: қалада бірінші, арнада бекіту және қайта пост.`,
    free: 'Сіз vacante арналарының модераторысыз: төлемді жұмыс берушілер сияқты көресіз, төлемсіз «🛡 Төлемсіз» батырмасымен орналастыруға болады.',
  },
};

export function Cabinet(props: { c: Colors; lang: Lang; onClose(): void; startPost?: boolean; from?: string }) {
  const { c, lang } = props;
  const t = T[lang];
  const [state, setState] = useState<CabinetState | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState('');
  const [note, setNote] = useState<{ text: string; error?: boolean } | null>(null);
  const [open, setOpen] = useState('');  // какая панель оплаты раскрыта: boost:12, post:12, pack:3
  const [authed, setAuthed] = useState(() => !!authHeader());
  // Форма размещения: по ссылке ?tab=post (кнопка «Разместить вакансию» на сайте) или кнопкой здесь
  const [posting, setPosting] = useState(!!props.startPost);

  const load = useCallback(async () => {
    setFailed(false);
    try {
      setState(await call());
    } catch (e) {
      if (e instanceof AuthError) setAuthed(false);
      else setFailed(true);
    }
  }, []);
  useEffect(() => {
    if (authed) load();
  }, [authed, load]);
  const logout = () => {
    setSession('');
    setState(null);
    setAuthed(false);
  };

  const act = async (key: string, body: Action) => {
    setBusy(key);
    setNote(null);
    try {
      const next = await call(body);
      setState(next);
      setNote(next.error ? { text: next.error, error: true } : next.message ? { text: next.message } : null);
      if (!next.error) setOpen('');
      return !next.error;
    } catch (e) {
      if (e instanceof AuthError) setAuthed(false);
      else setNote({ text: e instanceof Error ? e.message : t.error, error: true });
      return false;
    } finally {
      setBusy('');
    }
  };
  const bot = (start: string) => openUrl(`https://t.me/${BOT}?start=${start}`);

  const header = (
    <View style={styles.top}>
      <Pressable onPress={props.onClose} hitSlop={10} accessibilityRole="button" accessibilityLabel={t.back} style={styles.back}>
        <Icon name="back" color={c.ink} />
      </Pressable>
      <Text style={[styles.h1, { color: c.ink }]}>{t.title}</Text>
    </View>
  );

  let body;
  if (!authed) {
    body = <Login c={c} lang={lang} intro={t.noTelegram} onDone={() => setAuthed(true)} />;
  } else if (failed) {
    body = (
      <View style={styles.gap}>
        <Text style={[styles.text, { color: c.ink }]}>{t.error}</Text>
        <Button c={c} label={t.retry} onPress={load} />
      </View>
    );
  } else if (!state) {
    body = <Loading c={c} text={t.loading} />;
  } else {
    const kaspi = state.kaspi;
    body = (
      <View style={styles.gap}>
        <Text style={[styles.text, { color: c.quiet }]}>
          {state.user.first_name ? `${t.hello(state.user.first_name)} ` : ''}
          {t.lead}
        </Text>
        <Button c={c} label={state.draft ? t.draft(state.draft.title) : t.post} onPress={() => setPosting(true)} />
        <Button c={c} ghost label={t.shift} onPress={() => bot('smena_app')} />
        {note ? (
          <View style={[styles.note, { backgroundColor: note.error ? c.warnBg : c.okBg }]}>
            <Text style={[styles.text, { color: note.error ? c.warnInk : c.okInk }]}>{note.text}</Text>
          </View>
        ) : null}
        {state.admin ? <Text style={[styles.small, { color: c.quiet }]}>{t.free}</Text> : null}
        {state.credits ? <Badge c={c} tone="ok" label={t.credits(state.credits)} /> : null}

        {state.jobs.length === 0 ? <Text style={[styles.text, { color: c.ink }]}>{t.empty}</Text> : null}
        {state.jobs.map((j) => {
          const meta = [j.company, j.city, j.kind === 'shift' && j.shift_date ? j.shift_date.split('-').reverse().slice(0, 2).join('.') : null]
            .filter(Boolean)
            .join(' · ');
          return (
            <View key={j.id} style={[styles.card, { borderColor: c.line, backgroundColor: c.card }]}>
              <View style={styles.cardHead}>
                <View style={ui.flex}>
                  <Text style={[styles.h3, { color: c.ink }]}>
                    {j.kind === 'shift' ? '⚡ ' : ''}
                    {j.title}
                  </Text>
                  <Text style={[styles.small, { color: c.quiet }]}>{meta}</Text>
                  <Text style={[styles.small, { color: c.ink }]}>{j.salary}</Text>
                </View>
                <Badge c={c} tone={j.status === 'approved' ? 'ok' : j.status === 'payment' ? 'warn' : undefined} label={j.status_text} />
              </View>
              {j.pro_until ? <Badge c={c} tone="warn" label={t.proUntil(j.pro_until)} /> : null}
              {j.status === 'pending' ? <Text style={[styles.small, { color: c.quiet }]}>{t.pending}</Text> : null}
              {j.status === 'rejected' ? <Text style={[styles.small, { color: c.quiet }]}>{t.rejected}</Text> : null}

              {j.status === 'approved' ? (
                <View style={styles.row}>
                  <View style={ui.flex}>
                    <Button
                      c={c}
                      small
                      ghost
                      label={j.kind === 'shift' && j.need ? t.shiftTaken(j.confirmed ?? 0, j.need) : t.apps(j.applications)}
                      busy={busy === `apps:${j.id}`}
                      disabled={j.kind === 'shift' || !j.applications}
                      onPress={() => act(`apps:${j.id}`, { action: 'apps', id: j.id })}
                    />
                  </View>
                  {j.url ? (
                    <View style={ui.flex}>
                      <Button c={c} small ghost label={t.site} onPress={() => openUrl(j.url!)} />
                    </View>
                  ) : null}
                </View>
              ) : null}

              {j.pay && kaspi ? (
                j.pay.waiting ? (
                  <Text style={[styles.small, { color: c.quiet }]}>{t.waiting}</Text>
                ) : (
                  <>
                    <Text style={[styles.strong, { color: c.ink }]}>
                      {t.payTitle(j.pay.tariff === 'pro' ? t.proName : t.basic, money(j.pay.amount))}
                    </Text>
                    <PayBox c={c} t={t} kaspi={kaspi} comment={`№${j.id}`} busy={busy === `post:${j.id}`}
                      onPaid={() => act(`post:${j.id}`, { action: 'paid_post', id: j.id })} />
                  </>
                )
              ) : null}

              {j.boost ? (
                j.boost.waiting ? (
                  <Text style={[styles.small, { color: c.quiet }]}>{t.waiting}</Text>
                ) : (
                  <>
                    <View style={styles.row}>
                      <View style={ui.flex}>
                        <Button c={c} small label={(j.boost.active ? t.proMore : t.pro)(money(j.boost.price))}
                          onPress={() => setOpen(open === `boost:${j.id}` ? '' : `boost:${j.id}`)} />
                      </View>
                      {state.credits > 0 && !j.boost.shift ? (
                        <View style={ui.flex}>
                          <Button c={c} small ghost label={t.fromPack(state.credits)} busy={busy === `credit:${j.id}`}
                            onPress={() => act(`credit:${j.id}`, { action: 'credit', id: j.id })} />
                        </View>
                      ) : null}
                    </View>
                    {open === `boost:${j.id}` && kaspi ? (
                      <>
                        <Text style={[styles.small, { color: c.quiet }]}>{t.proWhat(j.boost.days, j.boost.shift)}</Text>
                        <PayBox c={c} t={t} kaspi={kaspi} comment={`№${j.id}`} busy={busy === `boost:${j.id}`}
                          onPaid={() => act(`boost:${j.id}`, { action: 'paid_boost', id: j.id })} />
                      </>
                    ) : null}
                  </>
                )
              ) : null}

              {['approved', 'pending', 'payment'].includes(j.status) ? (
                <Pressable
                  accessibilityRole="button"
                  onPress={async () => {
                    if (await confirm(t.closeAsk, t.yes, t.no)) act(`close:${j.id}`, { action: 'close', id: j.id });
                  }}
                >
                  <Text style={[styles.link, { color: c.skip }]}>{t.close}</Text>
                </Pressable>
              ) : null}
            </View>
          );
        })}

        {state.tariffs ? (
          <View style={styles.gap}>
            <Text style={[styles.sec, { color: c.quiet }]}>{t.tariffs}</Text>
            <Text style={[styles.small, { color: c.ink }]}>{t.tariffBasic(money(state.tariffs.post))}</Text>
            <Text style={[styles.small, { color: c.ink }]}>{t.tariffPro(money(state.tariffs.pro), state.tariffs.days)}</Text>
          </View>
        ) : null}
        {state.tariffs && state.tariffs.packs.length && kaspi ? (
          <View style={styles.gap}>
            <Text style={[styles.sec, { color: c.quiet }]}>{t.packs}</Text>
            <Text style={[styles.small, { color: c.quiet }]}>{t.packsLead}</Text>
            {state.pack_waiting ? <Text style={[styles.small, { color: c.quiet }]}>{t.packWaiting}</Text> : null}
            {state.tariffs.packs.map((p) => (
              <View key={p.count} style={[styles.card, { borderColor: c.line, backgroundColor: c.card }]}>
                <View style={styles.cardHead}>
                  <Text style={[styles.text, ui.flex, { color: c.ink }]}>
                    📦 {t.pack(p.count, money(p.price), money(Math.round(p.price / p.count)), p.days)}
                  </Text>
                  {!state.pack_waiting ? (
                    <Button c={c} small label={t.packBuy} onPress={() => setOpen(open === `pack:${p.count}` ? '' : `pack:${p.count}`)} />
                  ) : null}
                </View>
                {open === `pack:${p.count}` && !state.pack_waiting ? (
                  <PayBox c={c} t={t} kaspi={kaspi} comment={`Пакет ${p.count}`} busy={busy === `pack:${p.count}`}
                    onPaid={() => act(`pack:${p.count}`, { action: 'paid_pack', count: p.count })} />
                ) : null}
              </View>
            ))}
          </View>
        ) : null}
        {!initData() ? (
          <Pressable onPress={logout} accessibilityRole="button" style={styles.logout}>
            <Text style={[styles.link, { color: c.quiet }]}>{t.logout}</Text>
          </Pressable>
        ) : null}
      </View>
    );
  }

  if (posting) {
    return (
      <PostForm
        c={c}
        lang={lang}
        from={props.from || 'cabinet'}
        state={authed ? state : null}
        onState={setState}
        onAuthed={() => setAuthed(true)}
        onCabinet={() => {
          setPosting(false);
          if (authed) load();
        }}
        onClose={() => (props.startPost && !state ? props.onClose() : setPosting(false))}
      />
    );
  }

  return (
    <SafeAreaView style={[styles.page, { backgroundColor: c.bg }]} edges={['top', 'bottom']}>
      <View style={ui.column}>
        {header}
        <ScrollView contentContainerStyle={styles.body}>{body}</ScrollView>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1 },
  top: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingVertical: 8 },
  back: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  h1: { fontSize: 22, fontWeight: '800', letterSpacing: -0.4, flexShrink: 1 },
  body: { paddingHorizontal: 20, paddingBottom: 28 },
  gap: { gap: 12 },
  row: { flexDirection: 'row', gap: 8 },
  text: { fontSize: 15, lineHeight: 21 },
  small: { fontSize: 13, lineHeight: 18 },
  strong: { fontSize: 15, fontWeight: '700', flexShrink: 1 },
  h3: { fontSize: 16, fontWeight: '700' },
  sec: { fontSize: 12, fontWeight: '800', letterSpacing: 0.5, textTransform: 'uppercase', marginTop: 8 },
  link: { fontSize: 14, fontWeight: '600' },
  note: { borderRadius: 12, padding: 12 },
  card: { borderWidth: 1, borderRadius: 16, padding: 14, gap: 10 },
  cardHead: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  logout: { alignSelf: 'center', padding: 12, marginTop: 8 },
});
