// «Настройки и данные» из макета vacante 2.0: язык, уведомления в боте, данные и согласия.
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Icon } from './icons';
import { confirm, openUrl } from './platform';
import type { Colors } from './theme';
import type { Lang } from './types';
import { Seg, styles as ui } from './ui';
import { V } from './v2texts';

const T = {
  ru: {
    title: 'Настройки и данные',
    back: 'Назад',
    notify: 'Уведомления',
    subscribe: 'Новые вакансии в Telegram',
    subscribeHint: 'Бот пришлёт подборку по вашему городу и профессии',
    reminders: 'Напоминания о собеседованиях',
    remindersHint: 'Когда и о чём напоминать',
    lang: 'Язык',
    langRow: 'Интерфейс',
    data: 'Данные',
    privacy: 'Как мы используем данные',
    privacyHint: 'Что храним, зачем и сколько',
    why: 'Почему мне показывают эти вакансии',
    whyHint:
      'Лента показывает свежие вакансии вашего города. «Почему вам» на карточке значит, что совпали профессия, расстояние или опыт из ваших ответов на старте. Ответы хранятся только на этом телефоне.',
    restart: 'Пройти стартовые вопросы заново',
    profile: 'Профиль и удаление аккаунта',
    profileHint: 'Удалить профиль, кружок и фото можно на вкладке «Профиль»',
    clear: 'Очистить данные на этом телефоне',
    clearHint: 'Избранное, просмотренные и ответы на старте',
    clearAsk: 'Стереть избранное, просмотренные вакансии и настройки на этом телефоне?',
    clearYes: 'Стереть',
    clearNo: 'Отмена',
    footer: 'Профили хранятся на сервере в Казахстане · vacante 2.0',
  },
  kk: {
    title: 'Баптаулар және деректер',
    back: 'Артқа',
    notify: 'Хабарламалар',
    subscribe: 'Telegram-дағы жаңа бос орындар',
    subscribeHint: 'Бот қалаңыз бен мамандығыңыз бойынша іріктеме жібереді',
    reminders: 'Сұхбат туралы еске салу',
    remindersHint: 'Қашан және не туралы еске салу',
    lang: 'Тіл',
    langRow: 'Интерфейс',
    data: 'Деректер',
    privacy: 'Деректерді қалай пайдаланамыз',
    privacyHint: 'Не сақтаймыз, не үшін және қанша уақыт',
    why: 'Неге маған осы бос орындар көрсетіледі',
    whyHint:
      'Лента қалаңыздағы жаңа бос орындарды көрсетеді. Карточкадағы «Неге сізге» мамандық, қашықтық немесе тәжірибе сіздің бастапқы жауаптарыңызбен сәйкес келгенін білдіреді. Жауаптар тек осы телефонда сақталады.',
    restart: 'Бастапқы сұрақтарды қайта өту',
    profile: 'Профиль және аккаунтты жою',
    profileHint: 'Профильді, бейнехабарды және фотоны «Профиль» қойындысында жоюға болады',
    clear: 'Осы телефондағы деректерді тазалау',
    clearHint: 'Таңдаулылар, қаралғандар және бастапқы жауаптар',
    clearAsk: 'Осы телефондағы таңдаулыларды, қаралған бос орындарды және баптауларды өшіру керек пе?',
    clearYes: 'Өшіру',
    clearNo: 'Болдырмау',
    footer: 'Профильдер Қазақстандағы серверде сақталады · vacante 2.0',
  },
};

