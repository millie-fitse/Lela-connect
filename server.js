const http = require("http");
const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");

// Railway provides PORT in production.
// Local development falls back to 3000.
const PORT = process.env.PORT || 3000;
const HOST = "0.0.0.0";

const publicDir = path.join(__dirname, "public");


// ==================================================
// HTTP SERVER
// ==================================================

const server = http.createServer(async (req, res) => {
  let requestPath = req.url.split("?")[0];

  if (await handleAdminHttp(req, res, requestPath)) {
    return;
  }

  if (requestPath === "/") {
    requestPath = "/index.html";
  }

  try {
    requestPath = decodeURIComponent(requestPath);
  } catch (error) {
    console.error("Bad request URL:", error);

    res.writeHead(400);
    res.end("Bad request");

    return;
  }

  const filePath = path.resolve(
    publicDir,
    "." + requestPath
  );

  // Prevent requests outside the public folder.
  if (
    filePath !== publicDir &&
    !filePath.startsWith(publicDir + path.sep)
  ) {
    console.log("Blocked path:", requestPath);

    res.writeHead(403);
    res.end("Forbidden");

    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      console.log(
        "File not found:",
        filePath
      );

      res.writeHead(404);
      res.end("Not found");

      return;
    }

    const extension =
      path.extname(filePath).toLowerCase();

    const contentTypes = {
      ".html": "text/html; charset=utf-8",
      ".js": "application/javascript; charset=utf-8",
      ".css": "text/css; charset=utf-8"
    };

    const contentType =
      contentTypes[extension] ||
      "application/octet-stream";

    res.writeHead(200, {
      "Content-Type": contentType
    });

    res.end(data);
  });
});


// ==================================================
// WEBSOCKET SERVER
// ==================================================

const wss = new WebSocket.Server({
  server
});


// Each connected browser gets an ID.
let nextClientId = 1;

// Browsers waiting for a match.
const waitingClients = [];

// Every browser currently connected to the signaling server.
const connectedClients = new Set();

// ==================================================
// ADMIN / MODERATION STATE (PROTOTYPE)
// ==================================================
// This version intentionally keeps admin data in memory.
// Later we will move reports/bans/admin accounts into PostgreSQL.

const reports = [];
const bans = new Map();
const adminSessions = new Map();
let nextReportId = 1;

const ADMIN_USERNAME = process.env.ADMIN_USERNAME || "";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";

function parseCookies(request) {
  const header = request.headers.cookie || "";
  const cookies = {};

  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    try {
      cookies[key] = decodeURIComponent(value);
    } catch {
      cookies[key] = value;
    }
  }

  return cookies;
}

function setJson(res, statusCode, data, extraHeaders = {}) {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...extraHeaders
  });
  res.end(body);
}

function sendNoContent(res) {
  res.writeHead(204, { "Cache-Control": "no-store" });
  res.end();
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    let size = 0;

    req.on("data", chunk => {
      size += chunk.length;
      if (size > 1024 * 1024) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      body += chunk.toString("utf8");
    });

    req.on("end", () => {
      if (!body.trim()) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });

    req.on("error", reject);
  });
}

function makeToken(bytes = 32) {
  return require("crypto").randomBytes(bytes).toString("hex");
}

function isAdminRequest(req) {
  const cookies = parseCookies(req);
  const token = cookies.admin_session;

  if (!token || !adminSessions.has(token)) {
    return false;
  }

  const session = adminSessions.get(token);
  if (Date.now() > session.expiresAt) {
    adminSessions.delete(token);
    return false;
  }

  session.expiresAt = Date.now() + 1000 * 60 * 60 * 12;
  return true;
}

function getBan(userId) {
  if (!userId) return null;

  const ban = bans.get(userId);
  if (!ban) return null;

  if (ban.expiresAt && Date.now() >= ban.expiresAt) {
    bans.delete(userId);
    return null;
  }

  return ban;
}

function serializeReport(report) {
  return {
    ...report,
    ageSeconds: Math.max(0, Math.floor((Date.now() - report.createdAt) / 1000))
  };
}

function adminStats() {
  let matchedUsers = 0;
  for (const client of connectedClients) {
    if (client.peer && client.readyState === WebSocket.OPEN) {
      matchedUsers += 1;
    }
  }

  const activeMatches = Math.floor(matchedUsers / 2);
  const waiting = waitingClients.length;
  const pendingReports = reports.filter(r => r.status === "pending").length;

  return {
    online: connectedClients.size,
    activeMatches,
    waiting,
    reportsTotal: reports.length,
    pendingReports,
    activeBans: Array.from(bans.values()).filter(b => !b.expiresAt || b.expiresAt > Date.now()).length,
    serverTime: new Date().toISOString()
  };
}

