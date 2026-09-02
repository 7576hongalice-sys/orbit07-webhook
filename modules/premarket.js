const axios = require("axios");

const SOURCE_REPOSITORY = "7576hongalice-sys/chencai-postmarket-data";
const SOURCE_BRANCH = "main";
const STATUS_PATH = "data/latest/status.json";

const OFFICIAL_CHECKS = Object.freeze({
  "加權指數": "twse_index",
  "櫃買指數": "tpex_index",
  "三大法人買賣超": "institution_summary",
  "上市外資買賣超排行": "twse_foreign",
  "上市投信買賣超排行": "twse_trust",
  "上櫃外資買賣超排行": "tpex_foreign",
  "上櫃投信買賣超排行": "tpex_trust",
});

const EXPECTED_DEPENDENCIES = Object.freeze({
  "加權指數": ["twse_index"],
  "櫃買指數": ["tpex_index"],
  "三大法人買賣超": ["twse_institution_summary", "tpex_institution_summary"],
  "上市外資買賣超排行": ["twse_institution_detail"],
  "上市投信買賣超排行": ["twse_institution_detail"],
  "上櫃外資買賣超排行": ["tpex_foreign"],
  "上櫃投信買賣超排行": ["tpex_trust"],
});

class PremarketGateError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PremarketGateError";
    this.code = code;
  }
}

function taiwanDate(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function isIsoDate(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function parseJson(text, sourcePath) {
  if (typeof text !== "string") {
    throw new PremarketGateError("schema_error", `${sourcePath} did not return text`);
  }
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("root must be an object");
    }
    return value;
  } catch (error) {
    throw new PremarketGateError("json_parse_error", `${sourcePath}: ${error.message}`);
  }
}

function expectBaseGateFields(data, expectedDate, sourcePath) {
  if (data.trading_date !== expectedDate) {
    throw new PremarketGateError(
      "trading_date_mismatch",
      `${sourcePath} trading_date ${String(data.trading_date)} does not match ${expectedDate}`
    );
  }
  if (data.official_only !== true) {
    throw new PremarketGateError("not_official_only", `${sourcePath} official_only is not true`);
  }
  if (data.completeness !== "7/7") {
    throw new PremarketGateError("incomplete", `${sourcePath} completeness is not 7/7`);
  }
  if (data.complete !== true) {
    throw new PremarketGateError("incomplete", `${sourcePath} complete is not true`);
  }
}

function determinePreviousTradingDate(status, currentTaiwanDate) {
  const candidate = status?.trading_date;
  if (!isIsoDate(currentTaiwanDate) || !isIsoDate(candidate)) {
    throw new PremarketGateError("trading_date_invalid", "Unable to determine a valid previous trading date");
  }
  if (candidate >= currentTaiwanDate) {
    throw new PremarketGateError(
      "trading_date_not_previous",
      `Latest official trading_date ${candidate} is not before Taiwan date ${currentTaiwanDate}`
    );
  }
  return candidate;
}

function validateStatus(status, previousTradingDate) {
  expectBaseGateFields(status, previousTradingDate, STATUS_PATH);

  if (!Array.isArray(status.items) || status.items.length !== 7) {
    throw new PremarketGateError("schema_error", `${STATUS_PATH} must contain exactly 7 items`);
  }

  const byLabel = new Map();
  for (const item of status.items) {
    if (!item || typeof item.label !== "string" || byLabel.has(item.label)) {
      throw new PremarketGateError("schema_error", `${STATUS_PATH} contains an invalid or duplicate item`);
    }
    byLabel.set(item.label, item);
  }

  const checks = {};
  for (const [label, checkName] of Object.entries(OFFICIAL_CHECKS)) {
    const item = byLabel.get(label);
    if (!item) {
      throw new PremarketGateError("schema_error", `${STATUS_PATH} is missing item: ${label}`);
    }
    if (item.updated !== true) {
      throw new PremarketGateError("item_not_updated", `${STATUS_PATH} item is not updated: ${label}`);
    }

    const dependencies = EXPECTED_DEPENDENCIES[label];
    if (!Array.isArray(item.dependencies) ||
        dependencies.some((dependency) => !item.dependencies.includes(dependency))) {
      throw new PremarketGateError("schema_error", `${STATUS_PATH} item has invalid dependencies: ${label}`);
    }
    for (const dependency of dependencies) {
      if (status.endpoints?.[dependency]?.updated !== true) {
        throw new PremarketGateError(
          "endpoint_not_updated",
          `${STATUS_PATH} endpoint is not updated: ${dependency}`
        );
      }
    }
    checks[checkName] = true;
  }

  if ([...byLabel.keys()].some((label) => !(label in OFFICIAL_CHECKS))) {
    throw new PremarketGateError("schema_error", `${STATUS_PATH} contains an unknown official-data item`);
  }
  return checks;
}

