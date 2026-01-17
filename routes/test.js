import express from "express";
import stripe from "../services/stripe.js";

const router = express.Router();

router.get("/stripe", async (req, res) => {
  try {
    const balance = await stripe.balance.retrieve();
    res.json(balance);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
