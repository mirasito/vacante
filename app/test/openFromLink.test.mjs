import assert from 'node:assert/strict';
import { test } from 'node:test';

import { findLaunched, findOnPages } from '../src/openFromLink.ts';

const FEED = [{ id: 'hh-1', title: 'Бариста' }, { id: 'astana_job_vakansii-130653', title: 'Повар' }];

test('вакансия из ссылки есть в ленте', () => {
  assert.deepEqual(findLaunched(FEED, 'astana_job_vakansii-130653'), { vacancy: FEED[1], closed: false });
});

test('вакансии из ссылки в ленте нет: закрыта', () => {
  assert.deepEqual(findLaunched(FEED, 'hh-404'), { closed: true });
  assert.deepEqual(findLaunched([], 'hh-1'), { closed: true });
});

test('в ссылке вакансии не было', () => {
  assert.deepEqual(findLaunched(FEED, undefined), { closed: false });
});

test('вакансия не на первой странице ленты: ищем на следующих, но не дальше трёх', async () => {
  const pages = { 2: [{ id: 'a' }], 3: [{ id: 'hh-7' }], 4: [{ id: 'b' }], 5: [{ id: 'far' }] };
  const asked = [];
  const load = async (n) => (asked.push(n), pages[n]);
  assert.deepEqual(await findOnPages('hh-7', 9, load), { id: 'hh-7' });
  assert.deepEqual(asked, [2, 3]);
  asked.length = 0;
  assert.equal(await findOnPages('far', 9, load), undefined); // пятая страница уже слишком далеко
  assert.deepEqual(asked, [2, 3, 4]);
  assert.equal(await findOnPages('hh-7', 1, load), undefined); // страниц больше нет
});

test('страница ленты не загрузилась: вакансию считаем ненайденной, без ошибки', async () => {
  assert.equal(await findOnPages('hh-7', 5, async () => { throw new Error('сеть'); }), undefined);
});
