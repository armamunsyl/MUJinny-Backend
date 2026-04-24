require('dotenv').config();
const admin = require('firebase-admin');

try {
    const projectId = process.env.FIREBASE_PROJECT_ID;
    const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
    const privateKey = process.env.FIREBASE_PRIVATE_KEY;

    if (!projectId || !clientEmail || !privateKey) {
        throw new Error('Missing FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, or FIREBASE_PRIVATE_KEY environment variables.');
    }

    admin.initializeApp({
        credential: admin.credential.cert({
            projectId: projectId,
            clientEmail: clientEmail,
            privateKey: privateKey.replace(/\\n/g, '\n'),
        }),
    });

    console.log("Firebase Admin initialized");

} catch (error) {
    console.error("Firebase Admin initialization failed:", error.message);
    // Continue running the server even if Firebase Admin fails to initialize,
    // to prevent complete crashes when env variables are missing during setup.
}

module.exports = admin;
