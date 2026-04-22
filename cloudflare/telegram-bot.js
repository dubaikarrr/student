const DEFAULT_DATA_BASE_URL = "https://dubaikarrr.github.io/student/data";
const BOT_USERNAME = "SPOM_Seat_Checker_bot";
const BASE_URL = "https://spmt.icai.org/ICAI";
const SLOT_PAGE_URL = `${BASE_URL}/LoginAction_showSlotDetails.action`;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    if (request.method === "POST") {
      return handleTelegramWebhook(request, env);
    }

    if (request.method === "GET" && url.pathname === "/api/live-check") {
      return handleLiveCheck(request, env);
    }

    return jsonResponse({
      ok: true,
      service: "spom-telegram-bot",
      botUsername: BOT_USERNAME,
      dataBaseUrl: env.SPOM_DATA_BASE_URL || DEFAULT_DATA_BASE_URL,
    });
  },

  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(processScheduledReminders(env));
  },
};

async function handleLiveCheck(request, env) {
  const url = new URL(request.url);
  const state = normalizeCityName(url.searchParams.get("state"));
  const city = normalizeCityName(url.searchParams.get("city"));

  if (!city) {
    return jsonResponse(
      { ok: false, error: "Missing city. Pass ?city=CityName and optionally ?state=StateName." },
      400
    );
  }

  try {
    const { summary } = await fetchSeatData(env);
    const matchedCityMeta = findBestCityMatch(summary, state ? `${city} ${state}` : city);
    if (!matchedCityMeta) {
      return jsonResponse(
        {
          ok: false,
          error: `City "${city}" was not recognised in the tracked catalog.`,
        },
        404
      );
    }

    const liveRows = await fetchLiveCityAvailability(matchedCityMeta.state, matchedCityMeta.city);
    const alternatives = getBestAlternatives(
      summary,
      matchedCityMeta.city,
      matchedCityMeta.state
    ).slice(0, 5);

    return jsonResponse({
      ok: true,
      mode: "live",
      generatedAtIso: new Date().toISOString(),
      generatedAtDisplay: new Date().toLocaleString("en-IN", {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: "Asia/Kolkata",
      }),
      state: matchedCityMeta.state,
      city: matchedCityMeta.city,
      total: liveRows.length,
      rows: liveRows,
      alternatives,
    });
  } catch (error) {
    return jsonResponse(
      {
        ok: false,
        error: String(error?.message || error),
      },
      500
    );
  }
}

async function handleTelegramWebhook(request, env) {
  const body = await request.json();
  const message = body?.message;
  const text = (message?.text || "").trim();
  const chatId = message?.chat?.id;

  if (!chatId) {
    return new Response("ok");
  }

  try {
    await persistUserProfile(env, message);

    if (!text || text.startsWith("/start")) {
      await sendTelegramMessage(env, chatId, buildWelcomeText());
      return new Response("ok");
    }

    if (text === "/help") {
      await sendTelegramMessage(env, chatId, buildWelcomeText());
      return new Response("ok");
    }

    if (text.startsWith("/city ")) {
      const cityName = text.slice(6).trim();
      await sendCityLookup(env, chatId, cityName);
      return new Response("ok");
    }

    if (text.startsWith("/remind ")) {
      const cityName = text.slice(8).trim();
      await saveReminder(env, chatId, cityName);
      return new Response("ok");
    }

    if (text === "/remind") {
      await sendTelegramMessage(env, chatId, "Use /remind CityName. Example: /remind Pune");
      return new Response("ok");
    }

    if (text === "/myreminders") {
      await listReminders(env, chatId);
      return new Response("ok");
    }

    if (text.startsWith("/stop ")) {
      const cityName = text.slice(6).trim();
      await removeReminder(env, chatId, cityName);
      return new Response("ok");
    }

    await sendCityLookup(env, chatId, text);
  } catch (error) {
    await sendTelegramMessage(
      env,
      chatId,
      `I hit a temporary problem while checking SPOM seats. Please try again in a moment.\n\n${String(
        error?.message || error
      )}`
    );
  }

  return new Response("ok");
}

