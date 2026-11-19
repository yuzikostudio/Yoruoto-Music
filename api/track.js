// api/track.js  ->  becomes  https://YOUR-SITE.vercel.app/api/track
// GET  : returns the real numbers  { visitors, downloads: { android, windows, linux } }
// POST : records a visit or a download, then returns the new numbers
const { Redis } = require("@upstash/redis");

// Vercel injects one of these pairs when you connect the Redis database to the project
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN,
});

const PLATFORMS = ["android", "windows", "linux"];
const ID_RE = /^[A-Za-z0-9-]{8,64}$/;       // the random id the browser generates
const DOWNLOAD_COOLDOWN = 60 * 60;          // seconds: same visitor + same platform = 1 download per hour

async function readStats() {
  const [visitors, ...dl] = await Promise.all([
    redis.scard("yoruoto:visitors"),
    ...PLATFORMS.map((p) => redis.get(`yoruoto:downloads:${p}`)),
  ]);
  const downloads = {};
  PLATFORMS.forEach((p, i) => (downloads[p] = Number(dl[i]) || 0));
  return { visitors: Number(visitors) || 0, downloads };
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  try {
    if (req.method === "POST") {
      const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
      const { type, id, platform } = body;
      if (!ID_RE.test(String(id || ""))) return res.status(400).json({ error: "bad id" });

      if (type === "visit") {
        // A Redis Set stores each id once, so refreshing never inflates the visitor count
        await redis.sadd("yoruoto:visitors", id);
      } else if (type === "download" && PLATFORMS.includes(platform)) {
        // SET ... NX only succeeds the first time within the cooldown, so spam-clicking is ignored
        const first = await redis.set(`yoruoto:lock:${platform}:${id}`, 1, { nx: true, ex: DOWNLOAD_COOLDOWN });
        if (first) await redis.incr(`yoruoto:downloads:${platform}`);
        await redis.sadd("yoruoto:visitors", id);
      } else {
        return res.status(400).json({ error: "bad request" });
      }
    } else if (req.method !== "GET") {
      return res.status(405).json({ error: "method not allowed" });
    }
    return res.status(200).json(await readStats());
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "server error" });
  }
};