function disconnectUserById(userId) {
  let disconnected = false;

  for (const client of connectedClients) {
    if (client.userId !== userId) continue;

    disconnected = true;
    const peer = client.peer;

    removeFromWaiting(client);

    client.ready = false;
    client.peer = null;

    if (peer && peer.readyState === WebSocket.OPEN) {
      peer.peer = null;
      send(peer, { type: "peer-disconnected" });
    }

    send(client, { type: "banned" });
    try {
      client.close(4003, "Banned by administrator");
    } catch {}
  }

  return disconnected;
}

async function handleAdminHttp(req, res, requestPath) {
  // Login page
  if (requestPath === "/admin" || requestPath === "/admin/") {
    const adminFile = path.join(__dirname, "admin", "index.html");
    fs.readFile(adminFile, (error, data) => {
      if (error) {
        res.writeHead(500);
        res.end("Admin panel unavailable");
        return;
      }
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store"
      });
      res.end(data);
    });
    return true;
  }

  if (requestPath.startsWith("/admin/")) {
    const relative = requestPath.slice("/admin/".length);
    const safe = path.basename(relative);
    if (!safe || safe.includes("..")) {
      res.writeHead(403);
      res.end("Forbidden");
      return true;
    }

    const adminFile = path.join(__dirname, "admin", safe);
    fs.readFile(adminFile, (error, data) => {
      if (error) {
        res.writeHead(404);
        res.end("Not found");
        return;
      }

      const extension = path.extname(adminFile).toLowerCase();
      const types = {
        ".html": "text/html; charset=utf-8",
        ".js": "application/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8"
      };

      res.writeHead(200, {
        "Content-Type": types[extension] || "application/octet-stream",
        "Cache-Control": "no-store"
      });
      res.end(data);
    });
    return true;
  }

  if (requestPath === "/api/admin/login" && req.method === "POST") {
    if (!ADMIN_USERNAME || !ADMIN_PASSWORD) {
      setJson(res, 503, { error: "Admin login is not configured on the server." });
      return true;
    }

    try {
      const body = await readJsonBody(req);
      const username = String(body.username || "");
      const password = String(body.password || "");

      if (username !== ADMIN_USERNAME || password !== ADMIN_PASSWORD) {
        setJson(res, 401, { error: "Invalid admin credentials." });
        return true;
      }

      const token = makeToken();
      adminSessions.set(token, {
        createdAt: Date.now(),
        expiresAt: Date.now() + 1000 * 60 * 60 * 12
      });

      setJson(res, 200, { ok: true }, {
        "Set-Cookie": `admin_session=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Strict${process.env.NODE_ENV === "production" ? "; Secure" : ""}`
      });
    } catch (error) {
      setJson(res, 400, { error: error.message });
    }

    return true;
  }

  if (requestPath === "/api/admin/logout" && req.method === "POST") {
    const cookies = parseCookies(req);
    if (cookies.admin_session) adminSessions.delete(cookies.admin_session);
    setJson(res, 200, { ok: true }, {
      "Set-Cookie": "admin_session=; HttpOnly; Path=/; Max-Age=0; SameSite=Strict"
    });
    return true;
  }

  if (requestPath.startsWith("/api/admin/")) {
    if (!isAdminRequest(req)) {
      setJson(res, 401, { error: "Admin authentication required." });
      return true;
    }

    // Dashboard stats
    if (requestPath === "/api/admin/stats" && req.method === "GET") {
      setJson(res, 200, adminStats());
      return true;
    }

    // Current connected users (anonymous browser IDs only)
    if (requestPath === "/api/admin/users" && req.method === "GET") {
      const users = Array.from(connectedClients).map(client => ({
        userId: client.userId || `session-${client.id}`,
        clientId: client.id,
        status: client.peer ? "matched" : (client.ready ? "waiting" : "connected"),
        connectedAt: client.connectedAt,
        banned: Boolean(getBan(client.userId)),
        peerClientId: client.peer ? client.peer.id : null
      }));
      setJson(res, 200, users);
      return true;
    }

    // Reports
    if (requestPath === "/api/admin/reports" && req.method === "GET") {
      setJson(res, 200, reports.map(serializeReport));
      return true;
    }

    // Bans
    if (requestPath === "/api/admin/bans" && req.method === "GET") {
      const result = [];
      for (const [userId, ban] of bans.entries()) {
        if (ban.expiresAt && Date.now() >= ban.expiresAt) {
          bans.delete(userId);
          continue;
        }
        result.push({ userId, ...ban });
      }
      setJson(res, 200, result);
      return true;
    }

    const reportMatch = requestPath.match(/^\/api\/admin\/reports\/(\d+)\/(resolve|dismiss|ban)$/);
    if (reportMatch && req.method === "POST") {
      const reportId = Number(reportMatch[1]);
      const action = reportMatch[2];
      const report = reports.find(r => r.id === reportId);

      if (!report) {
        setJson(res, 404, { error: "Report not found." });
        return true;
      }

      if (action === "resolve") {
        report.status = "resolved";
        report.resolvedAt = Date.now();
      } else if (action === "dismiss") {
        report.status = "dismissed";
        report.resolvedAt = Date.now();
      } else if (action === "ban") {
        let body = {};
        try { body = await readJsonBody(req); } catch {}
        const duration = String(body.duration || "24h");
        const durationMap = {
          "1h": 60 * 60 * 1000,
          "24h": 24 * 60 * 60 * 1000,
          "7d": 7 * 24 * 60 * 60 * 1000,
          "permanent": null
        };
        const durationMs = Object.prototype.hasOwnProperty.call(durationMap, duration)
          ? durationMap[duration]
          : durationMap["24h"];

        bans.set(report.reportedUserId, {
          reason: `Report #${report.id}: ${report.reason}`,
          createdAt: Date.now(),
          expiresAt: durationMs ? Date.now() + durationMs : null
        });

        report.status = "resolved";
        report.action = `ban:${duration}`;
        report.resolvedAt = Date.now();

        disconnectUserById(report.reportedUserId);
      }

      setJson(res, 200, { ok: true, report: serializeReport(report) });
      return true;
    }

    const userBanMatch = requestPath.match(/^\/api\/admin\/users\/([^/]+)\/(ban|unban|disconnect)$/);
    if (userBanMatch && req.method === "POST") {
      const userId = decodeURIComponent(userBanMatch[1]);
      const action = userBanMatch[2];

      if (action === "disconnect") {
        disconnectUserById(userId);
        setJson(res, 200, { ok: true });
        return true;
      }

      if (action === "unban") {
        bans.delete(userId);
        setJson(res, 200, { ok: true });
        return true;
      }

      let body = {};
      try { body = await readJsonBody(req); } catch {}
      const duration = String(body.duration || "24h");
      const durationMap = {
        "1h": 60 * 60 * 1000,
        "24h": 24 * 60 * 60 * 1000,
        "7d": 7 * 24 * 60 * 60 * 1000,
        "permanent": null
      };
      const durationMs = Object.prototype.hasOwnProperty.call(durationMap, duration)
        ? durationMap[duration]
        : durationMap["24h"];

      bans.set(userId, {
        reason: String(body.reason || "Administrator ban"),
        createdAt: Date.now(),
        expiresAt: durationMs ? Date.now() + durationMs : null
      });

      disconnectUserById(userId);
      setJson(res, 200, { ok: true });
      return true;
    }

    setJson(res, 404, { error: "Admin endpoint not found." });
    return true;
  }

  return false;
}

