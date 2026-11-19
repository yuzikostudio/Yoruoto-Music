// Vercel serverless endpoint: /api/track
// Requires Upstash Redis environment variables in Vercel.
const { Redis } = require("@upstash/redis");

const PLATFORMS = ["android", "windows", "linux"];
const DOWNLOAD_COOLDOWN = 60 * 60; // one count per visitor/platform per hour

function getRedis() {
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

async function readStats(redis) {
  const [visitors, ...downloadValues] = await Promise.all([
    redis.scard("yoruoto:visitors"),
    ...PLATFORMS.map((platform) => redis.get(`yoruoto:downloads:${platform}`))
  ]);

  const downloads = {};
  PLATFORMS.forEach((platform, index) => {
    downloads[platform] = Number(downloadValues[index]) || 0;
  });

  return { visitors: Number(visitors) || 0, downloads };
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  res.setHeader("Access-Control-Allow-Origin", "*");

  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    return res.status(204).end();
  }

  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ error: "method not allowed" });
  }

  const redis = getRedis();
  if (!redis) {
    return res.status(503).json({
      error: "Redis is not configured. Add UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN in Vercel."
    });
  }

  try {
    if (req.method === "POST") {
      const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
      const { type, id, platform } = body;

      // crypto.randomUUID() is 36 characters and includes hyphens.
      if (typeof id !== "string" || !/^[A-Za-z0-9-]{8,64}$/.test(id)) {
        return res.status(400).json({ error: "bad id" });
      }

      if (type === "visit") {
        // A browser ID is stored once, so refreshes do not add repeat visitors.
        await redis.sadd("yoruoto:visitors", id);
      } else if (type === "download" && PLATFORMS.includes(platform)) {
        const lockKey = `yoruoto:lock:${platform}:${id}`;
        const firstClick = await redis.set(lockKey, "1", {
          nx: true,
          ex: DOWNLOAD_COOLDOWN
        });
        if (firstClick) await redis.incr(`yoruoto:downloads:${platform}`);
        await redis.sadd("yoruoto:visitors", id);
      } else {
        return res.status(400).json({ error: "bad request" });
      }
    }

    return res.status(200).json(await readStats(redis));
  } catch (error) {
    console.error("Yoruoto counter error:", error);
    return res.status(500).json({ error: "counter server error" });
  }
};
