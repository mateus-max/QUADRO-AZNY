import { initializeApp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js";
import { getDatabase } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-database.js";

const firebaseConfig = {
  apiKey: "AIzaSyB20GNxPQsMRmjF0RpRyQ8rNoNdpcgq13Y",
  authDomain: "quadro-azny.firebaseapp.com",
  databaseURL: "https://quadro-azny-default-rtdb.firebaseio.com",
  projectId: "quadro-azny",
  storageBucket: "quadro-azny.firebasestorage.app",
  messagingSenderId: "204452366229",
  appId: "1:204452366229:web:a6294fee1a6d92e604d89c",
  measurementId: "G-SVR4LGF8TH"
};

const app = initializeApp(firebaseConfig);
const db = getDatabase(app);

export { app, db };