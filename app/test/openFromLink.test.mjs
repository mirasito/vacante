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

test('по списку id города вакансия с дальней страницы находится сразу, без перебора', async () => {
  const pages = { 2: [{ id: 'a' }], 3: [{ id: 'b' }], 6: [{ id: 'far' }] };
  const asked = [];
  const load = async (n) => (asked.push(n), pages[n] ?? []);
  const ids = { per_page: 2, ids: ['x', 'y', 'a', 'a2', 'b', 'b2', 'c', 'c2', 'd', 'd2', 'far', 'f2'] };
  assert.deepEqual(await findOnPages('far', 6, load, Promise.resolve(ids)), { id: 'far' });
  assert.deepEqual(asked, [6]);
});

test('по списку id: вакансии в нём нет, значит закрыта, страницы не качаем', async () => {
  const asked = [];
  const load = async (n) => (asked.push(n), []);
  assert.equal(await findOnPages('gone', 9, load, Promise.resolve({ per_page: 400, ids: ['a', 'b'] })), undefined);
  assert.deepEqual(asked, []);
});

test('список id из другой часовой сборки: смотрим и соседние страницы', async () => {
  // По списку вакансия на 3-й странице, а в загруженной ленте она уже сползла на 4-ю
  const pages = { 3: [{ id: 'a' }], 4: [{ id: 'moved' }] };
  const asked = [];
  const load = async (n) => (asked.push(n), pages[n] ?? []);
  assert.deepEqual(await findOnPages('moved', 9, load, Promise.resolve({ per_page: 1, ids: ['p1', 'p2', 'moved'] })), { id: 'moved' });
  assert.deepEqual(asked, [3, 4]);
});

test('список id не загрузился: как раньше, страницы 2…4 по очереди', async () => {
  const pages = { 2: [{ id: 'a' }], 3: [{ id: 'hh-7' }] };
  const asked = [];
  const load = async (n) => (asked.push(n), pages[n] ?? []);
  assert.deepEqual(await findOnPages('hh-7', 9, load, Promise.reject(new Error('404'))), { id: 'hh-7' });
  assert.deepEqual(asked, [2, 3]);
  asked.length = 0;
  assert.deepEqual(await findOnPages('hh-7', 9, load, Promise.resolve(undefined)), { id: 'hh-7' });
  assert.deepEqual(asked, [2, 3]);
});
