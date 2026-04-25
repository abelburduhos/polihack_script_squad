// Weather validation for alarm evaluation.
// Requires WEATHER_API_KEY env var (OpenWeatherMap free tier).
// Without it every alarm defaults to verdict "real".

const https = require("https");

function fetchWeather(lat, lng) {
  const key = process.env.WEATHER_API_KEY;
  return new Promise((resolve, reject) => {
    const url =
      `https://api.openweathermap.org/data/2.5/weather` +
      `?lat=${lat}&lon=${lng}&appid=${encodeURIComponent(key)}&units=metric`;
    https
      .get(url, (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          try {
            const d = JSON.parse(raw);
            if (res.statusCode !== 200)
              reject(new Error(d.message || `HTTP ${res.statusCode}`));
            else resolve(d);
          } catch (e) {
            reject(e);
          }
        });
      })
      .on("error", reject);
  });
}

function evalWildfire(w) {
  const temp     = w.main?.temp     ?? 0;
  const humidity = w.main?.humidity ?? 100;
  const wind     = w.wind?.speed    ?? 0;
  const main     = w.weather?.[0]?.main ?? "";

  if (main === "Rain" || main === "Snow") {
    return { confirmed: false, reason: `Precipitation (${main}) — wildfire unlikely` };
  }
  if ((temp > 30 && humidity < 40) || (wind > 10 && temp > 25)) {
    return {
      confirmed: true,
      reason: `${temp}°C, ${humidity}% RH, wind ${wind} m/s — fire conditions confirmed`,
    };
  }
  return {
    confirmed: false,
    reason: `${temp}°C, ${humidity}% RH — conditions don't support wildfire`,
  };
}

function evalFlood(w) {
  const rain1h = w.rain?.["1h"] ?? 0;
  const main   = w.weather?.[0]?.main ?? "";
  const rainy  = ["Rain", "Thunderstorm", "Drizzle"].includes(main);

  if (rain1h > 5 || rainy) {
    return {
      confirmed: true,
      reason: `${rain1h} mm/h rain, ${main} — flood risk confirmed`,
    };
  }
  return {
    confirmed: false,
    reason: `${rain1h} mm/h rain, ${main} — no significant precipitation`,
  };
}

async function evaluateAlarm(type, lat, lng) {
  if (!process.env.WEATHER_API_KEY) {
    return {
      confirmed: null,
      reason: "Weather API not configured (set WEATHER_API_KEY in .env)",
      weather: null,
    };
  }
  try {
    const w = await fetchWeather(lat, lng);
    const result = type === "wildfire" ? evalWildfire(w) : evalFlood(w);
    return { ...result, weather: w };
  } catch (err) {
    return {
      confirmed: null,
      reason: `Weather fetch failed: ${err.message}`,
      weather: null,
    };
  }
}

module.exports = { evaluateAlarm };
