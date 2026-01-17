// routes/jobs.js - STANDARDIZED
import express from "express";
import { pool } from "../db.js";
import { verifyToken } from "../middleware/auth.js";

const router = express.Router();

/**
 * GET /api/jobs
 * List all open jobs with owner info
 */
router.get("/", async (req, res) => {
  try {
    const { status = "open" } = req.query;

    const result = await pool.query(
      `SELECT 
        j.id,
        j.title,
        j.description,
        j.is_remote,
        j.location,
        j.payment,
        j.status,
        j.created_at,
        u.id AS owner_id,
        u.firebase_uid AS owner_uid,
        u.name AS owner_name,
        u.image_url AS owner_image
      FROM jobs j
      JOIN users u ON u.id = j.owner_id
      WHERE j.status = $1
      ORDER BY j.created_at DESC`,
      [status],
    );

    res.json(result.rows);
  } catch (err) {
    console.error("GET /jobs error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

/**
 * GET /api/jobs/:id
 * Get single job details
 */
router.get("/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const result = await pool.query(
      `SELECT 
        j.id,
        j.title,
        j.description,
        j.is_remote,
        j.location,
        j.payment,
        j.status,
        j.created_at,
        u.id AS owner_id,
        u.firebase_uid AS owner_uid,
        u.name AS owner_name,
        u.email AS owner_email,
        u.image_url AS owner_image
      FROM jobs j
      JOIN users u ON u.id = j.owner_id
      WHERE j.id = $1`,
      [id],
    );

    if (!result.rows.length) {
      return res.status(404).json({ message: "Job not found" });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error("GET /jobs/:id error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

/**
 * POST /api/jobs
 * Create a new job
 */
router.post("/", verifyToken, async (req, res) => {
  try {
    const { uid } = req.user;
    const { title, description, is_remote, location, payment } = req.body;

    if (!title || !description) {
      return res.status(400).json({
        message: "Title and description are required",
      });
    }

    // Get user's internal ID
    const userRes = await pool.query(
      "SELECT id FROM users WHERE firebase_uid = $1",
      [uid],
    );

    if (!userRes.rows.length) {
      return res.status(404).json({ message: "User not found" });
    }

    const ownerId = userRes.rows[0].id;

    const result = await pool.query(
      `INSERT INTO jobs (
        owner_id, 
        title, 
        description, 
        is_remote, 
        location, 
        payment, 
        status
      )
      VALUES ($1, $2, $3, $4, $5, $6, 'open')
      RETURNING *`,
      [
        ownerId,
        title,
        description,
        !!is_remote,
        is_remote ? null : location || null,
        payment || null,
      ],
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error("POST /jobs error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

/**
 * PUT /api/jobs/:id
 * Update job (owner only, must be open)
 */
router.put("/:id", verifyToken, async (req, res) => {
  try {
    const { uid } = req.user;
    const { id } = req.params;
    const { title, description, is_remote, location, payment } = req.body;

    // Get user's internal ID
    const userRes = await pool.query(
      "SELECT id FROM users WHERE firebase_uid = $1",
      [uid],
    );

    if (!userRes.rows.length) {
      return res.status(404).json({ message: "User not found" });
    }

    const ownerId = userRes.rows[0].id;

    const result = await pool.query(
      `UPDATE jobs
       SET 
         title = COALESCE($1, title),
         description = COALESCE($2, description),
         is_remote = COALESCE($3, is_remote),
         location = CASE WHEN $3 = true THEN null ELSE COALESCE($4, location) END,
         payment = COALESCE($5, payment)
       WHERE id = $6 
         AND owner_id = $7 
         AND status = 'open'
       RETURNING *`,
      [title, description, is_remote, location, payment, id, ownerId],
    );

    if (!result.rows.length) {
      return res.status(403).json({
        message: "Job not found, locked, or you're not the owner",
      });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error("PUT /jobs/:id error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

/**
 * DELETE /api/jobs/:id
 * Delete job (owner only, must be open)
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

    const ownerId = userRes.rows[0].id;

    const result = await pool.query(
      `DELETE FROM jobs
       WHERE id = $1 
         AND owner_id = $2 
         AND status = 'open'
       RETURNING id`,
      [id, ownerId],
    );

    if (!result.rows.length) {
      return res.status(403).json({
        message: "Job not found, locked, or you're not the owner",
      });
    }

    res.json({ success: true, message: "Job deleted" });
  } catch (err) {
    console.error("DELETE /jobs/:id error:", err);
    res.status(500).json({
      message: "Cannot delete job with existing applications or hires",
    });
  }
});

/**
 * POST /api/jobs/:id/interest
 * Express interest in a job (create application)
 */
router.post("/:id/interest", verifyToken, async (req, res) => {
  try {
    const { uid } = req.user;
    const { id } = req.params;
    const { message = "" } = req.body;

    // Get user's internal ID
    const userRes = await pool.query(
      "SELECT id FROM users WHERE firebase_uid = $1",
      [uid],
    );

    if (!userRes.rows.length) {
      return res.status(404).json({ message: "User not found" });
    }

    const userId = userRes.rows[0].id;

    // Check if job exists and is open
    const jobRes = await pool.query(
      "SELECT id, status FROM jobs WHERE id = $1",
      [id],
    );

    if (!jobRes.rows.length) {
      return res.status(404).json({ message: "Job not found" });
    }

    if (jobRes.rows[0].status !== "open") {
      return res
        .status(400)
        .json({ message: "Job is no longer accepting applications" });
    }

    const result = await pool.query(
      `INSERT INTO job_interests (job_id, user_id, status, message)
       VALUES ($1, $2, 'pending', $3)
       ON CONFLICT (job_id, user_id) 
       DO NOTHING
       RETURNING *`,
      [id, userId, message],
    );

    if (!result.rows.length) {
      return res.status(200).json({
        success: true,
        alreadyApplied: true,
        message: "You've already expressed interest in this job",
      });
    }

    res.status(201).json({
      success: true,
      data: result.rows[0],
    });
  } catch (err) {
    console.error("POST /jobs/:id/interest error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

/**
 * GET /api/jobs/:id/interests
 * Get all applicants for a job (owner only)
 */
router.get("/:id/interests", verifyToken, async (req, res) => {
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

    const ownerId = userRes.rows[0].id;

    // Verify ownership
    const jobRes = await pool.query("SELECT owner_id FROM jobs WHERE id = $1", [
      id,
    ]);

    if (!jobRes.rows.length) {
      return res.status(404).json({ message: "Job not found" });
    }

    if (jobRes.rows[0].owner_id !== ownerId) {
      return res.status(403).json({ message: "Not authorized" });
    }

    // Get applicants
    const result = await pool.query(
      `SELECT 
        ji.id AS interest_id,
        ji.status,
        ji.message,
        ji.created_at,
        u.id AS user_id,
        u.firebase_uid AS user_uid,
        u.name,
        u.email,
        u.skills,
        u.bio,
        u.image_url
      FROM job_interests ji
      JOIN users u ON u.id = ji.user_id
      WHERE ji.job_id = $1
      ORDER BY ji.created_at ASC`,
      [id],
    );

    res.json(result.rows);
  } catch (err) {
    console.error("GET /jobs/:id/interests error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

export default router;
