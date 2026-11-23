// Размещение вакансии целиком здесь, на сайте и в приложении, без анкеты в чате с ботом.
// 1. Заполнить: вставить готовый текст или ссылку (hh.kz, пост в Telegram) — поля заполнятся сами, или вписать руками.
//    Черновик хранится на устройстве сразу, а после входа ещё и в боте (действие save): его можно дописать и в чате.
// 2. Проверить: бот приводит текст в порядок (bot/src/tidy.js), работодатель видит карточку, как её увидят кандидаты,
//    и выбирает тариф.
// 3. Оплатить: платный тариф ставит вакансию в «ждёт оплаты» (bot/src/webpost.js), на проверку она уходит только
//    после подтверждения перевода. Реквизиты Kaspi и «Я оплатил» здесь же.
// Вход через Telegram нужен один раз перед отправкой: туда приходят отклики кандидатов.
import { type ComponentRef, useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Icon } from '../icons';
import { Login } from '../Login';
import { authHeader } from '../session';
import { read, write } from '../storage';
import type { Colors } from '../theme';
import type { Lang } from '../types';
import { Button, Chip, Loading, styles as ui } from '../ui';
import { AuthError, call, money, postApi, type ActionResult, type CabinetState, type PostFields, type PostInfo } from './api';
import { PayBox } from './PayBox';

const LOCAL = 'vacante.postDraft';
const EMPTY: PostFields = { city: '', title: '', company: '', salary: '', schedule: '', address: '', details: '' };
type Tariff = 'basic' | 'pro' | 'credit' | 'free';

