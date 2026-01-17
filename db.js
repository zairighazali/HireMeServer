// db.js
import pkg from "pg";
import dotenv from "dotenv";

dotenv.config();
const { Pool } = pkg;

// ===== POOL =====
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// ===== TEST CONNECTION =====
pool
  .connect()
  .then((client) => {
    console.log("Database connected ✅");
    client.release();
  })
  .catch((err) => console.error("DB connection error ❌", err));
