const http = require("http");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");

const dataDir = path.join(__dirname, "data");
const dataFile = path.join(dataDir, "links.json");

async function loadLinks() {
  try {
    const data = await fsp.readFile(dataFile, "utf-8");
    const parsed = JSON.parse(data || "{}");

    // Backward compatibility: old format { code: "url" }
    for (const code of Object.keys(parsed)) {
      if (typeof parsed[code] === "string") {
        parsed[code] = {
          url: parsed[code],
          clicks: 0,
          createdAt: new Date().toISOString(),
          expiresAt: null,
        };
      } else {
        parsed[code] = {
          url: parsed[code].url,
          clicks: Number(parsed[code].clicks || 0),
          createdAt: parsed[code].createdAt || new Date().toISOString(),
          expiresAt: parsed[code].expiresAt ?? null,
        };
      }
    }

    return parsed;
  } catch (error) {
    if (error.code === "ENOENT") {
      await fsp.mkdir(dataDir, { recursive: true });
      await fsp.writeFile(dataFile, JSON.stringify({}), "utf-8");
      return {};
    }
    throw error;
  }
}

async function saveLinks(links) {
  await fsp.mkdir(dataDir, { recursive: true });
  await fsp.writeFile(dataFile, JSON.stringify(links, null, 2), "utf-8");
}

function isExpired(expiresAt) {
  if (!expiresAt) return false;
  return Date.now() > new Date(expiresAt).getTime();
}

const server = http.createServer(async (req, res) => {
  const fullUrl = new URL(req.url, "http://localhost");
  const pathname = fullUrl.pathname;

  console.log(req.method, pathname);

  // ✅ GET /links (frontend expects { shortcode: url })
  if (req.method === "GET" && pathname === "/links") {
    const links = await loadLinks();

    const simpleLinks = {};
    for (const [code, obj] of Object.entries(links)) {
      simpleLinks[code] = obj.url;
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify(simpleLinks));
  }

  // ✅ GET /stats/:shortcode
  if (req.method === "GET" && pathname.startsWith("/stats/")) {
    const code = pathname.replace("/stats/", "").trim();
    const links = await loadLinks();

    if (!code || !links[code]) {
      res.writeHead(404, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "Shortcode not found" }));
    }

    const link = links[code];
    const expired = isExpired(link.expiresAt);

    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(
      JSON.stringify({
        shortcode: code,
        url: link.url,
        clicks: link.clicks,
        createdAt: link.createdAt,
        expiresAt: link.expiresAt,
        expired,
      })
    );
  }

  // ✅ POST /shorten (supports expiresInDays)
  if (req.method === "POST" && pathname === "/shorten") {
    const links = await loadLinks();

    let body = "";
    req.on("data", (chunk) => (body += chunk.toString()));

    req.on("end", async () => {
      try {
        const { url, shortcode, expiresInDays } = JSON.parse(body || "{}");

        if (!url) {
          res.writeHead(400, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ error: "URL is required" }));
        }

        const shortCode =
          (shortcode && shortcode.trim()) || crypto.randomBytes(3).toString("hex");

        if (links[shortCode]) {
          res.writeHead(409, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ error: "Shortcode already in use" }));
        }

        // ✅ expiry calculation (optional)
        let expiresAt = null;
        const days = Number(expiresInDays);
        if (!Number.isNaN(days) && days > 0) {
          expiresAt = new Date(
            Date.now() + days * 24 * 60 * 60 * 1000
          ).toISOString();
        }

        links[shortCode] = {
          url,
          clicks: 0,
          createdAt: new Date().toISOString(),
          expiresAt,
        };

        await saveLinks(links);

        res.writeHead(201, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ shortcode: shortCode, url, expiresAt }));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: "Invalid JSON" }));
      }
    });

    return;
  }

  // ✅ GET / (serve HTML)
  if (req.method === "GET" && pathname === "/") {
    const filePath = path.join(__dirname, "public", "index.html");
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        return res.end("404 Not Found");
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(data);
    });
    return;
  }

  // ✅ GET /style.css
  if (req.method === "GET" && pathname === "/style.css") {
    const cssPath = path.join(__dirname, "public", "style.css");
    fs.readFile(cssPath, (err, data) => {
      if (err) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        return res.end("404 Not Found");
      }
      res.writeHead(200, { "Content-Type": "text/css; charset=utf-8" });
      res.end(data);
    });
    return;
  }

  // ✅ Redirect: GET /abc123 (click counter + expiry)
  if (req.method === "GET" && pathname.length > 1) {
    const code = pathname.slice(1);
    const links = await loadLinks();

    if (links[code]) {
      const link = links[code];

      // expiry check
      if (isExpired(link.expiresAt)) {
        res.writeHead(410, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: "Link expired" }));
      }

      // click counter
      link.clicks = (link.clicks || 0) + 1;
      links[code] = link;
      await saveLinks(links);

      res.writeHead(302, { Location: link.url });
      return res.end();
    }
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("404 Not Found");
});

const PORT = 3000;
server.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
