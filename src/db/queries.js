import { query } from './index.js';

export async function findUrl(url) {
  const { rows } = await query('SELECT * FROM url WHERE url=$1', [url]);
  return rows[0] || null;
}

export async function ensureUrl(url, type) {
  const ins = await query(
    `INSERT INTO url(url, type)
     VALUES ($1, $2)
     ON CONFLICT (url) DO NOTHING
     RETURNING *`,
    [url, type]
  );
  if (ins.rows[0]) return ins.rows[0];
  return await findUrl(url);
}

export async function saveUrlResult(url_id, resultObj) {
  await query(
    `UPDATE url SET result=$1, updated_at=now() WHERE url_id=$2`,
    [resultObj, url_id]
  );
}
