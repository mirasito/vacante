import assert from 'node:assert/strict';
import { test } from 'node:test';

import { findLaunched } from '../src/openFromLink.ts';

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
