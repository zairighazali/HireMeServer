import express from "express";
import Stripe from "stripe";
import { verifyToken } from "../middleware/auth.js";
import { pool } from "../db.js";

const router = express.Router();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

/**
 * POST /api/stripe/create-intent/:hireId
 * Create payment intent for a hire (Standard Connect Account)
 */
router.post("/create-intent/:hireId", verifyToken, async (req, res) => {
  try {
    const { hireId } = req.params;
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

    // Get hire details
    const hireRes = await pool.query(
      `SELECT
        h.amount,
        h.hired_by_id,
        freelancer.stripe_account_id
      FROM hires h
      JOIN users freelancer ON freelancer.id = h.freelancer_id
      WHERE h.id = $1`,
      [hireId],
    );

    if (!hireRes.rows.length) {
      return res.status(404).json({ message: "Hire not found" });
    }

    const hire = hireRes.rows[0];

    // Verify user is the one who hired
    if (hire.hired_by_id !== userId) {
      return res.status(403).json({
        message: "You are not authorized to pay for this hire",
      });
    }

    if (!hire.stripe_account_id) {
      return res.status(400).json({
        message: "Freelancer hasn't set up payment account yet",
      });
    }

    // For Standard accounts, create PaymentIntent ON the connected account
    // This means the payment goes directly to the freelancer's account
    const paymentIntent = await stripe.paymentIntents.create(
      {
        amount: Math.round(hire.amount * 100), // Convert to cents
        currency: "myr",
        payment_method_types: ["card"],
        capture_method: "manual", // Hold funds until work is complete
        metadata: {
          hire_id: hireId,
        },
      },
      {
        stripeAccount: hire.stripe_account_id, // Create on freelancer's account
      }
    );

    // Save payment_intent_id to hire
    await pool.query("UPDATE hires SET payment_intent_id = $1 WHERE id = $2", [
      paymentIntent.id,
      hireId,
    ]);

    res.json({
      success: true,
      clientSecret: paymentIntent.client_secret,
    });
  } catch (err) {
    console.error("POST /stripe/create-intent error:", err);
    console.error("Error details:", {
      type: err.type,
      code: err.code,
      message: err.message,
    });
    res.status(500).json({
      message: "Failed to create payment intent",
      error: err.message,
    });
  }
});

/**
 * POST /api/stripe/capture/:hireId
 * Capture held payment (release funds to freelancer)
 */
router.post("/capture/:hireId", verifyToken, async (req, res) => {
  try {
    const { hireId } = req.params;
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

    // Get hire details including freelancer's stripe account
    const hireRes = await pool.query(
      `SELECT
        h.payment_intent_id,
        h.hired_by_id,
        h.paid,
        freelancer.stripe_account_id
       FROM hires h
       JOIN users freelancer ON freelancer.id = h.freelancer_id
       WHERE h.id = $1`,
      [hireId],
    );

    if (!hireRes.rows.length) {
      return res.status(404).json({ message: "Hire not found" });
    }

    const hire = hireRes.rows[0];

    // Verify user is the one who hired
    if (hire.hired_by_id !== userId) {
      return res.status(403).json({
        message: "You are not authorized to capture this payment",
      });
    }

    if (!hire.payment_intent_id) {
      return res.status(400).json({
        message: "No payment intent found for this hire",
      });
    }

    if (hire.paid) {
      return res.status(400).json({
        message: "Payment already captured",
      });
    }

    // Capture the held payment on the connected account
    const paymentIntent = await stripe.paymentIntents.capture(
      hire.payment_intent_id,
      {},
      {
        stripeAccount: hire.stripe_account_id, // Capture on freelancer's account
      }
    );

    // Mark as paid
    await pool.query("UPDATE hires SET paid = true WHERE id = $1", [hireId]);

    res.json({
      success: true,
      message: "Payment captured successfully",
      paymentIntent,
    });
  } catch (err) {
    console.error("POST /stripe/capture error:", err);
    res.status(500).json({
      message: "Failed to capture payment",
      error: err.message,
    });
  }
});

/**
 * POST /api/stripe/refund/:hireId
 * Refund a payment
 */
router.post("/refund/:hireId", verifyToken, async (req, res) => {
  try {
    const { hireId } = req.params;
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

    // Get hire details including freelancer's stripe account
    const hireRes = await pool.query(
      `SELECT
        h.payment_intent_id,
        h.hired_by_id,
        h.paid,
        freelancer.stripe_account_id
       FROM hires h
       JOIN users freelancer ON freelancer.id = h.freelancer_id
       WHERE h.id = $1`,
      [hireId],
    );

    if (!hireRes.rows.length) {
      return res.status(404).json({ message: "Hire not found" });
    }

    const hire = hireRes.rows[0];

    // Verify user is the one who hired
    if (hire.hired_by_id !== userId) {
      return res.status(403).json({
        message: "You are not authorized to refund this payment",
      });
    }

    if (!hire.payment_intent_id) {
      return res.status(400).json({
        message: "No payment intent found for this hire",
      });
    }

    // Create refund on the connected account
    const refund = await stripe.refunds.create(
      {
        payment_intent: hire.payment_intent_id,
      },
      {
        stripeAccount: hire.stripe_account_id, // Refund on freelancer's account
      }
    );

    // Mark as unpaid
    await pool.query("UPDATE hires SET paid = false WHERE id = $1", [hireId]);

    res.json({
      success: true,
      message: "Payment refunded successfully",
      refund,
    });
  } catch (err) {
    console.error("POST /stripe/refund error:", err);
    res.status(500).json({
      message: "Failed to refund payment",
      error: err.message,
    });
  }
});


export default router;
