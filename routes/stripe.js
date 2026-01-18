// routes/stripe.js - STANDARDIZED
import express from "express";
import Stripe from "stripe";
import { verifyToken } from "../middleware/auth.js";
import { pool } from "../db.js";

const router = express.Router();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

/**
 * POST /api/stripe/create-intent/:hireId
 * Create payment intent for a hire
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

    // Create PaymentIntent with manual capture (hold funds)
    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(hire.amount * 100), // Convert to cents
      currency: "myr",
      payment_method_types: ["card"],
      capture_method: "manual", // Hold funds until work is complete
      transfer_data: {
        destination: hire.stripe_account_id,
      },
      metadata: {
        hire_id: hireId,
      },
    });

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

    // Get hire details
    const hireRes = await pool.query(
      `SELECT payment_intent_id, hired_by_id, paid
       FROM hires
       WHERE id = $1`,
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

    // Capture the held payment
    const paymentIntent = await stripe.paymentIntents.capture(
      hire.payment_intent_id,
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

    // Get hire details
    const hireRes = await pool.query(
      `SELECT payment_intent_id, hired_by_id, paid
       FROM hires
       WHERE id = $1`,
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

    // Create refund
    const refund = await stripe.refunds.create({
      payment_intent: hire.payment_intent_id,
    });

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

/**
 * POST /api/stripe/onboard
 * Create Stripe Connect account for freelancer
 */
router.post("/onboard", verifyToken, async (req, res) => {
  try {
    const { uid } = req.user;

    console.log("Starting onboarding for user:", uid);

    // Get user details
    const userRes = await pool.query(
      `SELECT id, email, stripe_account_id
       FROM users
       WHERE firebase_uid = $1`,
      [uid],
    );

    if (!userRes.rows.length) {
      console.error("User not found:", uid);
      return res.status(404).json({ message: "User not found" });
    }

    const user = userRes.rows[0];
    console.log("User found:", {
      id: user.id,
      email: user.email,
      hasAccount: !!user.stripe_account_id,
    });

    let accountId = user.stripe_account_id;

    // Create account if doesn't exist
    if (!accountId) {
      console.log("Creating new Stripe account for:", user.email);

      try {
        const account = await stripe.accounts.create({
          type: "standard",
          country: "MY", // Malaysia
          email: user.email,
        });

        accountId = account.id;
        console.log("Created Stripe account:", accountId);

        // Save to database
        await pool.query(
          "UPDATE users SET stripe_account_id = $1 WHERE id = $2",
          [accountId, user.id],
        );
        console.log("Saved account ID to database");
      } catch (accountError) {
        console.error("Failed to create Stripe account:", accountError);
        throw new Error(
          `Failed to create Stripe account: ${accountError.message}`,
        );
      }
    } else {
      console.log("Using existing Stripe account:", accountId);
    }

    // Verify the frontend URL is set
    if (!process.env.FRONTEND_URL) {
      throw new Error("FRONTEND_URL environment variable is not set");
    }

    console.log("Creating account link with:", {
      accountId,
      refreshUrl: `${process.env.FRONTEND_URL}/settings/payment`,
      returnUrl: `${process.env.FRONTEND_URL}/settings/payment?success=true`,
    });

    // Create account link for onboarding
    try {
      const accountLink = await stripe.accountLinks.create({
        account: accountId,
        refresh_url: `${process.env.FRONTEND_URL}/settings/payment`,
        return_url: `${process.env.FRONTEND_URL}/settings/payment?success=true`,
        type: "account_onboarding",
      });

      console.log("Account link created successfully:", accountLink.url);

      res.json({
        success: true,
        url: accountLink.url,
      });
    } catch (linkError) {
      console.error("Failed to create account link:", linkError);
      throw new Error(`Failed to create account link: ${linkError.message}`);
    }
  } catch (err) {
    console.error("POST /stripe/onboard error:", err);
    res.status(500).json({
      message: "Failed to create onboarding link",
      error: err.message,
      details: err.raw?.message || err.raw || undefined,
    });
  }
});

/**
 * GET /api/stripe/login-link
 * Redirect user to Stripe dashboard to complete setup
 */
router.get("/login-link", verifyToken, async (req, res) => {
  try {
    const { uid } = req.user;

    const userRes = await pool.query(
      "SELECT stripe_account_id FROM users WHERE firebase_uid = $1",
      [uid]
    );

    if (!userRes.rows.length || !userRes.rows[0].stripe_account_id) {
      return res.status(400).json({ message: "Stripe account not found" });
    }

    const loginLink = await stripe.accounts.createLoginLink(
      userRes.rows[0].stripe_account_id
    );

    res.json({ url: loginLink.url });
  } catch (err) {
    console.error("Stripe login link error:", err);
    res.status(500).json({ message: "Failed to create login link" });
  }
});


/**
 * GET /api/stripe/account-status
 * Check Stripe account onboarding status
 */
router.get("/account-status", verifyToken, async (req, res) => {
  try {
    const { uid } = req.user;

    console.log("Fetching account status for user:", uid);

    const userRes = await pool.query(
      `SELECT stripe_account_id, stripe_onboarded
       FROM users
       WHERE firebase_uid = $1`,
      [uid],
    );

    if (!userRes.rows.length) {
      return res.status(404).json({ message: "User not found" });
    }

    const user = userRes.rows[0];

    if (!user.stripe_account_id) {
      console.log("No Stripe account for user");
      return res.json({
        onboarded: false,
        hasAccount: false,
        chargesEnabled: false,
        payoutsEnabled: false,
      });
    }

    console.log("Checking account status for:", user.stripe_account_id);

    // Check account status with Stripe
    try {
      const account = await stripe.accounts.retrieve(user.stripe_account_id);

      console.log("Account status:", {
        id: account.id,
        chargesEnabled: account.charges_enabled,
        payoutsEnabled: account.payouts_enabled,
        detailsSubmitted: account.details_submitted,
      });

      const onboarded = account.charges_enabled

      // Update database if status changed
      if (onboarded !== user.stripe_onboarded) {
        await pool.query(
          "UPDATE users SET stripe_onboarded = $1 WHERE firebase_uid = $2",
          [onboarded, uid],
        );
        console.log("Updated stripe_onboarded in database:", onboarded);
      }

      res.json({
        onboarded,
        hasAccount: true,
        chargesEnabled: account.charges_enabled,
        payoutsEnabled: account.payouts_enabled,
        detailsSubmitted: account.details_submitted,
      });
    } catch (retrieveError) {
      console.error("Failed to retrieve account from Stripe:", retrieveError);

      // Account might have been deleted in Stripe
      if (retrieveError.code === "resource_missing") {
        await pool.query(
          "UPDATE users SET stripe_account_id = NULL, stripe_onboarded = false WHERE firebase_uid = $1",
          [uid],
        );
        return res.json({
          onboarded: false,
          hasAccount: false,
          chargesEnabled: false,
          payoutsEnabled: false,
        });
      }

      throw retrieveError;
    }
  } catch (err) {
    console.error("GET /stripe/account-status error:", err);
    res.status(500).json({
      message: "Failed to check account status",
      error: err.message,
    });
  }
});

export default router;