const T = {
  ru: {
    title: 'Разместить вакансию',
    back: 'Назад',
    steps: ['Заполнить', 'Проверить', 'Оплатить'],
    lead: 'Вакансия выйдет на vacante.kz, в приложении, в подборках тем, кто ищет работу, и в Telegram-канале вашего города.',
    pasteTitle: 'Есть готовое объявление?',
    pasteLead: 'Вставьте сюда текст вакансии или ссылку на неё (hh.kz, пост в Telegram-канале). Поля ниже заполнятся сами.',
    pasteHint: 'Например: Требуется повар в кафе «Арман», 15 000 ₸ за смену, Алматы, график 2/2…',
    pasteGo: '✨ Заполнить поля',
    pasted: (names: string) => `Заполнили: ${names}. Проверьте поля ниже и допишите, чего нет.`,
    or: 'или заполните вручную',
    city: 'Город',
    jobTitle: 'Кого ищете',
    jobTitleHint: 'Например, «Официант» или «Повар, помощник повара»',
    company: 'Заведение или компания',
    companyHint: 'Например, кафе «Арман»',
    salary: 'Зарплата',
    salaryHint: 'Например, 250 000 ₸ в месяц или 12 000 ₸ за смену',
    schedule: 'График',
    scheduleHint: 'Например, 2/2, 10:00–22:00',
    address: 'Адрес',
    addressHint: 'Улица и дом или ТЦ, без города',
    details: 'Подробнее',
    detailsHint: 'Обязанности, условия (питание, развозка, оформление), требования',
    detailsNote: 'Телефон писать не нужно: отклики кандидатов придут вам в Telegram.',
    optional: 'необязательно',
    need: (names: string) => `Осталось заполнить: ${names}`,
    next: 'Дальше: проверить',
    saved: 'Черновик сохранён',
    savedHere: 'Черновик сохранён на этом устройстве',
    checkTitle: 'Так вакансию увидят кандидаты',
    tidied: (names: string) => `✨ Поправили оформление: ${names}. Агент-модератор ещё раз проверит текст перед публикацией.`,
    edit: 'Изменить',
    tariff: 'Тариф',
    basic: 'Базовый',
    basicWhat: 'Сайт и приложение на 30 дней, подборки соискателям, пост в канале города, отклики в Telegram.',
    pro: 'Про',
    proWhat: (days: number) => `Всё из Базового, ${days} дней первой в городе с пометкой «🔥 Срочно», закреп и повтор в канале, итог по откликам.`,
    credit: (n: number) => `Про из пакета (осталось ${n})`,
    creditWhat: 'Без оплаты: спишем одну вакансию из вашего пакета.',
    free: '🛡 Без оплаты',
    freeWhat: 'Вы модератор каналов vacante. Работодатели этой кнопки не видят.',
    send: (price: string) => `Отправить и оплатить ${price}`,
    sendFree: 'Отправить на проверку',
    loginTitle: 'Последний шаг: вход через Telegram',
    loginIntro: 'Туда придут отклики кандидатов. После входа вакансия отправится сама.',
    payTitle: (price: string) => `Оплатите ${price}, и вакансия уйдёт на проверку`,
    payHow: 'Переведите сумму на Kaspi и в комментарии напишите',
    copy: 'Скопировать',
    copied: 'Скопировано',
    paid: 'Я оплатил',
    payNote: 'Без оплаты вакансия не публикуется. Если не пропустим её на проверке, деньги вернём.',
    waiting: 'Спасибо! Сверяем перевод, обычно до пары часов днём. Потом проверка, обычно до часа. Напишем в Telegram.',
    pending: 'Отправили на проверку, обычно это до часа (с 8:00 до 22:00). Напишем в Telegram, когда опубликуем.',
    cabinet: 'Мои вакансии',
    another: 'Разместить ещё одну',
    error: 'Не получилось связаться с сервером. Проверьте интернет и попробуйте ещё раз.',
    free_title: 'Бесплатно',
  },
  kk: {
    title: 'Вакансия орналастыру',
    back: 'Артқа',
    steps: ['Толтыру', 'Тексеру', 'Төлеу'],
    lead: 'Вакансия vacante.kz сайтында, қосымшада, жұмыс іздеушілерге іріктемелерде және қалаңыздың Telegram-арнасында шығады.',
    pasteTitle: 'Дайын хабарландыру бар ма?',
    pasteLead: 'Вакансия мәтінін немесе сілтемесін қойыңыз (hh.kz, Telegram-арнадағы пост). Төмендегі өрістер өзі толады.',
    pasteHint: 'Мысалы: «Арман» кафесіне аспаз керек, ауысымына 15 000 ₸, Алматы, 2/2 кесте…',
    pasteGo: '✨ Өрістерді толтыру',
    pasted: (names: string) => `Толтырдық: ${names}. Төмендегі өрістерді тексеріп, жоғын жазыңыз.`,
    or: 'немесе қолмен толтырыңыз',
    city: 'Қала',
    jobTitle: 'Кім керек',
    jobTitleHint: 'Мысалы, «Даяшы» немесе «Аспаз, аспаз көмекшісі»',
    company: 'Мекеме немесе компания',
    companyHint: 'Мысалы, «Арман» кафесі',
    salary: 'Жалақы',
    salaryHint: 'Мысалы, айына 250 000 ₸ немесе ауысымына 12 000 ₸',
    schedule: 'Кесте',
    scheduleHint: 'Мысалы, 2/2, 10:00–22:00',
    address: 'Мекенжай',
    addressHint: 'Көше мен үй немесе СО, қаласыз',
    details: 'Толығырақ',
    detailsHint: 'Міндеттер, жағдайлар (тамақ, тасымал, рәсімдеу), талаптар',
    detailsNote: 'Телефон жазу керек емес: кандидаттардың жауаптары Telegram-ға келеді.',
    optional: 'міндетті емес',
    need: (names: string) => `Толтыру керек: ${names}`,
    next: 'Әрі қарай: тексеру',
    saved: 'Жоба сақталды',
    savedHere: 'Жоба осы құрылғыда сақталды',
    checkTitle: 'Кандидаттар вакансияны осылай көреді',
    tidied: (names: string) => `✨ Безендіруді түзедік: ${names}. Жарияламас бұрын агент-модератор мәтінді тағы тексереді.`,
    edit: 'Өзгерту',
    tariff: 'Тариф',
    basic: 'Базалық',
    basicWhat: 'Сайт пен қосымша 30 күнге, іздеушілерге іріктемелер, қала арнасында пост, жауаптар Telegram-ға.',
    pro: 'Про',
    proWhat: (days: number) => `Базалықтың бәрі, ${days} күн қалада «🔥 Шұғыл» белгісімен бірінші, арнада бекіту және қайта пост, жауаптар қорытындысы.`,
    credit: (n: number) => `Пакеттен Про (қалды ${n})`,
    creditWhat: 'Төлемсіз: пакетіңізден бір вакансия есептейміз.',
    free: '🛡 Төлемсіз',
    freeWhat: 'Сіз vacante арналарының модераторысыз. Жұмыс берушілер бұл батырманы көрмейді.',
    send: (price: string) => `Жіберу және ${price} төлеу`,
    sendFree: 'Тексеруге жіберу',
    loginTitle: 'Соңғы қадам: Telegram арқылы кіру',
    loginIntro: 'Кандидаттардың жауаптары сонда келеді. Кіргеннен кейін вакансия өзі жіберіледі.',
    payTitle: (price: string) => `${price} төлеңіз, вакансия тексеруге кетеді`,
    payHow: 'Соманы Kaspi-ге аударыңыз, түсініктемеге жазыңыз',
    copy: 'Көшіру',
    copied: 'Көшірілді',
    paid: 'Төледім',
    payNote: 'Төлемсіз вакансия жарияланбайды. Тексеруден өтпесе, ақшаны қайтарамыз.',
    waiting: 'Рақмет! Аударымды тексеріп жатырмыз, күндіз әдетте екі сағатқа дейін. Содан соң тексеру, әдетте бір сағатқа дейін. Telegram-ға жазамыз.',
    pending: 'Тексеруге жібердік, әдетте бір сағатқа дейін (8:00–22:00). Жариялағанда Telegram-ға жазамыз.',
    cabinet: 'Менің вакансияларым',
    another: 'Тағы біреуін орналастыру',
    error: 'Серверге қосылу мүмкін болмады. Интернетті тексеріп, қайталап көріңіз.',
    free_title: 'Тегін',
  },
};

