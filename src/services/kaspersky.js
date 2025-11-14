import dotenv from "dotenv";
dotenv.config();

const URL_API =
  process.env.KASPERSKY_URL_API ||
  "https://opentip.kaspersky.com/api/v1/search/url";

const API_KEY = process.env.KASPERSKY_API_KEY;
const TIMEOUT_MS = Number(process.env.KASPERSKY_TIMEOUT_MS || 10000);

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

  const encoded = encodeURIComponent(url);
  const endpoint = `${URL_API}?request=${encoded}`;

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

async function pollFileResult(fileHash, maxAttempts = 5, delayMs = 5000) {
  const endpoint = `https://opentip.kaspersky.com/api/v1/getresult/file?request=${encodeURIComponent(
    fileHash,
  )}`;

  for (let i = 0; i < maxAttempts; i++) {
    const res = await fetchWithTimeout(endpoint, {
      method: "POST",
      headers: {
        "x-api-key": API_KEY,
        Accept: "application/json",
      },
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.warn("[kaspersky] file result non-200:", res.status, text);
      return null;
    }

    const data = await res.json().catch(() => null);
    if (!data) {
      console.warn("[kaspersky] cannot parse result json");
      return null;
    }

    const status = String(data.Status || "").toUpperCase();

    // DONE / FINISHED / ERROR — считаем конечным состоянием
    if (status === "DONE" || status === "FINISHED" || status === "ERROR") {
      return data;
    }

    // ещё в очереди — подождём и попробуем снова
    await new Promise((r) => setTimeout(r, delayMs));
  }

  // не дождались результата
  return null;
}


/**
 * Проверка файла через Kaspersky OpenTIP.
 * Возвращает нормализованный объект:
 * { verdict: "clean"|"suspicious"|"malicious"|"unknown", zone, raw }
 */
export async function checkFileWithKaspersky(fileBuffer, filename) {
  if (!API_KEY) {
    console.warn("[kaspersky] KASPERSKY_API_KEY is not set");
    return { verdict: "unknown", zone: "Grey", raw: null };
  }

  // 1) Submit file for analysis
  const scanEndpoint = `https://opentip.kaspersky.com/api/v1/scan/file?filename=${encodeURIComponent(filename)}`;
  
  try {
    const scanRes = await fetchWithTimeout(scanEndpoint, {
      method: "POST",
      headers: {
        "x-api-key": API_KEY,
        "Content-Type": "application/octet-stream",
      },
      body: fileBuffer,
    });

    if (!scanRes.ok) {
      const text = await scanRes.text().catch(() => "");
      console.warn("[kaspersky] file scan non-200 response:", scanRes.status, text);
      return { verdict: "unknown", zone: "Grey", raw: null };
    }

    const scanData = await scanRes.json().catch(() => null);
    if (!scanData) {
      console.warn("[kaspersky] cannot parse scan json");
      return { verdict: "unknown", zone: "Grey", raw: null };
    }

    // Get the file hash (SHA256) from the scan response
    const fileHash = scanData.Sha256 || scanData.Sha1 || scanData.Md5;
    if (!fileHash) {
      console.warn("[kaspersky] cannot get file hash from scan response");
      return { verdict: "unknown", zone: "Grey", raw: scanData };
    }

    // 2) Многократный опрос результата
    const resultData = await pollFileResult(fileHash);

    if (!resultData) {
      // Не смогли получить результат — хотя бы нормализуем по scanData
      return normalizeFileVerdict(scanData);
    }

    return normalizeFileVerdict(resultData);

  } catch (e) {
    if (e.name === "AbortError") {
      console.warn("[kaspersky] file request timeout");
    } else {
      console.warn("[kaspersky] file error:", e.message);
    }
    return { verdict: "unknown", zone: "Grey", raw: null };
  }
}

/**
 * Нормализация ответа от Kaspersky для файлов
 */
function normalizeFileVerdict(data) {
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
}