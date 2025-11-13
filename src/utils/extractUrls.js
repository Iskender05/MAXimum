// src/utils/extractUrls.js

export function extractUrls(body) {
  if (!body || typeof body !== "object") return [];

  const urls = [];

  // ---------- 1. ФАЙЛЫ ИЗ ВЛОЖЕНИЙ ----------
  const attachments = Array.isArray(body.attachments) ? body.attachments : [];

  for (const att of attachments) {
    if (!att || typeof att !== "object") continue;

    // Файл (тип "file")
    if (att.type === "file" && att.payload) {
      const fileId =
        att.payload.id ??
        att.payload.file_id ??
        null;
      const fileToken = att.payload.token ?? null;

      if (fileId) {
        urls.push({
          type: "file",
          url: `file:${fileId}`,      // условный идентификатор файла
          file_id: fileId,
          file_token: fileToken,
        });
      }
    }

    // Ссылка через attachment (если вдруг MAX так отдает)
    if (att.type === "link" && att.payload?.url) {
      urls.push({
        type: "link",
        url: att.payload.url,
      });
    }
  }

  // ---------- 2. ТЕКСТОВЫЕ ССЫЛКИ ----------
  const text = typeof body.text === "string" ? body.text : "";
  const pattern = /(https?:\/\/[^\s]+)/gi;
  const found = text.match(pattern) || [];

  for (const url of found) {
    // не дублируем, если уже есть такая ссылка из attachment
    if (!urls.some((u) => u.url === url)) {
      urls.push({ type: "link", url });
    }
  }

  return urls;
}
