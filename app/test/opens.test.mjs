// Повторное открытие приложения: устройство само помнит день прошлого открытия.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { dayOf, nextOpen } from '../src/opens.ts';

test('день считается по времени Казахстана', () => {
  assert.equal(dayOf(Date.parse('2026-11-04T18:59:00Z')), '2026-11-04');
  assert.equal(dayOf(Date.parse('2026-11-04T19:30:00Z')), '2026-11-05');
});

test('первое открытие на устройстве: давности нет', () => {
  assert.deepEqual(nextOpen(undefined, '2026-11-04'), { opens: { day: '2026-11-04' } });
});

test('открытие в другой день: сколько дней прошло с прошлого', () => {
  assert.deepEqual(nextOpen({ day: '2026-11-04' }, '2026-11-05'), { opens: { day: '2026-11-05', prev: '2026-11-04' }, gap: 1 });
  assert.deepEqual(nextOpen({ day: '2026-10-28', prev: '2026-10-01' }, '2026-11-04'), {
    opens: { day: '2026-11-04', prev: '2026-10-28' },
    gap: 7,
  });
});

test('второе открытие за день сообщает ту же давность, что и первое', () => {
  assert.deepEqual(nextOpen({ day: '2026-11-05', prev: '2026-11-04' }, '2026-11-05'), {
    opens: { day: '2026-11-05', prev: '2026-11-04' },
    gap: 1,
  });
  assert.deepEqual(nextOpen({ day: '2026-11-05' }, '2026-11-05'), { opens: { day: '2026-11-05' } });
});

test('больше 90 дней назад, часы переведены назад или в памяти мусор: как первое открытие', () => {
  assert.deepEqual(nextOpen({ day: '2026-07-01' }, '2026-11-04'), { opens: { day: '2026-11-04', prev: '2026-07-01' } });
  assert.deepEqual(nextOpen({ day: '2026-11-09' }, '2026-11-04'), { opens: { day: '2026-11-04' } });
  assert.deepEqual(nextOpen({ day: 'вчера' }, '2026-11-04'), { opens: { day: '2026-11-04' } });
  assert.deepEqual(nextOpen('x', '2026-11-04'), { opens: { day: '2026-11-04' } });
});
