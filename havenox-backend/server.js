/********************************************************************
 *  HavenOx Backend v1.0
 *  ---------------------------------------------------------------
 *  Technologies:
 *    - Express.js 5
 *    - Socket.IO for real-time presence & trade status
 *    - SendGrid for invitation emails
 *    - Kaspa RPC client for blockchain data
 *
 *  Environment (.env)
 *    SENDGRID_API_KEY=SG.xxxxxxxxxxxxxxxxxxxxx
 *    SENDGRID_FROM=dronoxonkaspa@gmail.com
 *    KASPA_RPC_URL=http://127.0.0.1:18110
 *    PORT=5000
 ********************************************************************/

import "dotenv/config";
import express from "express";
import cors from "cors";
import { promises as fs } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import crypto from "node:crypto";
import sgMail from "@sendgrid/mail";
import { createServer } from "http";
import { Server } from "socket.io";

/* ---------------------------------------------------------------
   Environment setup
----------------------------------------------------------------*/
const apiKey = process.env.SENDGRID_API_KEY;
if (!apiKey?.startsWith("SG.")) {
  console.error("⚠️  Missing or invalid SENDGRID_API_KEY in .env");
} else {
  sgMail.setApiKey(apiKey);
}

const env = process.env ?? {};
const app = express();
app.use(cors());
app.use(express.json({ limit: "5mb" }));

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, "data");

/* ---------------------------------------------------------------
   JSON helpers
----------------------------------------------------------------*/
async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}
async function readJson(file, fallback) {
  try {
    const raw = await fs.readFile(path.join(dataDir, file), "utf-8");
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === "ENOENT") return fallback;
    throw err;
  }
}
async function writeJson(file, data) {
  await ensureDir(dataDir);
  await fs.writeFile(
    path.join(dataDir, file),
    JSON.stringify(data, null, 2),
    "utf-8"
  );
}

/* ---------------------------------------------------------------
   Kaspa RPC Client
----------------------------------------------------------------*/
class KaspaRpcClient {
  constructor({ url }) {
    this.url = url || "http://127.0.0.1:18110";
    this.fallbackUrl = "https://api.kaspa.org";
    this.maxRetries = 3;
  }
  async call(method, params = {}) {
    const endpoints = [this.url, this.fallbackUrl];
    let lastError = null;
    for (const endpoint of endpoints) {
      for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
        try {
          const res = await fetch(endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: Date.now(),
              method,
              params,
            }),
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const json = await res.json();
          if (json.error) throw new Error(json.error.message);
          if (endpoint !== this.url)
            console.log(`⚙️ Using fallback RPC: ${endpoint}`);
          return json.result;
        } catch (err) {
          lastError = err;
          await new Promise((r) => setTimeout(r, 300 * attempt));
        }
      }
    }
    throw new Error(`Kaspa RPC failed: ${lastError?.message}`);
  }
  getDagInfo() {
    return this.call("getBlockDagInfo");
  }
  validateAddress(a) {
    return this.call("validateAddresses", { addresses: [a] });
  }
  verifyMessage(p) {
    return this.call("messageVerify", p);
  }
}
const kaspaClient = new KaspaRpcClient({ url: env.KASPA_RPC_URL });

/* ---------------------------------------------------------------
   Health route / mock session
----------------------------------------------------------------*/
app.get("/health", async (_, res) => {
  try {
    const info = await kaspaClient.getDagInfo();
    res.json({ status: "ok", rpc: "connected", dag: info });
  } catch {
    const response = await fetch("https://api.kaspa.org/info/blockdag");
    res.json({
      status: "ok",
      rpc: "rest-fallback",
      dag: await response.json(),
    });
  }
});
app.all("/session/verify", (_, res) =>
  res.json({ status: "ok", message: "Session verify placeholder (mocked)" })
);