async function processScheduledReminders(env) {
  if (!env.SUBSCRIPTIONS || !env.TELEGRAM_BOT_TOKEN) {
    return;
  }

  const { latest, summary } = await fetchSeatData(env);
  const snapshotId = latest.generatedAtIso || latest.generatedAtDisplay || latest.generatedAt || "";
  if (!snapshotId) {
    return;
  }

  let cursor = undefined;
  do {
    const page = await env.SUBSCRIPTIONS.list({ cursor, limit: 100 });
    for (const key of page.keys || []) {
      const record = await env.SUBSCRIPTIONS.get(key.name, "json");
      if (!record || !Array.isArray(record.cities) || !record.cities.length) {
        continue;
      }

      const alertState = record.alertState || {};
      let changed = false;

      for (const subscribedCity of record.cities) {
        const matchedCityMeta = findBestCityMatch(summary, subscribedCity);
        if (!matchedCityMeta) {
          continue;
        }

        const cityKey = canonicalCityKey(matchedCityMeta.city, matchedCityMeta.state);
        const matchingRows = (latest.rows || []).filter(
          (row) => canonicalCityKey(row.city, row.state) === cityKey
        );

        if (!matchingRows.length) {
          continue;
        }

        if (alertState[cityKey] === snapshotId) {
          continue;
        }

        await sendTelegramMessage(
          env,
          record.chatId || key.name,
          buildReminderAlertText(latest, matchedCityMeta, matchingRows)
        );

        alertState[cityKey] = snapshotId;
        changed = true;
      }

      if (changed) {
        await env.SUBSCRIPTIONS.put(
          key.name,
          JSON.stringify({
            ...record,
            alertState,
            updatedAt: new Date().toISOString(),
          })
        );
      }
    }

    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
}

async function sendCityLookup(env, chatId, rawCityName) {
  const cityName = normalizeCityName(rawCityName);
  if (!cityName) {
    await sendTelegramMessage(
      env,
      chatId,
      "Send a city name like Mumbai, Jaipur, Hyderabad, or Lucknow. You can also use /city Mumbai."
    );
    return;
  }

  const { latest, summary } = await fetchSeatData(env);
  const matchedCityMeta = findBestCityMatch(summary, cityName);

  if (!matchedCityMeta) {
    await sendTelegramMessage(
      env,
      chatId,
      `I could not recognise "${rawCityName}". Try a city like Mumbai, Jaipur, Pune, or type "/help" to see commands.`
    );
    return;
  }

  let matchingRows = [];
  let resultLabel = "Live check";
  let resultTimestamp = new Date().toLocaleString("en-IN", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Kolkata",
  });
  try {
    matchingRows = await fetchLiveCityAvailability(matchedCityMeta.state, matchedCityMeta.city);
  } catch (error) {
    matchingRows = (latest.rows || []).filter(
      (row) =>
        canonicalCityKey(row.city, row.state) ===
        canonicalCityKey(matchedCityMeta.city, matchedCityMeta.state)
    );
    resultLabel = "Latest saved scan";
    resultTimestamp = latest.generatedAtDisplay || latest.generatedAt || "Unknown";
  }

  const alternatives = getBestAlternatives(
    summary,
    matchedCityMeta.city,
    matchedCityMeta.state
  ).slice(0, 5);

  if (!matchingRows.length) {
    const lines = [
      `No open SPOM seats found for ${matchedCityMeta.city}, ${matchedCityMeta.state}.`,
      `${resultLabel}: ${resultTimestamp}`,
      "",
      "Next best 5 options:",
      ...formatAlternatives(alternatives),
      "",
      `To save this city for future Telegram reminders, use: /remind ${matchedCityMeta.city}`,
    ];

    await sendTelegramMessage(env, chatId, lines.join("\n"));
    return;
  }

  const citySummary = (summary.cities || []).find(
    (item) =>
      canonicalCityKey(item.city, item.state) ===
      canonicalCityKey(matchedCityMeta.city, matchedCityMeta.state)
  );

  const lines = [
    `SPOM seats for ${matchedCityMeta.city}, ${matchedCityMeta.state}`,
    `${resultLabel}: ${resultTimestamp}`,
    `Open entries: ${citySummary?.available_count ?? matchingRows.length}`,
    "",
    "Current batches:",
    ...matchingRows
      .slice(0, 12)
      .map((row) => `- ${row.centre} | ${row.date} | Capacity ${row.capacity}`),
  ];

  if (matchingRows.length > 12) {
    lines.push("");
    lines.push(`Showing first 12 entries out of ${matchingRows.length}.`);
  }

  lines.push("");
  lines.push("Next best 5 options:");
  lines.push(...formatAlternatives(alternatives));
  lines.push("");
  lines.push(`To save this city for future Telegram reminders, use: /remind ${matchedCityMeta.city}`);

  await sendTelegramMessage(env, chatId, lines.join("\n"));
}

