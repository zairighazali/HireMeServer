// routes/public.js
import express from "express";
import { pool } from "../db.js";

const router = express.Router();

// GET public freelancers (optional search q)
router.get("/freelancers", async (req, res) => {
  try {
    const q = req.query.q || "";

    const result = await pool.query(
      `
      SELECT 
        firebase_uid AS uid,
        name,
        skills,
        bio,
        image_url
      FROM users
      WHERE
        LOWER(skills) LIKE LOWER($1)
        OR LOWER(name) LIKE LOWER($1)
        OR LOWER(bio) LIKE LOWER($1)
      ORDER BY name ASC
      `,
      [`%${q}%`],
    );

    res.json(result.rows);
  } catch (err) {
    console.error("Public freelancers error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

export default router;
