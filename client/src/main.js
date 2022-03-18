import { createApp } from "vue";
import App from "./App.vue";
import "./index.css";

import { initializeApp } from "firebase/app";

// Your web app's Firebase configuration
const firebaseConfig = {
  apiKey: "AIzaSyDz4BJR-83Bu-s2uyFFUByh36n6nMegrVc",
  authDomain: "sellingx-a6131.firebaseapp.com",
  databaseURL:
    "https://sellingx-a6131-default-rtdb.europe-west1.firebasedatabase.app",
  projectId: "sellingx-a6131",
  storageBucket: "sellingx-a6131.appspot.com",
  messagingSenderId: "1061875950744",
  appId: "1:1061875950744:web:e8bee349e8cc8706955ced",
};

// Initialize Firebase
const fb_app = initializeApp(firebaseConfig);

createApp(App).mount("#app");