async function saveReminder(env, chatId, rawCityName) {
  const cityName = normalizeCityName(rawCityName);
  if (!cityName) {
    await sendTelegramMessage(env, chatId, "Use /remind CityName. Example: /remind Mumbai");
    return;
  }

  if (!env.SUBSCRIPTIONS) {
    await sendTelegramMessage(
      env,
      chatId,
      `Reminders are not fully connected yet, but you can already check the city by sending ${cityName}.\n\nOnce Cloudflare KV is attached, /remind ${cityName} will save your alert automatically.`
    );
    return;
  }

  const reminderKey = String(chatId);
  const existing = (await env.SUBSCRIPTIONS.get(reminderKey, "json")) || { cities: [] };
  const normalizedCities = new Set(
    (existing.cities || []).map((item) => normalizeCityName(item)).filter(Boolean)
  );
  normalizedCities.add(cityName);

  const { summary } = await fetchSeatData(env);
  const matchedCityMeta = findBestCityMatch(summary, cityName);
  const savedCityName = matchedCityMeta ? matchedCityMeta.city : cityName;
  normalizedCities.delete(cityName);
  normalizedCities.add(savedCityName);

  await env.SUBSCRIPTIONS.put(
    reminderKey,
    JSON.stringify({
      chatId,
      firstName: existing.firstName || "",
      lastName: existing.lastName || "",
      username: existing.username || "",
      languageCode: existing.languageCode || "",
      cities: Array.from(normalizedCities).sort((a, b) => a.localeCompare(b)),
      alertState: existing.alertState || {},
      createdAt: existing.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
  );

  await sendTelegramMessage(
    env,
    chatId,
    `Saved reminder for ${savedCityName}.\n\nUse /myreminders to see your saved cities.`
  );
}

async function listReminders(env, chatId) {
  if (!env.SUBSCRIPTIONS) {
    await sendTelegramMessage(
      env,
      chatId,
      "Reminder storage is not connected yet. Attach a KV binding named SUBSCRIPTIONS in Cloudflare to enable saved alerts."
    );
    return;
  }

  const existing = (await env.SUBSCRIPTIONS.get(String(chatId), "json")) || { cities: [] };
  const cities = existing.cities || [];

  if (!cities.length) {
    await sendTelegramMessage(
      env,
      chatId,
      "You do not have any saved reminder cities yet.\n\nUse /remind CityName to add one."
    );
    return;
  }

  await sendTelegramMessage(
    env,
    chatId,
    `Your reminder cities:\n${cities.map((city, index) => `${index + 1}. ${city}`).join("\n")}`
  );
}

async function removeReminder(env, chatId, rawCityName) {
  const cityName = normalizeCityName(rawCityName);
  if (!cityName) {
    await sendTelegramMessage(env, chatId, "Use /stop CityName. Example: /stop Mumbai");
    return;
  }

  if (!env.SUBSCRIPTIONS) {
    await sendTelegramMessage(
      env,
      chatId,
      "Reminder storage is not connected yet, so there is nothing saved to remove."
    );
    return;
  }

  const reminderKey = String(chatId);
  const existing = (await env.SUBSCRIPTIONS.get(reminderKey, "json")) || { cities: [] };
  const remaining = (existing.cities || []).filter(
    (item) => normalizeCityName(item).toLowerCase() !== cityName.toLowerCase()
  );

  await env.SUBSCRIPTIONS.put(
    reminderKey,
    JSON.stringify({
      chatId,
      firstName: existing.firstName || "",
      lastName: existing.lastName || "",
      username: existing.username || "",
      languageCode: existing.languageCode || "",
      cities: remaining,
      alertState: existing.alertState || {},
      createdAt: existing.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
  );

  await sendTelegramMessage(
    env,
    chatId,
    `Removed ${cityName} from your reminder list.`
  );
}

async function fetchSeatData(env) {
  const baseUrl = env.SPOM_DATA_BASE_URL || DEFAULT_DATA_BASE_URL;
  const [latestResponse, summaryResponse] = await Promise.all([
    fetch(`${baseUrl}/latest.json`, { cf: { cacheTtl: 0, cacheEverything: false } }),
    fetch(`${baseUrl}/summary.json`, { cf: { cacheTtl: 0, cacheEverything: false } }),
  ]);

  if (!latestResponse.ok || !summaryResponse.ok) {
    throw new Error("Could not load the latest SPOM seat data.");
  }

  const latest = await latestResponse.json();
  const summary = await summaryResponse.json();
  return { latest, summary };
}

async function fetchLiveCityAvailability(stateName, cityName) {
  const client = new LiveSpomClient();
  const states = await client.fetchStates();
  const matchedState = states.find(
    (item) => normalizeLookupKey(item.label) === normalizeLookupKey(stateName)
  );
  if (!matchedState) {
    throw new Error(`State "${stateName}" was not found on ICAI.`);
  }

  const cities = await client.fetchCities(matchedState.key);
  const matchedCity = cities.find(
    (item) => normalizeLookupKey(item.label) === normalizeLookupKey(cityName)
  );
  if (!matchedCity) {
    throw new Error(`City "${cityName}" was not found on ICAI for ${stateName}.`);
  }

  const centres = await client.fetchCentres(matchedCity.key);
  const rows = [];
  for (const centre of centres) {
    const availability = await client.fetchCentreAvailability(centre.key);
    for (const slot of availability) {
      rows.push({
        state: stateName,
        city: cityName,
        centre: centre.label,
        date: slot.date,
        capacity: slot.capacity,
      });
    }
  }

  return rows.sort((a, b) =>
    [a.state, a.city, a.centre, a.date].join("||").localeCompare([b.state, b.city, b.centre, b.date].join("||"))
  );
}

function getBestAlternatives(summary, cityName, stateName = "") {
  const cities = summary.cities || [];
  const selected = cities.find(
    (item) => canonicalCityKey(item.city, item.state) === canonicalCityKey(cityName, stateName)
  );

  const available = cities.filter((item) => Number(item.available_count || 0) > 0);

  if (!selected || selected.lat == null || selected.lon == null) {
    return available
      .filter(
        (item) => canonicalCityKey(item.city, item.state) !== canonicalCityKey(cityName, stateName)
      )
      .sort((a, b) => Number(b.available_count || 0) - Number(a.available_count || 0));
  }

  return available
    .filter(
      (item) => canonicalCityKey(item.city, item.state) !== canonicalCityKey(cityName, stateName)
    )
    .map((item) => ({
      ...item,
      distanceScore: haversineKm(selected.lat, selected.lon, item.lat, item.lon),
    }))
    .sort((a, b) => a.distanceScore - b.distanceScore);
}

function formatAlternatives(alternatives) {
  if (!alternatives.length) {
    return ["No tracked alternatives are open right now."];
  }

  return alternatives.map(
    (item, index) => `${index + 1}. ${item.city}, ${item.state} (${item.available_count} open entry(s))`
  );
}

function normalizeCityName(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

async function persistUserProfile(env, message) {
  if (!env.SUBSCRIPTIONS || !message?.chat?.id) {
    return;
  }

  const chatId = String(message.chat.id);
  const existing = (await env.SUBSCRIPTIONS.get(chatId, "json")) || {};
  const user = message.from || {};

  await env.SUBSCRIPTIONS.put(
    chatId,
    JSON.stringify({
      chatId: message.chat.id,
      firstName: user.first_name || existing.firstName || "",
      lastName: user.last_name || existing.lastName || "",
      username: user.username || existing.username || "",
      languageCode: user.language_code || existing.languageCode || "",
      cities: existing.cities || [],
      alertState: existing.alertState || {},
      createdAt: existing.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
    })
  );
}

function findBestCityMatch(summary, userInput) {
  const cities = summary.cities || [];
  const normalizedInput = normalizeLookupKey(userInput);
  if (!normalizedInput) {
    return null;
  }

  const exactMatch = cities.find(
    (item) => canonicalCityKey(item.city, item.state) === normalizedInput
  );
  if (exactMatch) {
    return exactMatch;
  }

  const cityOnlyMatch = cities.find((item) => normalizeLookupKey(item.city) === normalizedInput);
  if (cityOnlyMatch) {
    return cityOnlyMatch;
  }

  const stateAwareMatch = cities.find((item) => {
    const cityKey = normalizeLookupKey(item.city);
    const stateKey = normalizeLookupKey(item.state);
    return (
      normalizedInput === `${cityKey} ${stateKey}` ||
      normalizedInput === `${stateKey} ${cityKey}` ||
      normalizedInput.includes(cityKey)
    );
  });
  if (stateAwareMatch) {
    return stateAwareMatch;
  }

  return null;
}

function canonicalCityKey(city, state = "") {
  return normalizeLookupKey(`${city || ""} ${state || ""}`);
}

function normalizeLookupKey(value) {
  return normalizeCityName(value)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildWelcomeText() {
  return [
    "Welcome to the SPOM Seat Checker bot.",
    "",
    "How to use:",
    "1. Send any city name like Mumbai, Jaipur, or Pune.",
    "2. Use /remind CityName to save a reminder city.",
    "3. Use /myreminders to see your saved cities.",
    "4. Use /stop CityName to remove a saved city.",
    "5. Use /help to open this guide again.",
    "",
    "Every city reply shows the latest batches plus the next best 5 alternatives.",
  ].join("\n");
}

function buildReminderAlertText(latest, matchedCityMeta, matchingRows) {
  const lines = [
    `SPOM reminder for ${matchedCityMeta.city}, ${matchedCityMeta.state}`,
    `Latest successful scan: ${latest.generatedAtDisplay || latest.generatedAt || "Unknown"}`,
    "",
    "Seats are currently available:",
    ...matchingRows
      .slice(0, 8)
      .map((row) => `- ${row.centre} | ${row.date} | Capacity ${row.capacity}`),
  ];

  if (matchingRows.length > 8) {
    lines.push("");
    lines.push(`Showing first 8 entries out of ${matchingRows.length}.`);
  }

  lines.push("");
  lines.push("Use /stop CityName if you no longer want reminders for this city.");
  return lines.join("\n");
}

class LiveSpomClient {
  constructor() {
    this.cookies = "";
  }

  async bootstrap() {
    const response = await this.requestText(SLOT_PAGE_URL);
    const setCookie = response.headers.get("set-cookie");
    if (setCookie) {
      this.cookies = setCookie
        .split(/,(?=[^;]+=[^;]+)/)
        .map((part) => part.split(";", 1)[0].trim())
        .join("; ");
    }
    return response.text;
  }

  async fetchStates() {
    const page = await this.bootstrap();
    return extractSelectOptions(page, "cmbStateList");
  }

  async fetchCities(stateKey) {
    const payload = await this.fetchAjaxText(
      `${BASE_URL}/LoginAction_getCityForTestCenters.action?statePk=${encodeURIComponent(stateKey)}`
    );
    return parseDelimitedOptions(payload);
  }

  async fetchCentres(cityKey) {
    const payload = await this.fetchAjaxText(
      `${BASE_URL}/LoginAction_getTestCentreForCity.action?selectedCity=${encodeURIComponent(cityKey)}`
    );
    return parseDelimitedOptions(payload);
  }

  async fetchCentreAvailability(centreKey) {
    const payload = await this.fetchAjaxText(
      `${BASE_URL}/LoginAction_getTestCenterAddress.action?cmbTstCenter=${encodeURIComponent(centreKey)}`
    );
    const trimmed = payload.trim();
    if (!trimmed) {
      return [];
    }

    const parts = trimmed.split("##");
    if (parts.length < 2) {
      return [];
    }

    const rawDates = parts[1];
    if (rawDates.includes("NoDatesAvlMsg")) {
      return [];
    }

    return rawDates
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.includes("&&"))
      .map((entry) => {
        const [date, capacityText] = entry.split("&&");
        return {
          date: date.trim(),
          capacity: Number.parseInt(capacityText, 10),
        };
      })
      .filter((entry) => Number.isFinite(entry.capacity) && entry.capacity > 0);
  }

  async fetchAjaxText(url) {
    const response = await this.requestText(url, {
      "X-Requested-With": "XMLHttpRequest",
      Referer: SLOT_PAGE_URL,
      Origin: "https://spmt.icai.org",
      Cookie: this.cookies,
    });
    return response.text;
  }

  async requestText(url, extraHeaders = {}) {
    const response = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "*/*",
        ...extraHeaders,
      },
      redirect: "manual",
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      throw new Error(`ICAI redirected request to ${location || "an unknown location"}`);
    }

    const text = await response.text();
    if (!response.ok) {
      throw new Error(`ICAI request failed with status ${response.status}`);
    }

    return { text, headers: response.headers };
  }
}

function parseDelimitedOptions(payload) {
  return payload
    .trim()
    .split("##")
    .map((entry) => entry.trim())
    .filter((entry) => entry.includes("$$"))
    .map((entry) => {
      const [key, label] = entry.split("$$");
      return {
        key: key.trim(),
        label: label.trim(),
      };
    })
    .filter((entry) => entry.key && entry.key !== "-1" && entry.label);
}

function extractSelectOptions(html, selectId) {
  const selectPattern = new RegExp(
    `<select[^>]*id="${escapeRegex(selectId)}"[^>]*>([\\s\\S]*?)</select>`,
    "i"
  );
  const match = html.match(selectPattern);
  if (!match) {
    return [];
  }

  const optionPattern = /<option\s+value="([^"]*)"(?:[^>]*)>([\s\S]*?)<\/option>/gi;
  const options = [];
  let optionMatch;
  while ((optionMatch = optionPattern.exec(match[1])) !== null) {
    const key = decodeHtml(optionMatch[1]).trim();
    const label = decodeHtml(optionMatch[2]).replace(/\s+/g, " ").trim();
    if (key && key !== "-1" && label) {
      options.push({ key, label });
    }
  }

  return options;
}

function decodeHtml(value) {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const toRad = (value) => (value * Math.PI) / 180;
  const earthKm = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return earthKm * c;
}

async function sendTelegramMessage(env, chatId, text) {
  if (!env.TELEGRAM_BOT_TOKEN) {
    throw new Error("TELEGRAM_BOT_TOKEN is missing.");
  }

  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
    }),
  });

  if (!response.ok) {
    const failureText = await response.text();
    throw new Error(`Telegram sendMessage failed: ${failureText}`);
  }
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...corsHeaders(),
    },
  });
}

function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type",
  };
}
