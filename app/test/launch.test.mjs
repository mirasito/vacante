// Разбор ссылки запуска. Запуск: node --test test/ (Node 22.18+ читает .ts сам).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseLaunch } from '../src/launch.ts';

test('вакансия с источником и городом', () => {
  assert.deepEqual(parseLaunch('stg_v_almaty_hh-139501020'), { source: 'tg', city: 'almaty', vacancyId: 'hh-139501020' });
});

test('город с дефисом и id с подчёркиванием', () => {
  assert.deepEqual(parseLaunch('stg_v_ust-kamenogorsk_astana_job_vakansii-130653'), {
    source: 'tg',
    city: 'ust-kamenogorsk',
    vacancyId: 'astana_job_vakansii-130653',
  });
});

test('вакансия без источника', () => {
  assert.deepEqual(parseLaunch('v_almaty_hh-1'), { city: 'almaty', vacancyId: 'hh-1' });
});

test('лента города с источником рекламы', () => {
  assert.deepEqual(parseLaunch('sad12_c_almaty'), { source: 'ad12', city: 'almaty' });
});

test('старые ссылки работают', () => {
  assert.deepEqual(parseLaunch('almaty'), { city: 'almaty' });
  assert.deepEqual(parseLaunch('ust-kamenogorsk'), { city: 'ust-kamenogorsk' });
  assert.deepEqual(parseLaunch('ref_abc123'), { ref: 'abc123' });
  assert.deepEqual(parseLaunch('beta'), { beta: true });
});

test('город на «s» — не префикс источника', () => {
  assert.deepEqual(parseLaunch('shymkent'), { city: 'shymkent' });
  assert.deepEqual(parseLaunch('semey'), { city: 'semey' });
});

test('приглашение друга с источником', () => {
  assert.deepEqual(parseLaunch('sfr_ref_abc123'), { source: 'fr', ref: 'abc123' });
});

test('ссылка на отклик: a_ вместо v_, окно отклика открывается сразу', () => {
  assert.deepEqual(parseLaunch('stg_a_almaty_hh-139501020'), { source: 'tg', city: 'almaty', vacancyId: 'hh-139501020', apply: true });
  assert.deepEqual(parseLaunch('a_ust-kamenogorsk_astana_job_vakansii-130653'), {
    city: 'ust-kamenogorsk',
    vacancyId: 'astana_job_vakansii-130653',
    apply: true,
  });
});

test('старая ссылка v_ по-прежнему открывает карточку, а не отклик', () => {
  assert.equal(parseLaunch('stg_v_almaty_hh-1').apply, undefined);
  assert.equal(parseLaunch('stgdg_v_almaty_chan-205').apply, undefined);
  assert.deepEqual(parseLaunch('a_almaty_'), {});
});

test('мусор и пустое значение ничего не дают', () => {
  assert.deepEqual(parseLaunch('что-то<script>'), {});
  assert.deepEqual(parseLaunch('v_almaty_'), {});
  assert.deepEqual(parseLaunch('stg_'), {});
  assert.deepEqual(parseLaunch('ref_toolong1'), {});
  assert.deepEqual(parseLaunch(''), {});
  assert.deepEqual(parseLaunch(undefined), {});
});
