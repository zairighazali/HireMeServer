// routes/hires.js - STANDARDIZED
import express from "express";
import { pool } from "../db.js";
import { verifyToken } from "../middleware/auth.js";

const router = express.Router();

/**
 * POST /api/hires
 * Create a hire record (accept an applicant)
 * Amount is automatically set to the full job payment
 */
router.post("/", verifyToken, async (req, res) => {
  try {
    const { uid } = req.user;
    const { interest_id } = req.body;

    if (!interest_id) {
      return res.status(400).json({ message: "interest_id is required" });
    }

    // Get hiring user's ID
    const userRes = await pool.query(
      "SELECT id FROM users WHERE firebase_uid = $1",
      [uid],
    );

    if (!userRes.rows.length) {
      return res.status(404).json({ message: "User not found" });
    }

    const hiredById = userRes.rows[0].id;

    // Get interest details along with job payment
    const interestRes = await pool.query(
      `SELECT ji.*, j.owner_id, j.payment, j.title
       FROM job_interests ji
       JOIN jobs j ON j.id = ji.job_id
       WHERE ji.id = $1`,
      [interest_id],
    );

    if (!interestRes.rows.length) {
      return res.status(404).json({ message: "Interest not found" });
    }

    const interest = interestRes.rows[0];

    // Verify the hiring user is the job owner
    if (interest.owner_id !== hiredById) {
      return res.status(403).json({
        message: "Only job owner can hire applicants",
      });
    }

    // Check if already hired
    const existingHire = await pool.query(
      "SELECT id FROM hires WHERE interest_id = $1",
      [interest_id],
    );

    if (existingHire.rows.length > 0) {
      return res.status(400).json({
        message: "This applicant has already been hired",
      });
    }

    // Calculate amount as full job payment
    // If job payment is null, amount will be 0
    const calculatedAmount = interest.payment
      ? parseFloat(interest.payment)
      : 0;

    // Create hire record with calculated amount
    const hireRes = await pool.query(
      `INSERT INTO hires (
        job_id,
        freelancer_id,
        interest_id,
        hired_by_id,
        amount,
        paid
      )
      VALUES ($1, $2, $3, $4, $5, false)
      RETURNING *`,
      [
        interest.job_id,
        interest.user_id,
        interest_id,
        hiredById,
        calculatedAmount,
      ],
    );

    // Update interest status
    await pool.query(
      "UPDATE job_interests SET status = 'hired' WHERE id = $1",
      [interest_id],
    );

    // Get full hire details with user info
    const fullHireRes = await pool.query(
      `SELECT 
        h.*,
        j.title AS job_title,
        j.payment AS job_payment,
        u.firebase_uid AS freelancer_uid,
        u.name AS freelancer_name,
        u.email AS freelancer_email,
        u.image_url AS freelancer_image
      FROM hires h
      JOIN jobs j ON j.id = h.job_id
      JOIN users u ON u.id = h.freelancer_id
      WHERE h.id = $1`,
      [hireRes.rows[0].id],
    );

    res.status(201).json({
      success: true,
      hire: fullHireRes.rows[0],
      message: `Hire created with amount ${calculatedAmount} (full job payment)`,
    });
  } catch (err) {
    console.error("POST /hires error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

/**
 * GET /api/hires/:id
 * Get hire details
 */
router.get("/:id", verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
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

    const result = await pool.query(
      `SELECT 
        h.id AS hire_id,
        h.amount,
        h.payment_intent_id,
        h.paid,
        h.created_at,
        j.id AS job_id,
        j.title AS job_title,
        j.description AS job_description,
        j.payment AS job_payment,
        freelancer.id AS freelancer_id,
        freelancer.firebase_uid AS freelancer_uid,
        freelancer.name AS freelancer_name,
        freelancer.email AS freelancer_email,
        freelancer.image_url AS freelancer_image,
        hirer.id AS hired_by_id,
        hirer.firebase_uid AS hired_by_uid,
        hirer.name AS hired_by_name
      FROM hires h
      JOIN jobs j ON j.id = h.job_id
      JOIN users freelancer ON freelancer.id = h.freelancer_id
      JOIN users hirer ON hirer.id = h.hired_by_id
      WHERE h.id = $1
        AND (h.freelancer_id = $2 OR h.hired_by_id = $2)`,
      [id, userId],
    );

    if (!result.rows.length) {
      return res.status(404).json({
        message: "Hire not found or you don't have access",
      });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error("GET /hires/:id error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

/**
 * GET /api/hires/my/jobs
 * Get jobs I've hired for (as job owner)
 */
router.get("/my/jobs", verifyToken, async (req, res) => {
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

    const result = await pool.query(
      `SELECT 
        h.id AS hire_id,
        h.amount,
        h.paid,
        h.created_at,
        j.id AS job_id,
        j.title AS job_title,
        j.payment AS job_payment,
        u.firebase_uid AS freelancer_uid,
        u.name AS freelancer_name,
        u.image_url AS freelancer_image
      FROM hires h
      JOIN jobs j ON j.id = h.job_id
      JOIN users u ON u.id = h.freelancer_id
      WHERE h.hired_by_id = $1
      ORDER BY h.created_at DESC`,
      [userId],
    );

    res.json(result.rows);
  } catch (err) {
    console.error("GET /hires/my/jobs error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

/**
 * GET /api/hires/my/work
 * Get jobs I've been hired for (as freelancer)
 */
router.get("/my/work", verifyToken, async (req, res) => {
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

    const result = await pool.query(
      `SELECT 
        h.id AS hire_id,
        h.amount,
        h.paid,
        h.created_at,
        j.id AS job_id,
        j.title AS job_title,
        j.description AS job_description,
        j.payment AS job_payment,
        owner.firebase_uid AS owner_uid,
        owner.name AS owner_name,
        owner.image_url AS owner_image
      FROM hires h
      JOIN jobs j ON j.id = h.job_id
      JOIN users owner ON owner.id = h.hired_by_id
      WHERE h.freelancer_id = $1
      ORDER BY h.created_at DESC`,
      [userId],
    );

    res.json(result.rows);
  } catch (err) {
    console.error("GET /hires/my/work error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

/**
 * PUT /api/hires/:id/payment
 * Update payment details (payment_intent_id, paid status)
 */
router.put("/:id/payment", verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { uid } = req.user;
    const { payment_intent_id, paid } = req.body;

    // Get user's internal ID
    const userRes = await pool.query(
      "SELECT id FROM users WHERE firebase_uid = $1",
      [uid],
    );

    if (!userRes.rows.length) {
      return res.status(404).json({ message: "User not found" });
    }

    const userId = userRes.rows[0].id;

    const result = await pool.query(
      `UPDATE hires
       SET 
         payment_intent_id = COALESCE($1, payment_intent_id),
         paid = COALESCE($2, paid)
       WHERE id = $3 
         AND hired_by_id = $4
       RETURNING *`,
      [payment_intent_id, paid, id, userId],
    );

    if (!result.rows.length) {
      return res.status(403).json({
        message: "Hire not found or you're not authorized",
      });
    }

    res.json({
      success: true,
      hire: result.rows[0],
    });
  } catch (err) {
    console.error("PUT /hires/:id/payment error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

export default router;