function broadcastOnlineCount() {
  const message = {
    type: "online-count",
    count: connectedClients.size
  };

  for (const client of connectedClients) {
    send(client, message);
  }
}


// ==================================================
// HELPER: SEND MESSAGE
// ==================================================

function send(socket, message) {
  if (
    socket &&
    socket.readyState === WebSocket.OPEN
  ) {
    socket.send(JSON.stringify(message));
  }
}


// ==================================================
// HELPER: REMOVE FROM WAITING QUEUE
// ==================================================

function removeFromWaiting(socket) {
  const index =
    waitingClients.indexOf(socket);

  if (index !== -1) {
    waitingClients.splice(index, 1);
  }
}


// ==================================================
// HELPER: PUT USER BACK IN WAITING QUEUE
// ==================================================

function putInWaitingQueue(socket) {
  if (
    !socket ||
    socket.readyState !== WebSocket.OPEN
  ) {
    return;
  }

  if (socket.peer) {
    return;
  }

  if (!waitingClients.includes(socket)) {
    waitingClients.push(socket);

    console.log(
      `[SERVER] Client ${socket.id} is waiting.`
    );
  }

  send(socket, {
    type: "waiting"
  });
}


// ==================================================
// MATCH TWO USERS
// ==================================================

function tryMatchUsers() {
  // Remove closed connections from queue.
  for (
    let i = waitingClients.length - 1;
    i >= 0;
    i--
  ) {
    if (
      waitingClients[i].readyState !==
      WebSocket.OPEN
    ) {
      waitingClients.splice(i, 1);
    }
  }

  while (waitingClients.length >= 2) {
    const clientA =
      waitingClients.shift();

    const clientB =
      waitingClients.shift();

    if (
      clientA.readyState !== WebSocket.OPEN ||
      clientB.readyState !== WebSocket.OPEN
    ) {
      continue;
    }

    // Pair them.
    clientA.peer = clientB;
    clientB.peer = clientA;

    console.log("");
    console.log("========================================");
    console.log(
      `[MATCH] Client ${clientA.id} matched with Client ${clientB.id}`
    );
    console.log("========================================");
    console.log("");

    send(clientA, {
      type: "matched",
      role: "caller"
    });

    send(clientB, {
      type: "matched",
      role: "callee"
    });

    // Only the caller creates the offer.
    send(clientA, {
      type: "create-offer"
    });
  }
}


