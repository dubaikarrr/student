const BASE_URL = "https://spmt.icai.org/ICAI";
const SLOT_PAGE_URL = `${BASE_URL}/LoginAction_showSlotDetails.action`;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/api/health") {
      return json({ ok: true, service: "spom-seat-checker" });
    }

    if (url.pathname === "/api/latest") {
      return handleLatest(request, env);
    }

    if (url.pathname === "/api/summary") {
      return handleSummary(request, env);
    }

    if (url.pathname === "/api/run") {
      if (!isAuthorized(request, env)) {
        return json({ error: "Unauthorized" }, 401);
      }

      const result = await runScan(env);
      return json(result, result.ok ? 200 : 500);
    }

    return env.ASSETS.fetch(request);
  },

  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(runScan(env));
  },
};

async function handleLatest(request, env) {
  const url = new URL(request.url);
  const state = url.searchParams.get("state")?.trim() || "";
  const city = url.searchParams.get("city")?.trim() || "";
  const latestRun = await getLatestSuccessfulRun(env);

  if (!latestRun) {
    return json({
      generatedAt: null,
      total: 0,
      rows: [],
      message: "No scan has completed yet.",
    });
  }

  let query = `
    SELECT state, city, centre, exam_date AS date, capacity
    FROM availability
    WHERE run_id = ?
  `;
  const bindings = [latestRun.id];

  if (state) {
    query += " AND state = ?";
    bindings.push(state);
  }

  if (city) {
    query += " AND city = ?";
    bindings.push(city);
  }

  query += " ORDER BY state, city, centre, exam_date";

  const rows = await env.DB.prepare(query).bind(...bindings).all();

  return json({
    generatedAt: latestRun.finished_at,
    total: rows.results.length,
    rows: rows.results,
    filters: { state, city },
  });
}

async function handleSummary(_request, env) {
  const latestRun = await getLatestSuccessfulRun(env);
  if (!latestRun) {
    return json({
      generatedAt: null,
      states: [],
      cities: [],
    });
  }

  const states = await env.DB.prepare(
    `
      SELECT state, COUNT(*) AS available_count
      FROM availability
      WHERE run_id = ?
      GROUP BY state
      ORDER BY state
    `
  )
    .bind(latestRun.id)
    .all();

  const cities = await env.DB.prepare(
    `
      SELECT state, city, COUNT(*) AS available_count
      FROM availability
      WHERE run_id = ?
      GROUP BY state, city
      ORDER BY state, city
    `
  )
    .bind(latestRun.id)
    .all();

  return json({
    generatedAt: latestRun.finished_at,
    states: states.results,
    cities: cities.results,
  });
}

async function runScan(env) {
  const startedAt = new Date().toISOString();
  const runInsert = await env.DB.prepare(
    `
      INSERT INTO scan_runs (status, started_at)
      VALUES ('running', ?)
    `
  )
    .bind(startedAt)
    .run();

  const runId = runInsert.meta.last_row_id;

  try {
    const client = new SpomClient();
    const states = await client.fetchStates();
    const rows = [];

    for (const state of states) {
      const cities = await client.fetchCities(state.key);
      for (const city of cities) {
        const centres = await client.fetchCentres(city.key);
        for (const centre of centres) {
          const availability = await client.fetchCentreAvailability(centre.key);
          for (const slot of availability) {
            rows.push({
              runId,
              state: state.label,
              city: city.label,
              centre: centre.label,
              date: slot.date,
              capacity: slot.capacity,
            });
          }
        }
      }
    }

    await insertAvailabilityRows(env, rows);
    await trimOldRuns(env, 14);

    const finishedAt = new Date().toISOString();
    await env.DB.prepare(
      `
        UPDATE scan_runs
        SET status = 'success',
            finished_at = ?,
            total_rows = ?
        WHERE id = ?
      `
    )
      .bind(finishedAt, rows.length, runId)
      .run();

    return {
      ok: true,
      runId,
      generatedAt: finishedAt,
      total: rows.length,
    };
  } catch (error) {
    const finishedAt = new Date().toISOString();
    await env.DB.prepare(
      `
        UPDATE scan_runs
        SET status = 'failed',
            finished_at = ?,
            error_message = ?
        WHERE id = ?
      `
    )
      .bind(finishedAt, String(error?.message || error), runId)
      .run();

    return {
      ok: false,
      runId,
      error: String(error?.message || error),
    };
  }
}

async function insertAvailabilityRows(env, rows) {
  if (!rows.length) {
    return;
  }

  const batchSize = 50;
  for (let index = 0; index < rows.length; index += batchSize) {
    const chunk = rows.slice(index, index + batchSize);
    const statements = chunk.map((row) =>
      env.DB.prepare(
        `
          INSERT INTO availability (run_id, state, city, centre, exam_date, capacity)
          VALUES (?, ?, ?, ?, ?, ?)
        `
      ).bind(row.runId, row.state, row.city, row.centre, row.date, row.capacity)
    );
    await env.DB.batch(statements);
  }
}

async function trimOldRuns(env, keepCount) {
  const oldRuns = await env.DB.prepare(
    `
      SELECT id
      FROM scan_runs
      WHERE status IN ('success', 'failed')
      ORDER BY started_at DESC
      LIMIT -1 OFFSET ?
    `
  )
    .bind(keepCount)
    .all();

  if (!oldRuns.results.length) {
    return;
  }

  const ids = oldRuns.results.map((row) => row.id);
  const placeholders = ids.map(() => "?").join(", ");

  await env.DB.prepare(`DELETE FROM availability WHERE run_id IN (${placeholders})`)
    .bind(...ids)
    .run();
  await env.DB.prepare(`DELETE FROM scan_runs WHERE id IN (${placeholders})`)
    .bind(...ids)
    .run();
}

async function getLatestSuccessfulRun(env) {
  const result = await env.DB.prepare(
    `
      SELECT id, started_at, finished_at, total_rows
      FROM scan_runs
      WHERE status = 'success'
      ORDER BY started_at DESC
      LIMIT 1
    `
  ).first();

  return result || null;
}

class SpomClient {
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

function isAuthorized(request, env) {
  if (!env.ADMIN_TOKEN) {
    return false;
  }

  const bearer = request.headers.get("authorization");
  const headerToken = request.headers.get("x-admin-token");
  const token = bearer?.startsWith("Bearer ") ? bearer.slice(7) : headerToken;
  return token === env.ADMIN_TOKEN;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}
