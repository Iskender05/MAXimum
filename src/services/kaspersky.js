import dotenv from "dotenv";
dotenv.config();

const URL_API = "https://opentip.kaspersky.com/api/v1/search/domain";
const API_KEY = process.env.KASPERSKY_API_KEY;
const TIMEOUT_MS = 20000;

/**
 * Простейшая обёртка над fetch с таймаутом.
 */
async function fetchWithTimeout(url, options = {}, timeoutMs = TIMEOUT_MS) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(id);
  }
}

/**
 * Проверка URL через Kaspersky OpenTIP.
 * Возвращает нормализованный объект:
 * { verdict: "clean"|"suspicious"|"malicious"|"unknown", zone, raw }
 */
export async function checkUrlWithKaspersky(url) {
  if (!API_KEY) {
    console.warn("[kaspersky] KASPERSKY_API_KEY is not set");
    return { verdict: "unknown", zone: "Grey", raw: null };
  }

  const endpoint = `${URL_API}?request=${url}`;

  try {
    const res = await fetchWithTimeout(endpoint, {
      method: "GET",
      headers: {
        "x-api-key": API_KEY,
        Accept: "application/json",
      },
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.warn("[kaspersky] non-200 response:", res.status, text);
      return { verdict: "unknown", zone: "Grey", raw: null };
    }

    const data = await res.json().catch(() => null);
    if (!data) {
      console.warn("[kaspersky] cannot parse json");
      return { verdict: "unknown", zone: "Grey", raw: null };
    }

    // в ответе есть поле Zone: Green / Yellow / Red / Grey и т.д.
    const zone = String(data.Zone || "Grey");

    let verdict;
    switch (zone) {
      case "Green":
        verdict = "clean";
        break;
      case "Yellow":
        verdict = "suspicious";
        break;
      case "Red":
        verdict = "malicious";
        break;
      default:
        verdict = "unknown";
    }

    return { verdict, zone, raw: data };
  } catch (e) {
    if (e.name === "AbortError") {
      console.warn("[kaspersky] request timeout");
    } else {
      console.warn("[kaspersky] error:", e.message);
    }
    return { verdict: "unknown", zone: "Grey", raw: null };
  }
}