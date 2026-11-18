// Кнопка «Войти через Telegram» на сайте и в приложении для телефона: сайт берёт у бота код,
// человек открывает t.me/vacantekz_bot?start=login_<код> и нажимает «Да, войти», сайт забирает
// ключ входа (src/session.ts). Общая для профиля соискателя и кабинета работодателя.
import { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { onAppVisible, openUrl } from './platform';
import { LOGIN_URL, setSession } from './session';
import type { Colors } from './theme';
import type { Lang } from './types';
import { Button } from './ui';

const T = {
  ru: {
    login: 'Войти через Telegram',
    how: 'Без пароля и SMS: бот спросит «Войти?», нажмите «Да», и всё откроется здесь.',
    wait: 'Ждём подтверждения в Telegram. Нажмите в боте «✅ Да, войти» и вернитесь на эту страницу.',
    again: 'Открыть Telegram ещё раз',
    expired: 'Ссылка для входа устарела. Нажмите «Войти через Telegram» ещё раз.',
    error: 'Не получилось связаться с сервером. Проверьте интернет и попробуйте ещё раз.',
  },
  kk: {
    login: 'Telegram арқылы кіру',
    how: 'Құпиясөзсіз және SMS-сіз: бот «Кіру?» деп сұрайды, «Иә» басыңыз, бәрі осында ашылады.',
    wait: 'Telegram-дағы растауды күтіп тұрмыз. Ботта «✅ Иә, кіру» басып, осы бетке оралыңыз.',
    again: 'Telegram-ды қайта ашу',
    expired: 'Кіру сілтемесінің мерзімі өтті. «Telegram арқылы кіру» батырмасын қайта басыңыз.',
    error: 'Серверге қосылу мүмкін болмады. Интернетті тексеріп, қайталап көріңіз.',
  },
};

/** Код берём заранее, чтобы ссылка открылась прямо по нажатию (иначе браузер её заблокирует). */
export function Login(props: { c: Colors; lang: Lang; intro?: string; onDone?(): void }) {
  const { c } = props;
  const t = T[props.lang];
  const [link, setLink] = useState<{ code: string; link: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [waiting, setWaiting] = useState(false);
  const [note, setNote] = useState('');
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const onDone = useRef(props.onDone);
  onDone.current = props.onDone;

  const fresh = useCallback(async () => {
    setLink(null);
    setLoading(true);
    try {
      const res = await fetch(LOGIN_URL, { method: 'POST' });
      const data = await res.json();
      if (data?.code && data?.link) setLink(data);
      else setNote(t.error);
    } catch {
      setNote(t.error);
    } finally {
      setLoading(false);
    }
  }, [t]);
  useEffect(() => {
    fresh();
  }, [fresh]);

  const check = useCallback(async () => {
    if (!link) return;
    try {
      const res = await fetch(`${LOGIN_URL}?code=${link.code}`);
      const data = await res.json().catch(() => ({}));
      if (data.session) {
        setWaiting(false);
        setSession(data.session);
        onDone.current?.();
      } else if (res.status === 410) {
        setWaiting(false);
        setNote(t.expired);
        fresh();
      }
    } catch {
      // сеть моргнула: проверим ещё раз
    }
  }, [link, t, fresh]);

  useEffect(() => {
    if (!waiting) return;
    timer.current = setInterval(check, 2000);
    const off = onAppVisible(check); // вернулись из Telegram: проверяем сразу
    return () => {
      if (timer.current) clearInterval(timer.current);
      off();
    };
  }, [waiting, check]);

  const go = () => {
    if (!link) {
      setNote('');
      fresh();
      return;
    }
    setNote('');
    setWaiting(true);
    openUrl(link.link);
  };
  return (
    <View style={s.gap}>
      {props.intro && !waiting ? <Text style={[s.text, { color: c.ink }]}>{props.intro}</Text> : null}
      <Text style={[s.small, { color: waiting ? c.ink : c.quiet }]}>{waiting ? t.wait : t.how}</Text>
      {note ? <Text style={[s.small, { color: c.quiet }]}>{note}</Text> : null}
      <Button c={c} icon="link" label={waiting ? t.again : t.login} busy={loading} ghost={waiting} onPress={go} />
    </View>
  );
}

const s = StyleSheet.create({
  gap: { gap: 12, alignSelf: 'stretch' },
  text: { fontSize: 16, lineHeight: 22 },
  small: { fontSize: 14, lineHeight: 20 },
});
