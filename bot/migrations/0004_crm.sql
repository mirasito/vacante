-- CRM заведений в админке vacante.kz/admin/: статус переписки, заметка и дата последнего контакта
CREATE TABLE crm (
  venue TEXT PRIMARY KEY,          -- ключ заведения «город:название», как в venues.json
  status TEXT NOT NULL DEFAULT '', -- '' | sent | replied | client | no
  note TEXT NOT NULL DEFAULT '',
  contacted_at TEXT,               -- когда последний раз поменяли статус (ISO, UTC)
  updated_at TEXT NOT NULL
);
