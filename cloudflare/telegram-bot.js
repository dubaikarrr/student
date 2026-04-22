const DEFAULT_DATA_BASE_URL = "https://dubaikarrr.github.io/student/data";
const BOT_USERNAME = "SPOM_Seat_Checker_bot";

export default {
  async fetch(request, env) {
    if (request.method === "POST") {
      return handleTelegramWebhook(request, env);
    }

    return jsonResponse({
      ok: true,
      service: "spom-telegram-bot",
      botUsername: BOT_USERNAME,
      dataBaseUrl: env.SPOM_DATA_BASE_URL || DEFAULT_DATA_BASE_URL,
    });
  },
};

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

  const matchingRows = (latest.rows || []).filter(
    (row) =>
      canonicalCityKey(row.city, row.state) ===
      canonicalCityKey(matchedCityMeta.city, matchedCityMeta.state)
  );

  const alternatives = getBestAlternatives(
    summary,
    matchedCityMeta.city,
    matchedCityMeta.state
  ).slice(0, 5);

  if (!matchingRows.length) {
    const lines = [
      `No open SPOM seats found for ${matchedCityMeta.city}, ${matchedCityMeta.state} in the latest successful scan.`,
      `Last successful scan: ${latest.generatedAtDisplay || latest.generatedAt || "Unknown"}`,
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
    `Last successful scan: ${latest.generatedAtDisplay || latest.generatedAt || "Unknown"}`,
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

  await env.SUBSCRIPTIONS.put(
    reminderKey,
    JSON.stringify({
      chatId,
      firstName: existing.firstName || "",
      lastName: existing.lastName || "",
      username: existing.username || "",
      languageCode: existing.languageCode || "",
      cities: Array.from(normalizedCities).sort((a, b) => a.localeCompare(b)),
      createdAt: existing.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
  );

  await sendTelegramMessage(
    env,
    chatId,
    `Saved reminder for ${cityName}.\n\nUse /myreminders to see your saved cities.`
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
    },
  });
}
