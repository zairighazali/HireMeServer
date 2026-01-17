// routes/conversations.js - STANDARDIZED
import express from "express";
import { pool } from "../db.js";
import { verifyToken } from "../middleware/auth.js";
import { sendMessageToUser } from "../socket.js";

const router = express.Router();

/**
 * GET /api/conversations
 * Get all my conversations
 */
router.get("/", verifyToken, async (req, res) => {
  try {
    const { uid } = req.user;

    // Get user's internal ID
    const userRes = await pool.query(
      "SELECT id FROM users WHERE firebase_uid = $1",
      [uid],
    );

    if (!userRes.rows.length) {
      return res.status(404).json({ message: "User not found" });
    }

    const userId = userRes.rows[0].id;

    // Get conversations with other user info and last message
    const result = await pool.query(
      `SELECT 
        c.id AS conversation_id,
        c.created_at,
        other.id AS other_user_id,
        other.firebase_uid AS other_user_uid,
        other.name AS other_user_name,
        other.image_url AS other_user_image,
        last_msg.content AS last_message,
        last_msg.created_at AS last_message_at
      FROM conversations c
      JOIN users other ON 
        (other.id = c.user_a AND c.user_a != $1)
        OR (other.id = c.user_b AND c.user_b != $1)
      LEFT JOIN LATERAL (
        SELECT content, created_at
        FROM messages
        WHERE conversation_id = c.id
        ORDER BY created_at DESC
        LIMIT 1
      ) last_msg ON true
      WHERE c.user_a = $1 OR c.user_b = $1
      ORDER BY COALESCE(last_msg.created_at, c.created_at) DESC`,
      [userId],
    );

    res.json(result.rows);
  } catch (err) {
    console.error("GET /conversations error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

/**
 * POST /api/conversations/start
 * Start or get conversation with another user
 */
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
      [[uid, other_uid]],
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
      [myId, otherId],
    );

    let conversation;
    if (convRes.rows.length > 0) {
      conversation = convRes.rows[0];
    } else {
      const insertRes = await pool.query(
        `INSERT INTO conversations (user_a, user_b)
         VALUES ($1, $2)
         RETURNING *`,
        [myId, otherId],
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
      [otherId],
    );

    res.json({
      conversation_id: conversation.id,
      other_user: otherUserRes.rows[0],
      created_at: conversation.created_at,
    });
  } catch (err) {
    console.error("POST /conversations/start error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

/**
 * GET /api/conversations/:id/messages
 * Get all messages in a conversation
 */
router.get("/:id/messages", verifyToken, async (req, res) => {
  try {
    const { uid } = req.user;
    const { id } = req.params;

    // Get user's internal ID
    const userRes = await pool.query(
      "SELECT id FROM users WHERE firebase_uid = $1",
      [uid],
    );

    if (!userRes.rows.length) {
      return res.status(404).json({ message: "User not found" });
    }

    const userId = userRes.rows[0].id;

    // Verify user is part of conversation
    const convRes = await pool.query(
      `SELECT * FROM conversations
       WHERE id = $1 
         AND (user_a = $2 OR user_b = $2)`,
      [id, userId],
    );

    if (!convRes.rows.length) {
      return res.status(403).json({
        message: "Conversation not found or you don't have access",
      });
    }

    // Get messages
    const messagesRes = await pool.query(
      `SELECT 
        m.id,
        m.conversation_id,
        m.content,
        m.created_at,
        u.id AS sender_id,
        u.firebase_uid AS sender_uid,
        u.name AS sender_name,
        u.image_url AS sender_image
      FROM messages m
      JOIN users u ON u.id = m.sender_id
      WHERE m.conversation_id = $1
      ORDER BY m.created_at ASC`,
      [id],
    );

    res.json(messagesRes.rows);
  } catch (err) {
    console.error("GET /conversations/:id/messages error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

/**
 * POST /api/conversations/:id/messages
 * Send a message in a conversation
 */
router.post("/:id/messages", verifyToken, async (req, res) => {
  try {
    const { uid } = req.user;
    const { id } = req.params;
    const { content } = req.body;

    if (!content || !content.trim()) {
      return res.status(400).json({ message: "Message content is required" });
    }

    // Get user's internal ID
    const userRes = await pool.query(
      "SELECT id FROM users WHERE firebase_uid = $1",
      [uid],
    );

    if (!userRes.rows.length) {
      return res.status(404).json({ message: "User not found" });
    }

    const userId = userRes.rows[0].id;

    // Verify user is part of conversation and get other user
    const convRes = await pool.query(
      `SELECT user_a, user_b FROM conversations
       WHERE id = $1 
         AND (user_a = $2 OR user_b = $2)`,
      [id, userId],
    );

    if (!convRes.rows.length) {
      return res.status(403).json({
        message: "Conversation not found or you don't have access",
      });
    }

    const conversation = convRes.rows[0];
    const otherUserId =
      conversation.user_a === userId
        ? conversation.user_b
        : conversation.user_a;

    // Insert message
    const messageRes = await pool.query(
      `INSERT INTO messages (conversation_id, sender_id, content)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [id, userId, content.trim()],
    );

    const message = messageRes.rows[0];

    // Get sender details for response
    const senderRes = await pool.query(
      `SELECT 
        id,
        firebase_uid AS uid,
        name,
        image_url
      FROM users
      WHERE id = $1`,
      [userId],
    );

    // Get receiver's firebase_uid for socket
    const receiverRes = await pool.query(
      "SELECT firebase_uid FROM users WHERE id = $1",
      [otherUserId],
    );

    const responseMessage = {
      id: message.id,
      conversation_id: message.conversation_id,
      content: message.content,
      created_at: message.created_at,
      sender: senderRes.rows[0],
    };

    // Emit via socket
    if (receiverRes.rows[0]) {
      sendMessageToUser(receiverRes.rows[0].firebase_uid, {
        type: "new_message",
        message: responseMessage,
      });
    }

    res.status(201).json(responseMessage);
  } catch (err) {
    console.error("POST /conversations/:id/messages error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

/**
 * DELETE /api/conversations/:id
 * Delete a conversation (both users can delete)
 */
router.delete("/:id", verifyToken, async (req, res) => {
  try {
    const { uid } = req.user;
    const { id } = req.params;

    // Get user's internal ID
    const userRes = await pool.query(
      "SELECT id FROM users WHERE firebase_uid = $1",
      [uid],
    );

    if (!userRes.rows.length) {
      return res.status(404).json({ message: "User not found" });
    }

    const userId = userRes.rows[0].id;

    // Delete conversation (will cascade delete messages)
    const result = await pool.query(
      `DELETE FROM conversations
       WHERE id = $1 
         AND (user_a = $2 OR user_b = $2)
       RETURNING id`,
      [id, userId],
    );

    if (!result.rows.length) {
      return res.status(403).json({
        message: "Conversation not found or you don't have access",
      });
    }

    res.json({
      success: true,
      message: "Conversation deleted",
    });
  } catch (err) {
    console.error("DELETE /conversations/:id error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

export default router;
