// Метки формы размещения: откуда работодатель на неё пришёл. Запуск: node --test test/ (Node 22.18+ читает .ts сам).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { cameOf, viaOf, withCame } from '../src/employer/came.ts';

test('via из адреса страницы: до восьми строчных букв и цифр', () => {
  assert.equal(viaOf('google'), 'google');
  assert.equal(viaOf('chatgpt'), 'chatgpt');
  assert.equal(viaOf('tg'), 'tg');
  assert.equal(viaOf('2gis'), '2gis');
  assert.equal(viaOf('abcdefgh'), 'abcdefgh');
});

test('via не по формату или без значения: пустая строка', () => {
  for (const bad of [null, undefined, '', 'abcdefghi', 'Google', 'site_header', 'a b', 'google&x=1', 'гугл', '<script>']) {
    assert.equal(viaOf(bad), '', String(bad));
  }
});

test('метки запроса: пустые не передаём', () => {
  assert.deepEqual(cameOf('site_header', 'google'), { from: 'site_header', via: 'google' });
  // В Telegram и в приложении via нет: остаётся одна метка кнопки
  assert.deepEqual(cameOf('miniapp', ''), { from: 'miniapp' });
  assert.deepEqual(cameOf('cabinet'), { from: 'cabinet' });
  assert.deepEqual(cameOf('', 'tg'), { via: 'tg' });
  assert.deepEqual(cameOf(), {});
});

test('адрес запроса настроек формы несёт обе метки', () => {
  const url = 'https://bot.example/api/post';
  assert.equal(withCame(url, { from: 'site_header', via: 'google' }), `${url}?from=site_header&via=google`);
  assert.equal(withCame(url, { from: 'miniapp' }), `${url}?from=miniapp`);
  assert.equal(withCame(url, { via: 'direct' }), `${url}?via=direct`);
});

test('без меток адрес не меняется, а чужие знаки в метке не ломают адрес', () => {
  const url = 'https://bot.example/api/post';
  assert.equal(withCame(url, {}), url);
  assert.equal(withCame(url, { from: '', via: '' }), url);
  assert.equal(withCame(url, { from: 'a&via=b' }), `${url}?from=a%26via%3Db`);
});

test('тело запроса формы: метки ложатся рядом с action и ничего в нём не затирают', () => {
  const body = { action: 'parse', text: 'Требуется повар' };
  assert.deepEqual({ ...body, ...cameOf('land', 'chatgpt') }, { action: 'parse', text: 'Требуется повар', from: 'land', via: 'chatgpt' });
  assert.deepEqual({ ...body, ...cameOf('', '') }, body);
});
