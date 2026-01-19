import express from "express";
import { pool } from "../db.js";
import { verifyToken } from "../middleware/auth.js";
import { db } from "../firebase-admin.js";
import { getIO } from "../socket.js";

const router = express.Router();

// Get all my conversations
router.get("/", verifyToken, async (req, res) => {
  try {
    const uid = req.user.uid;
    
    // Get user's internal ID
    const userRes = await pool.query(
      "SELECT id FROM users WHERE firebase_uid = $1",
      [uid]
    );

    if (!userRes.rows.length) {
      return res.status(404).json({ message: "User not found" });
    }

    const userId = userRes.rows[0].id;

    // Get conversations with other user info
    const result = await pool.query(
      `SELECT 
        c.id AS conversation_id,
        c.created_at,
        other.id AS other_user_id,
        other.firebase_uid AS other_user_uid,
        other.name AS other_user_name,
        other.image_url AS other_user_image
      FROM conversations c
      JOIN users other ON 
        (other.id = c.user_a AND c.user_a != $1)
        OR (other.id = c.user_b AND c.user_b != $1)
      WHERE c.user_a = $1 OR c.user_b = $1
      ORDER BY c.created_at DESC`,
      [userId]
    );

    res.json(result.rows);
  } catch (err) {
    console.error("GET /chats error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// Start or get conversation
router.post("/start", verifyToken, async (req, res) => {
  try {
    const { uid } = req.user;
    const { other_uid } = req.body;

    if (!other_uid) {
      return res.status(400).json({ message: "other_uid is required" });
    }

    if (uid === other_uid) {
      return res.status(400).json({
        message: "Cannot create conversation with yourself",
      });
    }

    // Get both users' internal IDs
    const usersRes = await pool.query(
      "SELECT id, firebase_uid FROM users WHERE firebase_uid = ANY($1::text[])",
      [[uid, other_uid]]
    );

    if (usersRes.rows.length !== 2) {
      return res.status(404).json({ message: "One or both users not found" });
    }

    const userMap = {};
    usersRes.rows.forEach((u) => {
      userMap[u.firebase_uid] = u.id;
    });

    const myId = userMap[uid];
    const otherId = userMap[other_uid];

    // Find or create conversation
    let convRes = await pool.query(
      `SELECT * FROM conversations
       WHERE (user_a = $1 AND user_b = $2) 
          OR (user_a = $2 AND user_b = $1)`,
      [myId, otherId]
    );

    let conversation;
    if (convRes.rows.length > 0) {
      conversation = convRes.rows[0];
    } else {
      const insertRes = await pool.query(
        `INSERT INTO conversations (user_a, user_b)
         VALUES ($1, $2)
         RETURNING *`,
        [myId, otherId]
      );
      conversation = insertRes.rows[0];
    }

    // Get other user details
    const otherUserRes = await pool.query(
      `SELECT 
        id,
        firebase_uid AS uid,
        name,
        image_url
      FROM users
      WHERE id = $1`,
      [otherId]
    );

    res.json({
      conversation_id: conversation.id,
      other_user: otherUserRes.rows[0],
      created_at: conversation.created_at,
    });
  } catch (err) {
    console.error("POST /chats/start error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// Get messages for a conversation
router.get("/:chatId/messages", verifyToken, async (req, res) => {
  try {
    const chatId = req.params.chatId;
    const uid = req.user.uid;

    // Verify user is part of this conversation
    const userRes = await pool.query(
      "SELECT id FROM users WHERE firebase_uid = $1",
      [uid]
    );

    if (!userRes.rows.length) {
      return res.status(404).json({ message: "User not found" });
    }

    const userId = userRes.rows[0].id;

    const convRes = await pool.query(
      `SELECT * FROM conversations
       WHERE id = $1 
         AND (user_a = $2 OR user_b = $2)`,
      [chatId, userId]
    );

    if (!convRes.rows.length) {
      return res.status(403).json({
        message: "Conversation not found or you don't have access",
      });
    }

    // Get messages from Firebase
    const messagesSnapshot = await db.ref(`messages/${chatId}`).once('value');
    const messagesData = messagesSnapshot.val();

    let messages = [];
    if (messagesData) {
      messages = Object.entries(messagesData).map(([key, msg]) => ({
        id: key,
        sender_uid: msg.senderUid,
        content: msg.content,
        created_at: msg.createdAt,
        timestamp: msg.timestamp,
      })).sort((a, b) => a.timestamp - b.timestamp);
    }

    res.json(messages);
  } catch (err) {
    console.error("GET /chats/:chatId/messages error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// Send message
router.post("/send", verifyToken, async (req, res) => {
  const senderUid = req.user.uid;
  const { receiverUid, content, conversationId } = req.body;

  if (!content || !content.trim()) {
    return res.status(400).json({ message: "Empty message" });
  }

  try {
    // Get both users' internal IDs
    const usersRes = await pool.query(
      "SELECT id, firebase_uid, name, image_url FROM users WHERE firebase_uid = ANY($1::text[])",
      [[senderUid, receiverUid]]
    );

    if (usersRes.rows.length !== 2) {
      return res.status(404).json({ message: "One or both users not found" });
    }

    const userMap = {};
    usersRes.rows.forEach((u) => {
      userMap[u.firebase_uid] = u;
    });

    const myId = userMap[senderUid].id;
    const otherId = userMap[receiverUid].id;
    const senderInfo = userMap[senderUid];

    // Find or create conversation
    let chatId = conversationId;
    
    if (!chatId) {
      let convRes = await pool.query(
        `SELECT * FROM conversations
         WHERE (user_a = $1 AND user_b = $2) 
            OR (user_a = $2 AND user_b = $1)`,
        [myId, otherId]
      );

      if (convRes.rows.length === 0) {
        const insertChat = await pool.query(
          `INSERT INTO conversations (user_a, user_b) VALUES ($1,$2) RETURNING *`,
          [myId, otherId]
        );
        chatId = insertChat.rows[0].id;
      } else {
        chatId = convRes.rows[0].id;
      }
    }

    // Create message object
    const timestamp = Date.now();
    const firebaseMessage = {
      senderUid: senderUid,
      content: content.trim(),
      createdAt: new Date().toISOString(),
      timestamp: timestamp,
    };

    // Save to Firebase
    const messageRef = await db.ref(`messages/${chatId}`).push(firebaseMessage);
    const messageId = messageRef.key;

    // Update unread count for receiver
    const unreadRef = db.ref(`unread/${receiverUid}/${chatId}`);
    const unreadSnapshot = await unreadRef.once("value");
    const currentUnread = unreadSnapshot.val() || 0;
    await unreadRef.set(currentUnread + 1);

    // Emit via Socket.io to receiver
    try {
      const io = getIO();
      io.to(receiverUid).emit("new_message", {
        conversationId: chatId,
        message: {
          id: messageId,
          sender_uid: senderUid,
          sender_name: senderInfo.name,
          sender_image: senderInfo.image_url,
          content: content.trim(),
          created_at: firebaseMessage.createdAt,
          timestamp: timestamp,
        },
      });

      // Send notification via Socket.io
      io.to(receiverUid).emit("notification", {
        type: "new_message",
        message: `New message from ${senderInfo.name}`,
        conversationId: chatId,
        senderUid: senderUid,
        senderName: senderInfo.name,
        timestamp: timestamp,
      });
    } catch (socketErr) {
      console.error("Socket emit error:", socketErr);
      // Continue even if socket fails
    }

    res.json({
      success: true,
      messageId: messageId,
      conversationId: chatId,
    });
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

    // Emit to other user that messages were seen
    const userRes = await pool.query(
      "SELECT id FROM users WHERE firebase_uid = $1",
      [uid]
    );

    if (userRes.rows.length) {
      const userId = userRes.rows[0].id;
      
      const convRes = await pool.query(
        `SELECT user_a, user_b FROM conversations WHERE id = $1`,
        [chatId]
      );

      if (convRes.rows.length) {
        const conv = convRes.rows[0];
        const otherUserId = conv.user_a === userId ? conv.user_b : conv.user_a;
        
        const otherUserRes = await pool.query(
          "SELECT firebase_uid FROM users WHERE id = $1",
          [otherUserId]
        );

        if (otherUserRes.rows.length) {
          try {
            const io = getIO();
            io.to(otherUserRes.rows[0].firebase_uid).emit("messages_seen", {
              conversationId: chatId,
              seenBy: uid,
            });
          } catch (socketErr) {
            console.error("Socket emit error:", socketErr);
          }
        }
      }
    }

    res.json({ success: true });
  } catch (err) {
    console.error("POST /chats/:chatId/read error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// Typing indicator
router.post("/:chatId/typing", verifyToken, async (req, res) => {
  try {
    const chatId = req.params.chatId;
    const uid = req.user.uid;
    const { isTyping } = req.body;

    // Get other user in conversation
    const userRes = await pool.query(
      "SELECT id FROM users WHERE firebase_uid = $1",
      [uid]
    );

    if (userRes.rows.length) {
      const userId = userRes.rows[0].id;
      
      const convRes = await pool.query(
        `SELECT user_a, user_b FROM conversations WHERE id = $1`,
        [chatId]
      );

      if (convRes.rows.length) {
        const conv = convRes.rows[0];
        const otherUserId = conv.user_a === userId ? conv.user_b : conv.user_a;
        
        const otherUserRes = await pool.query(
          "SELECT firebase_uid FROM users WHERE id = $1",
          [otherUserId]
        );

        if (otherUserRes.rows.length) {
          try {
            const io = getIO();
            io.to(otherUserRes.rows[0].firebase_uid).emit("user_typing", {
              conversationId: chatId,
              userUid: uid,
              isTyping: isTyping,
            });
          } catch (socketErr) {
            console.error("Socket emit error:", socketErr);
          }
        }
      }
    }

    res.json({ success: true });
  } catch (err) {
    console.error("POST /chats/:chatId/typing error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

export default router;
