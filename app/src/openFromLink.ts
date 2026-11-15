/** Вакансия из ссылки запуска (кнопка «Откликнуться» под постом в канале) среди загруженной ленты города. */
export function findLaunched<T extends { id: string }>(items: T[], id: string | undefined): { vacancy?: T; closed: boolean } {
  if (!id) return { closed: false };
  const vacancy = items.find((v) => v.id === id);
  // Нет в свежих вакансиях города: её сняли или она ушла по возрасту. Показываем ленту и говорим об этом
  return vacancy ? { vacancy, closed: false } : { closed: true };
}
