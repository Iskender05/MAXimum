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

export async function processUrl(url, type) {
  const existing = await findUrl(url);
  if (!existing) {
    return await ensureUrl(url, type);
  }
  return existing;
}

export async function handleUserUrl(maxUserId, urlId) {
  const { rows } = await query(
    "SELECT * FROM user_url WHERE max_user_id=$1 AND url_id=$2",
    [maxUserId, urlId],
  );

  if (!rows.length) {
    await query(
      "INSERT INTO user_url(max_user_id, url_id, number) VALUES($1,$2,1)",
      [maxUserId, urlId],
    );
    return 1;
  } else {
    const current = Number(rows[0].number || 0);
    const next = current + 1;
    await query(
      "UPDATE user_url SET number=$1 WHERE max_user_id=$2 AND url_id=$3",
      [next, maxUserId, urlId],
    );
    return next;
  }
}