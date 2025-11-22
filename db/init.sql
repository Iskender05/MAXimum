-- db/init.sql

CREATE TABLE IF NOT EXISTS url (
    url_id   BIGSERIAL PRIMARY KEY,
    url      TEXT NOT NULL UNIQUE,
    type     TEXT NOT NULL,      -- 'link' или 'file'
    result   TEXT                -- вердикт от Касперского и т.п.
);

CREATE TABLE IF NOT EXISTS user_url (
    max_user_id BIGINT NOT NULL,
    url_id      BIGINT NOT NULL REFERENCES url(url_id) ON DELETE CASCADE,
    number      INTEGER NOT NULL,       -- порядковый номер / счётчик

    PRIMARY KEY (max_user_id, url_id)
);
