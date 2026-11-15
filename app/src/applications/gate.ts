// Что открыть по нажатию «Откликнуться»: короткую анкету или сразу окно отклика.
// Отдельно от экрана, чтобы порядок загрузки проверялся тестом (app/test/gate.test.mjs).

export type ApplyGate = 'wait' | 'quick' | 'sheet';

/**
 * known — сервер уже ответил, кто вошёл и есть ли у него профиль (или стало ясно, что ответа не будет).
 * Пока ответа нет, решать рано: «профиля нет» и «ещё не знаем» выглядят одинаково, и отклик,
 * нажатый в первую секунду после запуска, уходил мимо короткой анкеты.
 */
export function applyGate(state: {
  known: boolean;
  /** Профиль создать можно: сервер ответил и профили открыты (или это тестировщик). */
  canProfile: boolean;
  hasProfile: boolean;
  /** Человек уже отказался от короткой анкеты в этом запуске. */
  skipped: boolean;
}): ApplyGate {
  if (!state.known) return 'wait';
  return state.canProfile && !state.hasProfile && !state.skipped ? 'quick' : 'sheet';
}
