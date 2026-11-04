-- Фото в профиле и где живёт соискатель.
--
-- Фото: одно на соискателя. Приложение уменьшает снимок на телефоне, а сервер вычищает из файла
-- всё, кроме картинки (EXIF с местом съёмки, модель телефона, миниатюры), и кладёт его рядом
-- с кружками. Видят его те же, кто видит профиль.
CREATE TABLE photos (
  seeker_id INTEGER PRIMARY KEY REFERENCES seekers (id) ON DELETE CASCADE,
  file TEXT NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  size INTEGER NOT NULL,
  uploaded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

-- Дом: точка, округлённая до 0,005° (300–500 метров), чтобы считать, далеко ли ехать до работы.
-- Адрес не храним, работодатель точку не видит. Источник: phone (определили по телефону) или 2gis
ALTER TABLE profiles ADD COLUMN home_lat REAL;
ALTER TABLE profiles ADD COLUMN home_lon REAL;
ALTER TABLE profiles ADD COLUMN home_source TEXT CHECK (home_source IN ('phone', '2gis'));
