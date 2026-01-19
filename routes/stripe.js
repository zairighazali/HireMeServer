import express from "express";
import Stripe from "stripe";
import { verifyToken } from "../middleware/auth.js";
import { pool } from "../db.js";

const router = express.Router();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

/**
 * POST /api/stripe/create-intent/:hireId
 * Create payment intent with destination charge (Standard Connect)
 */
router.post("/create-intent/:hireId", verifyToken, async (req, res) => {
  try {
    const { hireId } = req.params;
    const { uid } = req.user;

    console.log("Creating payment intent for hire:", hireId, "by user:", uid);

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
        h.id,
        h.amount,
        h.hired_by_id,
        h.payment_intent_id,
        freelancer.stripe_account_id,
        freelancer.email as freelancer_email
      FROM hires h
      JOIN users freelancer ON freelancer.id = h.freelancer_id
      WHERE h.id = $1`,
      [hireId],
    );

    if (!hireRes.rows.length) {
      return res.status(404).json({ message: "Hire not found" });
    }

    const hire = hireRes.rows[0];

    console.log("Hire details:", {
      hireId: hire.id,
      amount: hire.amount,
      hired_by_id: hire.hired_by_id,
      requestingUserId: userId,
      stripe_account_id: hire.stripe_account_id,
    });

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

    // Check if payment intent already exists
    if (hire.payment_intent_id) {
      try {
        const existingIntent = await stripe.paymentIntents.retrieve(
          hire.payment_intent_id
        );

        if (existingIntent.status === 'requires_payment_method' ||
            existingIntent.status === 'requires_confirmation') {
          console.log("Reusing existing payment intent:", hire.payment_intent_id);
          return res.json({
            success: true,
            clientSecret: existingIntent.client_secret,
          });
        }
      } catch (err) {
        console.log("Existing payment intent not valid, creating new one");
      }
    }

    // Calculate platform fee (10% example - adjust as needed)
    const platformFeeAmount = Math.round(hire.amount * 100 * 0.10); // 10% fee in cents
    const totalAmount = Math.round(hire.amount * 100); // Total in cents

    // Create PaymentIntent with DESTINATION CHARGE
    // Charge happens on YOUR platform, funds go to connected account
    console.log("Creating destination charge payment intent");
    
    const paymentIntent = await stripe.paymentIntents.create({
      amount: totalAmount,
      currency: "myr",
      payment_method_types: ["card"],
      capture_method: "manual", // Hold funds until work is complete
      application_fee_amount: platformFeeAmount, // Your platform fee
      transfer_data: {
        destination: hire.stripe_account_id, // Freelancer gets the rest
      },
      metadata: {
        hire_id: hireId.toString(),
        platform: "hireme",
        freelancer_amount: (totalAmount - platformFeeAmount).toString(),
        platform_fee: platformFeeAmount.toString(),
      },
    });

    console.log("Payment intent created:", paymentIntent.id);

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
      raw: err.raw,
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

    console.log("Capturing payment for hire:", hireId, "by user:", uid);

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
        h.payment_intent_id,
        h.hired_by_id,
        h.paid
       FROM hires h
       WHERE h.id = $1`,
      [hireId],
    );

    if (!hireRes.rows.length) {
      return res.status(404).json({ message: "Hire not found" });
    }

    const hire = hireRes.rows[0];

    console.log("Capture details:", {
      payment_intent_id: hire.payment_intent_id,
      hired_by_id: hire.hired_by_id,
      requestingUserId: userId,
    });

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

    // Capture the held payment (no stripeAccount needed - it's on your platform)
    console.log("Capturing payment intent:", hire.payment_intent_id);
    
    const paymentIntent = await stripe.paymentIntents.capture(
      hire.payment_intent_id
    );

    console.log("Payment captured successfully");

    // Mark as paid
    await pool.query("UPDATE hires SET paid = true WHERE id = $1", [hireId]);

    res.json({
      success: true,
      message: "Payment captured successfully",
      paymentIntent,
    });
  } catch (err) {
    console.error("POST /stripe/capture error:", err);
    console.error("Error details:", {
      type: err.type,
      code: err.code,
      message: err.message,
    });
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

    console.log("Refunding payment for hire:", hireId, "by user:", uid);

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
        h.payment_intent_id,
        h.hired_by_id,
        h.paid
       FROM hires h
       WHERE h.id = $1`,
      [hireId],
    );

    if (!hireRes.rows.length) {
      return res.status(404).json({ message: "Hire not found" });
    }

    const hire = hireRes.rows[0];

    console.log("Refund details:", {
      payment_intent_id: hire.payment_intent_id,
    });

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

    // Create refund (no stripeAccount needed - refunds happen on your platform)
    const refund = await stripe.refunds.create({
      payment_intent: hire.payment_intent_id,
    });

    console.log("Refund created successfully");

    // Mark as unpaid
    await pool.query("UPDATE hires SET paid = false WHERE id = $1", [hireId]);

    res.json({
      success: true,
      message: "Payment refunded successfully",
      refund,
    });
  } catch (err) {
    console.error("POST /stripe/refund error:", err);
    console.error("Error details:", {
      type: err.type,
      code: err.code,
      message: err.message,
    });
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

      const onboarded = account.charges_enabled && account.payouts_enabled && account.details_submitted;

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