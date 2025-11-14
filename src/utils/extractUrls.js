// src/utils/extractUrls.js

export function extractUrls(body) {
  if (!body || typeof body !== "object") return [];

  const urls = [];

  const attachments = Array.isArray(body.attachments)
    ? body.attachments
    : [];

  for (const att of attachments) {
    if (!att || typeof att !== "object") continue;

    // файлы
    if (att.type === "file" && att.payload) {
      const fileId =
        att.payload.id ??
        att.payload.file_id ??
        att.payload.fileId ??
        null;

      const fileToken =
        att.payload.token ??
        att.payload.file_token ??
        att.payload.fileToken ??
        null;

      if (fileId) {
        urls.push({
          type: "file",
          url: `file:${fileId}`,
          file_id: fileId,
          file_token: fileToken || null,
        });
      }
    }

    // ссылки через attachment (на всякий случай)
    if (att.type === "link" && att.payload?.url) {
      urls.push({
        type: "link",
        url: att.payload.url,
      });
    }
  }

  // --- 2. текстовые ссылки ---
  const text =
    typeof body.text === "string"
      ? body.text
      : typeof message.text === "string"
        ? message.text
        : "";

  const pattern = /(https?:\/\/[^\s]+)/gi;
  const found = text.match(pattern) || [];

  for (const url of found) {
    if (!urls.some((u) => u.url === url)) {
      urls.push({ type: "link", url });
    }
  }

  return urls;
}
