import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import admin from "firebase-admin";
import userRoutes from "./routes/users.js";
import jobRoutes from "./routes/jobs.js";
import chatRoutes from "./routes/chats.js";
import conversationsRouter from "./routes/conversations.js";
import publicRoutes from "./routes/public.js";
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

app.get("/", (req, res) => {
  res.send({ message: "Server is running - Firebase Realtime Chat enabled" });
});

// ===== START SERVER =====
// Note: Removed Socket.io - using Firebase Realtime Database only
// This is compatible with Vercel serverless functions
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log("Firebase Realtime Database enabled for chat");
});

export default app;