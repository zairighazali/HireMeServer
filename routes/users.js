// routes/users.js - STANDARDIZED
import express from "express";
import { pool } from "../db.js";
import { verifyToken } from "../middleware/auth.js";

const router = express.Router();

// ============================================
// PUBLIC ROUTES (No Auth Required)
// ============================================

/**
 * GET /api/users/public/freelancers
 * Search freelancers (public access)
 */
router.get("/public/freelancers", async (req, res) => {
  try {
    const { q = "" } = req.query;

    const result = await pool.query(
      `SELECT 
        id,
        firebase_uid AS uid,
        name,
        email,
        skills,
        bio,
        image_url,
        is_best_hired,
        created_at
      FROM users
      WHERE 
        role = 'user'
        AND (
          LOWER(name) LIKE LOWER($1)
          OR LOWER(skills) LIKE LOWER($1)
          OR LOWER(bio) LIKE LOWER($1)
        )
      ORDER BY name ASC
      LIMIT 50`,
      [`%${q}%`],
    );

    res.json(result.rows);
  } catch (err) {
    console.error("GET /users/public/freelancers error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

/**
 * GET /api/users/public/:uid
 * Get public profile by firebase_uid
 */
router.get("/public/:uid", async (req, res) => {
  try {
    const { uid } = req.params;

    const result = await pool.query(
      `SELECT 
        id,
        firebase_uid AS uid,
        name,
        skills,
        bio,
        image_url,
        is_best_hired,
        created_at
      FROM users
      WHERE firebase_uid = $1`,
      [uid],
    );

    if (!result.rows.length) {
      return res.status(404).json({ message: "User not found" });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error("GET /users/public/:uid error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// ============================================
// AUTHENTICATED ROUTES
// ============================================

/**
 * POST /api/users/me
 * Create or sync current user
 */
router.post("/me", verifyToken, async (req, res) => {
  try {
    const { uid, email, picture } = req.user;
    const { name = "Unnamed User" } = req.body;

    const result = await pool.query(
      `INSERT INTO users (firebase_uid, name, email, role, image_url)
       VALUES ($1, $2, $3, 'user', $4)
       ON CONFLICT(firebase_uid) 
       DO UPDATE SET
         name = COALESCE($2, users.name),
         email = $3,
         image_url = COALESCE($4, users.image_url)
       RETURNING 
         id,
         firebase_uid AS uid,
         name,
         email,
         role,
         skills,
         bio,
         image_url,
         stripe_customer_id,
         stripe_account_id,
         stripe_onboarded,
         created_at`,
      [uid, name, email, picture || null],
    );

    res.json(result.rows[0]);
  } catch (err) {
    console.error("POST /users/me error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

/**
 * GET /api/users/me
 * Get current user profile
 */
router.get("/me", verifyToken, async (req, res) => {
  try {
    const { uid } = req.user;

    const result = await pool.query(
      `SELECT 
        id,
        firebase_uid AS uid,
        name,
        email,
        role,
        skills,
        bio,
        image_url,
        stripe_customer_id,
        stripe_account_id,
        stripe_onboarded,
        created_at
      FROM users
      WHERE firebase_uid = $1`,
      [uid],
    );

    if (!result.rows.length) {
      return res.status(404).json({ message: "User not found" });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error("GET /users/me error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

/**
 * PUT /api/users/me
 * Update current user profile
 */
router.put("/me", verifyToken, async (req, res) => {
  try {
    const { uid } = req.user;
    const { name, skills, bio, image_url } = req.body;

    const result = await pool.query(
      `UPDATE users
       SET 
         name = COALESCE($1, name),
         skills = COALESCE($2, skills),
         bio = COALESCE($3, bio),
         image_url = COALESCE($4, image_url)
       WHERE firebase_uid = $5
       RETURNING 
         id,
         firebase_uid AS uid,
         name,
         email,
         role,
         skills,
         bio,
         image_url,
         is_best_hired,
         created_at`,
      [name, skills, bio, image_url, uid],
    );

    if (!result.rows.length) {
      return res.status(404).json({ message: "User not found" });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error("PUT /users/me error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

/**
 * GET /api/users/freelancers
 * Search freelancers (authenticated)
 */
router.get("/freelancers", verifyToken, async (req, res) => {
  try {
    const { q = "" } = req.query;

    const result = await pool.query(
      `SELECT 
        id,
        firebase_uid AS uid,
        name,
        email,
        skills,
        bio,
        image_url,
        is_best_hired,
        created_at
      FROM users
      WHERE 
        role = 'user'
        AND (
          LOWER(name) LIKE LOWER($1)
          OR LOWER(skills) LIKE LOWER($1)
          OR LOWER(bio) LIKE LOWER($1)
        )
      ORDER BY name ASC
      LIMIT 50`,
      [`%${q}%`],
    );

    res.json(result.rows);
  } catch (err) {
    console.error("GET /users/freelancers error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

/**
 * GET /api/users/:uid
 * Get user profile by firebase_uid (authenticated)
 */
router.get("/:uid", verifyToken, async (req, res) => {
  try {
    const { uid } = req.params;

    const result = await pool.query(
      `SELECT 
        id,
        firebase_uid AS uid,
        name,
        email,
        skills,
        bio,
        image_url,
        is_best_hired,
        created_at
      FROM users
      WHERE firebase_uid = $1`,
      [uid],
    );

    if (!result.rows.length) {
      return res.status(404).json({ message: "User not found" });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error("GET /users/:uid error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

export default router;