export function Settings(props: {
  c: Colors;
  lang: Lang;
  subscribeUrl: string | null;
  /** Есть ли профиль на сервере: тогда есть напоминания и вкладка «Профиль». */
  server: boolean;
  onLang(l: Lang): void;
  onReminders(): void;
  onProfile(): void;
  onRestart(): void;
  onClear(): void;
  onClose(): void;
  /** vacante 2.0, только с профилем: «Скачать мои данные» и «Пригласить друга». */
  onExport?(): Promise<void>;
  onInvite?(): void;
}) {
  const { c, lang } = props;
  const t = T[lang];
  const [exportError, setExportError] = useState('');
  const row = (title: string, hint: string | null, onPress: (() => void) | null, opts: { danger?: boolean; last?: boolean } = {}) => (
    <Pressable
      onPress={onPress ?? undefined}
      disabled={!onPress}
      accessibilityRole={onPress ? 'button' : undefined}
      style={[styles.line, { borderColor: c.line }, opts.last && styles.last]}
    >
      <View style={ui.flex}>
        <Text style={[styles.h3, { color: opts.danger ? c.skip : c.ink }]}>{title}</Text>
        {hint ? <Text style={[styles.sub, { color: c.quiet }]}>{hint}</Text> : null}
      </View>
      {onPress ? <Icon name="next" color={c.faint} size={20} /> : null}
    </Pressable>
  );
  return (
    <SafeAreaView style={[styles.page, { backgroundColor: c.bg }]} edges={['top', 'bottom']}>
      <View style={ui.column}>
        <View style={styles.top}>
          <Pressable onPress={props.onClose} hitSlop={10} accessibilityRole="button" accessibilityLabel={t.back} style={styles.back}>
            <Icon name="back" color={c.ink} />
          </Pressable>
          <Text style={[styles.h1, { color: c.ink }]}>{t.title}</Text>
        </View>
        <ScrollView contentContainerStyle={styles.body}>
          <Text style={[styles.sec, { color: c.quiet }]}>{t.notify}</Text>
          <View>
            {props.subscribeUrl ? row(t.subscribe, t.subscribeHint, () => openUrl(props.subscribeUrl!), { last: !props.server }) : null}
            {props.server ? row(t.reminders, t.remindersHint, props.onReminders, { last: true }) : null}
          </View>
          <Text style={[styles.sec, { color: c.quiet }]}>{t.lang}</Text>
          <View style={[styles.line, styles.last]}>
            <Text style={[styles.h3, ui.flex, { color: c.ink }]}>{t.langRow}</Text>
            <Seg<Lang>
              c={c}
              small
              value={lang}
              options={[
                { value: 'ru', label: 'Русский' },
                { value: 'kk', label: 'Қазақша' },
              ]}
              onChange={props.onLang}
            />
          </View>
          <Text style={[styles.sec, { color: c.quiet }]}>{t.data}</Text>
          <View>
            {row(t.privacy, t.privacyHint, () => openUrl(lang === 'kk' ? 'https://vacante.kz/kk/privacy/' : 'https://vacante.kz/privacy/'))}
            {row(t.why, t.whyHint, null)}
            {row(t.restart, null, props.onRestart)}
            {props.server ? row(t.profile, t.profileHint, props.onProfile) : null}
            {props.server && props.onInvite ? row(V[lang].invite, null, props.onInvite) : null}
            {props.server && props.onExport
              ? row(V[lang].export, exportError || V[lang].exportHint, async () => {
                  setExportError('');
                  try {
                    await props.onExport!();
                  } catch {
                    setExportError(V[lang].error);
                  }
                })
              : null}
            {row(
              t.clear,
              t.clearHint,
              async () => {
                if (await confirm(t.clearAsk, t.clearYes, t.clearNo)) props.onClear();
              },
              { danger: true, last: true },
            )}
          </View>
          <Text style={[styles.footer, { color: c.quiet }]}>{t.footer}</Text>
        </ScrollView>
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
  sec: { fontSize: 12, fontWeight: '800', letterSpacing: 0.5, textTransform: 'uppercase', marginTop: 18, marginBottom: 2 },
  line: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 14, borderBottomWidth: 1 },
  last: { borderBottomWidth: 0 },
  h3: { fontSize: 15, fontWeight: '700' },
  sub: { fontSize: 13, lineHeight: 18, marginTop: 2 },
  footer: { fontSize: 13, textAlign: 'center', marginTop: 24 },
});