function validateHistory(history, previousTradingDate) {
  const sourcePath = `data/history/${previousTradingDate.replaceAll("-", "")}.json`;
  expectBaseGateFields(history, previousTradingDate, sourcePath);
  if (!history.checks || typeof history.checks !== "object" || Array.isArray(history.checks)) {
    throw new PremarketGateError("schema_error", `${sourcePath} checks must be an object`);
  }
  for (const label of Object.keys(OFFICIAL_CHECKS)) {
    if (history.checks[label] !== true) {
      throw new PremarketGateError("history_check_failed", `${sourcePath} check failed: ${label}`);
    }
  }
  if (Object.keys(history.checks).length !== 7) {
    throw new PremarketGateError("schema_error", `${sourcePath} must contain exactly 7 checks`);
  }
}

function contentsApiUrl(path) {
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  return `https://api.github.com/repos/${SOURCE_REPOSITORY}/contents/${encodedPath}?ref=${encodeURIComponent(SOURCE_BRANCH)}`;
}

function decodeContentsApiFile(payload, expectedPath) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new PremarketGateError("github_response_invalid", "GitHub Contents API response is not a file object");
  }
  if (payload.type !== "file" || payload.path !== expectedPath || payload.encoding !== "base64" ||
      typeof payload.content !== "string") {
    throw new PremarketGateError("github_response_invalid", `GitHub Contents API returned an invalid file for ${expectedPath}`);
  }

  const encoded = payload.content.replace(/\s/g, "");
  if (!encoded || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    throw new PremarketGateError("base64_decode_failed", `GitHub Contents API returned invalid base64 for ${expectedPath}`);
  }
  try {
    const decoded = Buffer.from(encoded, "base64");
    if (decoded.toString("base64") !== encoded) {
      throw new Error("non-canonical base64");
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(decoded);
  } catch {
    throw new PremarketGateError("base64_decode_failed", `GitHub Contents API could not decode ${expectedPath}`);
  }
}

function createGitHubReader(httpClient = axios, options = {}) {
  const configuredToken = Object.prototype.hasOwnProperty.call(options, "token")
    ? options.token
    : process.env.CHENCAI_POSTMARKET_READ_TOKEN;

  return {
    async readText(path) {
      const token = typeof configuredToken === "string" ? configuredToken.trim() : "";
      if (!token) {
        throw new PremarketGateError(
          "missing_read_token",
          "CHENCAI_POSTMARKET_READ_TOKEN is not configured"
        );
      }
      try {
        const response = await httpClient.get(contentsApiUrl(path), {
          timeout: 20000,
          headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${token}`,
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "orbit07-premarket-gate",
          },
        });
        return decodeContentsApiFile(response?.data, path);
      } catch (error) {
        if (error instanceof PremarketGateError) throw error;
        const status = error?.response?.status;
        throw new PremarketGateError(
          "github_read_failed",
          `Unable to read ${path} from official data repository${status ? ` (HTTP ${status})` : ""}`
        );
      }
    },
  };
}

async function runPremarketGate({ reader = createGitHubReader(), now = new Date() } = {}) {
  const currentTaiwanDate = taiwanDate(now);
  const status = parseJson(await reader.readText(STATUS_PATH), STATUS_PATH);
  const previousTradingDate = determinePreviousTradingDate(status, currentTaiwanDate);
  const checks = validateStatus(status, previousTradingDate);

  const historyPath = `data/history/${previousTradingDate.replaceAll("-", "")}.json`;
  const history = parseJson(await reader.readText(historyPath), historyPath);
  validateHistory(history, previousTradingDate);

  return {
    premarket_ready: true,
    taiwan_date: currentTaiwanDate,
    previous_trading_date: previousTradingDate,
    source_repository: SOURCE_REPOSITORY,
    source_branch: SOURCE_BRANCH,
    official_only: true,
    official_data_count: 7,
    official_data_total: 7,
    complete: true,
    checks,
    message: "Premarket official-data gate passed",
  };
}

function failureDiagnostic(error, now = new Date()) {
  const gateError = error instanceof PremarketGateError
    ? error
    : new PremarketGateError("unexpected_error", "Unexpected premarket gate error");
  return {
    premarket_ready: false,
    taiwan_date: taiwanDate(now),
    source_repository: SOURCE_REPOSITORY,
    source_branch: SOURCE_BRANCH,
    reason: gateError.code,
    detail: gateError.message,
    message: "Previous trading day's official data is not complete",
  };
}

function mountPremarket(app, {
  requireKey,
  reader = createGitHubReader(),
  now = () => new Date(),
  afterReady,
} = {}) {
  if (typeof requireKey !== "function") throw new Error("requireKey is required");

  app.post("/cron/premarket", async (req, res) => {
    if (!requireKey(req, res)) return;
    const currentTime = now();
    try {
      const diagnostic = await runPremarketGate({ reader, now: currentTime });
      if (typeof afterReady === "function") await afterReady(diagnostic);
      return res.json(diagnostic);
    } catch (error) {
      const diagnostic = failureDiagnostic(error, currentTime);
      console.error("premarket gate failed:", diagnostic.reason, diagnostic.detail);
      return res.status(503).json(diagnostic);
    }
  });
}

module.exports = {
  OFFICIAL_CHECKS,
  PremarketGateError,
  STATUS_PATH,
  contentsApiUrl,
  createGitHubReader,
  decodeContentsApiFile,
  determinePreviousTradingDate,
  failureDiagnostic,
  mountPremarket,
  parseJson,
  runPremarketGate,
  taiwanDate,
  validateHistory,
  validateStatus,
};
