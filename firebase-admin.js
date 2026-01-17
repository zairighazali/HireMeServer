// backend/firebase-admin.js
import admin from "firebase-admin";

// Check if Firebase app is already initialized
let app;
if (!admin.apps.length) {
  // Option 1: Using service account JSON file (download from Firebase Console)
  // Go to: Firebase Console → Project Settings → Service Accounts → Generate New Private Key
  /*
  import serviceAccount from './firebase-service-account.json' assert { type: 'json' };

  app = admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: process.env.FIREBASE_DATABASE_URL
  });
  */

  // Option 2: Using environment variables (more secure for production)
  app = admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
    }),
    databaseURL: process.env.FIREBASE_DATABASE_URL,
  });

  console.log("✅ Firebase Admin initialized successfully");
} else {
  // Use existing app
  app = admin.app();
  console.log("ℹ️  Using existing Firebase Admin instance");
}

export const db = admin.database();
export default admin;