// ==================================================
// NEW WEBSOCKET CONNECTION
// ==================================================

wss.on("connection", (socket, request) => {
  socket.id = nextClientId++;
  socket.userId = null;
  socket.connectedAt = new Date().toISOString();

  connectedClients.add(socket);
  socket.ready = false;
  socket.peer = null;

  broadcastOnlineCount();

  console.log("");
  console.log(
    `[SERVER] Client ${socket.id} connected`
  );
  console.log(
    `[SERVER] IP: ${request.socket.remoteAddress}`
  );
  console.log("");

  // ------------------------------------------------
  // RECEIVE MESSAGE
  // ------------------------------------------------

  socket.on("message", (rawMessage) => {
    let message;

    try {
      message = JSON.parse(
        rawMessage.toString()
      );
    } catch (error) {
      console.error(
        `[SERVER] Client ${socket.id} sent invalid JSON`
      );

      return;
    }

    console.log(
      `[SERVER] Client ${socket.id} -> ${message.type}`
    );


    // ==============================================
    // IDENTIFY BROWSER (ANONYMOUS ID)
    // ==============================================

    if (message.type === "identify") {
      const userId = String(message.userId || "").trim();

      if (!/^[-_a-zA-Z0-9]{16,128}$/.test(userId)) {
        send(socket, {
          type: "identity-error"
        });
        return;
      }

      const activeBan = getBan(userId);
      if (activeBan) {
        send(socket, {
          type: "banned",
          reason: activeBan.reason,
          expiresAt: activeBan.expiresAt
        });
        setTimeout(() => {
          try { socket.close(4003, "Banned by administrator"); } catch {}
        }, 50);
        return;
      }

      socket.userId = userId;
      return;
    }

    // ==============================================
    // USER REPORTS STRANGER
    // ==============================================

    if (message.type === "report") {
      const peer = socket.peer;

      if (!peer || peer.readyState !== WebSocket.OPEN) {
        send(socket, { type: "report-error", error: "No active stranger to report." });
        return;
      }

      const reason = String(message.reason || "Other").trim().slice(0, 200);

      const report = {
        id: nextReportId++,
        reporterUserId: socket.userId || `session-${socket.id}`,
        reportedUserId: peer.userId || `session-${peer.id}`,
        reporterClientId: socket.id,
        reportedClientId: peer.id,
        reason,
        createdAt: Date.now(),
        status: "pending"
      };

      reports.unshift(report);

      send(socket, {
        type: "report-submitted",
        reportId: report.id
      });

      console.log(
        `[REPORT] #${report.id} Client ${socket.id} reported Client ${peer.id}: ${reason}`
      );

      return;
    }

    // ==============================================
    // USER READY
    // ==============================================

    if (message.type === "ready") {
      if (socket.ready) {
        console.log(
          `[SERVER] Client ${socket.id} already ready`
        );

        return;
      }

      socket.ready = true;

      console.log(
        `[SERVER] Client ${socket.id} is ready for matching`
      );

      putInWaitingQueue(socket);

      tryMatchUsers();

      return;
    }


    // ==============================================
    // STOP VIDEO CHAT / DESTROY CURRENT MATCH
    // ==============================================

    if (message.type === "stop") {
      console.log(
        `[SERVER] Client ${socket.id} requested stop`
      );

      // Make sure this client is not left in the waiting queue.
      removeFromWaiting(socket);

      const oldPeer = socket.peer;

      // The stopping client is no longer ready or matched.
      socket.ready = false;
      socket.peer = null;

      // Tell the other browser that its stranger has left.
      if (
        oldPeer &&
        oldPeer.readyState === WebSocket.OPEN
      ) {
        oldPeer.peer = null;

        send(oldPeer, {
          type: "peer-disconnected"
        });
      }

      return;
    }

    // ==============================================
    // SKIP / FIND NEW PERSON
    // ==============================================

    if (message.type === "skip") {
      console.log(
        `[SERVER] Client ${socket.id} requested skip`
      );

      const oldPeer = socket.peer;

      /*
        IMPORTANT:
        Keep the requester at the FRONT of the queue.

        The old implementation queued the old peer first and
        then queued the requester. With 3+ users that could
        produce a queue like:

          [C, oldPeer, requester]

        which paired C with oldPeer and left the requester
        stuck on "Looking for someone...".

        By putting the requester first, we guarantee that the
        person who pressed Next gets the first available
        stranger. The previous stranger is still allowed to
        come back later, but is not immediately preferred.
      */

      socket.peer = null;

      if (oldPeer) {
        oldPeer.peer = null;

        send(oldPeer, {
          type: "peer-disconnected"
        });

        if (oldPeer.ready) {
          putInWaitingQueue(oldPeer);
        }
      }

      /*
        Remove any stale queue entry before placing the
        requester at the front.
      */
      removeFromWaiting(socket);

      if (
        socket.readyState === WebSocket.OPEN &&
        socket.ready
      ) {
        waitingClients.unshift(socket);

        send(socket, {
          type: "waiting"
        });
      }

      tryMatchUsers();

      return;
    }


    // ==============================================
    // FORWARD SIGNALING MESSAGE ONLY TO MATCHED PEER
    // ==============================================

    if (
      message.type === "record-request" ||
      message.type === "record-response" ||
      message.type === "recording-started" ||
      message.type === "recording-paused" ||
      message.type === "recording-stopped" ||
      message.type === "offer" ||
      message.type === "answer" ||
      message.type === "ice-candidate"
    ) {
      if (
        socket.peer &&
        socket.peer.readyState ===
          WebSocket.OPEN
      ) {
        console.log(
          `[SIGNAL] ${socket.id} -> ${socket.peer.id}: ${message.type}`
        );

        send(
          socket.peer,
          message
        );
      } else {
        console.log(
          `[SERVER] Client ${socket.id} has no peer for ${message.type}`
        );
      }

      return;
    }

    console.log(
      `[SERVER] Unknown message type: ${message.type}`
    );
  });


  // ------------------------------------------------
  // SOCKET ERROR
  // ------------------------------------------------

  socket.on("error", (error) => {
    console.error(
      `[SERVER] WebSocket error for Client ${socket.id}:`,
      error.message
    );
  });


  // ------------------------------------------------
  // CLIENT DISCONNECTS
  // ------------------------------------------------

  socket.on("close", () => {
    connectedClients.delete(socket);
    broadcastOnlineCount();

    console.log("");
    console.log(
      `[SERVER] Client ${socket.id} disconnected`
    );

    removeFromWaiting(socket);

    const oldPeer = socket.peer;

    socket.peer = null;

    if (oldPeer) {
      oldPeer.peer = null;

      console.log(
        `[SERVER] Client ${oldPeer.id} lost their peer`
      );

      send(oldPeer, {
        type: "peer-disconnected"
      });

      // Put remaining person back in queue.
      if (oldPeer.ready) {
        putInWaitingQueue(oldPeer);

        tryMatchUsers();
      }
    }
  });
});


// ==================================================
// START SERVER
// ==================================================

server.listen(PORT, HOST, () => {
  console.log("");
  console.log("========================================");
  console.log(" WebRTC signaling server is running");
  console.log("========================================");
  console.log(`Host: ${HOST}`);
  console.log(`Port: ${PORT}`);

  if (process.env.PORT) {
    console.log("Environment: Railway / production");
  } else {
    console.log("Environment: Local development");
    console.log(
      `Open: http://localhost:${PORT}`
    );
  }

  console.log("========================================");
  console.log("");
});
