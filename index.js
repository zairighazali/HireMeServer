import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import http from "http";
import admin from "firebase-admin";
import userRoutes from "./routes/users.js";
import jobRoutes from "./routes/jobs.js";
import chatRoutes from "./routes/chats.js";
import conversationsRouter from "./routes/conversations.js";
import publicRoutes from "./routes/public.js";
import { initSocket } from "./socket.js";
import testRoutes from "./routes/test.js";
import stripeRoutes from "./routes/stripe.js";
import hiresRouter from "./routes/hires.js";

dotenv.config();

// ===== FIREBASE ADMIN =====
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
    }),
    databaseURL: process.env.FIREBASE_DATABASE_URL,
  });
}

// ===== EXPRESS APP =====
const app = express();
app.use(cors({ origin: "*" }));

app.use(express.json());

// ===== ROUTES =====
app.use("/api/users", userRoutes);
app.use("/api/jobs", jobRoutes);
app.use("/api/chats", chatRoutes);
app.use("/api/conversations", conversationsRouter);
app.use("/api/public", publicRoutes);
app.use("/api/test", testRoutes);
app.use("/api/stripe", stripeRoutes);
app.use("/api/hires", hiresRouter);

// ===== HTTP SERVER + SOCKET.IO =====
const server = http.createServer(app);
const io = initSocket(server, admin); // <-- init socket with firebase admin

app.get("/", (req, res) => {
  res.send({ message: "Yes connected" });
});

// ===== START SERVER =====
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