const FIELD_ORDER: (keyof PostFields)[] = ['title', 'company', 'salary', 'schedule', 'address', 'details'];
const REQUIRED: (keyof PostFields)[] = ['city', 'title', 'company', 'salary'];

export function PostForm(props: {
  c: Colors;
  lang: Lang;
  from: string;
  /** Состояние кабинета, если уже вошли: черновик из бота, пакеты, модератор ли. */
  state: CabinetState | null;
  onState(next: CabinetState): void;
  onAuthed(): void;
  onCabinet(): void;
  onClose(): void;
}) {
  const { c, lang, state } = props;
  const t = T[lang];
  const [info, setInfo] = useState<PostInfo | null>(null);
  const [fields, setFields] = useState<PostFields>(EMPTY);
  const [loaded, setLoaded] = useState(false);
  const [step, setStep] = useState<'form' | 'check' | 'done'>('form');
  const [paste, setPaste] = useState('');
  const [note, setNote] = useState<{ text: string; error?: boolean } | null>(null);
  const [busy, setBusy] = useState('');
  const [saved, setSaved] = useState('');
  const [tidied, setTidied] = useState('');
  const [tariff, setTariff] = useState<Tariff>('basic');
  const [askLogin, setAskLogin] = useState(false);
  const [result, setResult] = useState<ActionResult | null>(null);
  const [paidSent, setPaidSent] = useState(false);
  const scroll = useRef<ComponentRef<typeof ScrollView>>(null);
  const top = () => scroll.current?.scrollTo({ y: 0, animated: true });

  // Города и тарифы открыты всем; черновик: с устройства, иначе из бота
  useEffect(() => {
    postApi<PostInfo>().then((i) => (i.cities ? setInfo(i) : setNote({ text: t.error, error: true }))).catch(() => setNote({ text: t.error, error: true }));
    read<PostFields | null>(LOCAL, null).then((local) => {
      if (local && Object.values(local).some(Boolean)) setFields({ ...EMPTY, ...local });
      setLoaded(true);
    });
  }, [t]);
  const serverDraft = state?.draft;
  useEffect(() => {
    if (!loaded || !serverDraft) return;
    setFields((f) => (Object.values(f).some(Boolean) ? f : { ...EMPTY, ...serverDraft, city: serverDraft.city || '' }));
  }, [loaded, serverDraft]);

  // Сохраняем черновик: на устройстве сразу, в боте через пару секунд тишины (если вошли)
  const authed = !!authHeader();
  const first = useRef(true);
  useEffect(() => {
    if (!loaded || step === 'done') return;
    if (first.current) {
      first.current = false;
      return;
    }
    write(LOCAL, fields);
    setSaved(t.savedHere);
    if (!authed || !Object.values(fields).some(Boolean)) return;
    const timer = setTimeout(() => {
      call({ action: 'save', fields, from: props.from })
        .then(() => setSaved(t.saved))
        .catch(() => undefined);
    }, 2000);
    return () => clearTimeout(timer);
  }, [fields, loaded, authed, step, t, props.from]);

  const set = (field: keyof PostFields, value: string) => setFields((f) => ({ ...f, [field]: value }));
  const labels: Record<keyof PostFields, string> = {
    city: t.city, title: t.jobTitle, company: t.company, salary: t.salary, schedule: t.schedule, address: t.address, details: t.details,
  };
  const lack = REQUIRED.filter((f) => !fields[f].trim());

  const fill = async () => {
    setBusy('paste');
    setNote(null);
    try {
      const r = await postApi<{ fields: Partial<PostFields>; found: (keyof PostFields)[] }>({ action: 'parse', text: paste });
      if (r.error || !r.fields) {
        setNote({ text: r.error || t.error, error: true });
        return;
      }
      setFields((f) => ({ ...f, ...Object.fromEntries(Object.entries(r.fields).filter(([, v]) => v)) }));
      setNote({ text: t.pasted(r.found.map((f) => labels[f].toLowerCase()).join(', ')) });
      setPaste('');
    } catch {
      setNote({ text: t.error, error: true });
    } finally {
      setBusy('');
    }
  };

  const check = async () => {
    setBusy('check');
    setNote(null);
    try {
      const r = await postApi<{ fields: Partial<PostFields>; changed_names: string[] }>({ action: 'tidy', fields });
      if (r.fields) setFields((f) => ({ ...f, ...r.fields }));
      setTidied(r.changed_names?.length ? t.tidied(r.changed_names.join(', ')) : '');
      setStep('check');
      top();
    } catch {
      setNote({ text: t.error, error: true });
    } finally {
      setBusy('');
    }
  };

  const submit = useCallback(async () => {
    if (!authHeader()) {
      setAskLogin(true);
      return;
    }
    setBusy('submit');
    setNote(null);
    try {
      const r = await call({ action: 'submit', fields, tariff, from: props.from });
      props.onState(r);
      if (r.error) {
        setNote({ text: r.error, error: true });
        return;
      }
      setResult(r);
      setStep('done');
      write(LOCAL, null);
      top();
    } catch (e) {
      if (e instanceof AuthError) setAskLogin(true);
      else setNote({ text: e instanceof Error ? e.message : t.error, error: true });
    } finally {
      setBusy('');
    }
  }, [fields, tariff, props, t]);

  const paid = async () => {
    if (!result?.submitted) return;
    setBusy('paid');
    try {
      const r = await call({ action: 'paid_post', id: result.submitted });
      props.onState(r);
      if (r.error) setNote({ text: r.error, error: true });
      else setPaidSent(true);
    } catch {
      setNote({ text: t.error, error: true });
    } finally {
      setBusy('');
    }
  };

  const tariffs = info?.tariffs ?? null;
  const credits = state?.credits ?? 0;
  const price = !tariffs ? 0 : tariff === 'pro' ? tariffs.pro : tariff === 'basic' ? tariffs.post : 0;
  const stepIndex = step === 'form' ? 0 : step === 'check' ? 1 : 2;

  const header = (
    <View style={s.top}>
      <Pressable
        onPress={step === 'check' ? () => setStep('form') : props.onClose}
        hitSlop={10}
        accessibilityRole="button"
        accessibilityLabel={t.back}
        style={s.back}
      >
        <Icon name="back" color={c.ink} />
      </Pressable>
      <Text style={[s.h1, { color: c.ink }]}>{t.title}</Text>
    </View>
  );

  const stepper = (
    <View style={s.steps} accessibilityRole="progressbar">
      {t.steps.map((name, i) => (
        <View key={name} style={s.stepItem}>
          <View style={[s.dot, { backgroundColor: i <= stepIndex ? c.accent : c.pill }]}>
            <Text style={[s.dotText, { color: i <= stepIndex ? c.onAccent : c.quiet }]}>{i < stepIndex ? '✓' : i + 1}</Text>
          </View>
          <Text style={[s.stepName, { color: i === stepIndex ? c.ink : c.quiet }]}>{name}</Text>
        </View>
      ))}
    </View>
  );

  const noteBox = note ? (
    <View style={[s.note, { backgroundColor: note.error ? c.warnBg : c.okBg }]}>
      <Text style={[s.text, { color: note.error ? c.warnInk : c.okInk }]}>{note.text}</Text>
    </View>
  ) : null;

  let body;
  if (!loaded) {
    body = <Loading c={c} text="" />;
  } else if (step === 'form') {
    body = (
      <View style={s.gap}>
        <Text style={[s.text, { color: c.quiet }]}>{t.lead}</Text>
        <View style={[s.paste, { borderColor: c.brand, backgroundColor: c.soft }]}>
          <Text style={[s.h3, { color: c.ink }]}>{t.pasteTitle}</Text>
          <Text style={[s.small, { color: c.quiet }]}>{t.pasteLead}</Text>
          <TextInput
            value={paste}
            onChangeText={setPaste}
            placeholder={t.pasteHint}
            placeholderTextColor={c.quiet}
            multiline
            maxLength={4000}
            accessibilityLabel={t.pasteTitle}
            style={[s.input, s.area, { color: c.ink, borderColor: c.line, backgroundColor: c.card }]}
          />
          <Button c={c} label={t.pasteGo} busy={busy === 'paste'} disabled={paste.trim().length < 10} onPress={fill} />
        </View>
        {noteBox}
        <Text style={[s.or, { color: c.quiet }]}>{t.or}</Text>

        <Text style={[s.label, { color: c.ink }]}>{t.city} *</Text>
        <View style={s.wrap}>
          {(info?.cities ?? []).map(([slug, name]) => (
            <Chip key={slug} c={c} active={fields.city === slug} label={name} onPress={() => set('city', slug)} />
          ))}
        </View>

        {FIELD_ORDER.map((field) => (
          <View key={field} style={s.field}>
            <Text style={[s.label, { color: c.ink }]}>
              {labels[field]}
              {REQUIRED.includes(field) ? ' *' : <Text style={{ color: c.quiet, fontWeight: '400' }}>{` · ${t.optional}`}</Text>}
            </Text>
            <TextInput
              value={fields[field]}
              onChangeText={(v) => set(field, v)}
              placeholder={t[`${field === 'title' ? 'jobTitle' : field}Hint` as 'salaryHint']}
              placeholderTextColor={c.quiet}
              maxLength={info?.limits[field] ?? 1000}
              multiline={field === 'details'}
              accessibilityLabel={labels[field]}
              style={[s.input, field === 'details' && s.area, { color: c.ink, borderColor: c.line, backgroundColor: c.card }]}
            />
            {field === 'title' && info?.titles.length ? (
              <View style={s.wrap}>
                {info.titles.map((name) => (
                  <Chip key={name} c={c} active={fields.title === name} label={name} onPress={() => set('title', name)} />
                ))}
              </View>
            ) : null}
            {field === 'details' ? <Text style={[s.small, { color: c.quiet }]}>{t.detailsNote}</Text> : null}
          </View>
        ))}

        {lack.length ? <Text style={[s.small, { color: c.quiet }]}>{t.need(lack.map((f) => labels[f].toLowerCase()).join(', '))}</Text> : null}
        <Button c={c} label={t.next} busy={busy === 'check'} disabled={lack.length > 0} onPress={check} />
        {saved ? <Text style={[s.small, s.center, { color: c.quiet }]}>✓ {saved}</Text> : null}
      </View>
    );
  } else if (step === 'check') {
    const cityName = info?.cities.find(([slug]) => slug === fields.city)?.[1] ?? '';
    const options: { key: Tariff; name: string; what: string; price?: number }[] = [];
    if (tariffs) {
      options.push({ key: 'basic', name: t.basic, what: t.basicWhat, price: tariffs.post });
      options.push({ key: 'pro', name: t.pro, what: t.proWhat(tariffs.days), price: tariffs.pro });
      if (credits > 0) options.push({ key: 'credit', name: t.credit(credits), what: t.creditWhat });
      if (state?.admin) options.push({ key: 'free', name: t.free, what: t.freeWhat });
    }
    const chosen = tariffs ? tariff : 'basic';
    body = (
      <View style={s.gap}>
        <Text style={[s.sec, { color: c.quiet }]}>{t.checkTitle}</Text>
        <View style={[s.card, { borderColor: c.line, backgroundColor: c.card }]}>
          <Text style={[s.cardTitle, { color: c.ink }]}>{fields.title}</Text>
          <Text style={[s.cardCompany, { color: c.accent }]}>{fields.company}</Text>
          <Text style={[s.small, { color: c.quiet }]}>📍 {[cityName, fields.address].filter(Boolean).join(', ')}</Text>
          <Text style={[s.strong, { color: c.ink }]}>💰 {fields.salary}</Text>
          {fields.schedule ? <Text style={[s.small, { color: c.ink }]}>🕒 {fields.schedule}</Text> : null}
          {fields.details ? <Text style={[s.text, { color: c.ink }]}>{fields.details}</Text> : null}
          <Pressable onPress={() => setStep('form')} accessibilityRole="button">
            <Text style={[s.link, { color: c.brand }]}>✏️ {t.edit}</Text>
          </Pressable>
        </View>
        {tidied ? <Text style={[s.small, { color: c.quiet }]}>{tidied}</Text> : null}

        {options.length ? (
          <>
            <Text style={[s.sec, { color: c.quiet }]}>{t.tariff}</Text>
            {options.map((o) => (
              <Pressable
                key={o.key}
                onPress={() => setTariff(o.key)}
                accessibilityRole="radio"
                aria-checked={chosen === o.key}
                style={[s.tariff, { borderColor: chosen === o.key ? c.accent : c.line, backgroundColor: c.card }]}
              >
                <View style={[s.radio, { borderColor: chosen === o.key ? c.accent : c.line }]}>
                  {chosen === o.key ? <View style={[s.radioDot, { backgroundColor: c.accent }]} /> : null}
                </View>
                <View style={ui.flex}>
                  <Text style={[s.h3, { color: c.ink }]}>
                    {o.key === 'pro' ? '🔥 ' : ''}
                    {o.name}
                    {o.price ? `: ${money(o.price)}` : ''}
                  </Text>
                  <Text style={[s.small, { color: c.quiet }]}>{o.what}</Text>
                </View>
              </Pressable>
            ))}
          </>
        ) : null}
        {noteBox}
        {askLogin && !authHeader() ? (
          <View style={[s.paste, { borderColor: c.brand, backgroundColor: c.soft }]}>
            <Text style={[s.h3, { color: c.ink }]}>{t.loginTitle}</Text>
            <Login
              c={c}
              lang={lang}
              intro={t.loginIntro}
              onDone={() => {
                setAskLogin(false);
                props.onAuthed();
                submit();
              }}
            />
          </View>
        ) : (
          <Button c={c} label={price ? t.send(money(price)) : t.sendFree} busy={busy === 'submit'} onPress={submit} />
        )}
        {price ? <Text style={[s.small, s.center, { color: c.quiet }]}>{t.payNote}</Text> : null}
      </View>
    );
  } else {
    const kaspi = result?.kaspi;
    const job = result?.jobs.find((j) => j.id === result.submitted);
    const amount = job?.pay?.amount ?? price;
    body = (
      <View style={s.gap}>
        {result?.outcome === 'payment' && kaspi ? (
          paidSent || job?.pay?.waiting ? (
            <View style={[s.note, { backgroundColor: c.okBg }]}>
              <Text style={[s.text, { color: c.okInk }]}>{t.waiting}</Text>
            </View>
          ) : (
            <>
              <Text style={[s.h3, { color: c.ink }]}>{t.payTitle(money(amount))}</Text>
              <PayBox c={c} t={t} kaspi={kaspi} comment={`№${result.submitted}`} busy={busy === 'paid'} onPaid={paid} />
              <Text style={[s.small, { color: c.quiet }]}>{t.payNote}</Text>
            </>
          )
        ) : (
          <View style={[s.note, { backgroundColor: c.okBg }]}>
            <Text style={[s.text, { color: c.okInk }]}>{t.pending}</Text>
          </View>
        )}
        {noteBox}
        <Button c={c} ghost label={t.cabinet} onPress={props.onCabinet} />
        <Pressable
          onPress={() => {
            setFields(EMPTY);
            setResult(null);
            setPaidSent(false);
            setStep('form');
          }}
          accessibilityRole="button"
          style={s.center}
        >
          <Text style={[s.link, { color: c.brand }]}>{t.another}</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <SafeAreaView style={[s.page, { backgroundColor: c.bg }]} edges={['top', 'bottom']}>
      <View style={ui.column}>
        {header}
        <ScrollView ref={scroll} contentContainerStyle={s.body} keyboardShouldPersistTaps="handled">
          {stepper}
          {body}
        </ScrollView>
      </View>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  page: { flex: 1 },
  top: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingVertical: 8 },
  back: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  h1: { fontSize: 22, fontWeight: '800', letterSpacing: -0.4, flexShrink: 1 },
  body: { paddingHorizontal: 20, paddingBottom: 40 },
  steps: { flexDirection: 'row', gap: 8, marginBottom: 16 },
  stepItem: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 6 },
  dot: { width: 24, height: 24, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  dotText: { fontSize: 12, fontWeight: '800' },
  stepName: { fontSize: 13, fontWeight: '700', flexShrink: 1 },
  gap: { gap: 12 },
  field: { gap: 6 },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  text: { fontSize: 15, lineHeight: 21 },
  small: { fontSize: 13, lineHeight: 18 },
  strong: { fontSize: 15, fontWeight: '700' },
  h3: { fontSize: 16, fontWeight: '700' },
  label: { fontSize: 15, fontWeight: '700' },
  sec: { fontSize: 12, fontWeight: '800', letterSpacing: 0.5, textTransform: 'uppercase', marginTop: 4 },
  or: { fontSize: 13, textAlign: 'center' },
  link: { fontSize: 14, fontWeight: '700' },
  center: { textAlign: 'center', alignSelf: 'center', padding: 4 },
  note: { borderRadius: 12, padding: 12 },
  paste: { borderWidth: 2, borderRadius: 16, padding: 14, gap: 10 },
  input: { borderWidth: 1, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10, fontSize: 16, lineHeight: 21 },
  area: { minHeight: 110, textAlignVertical: 'top' },
  card: { borderWidth: 1, borderRadius: 16, padding: 16, gap: 6 },
  cardTitle: { fontSize: 20, fontWeight: '800' },
  cardCompany: { fontSize: 15, fontWeight: '700' },
  tariff: { flexDirection: 'row', gap: 12, borderWidth: 2, borderRadius: 14, padding: 14, alignItems: 'flex-start' },
  radio: { width: 22, height: 22, borderRadius: 11, borderWidth: 2, alignItems: 'center', justifyContent: 'center', marginTop: 1 },
  radioDot: { width: 10, height: 10, borderRadius: 5 },
});