/* ---------------------------------------------------------------
   Tent (Escrow) System
----------------------------------------------------------------*/
// Create tent + SendGrid invite
app.post("/tent/create", async (req, res) => {
  try {
    const { seller, buyer, nftId, price, metadata } = req.body;
    if (!seller)
      return res.status(400).json({ error: "Seller address is required" });

    const tents = await readJson("tents.json", []);
    const newTent = {
      id: crypto.randomUUID(),
      seller,
      buyer: buyer || null,
      nftId: nftId || "none",
      price: Number(price) || 0,
      status: buyer ? "active" : "awaiting_partner",
      metadata: metadata || {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    tents.push(newTent);
    await writeJson("tents.json", tents);

    // Send email invite if buyer (email) provided
    if (buyer && apiKey?.startsWith("SG.")) {
      const joinUrl = `http://localhost:5173/tent/${newTent.id}`;
      const msg = {
        to: buyer,
        from: process.env.SENDGRID_FROM,
        subject: `Invitation to join HavenOx Tent ${newTent.id}`,
        html: `
          <div style="font-family:Arial,sans-serif;padding:20px">
            <h2 style="color:#00FFA3">You've been invited to join a HavenOx Tent</h2>
            <p><b>${seller}</b> created a Tent for NFT <b>${nftId}</b> worth <b>${price} KAS</b>.</p>
            ${
              metadata?.image
                ? `<img src="${metadata.image}" width="200" style="border-radius:10px;margin:10px 0;" />`
                : ""
            }
            <p>Click below to join:</p>
            <a href="${joinUrl}" style="display:inline-block;background:#00FFA3;color:#000;padding:10px 15px;border-radius:8px;text-decoration:none;">Join Tent</a>
          </div>`,
      };
      try {
        await sgMail.send(msg);
        console.log(`✉️ Invitation email sent to ${buyer}`);
      } catch (err) {
        console.error("SendGrid error:", err.message);
      }
    }

    res.json({ status: "created", tent: newTent });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Join tent
app.post("/tent/join/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { buyer } = req.body;
    const tents = await readJson("tents.json", []);
    const tent = tents.find((t) => t.id === id);
    if (!tent) return res.status(404).json({ error: "Tent not found" });
    tent.buyer = buyer;
    tent.status = "active";
    tent.updatedAt = new Date().toISOString();
    await writeJson("tents.json", tents);
    io.to(id).emit("tentUpdated", tent);
    res.json({ status: "joined", tent });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update tent (e.g. trade status)
app.post("/tent/update/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { status, metadata } = req.body;
    const tents = await readJson("tents.json", []);
    const tent = tents.find((t) => t.id === id);
    if (!tent) return res.status(404).json({ error: "Tent not found" });
    if (status) tent.status = status;
    if (metadata) tent.metadata = { ...tent.metadata, ...metadata };
    tent.updatedAt = new Date().toISOString();
    await writeJson("tents.json", tents);
    io.to(id).emit("tentUpdated", tent);
    res.json({ status: "updated", tent });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get single tent
app.get("/tent/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const tents = await readJson("tents.json", []);
    const tent = tents.find((t) => t.id === id);
    if (!tent) return res.status(404).json({ error: "Tent not found" });
    res.json({ status: "ok", tent });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// List tents
app.get("/tents", async (_, res) => {
  const tents = await readJson("tents.json", []);
  res.json({ count: tents.length, tents });
});

/* ---------------------------------------------------------------
   NFT Verification (Kaspa)
----------------------------------------------------------------*/
app.post("/verify", async (req, res) => {
  try {
    const { address, signature, message } = req.body;
    if (!address || !signature || !message)
      return res.status(400).json({ error: "Missing fields" });
    const valid = await kaspaClient.validateAddress(address);
    if (!valid?.entries?.[0]?.isValid)
      return res.status(400).json({ error: "Invalid Kaspa address" });
    const verify = await kaspaClient.verifyMessage({
      address,
      signature,
      message,
    });
    if (!verify?.isValid)
      return res
        .status(403)
        .json({ status: "invalid", message: "Signature verification failed" });
    res.json({ status: "verified", address });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ---------------------------------------------------------------
   Real-time Sockets
----------------------------------------------------------------*/
const PORT = env.PORT || 5000;
const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: "*" } });

io.on("connection", (socket) => {
  console.log("⚡ User connected:", socket.id);

  socket.on("joinTent", (tentId) => {
    socket.join(tentId);
    const room = io.sockets.adapter.rooms.get(tentId);
    const count = room ? room.size : 0;
    io.to(tentId).emit("presenceUpdate", { online: count });
    io.to(tentId).emit("systemMessage", `👋 ${socket.id} joined ${tentId}`);
  });

  socket.on("chatMessage", ({ tentId, sender, message }) => {
    io.to(tentId).emit("chatMessage", {
      sender,
      message,
      time: new Date().toISOString(),
    });
  });

  socket.on("transactionUpdate", ({ tentId, sender, status }) => {
    io.to(tentId).emit("transactionStatus", {
      sender,
      status,
      time: new Date().toISOString(),
    });
  });

  socket.on("disconnect", () => {
    const rooms = Array.from(socket.rooms);
    rooms.forEach((r) => {
      const room = io.sockets.adapter.rooms.get(r);
      const count = room ? room.size - 1 : 0;
      io.to(r).emit("presenceUpdate", { online: count });
    });
    console.log("❌ User disconnected:", socket.id);
  });
});

/* ---------------------------------------------------------------
   Start server
----------------------------------------------------------------*/
httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`🧩 HavenOx Tent API running with live sockets on port ${PORT}`);
});
