// AI-based sensor alarm analysis using OpenAI GPT-4o.
// Analyzes full sensor metrics and returns a structured verdict.
// Set OPENAI_API_KEY in .env to enable. Without it all alarms return UNKNOWN.

const OpenAI = require("openai");

let client = null;
function getClient() {
  if (!client && process.env.OPENAI_API_KEY) {
    client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return client;
}

const SYSTEM_PROMPT = `You are a disaster monitoring AI integrated into a real-time sensor network.
Analyze the sensor data and return a JSON object with exactly two fields:
- "verdict": one of "SAFE", "FOREST_FIRE_WARNING", or "FLOOD_WARNING"
- "reasoning": one concise sentence explaining the verdict

Rules:
- FOREST_FIRE_WARNING: smoke_index > 0.5 AND (temp_c > 32 OR humidity_pct < 25), OR co2_ppm > 650
- FLOOD_WARNING: level_cm > 500 OR flow_m3s > 1500
- SAFE: conditions do not meet warning thresholds
- Use the location and context to add geographic reasoning if relevant.`;

async function analyzeAlarm(type, metrics, lat, lng) {
  const ai = getClient();
  if (!ai) {
    return { verdict: "UNKNOWN", reasoning: "OPENAI_API_KEY not configured — set it in .env" };
  }

  const sensorData = {
    sensor_type: type,
    location: { lat: +lat.toFixed(5), lng: +lng.toFixed(5) },
    metrics: type === "wildfire"
      ? {
          temperature_celsius: metrics.temp_c,
          humidity_percent:    metrics.humidity_pct,
          co2_ppm:             metrics.co2_ppm,
          smoke_index:         metrics.smoke_index,
        }
      : {
          water_level_cm:   metrics.level_cm,
          flow_rate_m3s:    metrics.flow_m3s,
          temperature_celsius: metrics.temp_c,
          turbidity_ntu:    metrics.turbidity_ntu,
        },
  };

  try {
    const res = await ai.chat.completions.create({
      model: "gpt-4o",
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user",   content: JSON.stringify(sensorData) },
      ],
    });
    return JSON.parse(res.choices[0].message.content);
  } catch (err) {
    console.error("[ai-analysis]", err.message);
    return { verdict: "UNKNOWN", reasoning: `AI analysis failed: ${err.message}` };
  }
}

module.exports = { analyzeAlarm };
