// Короткая анкета перед первым откликом: что открыть по нажатию «Откликнуться».
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { applyGate } from '../src/applications/gate.ts';

const state = (patch = {}) => ({ known: true, canProfile: true, hasProfile: false, skipped: false, ...patch });

test('сервер ещё не ответил, есть ли профиль: ждём, а не открываем отклик мимо анкеты', () => {
  // Так и пропускалась анкета: в первую секунду после запуска аккаунт ещё не загружен
  assert.equal(applyGate(state({ known: false, canProfile: false })), 'wait');
  assert.equal(applyGate(state({ known: false })), 'wait');
  assert.equal(applyGate(state({ known: false, skipped: true })), 'wait');
});

test('профиля нет: сначала короткая анкета', () => {
  assert.equal(applyGate(state()), 'quick');
});

test('профиль есть или человек отказался от анкеты: сразу окно отклика', () => {
  assert.equal(applyGate(state({ hasProfile: true })), 'sheet');
  assert.equal(applyGate(state({ skipped: true })), 'sheet');
});

test('профили недоступны (сервер не ответил или они закрыты): отклик коротким текстом, как раньше', () => {
  assert.equal(applyGate(state({ canProfile: false })), 'sheet');
});
