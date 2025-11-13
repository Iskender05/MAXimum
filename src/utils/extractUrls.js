// src/utils/extractUrls.js
export function extractUrls(message) {
  const urls = [];

  let text = '';

  // 1. Если пришла строка — используем её как текст
  if (typeof message === 'string') {
    text = message;
  }
  // 2. Если объект (как msg.body) — берём text и attachments
  else if (message && typeof message === 'object') {
    text = message.text || '';

    if (Array.isArray(message.attachments)) {
      message.attachments.forEach((attachment) => {
        if (attachment.type === 'file' && attachment.payload?.url) {
          urls.push({ url: attachment.payload.url, type: 'file' });
        }
      });
    }
  } else {
    // что-то странное прилетело — просто ничего не нашли
    return [];
  }

  // 3. Ищем обычные текстовые ссылки
  const textUrlPattern = /(https?:\/\/[^\s]+)/g;
  const foundTextUrls = (text || '').match(textUrlPattern) || [];

  foundTextUrls.forEach((url) => {
    urls.push({ url, type: 'link' });
  });

  return urls;
}
