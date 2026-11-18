// Отклики и напоминания на сервере (когда у человека есть профиль): загрузка, повтор после ошибки,
// перенос на сервер того, что накопилось на телефоне до профиля (сохранённые вакансии и цель недели).
// Вынесено из App.tsx как есть; порядок эффектов тот же.
import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';

import { localGoal, toImport, type GoalHistory } from './applications/model';
import {
  importApplications,
  importGoal,
  listApplications,
  listReminders,
  type Application,
  type Reminders,
  type Summary,
} from './server';
import type { Liked } from './types';

export function useServerTracker(
  tracker: 'off' | 'local' | 'server',
  liked: Liked[],
  setLiked: Dispatch<SetStateAction<Liked[]>>,
  goalHistory: GoalHistory,
  setGoalHistory: Dispatch<SetStateAction<GoalHistory>>,
) {
  // Отклики на сервере (когда есть профиль) и сводка недели
  const [apps, setApps] = useState<Application[] | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [appsFailed, setAppsFailed] = useState(false);
  const [appsAttempt, setAppsAttempt] = useState(0);
  // Напоминания (только с профилем на сервере): что ждёт, история, счётчик и настройки
  const [reminders, setReminders] = useState<Reminders | null>(null);
  const [remindersFailed, setRemindersFailed] = useState(false);
  const [remindersAttempt, setRemindersAttempt] = useState(0);

  // Отклики с сервера; заодно переносим туда то, что накопилось на телефоне до профиля
  useEffect(() => {
    if (tracker !== 'server') return;
    let alive = true;
    setAppsFailed(false);
    listApplications().then(
      (r) => {
        if (!alive) return;
        setApps(r.applications);
        setSummary(r.summary);
      },
      () => alive && setAppsFailed(true),
    );
    return () => {
      alive = false;
    };
  }, [tracker, appsAttempt]);

  const moving = useRef(false);
  useEffect(() => {
    if (tracker !== 'server' || !liked.length || moving.current) return;
    moving.current = true;
    const batch = liked.slice(0, 300);
    importApplications(batch.map(toImport)).then(
      (r) => {
        moving.current = false;
        setApps(r.applications);
        setSummary(r.summary);
        const done = new Set(batch.map((l) => l.id));
        setLiked((list) => list.filter((l) => !done.has(l.id)));
      },
      () => {
        moving.current = false;
      },
    );
  }, [tracker, liked]);

  // Цель с телефона переносим, когда отклики уже на сервере: по ним он считает прошлые недели серии
  const movingGoal = useRef(false);
  useEffect(() => {
    if (tracker !== 'server' || !summary || liked.length || !goalHistory.length || movingGoal.current) return;
    const goal = localGoal([], goalHistory).goal;
    if (!goal) {
      setGoalHistory([]);
      return;
    }
    movingGoal.current = true;
    importGoal(goal, goalHistory).then(
      (r) => {
        movingGoal.current = false;
        setSummary(r.summary);
        setGoalHistory([]);
      },
      () => {
        movingGoal.current = false;
      },
    );
  }, [tracker, summary, liked.length, goalHistory]);

  // Напоминания с сервера: при запуске, после изменений в откликах и при переходе на вкладку
  useEffect(() => {
    if (tracker !== 'server') {
      setReminders(null);
      return;
    }
    let alive = true;
    setRemindersFailed(false);
    listReminders().then(
      (r) => alive && setReminders(r),
      () => alive && setRemindersFailed(true),
    );
    return () => {
      alive = false;
    };
  }, [tracker, remindersAttempt]);

  const reloadApps = useCallback(() => setAppsAttempt((n) => n + 1), []);
  const refreshReminders = useCallback(() => setRemindersAttempt((n) => n + 1), []);

  // Стадия или дата собеседования поменялись: у отклика другие напоминания
  const putApp = useCallback(
    (a: Application, next?: Summary) => {
      setApps((list) => [a, ...(list ?? []).filter((x) => x.id !== a.id)]);
      if (next) setSummary(next);
      refreshReminders();
    },
    [refreshReminders],
  );

  return {
    apps,
    setApps,
    summary,
    setSummary,
    appsFailed,
    reloadApps,
    reminders,
    setReminders,
    remindersFailed,
    refreshReminders,
    putApp,
  };
}
