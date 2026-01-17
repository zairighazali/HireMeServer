import express from "express";
import { pool } from "../db.js";
import { verifyToken } from "../middleware/auth.js";
import { db } from "../firebase-admin.js";

const router = express.Router();

// Get my chats
router.get("/", verifyToken, async (req, res) => {
  const uid = req.user.uid;
  const chats = await pool.query(
    `SELECT * FROM chats WHERE user1_uid=$1 OR user2_uid=$1 ORDER BY created_at DESC`,
    [uid],
  );
  res.json(chats.rows);
});

// Get messages for a chat
router.get("/:chatId/messages", verifyToken, async (req, res) => {
  try {
    const chatId = req.params.chatId;

    const messagesRes = await pool.query(
      `SELECT id, chat_id, sender_uid, content, created_at
       FROM messages
       WHERE chat_id = $1
       ORDER BY created_at ASC`,
      [chatId],
    );

    res.json(messagesRes.rows || []);
  } catch (err) {
    console.error("GET /chats/:chatId/messages error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// Send message
router.post("/send", verifyToken, async (req, res) => {
  const senderUid = req.user.uid;
  const { receiverUid, content } = req.body;

  if (!content) return res.status(400).json({ message: "Empty message" });

  try {
    // ===== Find or create chat =====
    let chatRes = await pool.query(
      `SELECT * FROM chats WHERE (user1_uid=$1 AND user2_uid=$2) OR (user1_uid=$2 AND user2_uid=$1)`,
      [senderUid, receiverUid],
    );

    let chatId;
    if (chatRes.rows.length === 0) {
      const insertChat = await pool.query(
        `INSERT INTO chats (user1_uid, user2_uid) VALUES ($1,$2) RETURNING *`,
        [senderUid, receiverUid],
      );
      chatId = insertChat.rows[0].id;
    } else {
      chatId = chatRes.rows[0].id;
    }

    // ===== Insert message into PostgreSQL =====
    const msgRes = await pool.query(
      `INSERT INTO messages (chat_id, sender_uid, content) VALUES ($1,$2,$3) RETURNING *`,
      [chatId, senderUid, content],
    );

    const message = msgRes.rows[0];

    // ===== Send to Firebase Realtime Database =====
    const firebaseMessage = {
      id: message.id,
      chatId: chatId,
      senderUid: senderUid,
      content: content,
      createdAt: message.created_at.toISOString(),
      timestamp: Date.now(),
    };

    // Save to Firebase - will auto-create structure
    await db.ref(`messages/${chatId}`).push(firebaseMessage);

    // Update unread count for receiver
    const unreadRef = db.ref(`unread/${receiverUid}/${chatId}`);
    const unreadSnapshot = await unreadRef.once("value");
    const currentUnread = unreadSnapshot.val() || 0;
    await unreadRef.set(currentUnread + 1);

    // Send notification to receiver
    await db.ref(`notifications/${receiverUid}`).push({
      type: "new_message",
      chatId: chatId,
      senderUid: senderUid,
      content: content,
      timestamp: Date.now(),
      read: false,
    });

    res.json(message);
  } catch (err) {
    console.error("POST /chats/send error:", err);
    res.status(500).json({ message: "Server error", error: err.message });
  }
});

// Mark messages as read
router.post("/:chatId/read", verifyToken, async (req, res) => {
  try {
    const chatId = req.params.chatId;
    const uid = req.user.uid;

    // Reset unread count to 0
    await db.ref(`unread/${uid}/${chatId}`).set(0);

    res.json({ success: true });
  } catch (err) {
    console.error("POST /chats/:chatId/read error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

export default router;
