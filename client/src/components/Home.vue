<script setup>
import { ref, onMounted, computed } from "vue";
import {
  getAuth,
  signOut,
  sendSignInLinkToEmail,
  isSignInWithEmailLink,
  signInWithEmailLink,
  onAuthStateChanged,
} from "firebase/auth";
import {
  getFirestore,
  collection,
  query,
  onSnapshot,
  doc,
  updateDoc,
  deleteDoc,
  where,
  Timestamp,
} from "firebase/firestore";
import { getFunctions, httpsCallable } from "firebase/functions";
import { getStorage, ref as storageref, uploadBytes } from "firebase/storage";
import { v4 as uuidv4 } from "uuid";

import EventListElement from "./EventListElement.vue";
import TicketListElement from "./TicketListElement.vue";
import LoadingSpinner from "./LoadingSpinner.vue";

let hostUrl;
// CHECK FOR DEV MODE
if(window.location.hostname == 'localhost')
  hostUrl = `http://${window.location.host}/` 
else
  hostUrl = `https://${window.location.host}/`;

console.log(hostUrl)

// Firebase passwordless settings
const actionCodeSettings = {
  // URL you want to redirect back to. The domain (www.example.com) for this
  // URL must be in the authorized domains list in the Firebase Console.
  url: hostUrl,
  handleCodeInApp: true,
};

// Stripe settings (imported in index)
const stripe = Stripe(
  "pk_test_51Kc9zuICM6wKNignNV224oUSa4Rs07yOKbQlQsJECDiFJE42RE3bOntjdXBV1gMvpW8f38qGqtZIoWVVzfYFpKAu005DLPPYTE"
);

const email = ref("");
const page = ref("events");
const user = ref(null);
const userData = ref(null);
let userDataUnsub = null;

const infoMessage = ref(null);
const errorMessage = ref(null);
const successMessage = ref(null);
const signInButtonLoading = ref(false);
const events = ref(null);

// Ticket page stuff
const activeEvent = ref(null);
const activeTickets = ref(null);
const stripeConnectLoading = ref(false);
let activeEventUnsub = null;
let activeTicketsUnsub = null;

// Buy Modal Stuff
const showBuyModal = ref(false);
const buyTicket = ref(null);
const buyButtonLoading = ref(false);
const paymentOptionsLoading = ref(false);
const errorMessageBuyModal = ref(null);
let stripeElements = null;

// Sell Modal Stuff
const showSellModal = ref(false);
const ticketFile = ref(null);
const ticketPrice = ref(null);
const selectedFileName = ref(null);
const sellButtonLoading = ref(false);
const errorMessageSellModal = ref(null);

// Sell Update Modal
const showSellUpdateModal = ref(false);
const updateTicket = ref(null);
const newTicketPrice = ref(null);
const updateButtonLoading = ref(false);
const cancelButtonLoading = ref(false);
const errorMessageUpdateModal = ref(null);

onMounted(() => {
  const auth = getAuth();

  // Configure callback for the user login state
  onAuthStateChanged(auth, async (userRaw) => {
    if (userRaw) {
      user.value = userRaw;
      userDataUnsub = subscribeUser();
    } else {
      user.value = null;
      userData.value = null;

      if(userDataUnsub != null) {
        userDataUnsub();
        userDataUnsub = null;
      }
    }
  });

  // Check if there's a signin process happening
  if (isSignInWithEmailLink(auth, window.location.href)) {
    let email = window.localStorage.getItem("emailForSignIn");
    if (!email) {
      infoMessage.value = "Please login with the same device!";
    }
    signInWithEmailLink(auth, email, window.location.href)
      .then((result) => {
        window.localStorage.removeItem("emailForSignIn");
        window.location.replace(hostUrl); 
      })
      .catch(() => {
        // Probably an expired token or something let's just silently fail
      });
  }

  // Check if there is any messages to show
  var urlParams = new URLSearchParams(window.location.search);
  if(urlParams.has('successConnect'))
    successMessage.value = "We've successfully configured your seller account 💰";
  else if(urlParams.has('successBuy'))
    successMessage.value = "You've bought a ticket, it's on it's way to your email 💌";

  subscribeEvents();
});

/******************* FIRESTORE CALLS **********************/
const subscribeUser = () => {
  const fStore = getFirestore();
  const userRef = doc(fStore, "users", user.value.uid);
  const unsub = onSnapshot(userRef, (doc) => {
    userData.value = doc.data();
    console.log(userData.value);
  });

  return unsub;
};

const subscribeEvents = () => {
  const fStore = getFirestore();
  const now = Timestamp.now();
  const q = query(collection(fStore, "events"), where("expiry", ">=", now));
  const unsub = onSnapshot(q, (querySnapshot) => {
    const newEvents = [];
    querySnapshot.forEach((doc) => {
      const newEvent = newEventFromDoc(doc.id, doc.data());
      newEvents.push(newEvent);
    });

    events.value = newEvents;
  });

  return unsub;
};

const subscribeActiveEvent = (eventId) => {
  const fStore = getFirestore();

  // Streaming Active Event
  const eventRef = doc(fStore, "events", eventId);
  activeEventUnsub = onSnapshot(eventRef, (doc) => {
    const newEvent = newEventFromDoc(doc.id, doc.data());
    activeEvent.value = newEvent;
  });

  // Streaming Active Event Tickets
  const ticketsQuery = query(
    collection(fStore, "events/" + eventId + "/tickets"),
    where("sold", "==", false)
  );
  activeTicketsUnsub = onSnapshot(ticketsQuery, (querySnapshot) => {
    const newTickets = [];
    querySnapshot.forEach((doc) => {
      const newTicket = newTicketFromDoc(doc.id, doc.data());
      newTickets.push(newTicket);
    });
    activeTickets.value = newTickets;
    page.value = "tickets";
  });
};

const unsubscribeActiveEvent = () => {
  activeEventUnsub();
  activeTicketsUnsub();

  activeEvent.value = null;
  activeTickets.value = null;

  activeEventUnsub = null;
  activeTicketsUnsub = null;
};

const startStripeConnect = () => {
  const functions = getFunctions();
  const signup = httpsCallable(functions, "signup");
  signup()
    .then((result) => {
      window.location.replace(result.data.url);
    })
    .catch(() => {
      // Probably the user is not authenticated
      infoMessage.value =
        "We don't know who you are. Login above to sell a ticket 😉";
    });
};

const getStripeBuyerSecret = async (ticket) => {
  // Configure Stripe Elements
  const functions = getFunctions();
  console.log(functions);
  const buyTicket = httpsCallable(functions, "buyTicket");

  let result = await buyTicket({
    event: activeEvent.value.id,
    ticket: ticket.id,
  });
  console.log(result.data);
  return result.data.secret;
};

/******************* UTILITY FUNCTIONS **********************/
function newEventFromDoc(id, data) {
  const newEvent = {};

  newEvent.id = id;
  newEvent.name = data.name;
  newEvent.price = data.average_price;
  newEvent.previousPrice = data.previous_average;
  newEvent.date = new Date(data.expiry.seconds * 1000);
  newEvent.readableDate = new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(newEvent.date);

  return newEvent;
}

function newTicketFromDoc(id, data) {
  const newTicket = {};

  newTicket.id = id;
  newTicket.email = data.seller;
  newTicket.sellerId = data.seller_id;
  newTicket.price = data.price;

  return newTicket;
}

/**************** VUE FUNCTIONS **************************/
const onTicketUpload = () => {
  // To keep the upload file name in sync with the ticket name
  selectedFileName.value = ticketFile.value.files[0].name;
};

function updateTicketPrice() {
  updateButtonLoading.value = true;
  
  if(!newTicketPrice.value) {
    errorMessageUpdateModal.value = "Invalid form fields!";
    updateButtonLoading.value = false;
    return;
  }

  const fStore = getFirestore();
  const ticketRef = doc(
    fStore,
    "events/" + activeEvent.value.id + "/tickets",
    updateTicket.value.id
  );
  updateDoc(ticketRef, {
    price: newTicketPrice.value,
  }).then(() => {
    sellUpdateModalOff();
    updateButtonLoading.value = false;
  }).catch((error) => {
    errorMessageUpdateModal.value = "Oops, there's an error, reach out to us to report it!"
    updateButtonLoading.value = false;
  });
}

function cancelTicketSale() {
  cancelButtonLoading.value = true;

  const fStore = getFirestore();
  const ticketRef = doc(
    fStore,
    "events/" + activeEvent.value.id + "/tickets",
    updateTicket.value.id
  );
  deleteDoc(ticketRef).then(() => {
    sellUpdateModalOff();
    cancelButtonLoading.value = false;
  }).catch((error) => {
    console.log(error)
    errorMessageUpdateModal.value = "Oops, there's an error, reach out to us to report it!"
    cancelButtonLoading.value = false;
  });
}

function sellTicket() {
  sellButtonLoading.value = true;

  if(!ticketFile.value.files[0] || !ticketPrice.value) {
    errorMessageSellModal.value = "Invalid form fields!";
    sellButtonLoading.value = false;
    return;
  }

  if(ticketPrice.value == "") {
    errorMessageSellModal.value = "Selling price must be a number!";
    sellButtonLoading.value = false;
    return;
  }

  // Uploading ticket to file storage
  const storage = getStorage();
  const ticketUid = uuidv4();
  const ticketRef = storageref(storage, ticketUid);

  const metadata = {
    contentType: "application/pdf",
    customMetadata: {
      seller: user.value.uid,
      price: ticketPrice.value,
      event: activeEvent.value.id,
    },
  };

  uploadBytes(ticketRef, ticketFile.value.files[0], metadata).then(() => {
    sellButtonLoading.value = false;
    sellModalOff();
    console.log("Uploaded the ticket!");
  });
}

function payForTicket() {
  buyButtonLoading.value = true;
  stripe.confirmPayment({
    //`Elements` instance that was used to create the Payment Element
    elements: stripeElements,
    confirmParams: {
      return_url: hostUrl + "?successBuy=true",
    },
  }).then(function(result) {
    if (result.error){
      errorMessageBuyModal.value = "Unable to complete purchase, report any bugs below!";
      buyButtonLoading.value = false;
    }
  });
}

const gotoTickets = (eventId) => {
  // Hooking Active event to firebase
  subscribeActiveEvent(eventId);
};

const gotoEvents = () => {
  unsubscribeActiveEvent();
  page.value = "events";
};

const buyModalOn = (ticket) => {
  if (!user.value) {
    // User not logged in
    infoMessage.value = "Login above to buy a ticket 😉";
    return;
  }

  paymentOptionsLoading.value = true;
  showBuyModal.value = true;
  buyTicket.value = ticket;

  // startStripeConnect();
  getStripeBuyerSecret(ticket).then((secret) => {
    const options = {
      clientSecret: secret,
      appearance: {
        variables: {
          fontFamily: "Fira Sans, system-ui, sans-serif",
        },
      },
    };

    // Set up Stripe.js and Elements to use in checkout form, passing the client secret obtained in step 2
    stripeElements = stripe.elements(options);

    // Create and mount the Payment Element
    const paymentElem = stripeElements.create("payment");
    paymentElem.mount("#payment-element");
    paymentOptionsLoading.value = false;
  });
};

const buyModalOff = () => {
  showBuyModal.value = false;
  buyTicket.value = null;
  errorMessageBuyModal.value = null;
};

const sellModalOn = () => {
  if (!user.value) {
    // User not logged in
    infoMessage.value = "Login above to sell a ticket 😉";
    return;
  }

  if (!userData.value.payable) {
    stripeConnectLoading.value = true;
    startStripeConnect();
    return;
  }

  showSellModal.value = true;
};

const sellModalOff = () => {
  showSellModal.value = false;
  errorMessageSellModal.value = null;
};

const sellUpdateModalOn = (ticket) => {
  if (!user.value) {
    // User not logged in
    errorMessage.value = "Login above to sell a ticket 😉";
    return;
  }

  updateTicket.value = ticket;
  showSellUpdateModal.value = true;
};

const sellUpdateModalOff = () => {
  showSellUpdateModal.value = false;
  updateTicket.value = null;
  errorMessageUpdateModal.value = null;
};

const isActiveEventUp = computed(() => {
  return activeEvent.value.price >= activeEvent.value.previousPrice
    ? true
    : false;
});

const myActiveTickets = computed(() => {
  return activeTickets.value.filter(
    (ticket) => ticket.sellerId == user.value.uid
  );
});

const notMyTickets = computed(() => {
  if(user.value != null) 
    return activeTickets.value.filter(
      (ticket) => ticket.sellerId != user.value.uid
    );
  else
    return activeTickets.value;
});

// Method to sign into firebase using passwordless
const signin = () => {
  signInButtonLoading.value = true;
  const auth = getAuth();
  const emailSanitized = email.value.trim();
  sendSignInLinkToEmail(auth, emailSanitized, actionCodeSettings)
    .then(() => {
      // Save the email locally so you don't need to ask the user for it again
      // if they open the link on the same device.
      window.localStorage.setItem("emailForSignIn", emailSanitized);
      signInButtonLoading.value = false;
      infoMessage.value = `A magic email is on the way. Please check ${emailSanitized} and click the link on the same
      device 🚀`;
    })
    .catch((error) => {
      console.log(error.code);
      signInButtonLoading.value = false;
      errorMessage.value = error.message;
    });
};

const signout = () => {
  const auth = getAuth();
  signOut(auth)
    .then(() => {
      // Sign-out successful.
    })
    .catch((error) => {
      console.log(error);
    });
};
</script>

<template>
  <nav class="flex flex-col sm:pb-6">
    <div class="flex flex-row items-center">
      <h1 class="text-3xl font-semibold">sellingx</h1>
      <template v-if="user">
        <div class="hidden sm:block ml-auto">
          Signed in as
          <span class="font-semibold">{{ user.email }}</span>
        </div>
        <button
          class="ml-auto sm:ml-4 bg-gray-900 color-white rounded text-white px-4 py-2 uppercase hover:bg-gray-600"
          @click="signout"
        >
          Logout
        </button>
      </template>
      <template v-else>
        <input
          type="text"
          placeholder="Email"
          class="sm:block hidden bg-gray-200 text-gray-800 ml-auto rounded p-2"
          v-model="email"
        />
        <button
          :disabled="signInButtonLoading"
          class="w-28 sm:flex flex-row justify-center items-center hidden bg-gray-900 color-white ml-2 rounded text-white px-4 py-2 uppercase hover:bg-gray-600"
          @click="signin"
        >
          <span v-if="!signInButtonLoading">Sign In</span>
          <LoadingSpinner v-if="signInButtonLoading" size="24" color="#fff" />
        </button>
      </template>
    </div>
    <!-- Signed In Mobile -->
    <div v-if="user" class="sm:hidden py-4">
      Signed in as
      <span class="font-semibold">{{ user.email }}</span>
    </div>
    <!-- Email Mobile -->
    <div v-else class="sm:hidden flex flex-row items-center py-4">
      <input
        type="text"
        placeholder="Email"
        class="bg-gray-200 text-gray-800 grow rounded p-2"
        v-model="email"
      />
      <button
        class="w-28 flex flex-row justify-center items-center bg-gray-900 color-white ml-2 rounded text-white px-4 py-2 uppercase hover:bg-gray-600"
        @click="signin"
      >
        <span v-if="!signInButtonLoading">Sign In</span>
        <LoadingSpinner v-if="signInButtonLoading" size="24" color="#fff" />
      </button>
    </div>
  </nav>

  <!-- Info Messages -->
  <div
    v-if="infoMessage != null"
    class="mb-4 bg-yellow-50 border-yellow-300 border rounded w-full py-2 px-4 text-yellow-600 text-sm"
  >
    {{ infoMessage }}
  </div>

  <!-- Error Messages -->
  <div
    v-if="errorMessage != null"
    class="mb-4 bg-red-50 border-red-300 border rounded w-full py-2 px-4 text-red-600 text-sm"
  >
    {{ errorMessage }}
  </div>
  
    <!-- Success Messages -->
  <div
    v-if="successMessage != null"
    class="mb-4 bg-green-50 border-green-300 border rounded w-full py-2 px-4 text-green-600 text-sm"
  >
    {{ successMessage }}
  </div>

  <!-- Divider between view and personal -->
  <div class="h-px w-full bg-gray-100 mb-4"></div>

  <!-- Events View -->
  <template v-if="page == 'events'">
    <EventListElement
      v-for="event in events"
      :name="event.name"
      :price="event.price.toFixed(2)"
      :date="event.readableDate"
      :isUp="event.price >= event.previousPrice"
      @click="gotoTickets(event.id)"
    />
  </template>

  <!-- Event Tickets View -->
  <template v-if="page == 'tickets'">
    <div class="flex flex-row w-full mb-4">
      <button
        class="bg-gray-100 color-white rounded px-4 py-2 uppercase hover:bg-gray-200"
        @click="gotoEvents"
      >
        ❮ back
      </button>
      <button
        class="flex justify-center items-center bg-gray-100 color-white rounded px-4 py-2 uppercase hover:bg-gray-200 ml-2"
        @click="sellModalOn"
      >
        <span v-if="!stripeConnectLoading">➕ sell</span>
        <LoadingSpinner v-if="stripeConnectLoading" size="24" color="#000" />
      </button>
    </div>

    <div class="flex flex-row w-full items-center">
      <h1 class="text-3xl font-semibold uppercase">{{ activeEvent.name }}</h1>
      <div
        class="flex flex-row w-24 justify-center px-4 py-2 ml-auto rounded"
        :class="{
          'bg-green-500': isActiveEventUp,
          'bg-red-500': !isActiveEventUp,
        }"
      >
        <span class="text-white">{{ isActiveEventUp ? "▲" : "▼" }}</span>
        <h2 class="ml-2 text-white">£{{ activeEvent.price.toFixed(2) }}</h2>
      </div>
    </div>
    <h2 class="ml-auto font-light text-gray-500 text-xl mb-4">
      {{ activeEvent.readableDate }}
    </h2>

    <!-- Selling Tickets -->
    <div
      v-if="user"
      class="bg-gray-100 rounded w-full font-semibold px-4 py-2 text-gray-500 font-normal"
    >
      {{ (myActiveTickets.length != 0) ? "My Selling Tickets" : "Sell a ticket using the button above 😜" }} 
    </div>
    <TicketListElement
      v-if="user"
      v-for="ticket in myActiveTickets"
      @click="sellUpdateModalOn(ticket)"
      :email="ticket.email"
      :price="ticket.price"
    />
    <!-- Divider between view and personal -->
    <div
      v-if="user"
      class="h-px w-full bg-gray-100 my-4"
    ></div>

    <TicketListElement
      v-for="ticket in notMyTickets"
      @click="buyModalOn(ticket)"
      :email="ticket.email"
      :price="ticket.price"
    />
  </template>

  <!-- Buy Modal -->
  <div
    v-if="showBuyModal"
    class="absolute inset-0 backdrop-blur-md bg-black/50 z-50 flex justify-center items-center"
  >
    <div
      class="flex flex-col w-full sm:w-10/12 md:w-8/12 lg:w-4/12 m-2 p-6 bg-white rounded"
    >
      <div class="flex flex-row w-full items-center">
        <h1 class="text-3xl font-semibold uppercase">{{ activeEvent.name }}</h1>
        <div
          class="flex flex-row w-24 justify-center px-4 py-2 ml-auto rounded"
          :class="{
            'bg-green-500': isActiveEventUp,
            'bg-red-500': !isActiveEventUp,
          }"
        >
          <span class="text-white">{{ isActiveEventUp ? "▲" : "▼" }}</span>
          <h2 class="ml-2 text-white">£{{ activeEvent.price.toFixed(2) }}</h2>
        </div>
      </div>
      <h2 class="font-light text-gray-500 text-xl mb-4">
        {{ activeEvent.readableDate }}
      </h2>
      <div class="flex flex-row w-full my-2">
        <div
          class="flex flex-row w-24 justify-center px-4 py-2 mr-2 rounded bg-gray-100"
        >
          <h2 class="text-gray-500 font-semibold">Seller</h2>
        </div>
        <div class="bg-gray-100 w-full flex flex-row px-4 py-2 rounded">
          <h1 class="text-gray-500">{{ buyTicket.email }}</h1>
        </div>
      </div>
      <div
        v-if="paymentOptionsLoading"
        class="bg-gray-100 w-full flex flex-row justify-center items-center px-4 py-2 rounded"
      >
        <LoadingSpinner size="24" color="#6b7280" class="mr-2" />
        <h1 class="text-gray-500">Loading payment options...</h1>
      </div>
      <div
        v-if="!paymentOptionsLoading"
        class="bg-gray-100 w-full flex flex-row px-4 py-2 mt-4 rounded"
      >
        <h1 class="text-gray-500">Payment Details</h1>
      </div>
      <div v-show="!paymentOptionsLoading" class="mt-4" id="payment-element">
        <!-- Elements will create form elements here -->
      </div>
      <div class="text-gray-500 text-xs mt-4">
        We charge a £0.30 transaction fee to pay for hosting :)
      </div>
      <div
        v-if="errorMessageBuyModal != null"
        class="mb-4 bg-red-50 border-red-300 border rounded w-full py-2 px-4 text-red-600 text-sm mt-2"
      >
        {{ errorMessageBuyModal }}
      </div>
      <div class="flex flex-row w-full mt-10">
        <button
          :disabled="buyButtonLoading || paymentOptionsLoading"
          class="flex justify-center items-center bg-green-500 color-white rounded text-white px-4 py-2 uppercase hover:bg-green-600 grow mr-2"
          @click="payForTicket"
        >
          <span v-if="!buyButtonLoading">Buy £{{ (buyTicket.price + 0.30).toFixed(2) }}</span>
          <LoadingSpinner size="24" color="#fff" v-if="buyButtonLoading" />
        </button>
        <button
          @click="buyModalOff"
          class="bg-gray-100 color-white rounded px-4 py-2 uppercase hover:bg-gray-200 grow ml-2"
        >
          Cancel
        </button>
      </div>
    </div>
  </div>

  <!-- Sell Modal -->
  <div
    v-if="showSellModal"
    class="absolute inset-0 backdrop-blur-md bg-black/50 z-50 flex justify-center items-center"
  >
    <div
      class="flex flex-col w-full sm:w-10/12 md:w-8/12 lg:w-4/12 m-2 p-6 bg-white rounded"
    >
      <div class="flex flex-row w-full items-center">
        <h1 class="text-3xl font-semibold uppercase">{{ activeEvent.name }}</h1>
        <div
          class="flex flex-row w-24 justify-center px-4 py-2 ml-auto rounded"
          :class="{
            'bg-green-500': isActiveEventUp,
            'bg-red-500': !isActiveEventUp,
          }"
        >
          <span class="text-white">{{ isActiveEventUp ? "▲" : "▼" }}</span>
          <h2 class="ml-2 text-white">£{{ activeEvent.price.toFixed(2) }}</h2>
        </div>
      </div>
      <h2 class="font-light text-gray-500 text-xl mb-4">
        {{ activeEvent.readableDate }}
      </h2>
      <div class="flex items-center justify-center w-full">
        <label
          class="flex flex-col w-full h-32 border-4 border-dashed hover:bg-gray-100 hover:border-gray-300"
        >
          <div class="flex flex-col items-center justify-center pt-7">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 512 512"
              class="w-12 h-12 text-gray-400 group-hover:text-gray-600"
            >
              <path
                d="M492.408,210.307C503.325,209.97,512,201.023,512,190.101v-77.338c0-11.164-9.051-20.216-20.216-20.216H20.216
                  C9.051,92.548,0,101.599,0,112.763v77.287c0,11.164,9.051,20.216,20.216,20.216c25.218,0,45.734,20.516,45.734,45.734
                  s-20.516,45.734-45.734,45.734C9.051,301.734,0,310.786,0,321.95v77.287c0,11.164,9.051,20.216,20.216,20.216h471.569
                  c11.164,0,20.216-9.051,20.216-20.216v-77.338c0-10.922-8.675-19.869-19.592-20.206c-24.836-0.767-44.29-20.837-44.29-45.693
                  S467.573,211.074,492.408,210.307z M162.745,379.02H40.431v-39.249c37.792-9.12,65.95-43.218,65.95-83.771
                  c0-40.552-28.158-74.652-65.95-83.772v-39.249h122.314V379.02z M432.049,316.025c10.997,11.315,24.617,19.251,39.521,23.217
                  v39.778H203.176V132.979h268.393v39.778c-14.904,3.966-28.524,11.903-39.521,23.217c-15.709,16.164-24.361,37.482-24.361,60.027
                  C407.686,278.544,416.339,299.861,432.049,316.025z"
              />
              <path
                d="M372.235,198.673H246.198c-11.164,0-20.216,9.051-20.216,20.216s9.051,20.216,20.216,20.216h126.037
                  c11.164,0,20.216-9.051,20.216-20.216S383.399,198.673,372.235,198.673z"
              />
              <path
                d="M372.235,272.895H246.198c-11.164,0-20.216,9.051-20.216,20.216s9.051,20.216,20.216,20.216h126.037
                  c11.164,0,20.216-9.051,20.216-20.216S383.399,272.895,372.235,272.895z"
              />
            </svg>
            <p
              class="pt-1 text-sm tracking-wider text-gray-400 group-hover:text-gray-600"
            >
              Upload your ticket
            </p>
          </div>
          <input
            type="file"
            ref="ticketFile"
            class="opacity-0"
            @change="onTicketUpload"
          />
        </label>
      </div>
      <div
        class="flex flex-row justify-center px-4 py-2 mt-4 rounded w-full bg-gray-100"
      >
        <h2 class="text-gray-500">
          {{
            selectedFileName == null
              ? "No ticket selected"
              : "Selected ticket: " + selectedFileName
          }}
        </h2>
      </div>
      <div class="flex flex-row w-full mt-2">
        <div
          class="flex flex-row justify-center px-4 py-2 mr-2 rounded bg-gray-100"
        >
          <h2 class="text-gray-500 font-semibold">£</h2>
        </div>
        <input
          type="number"
          placeholder="Selling Price"
          class="bg-gray-100 text-gray-800 w-full rounded p-2"
          v-model="ticketPrice"
        />
      </div>
      <div
        v-if="errorMessageSellModal != null"
        class="mb-4 bg-red-50 border-red-300 border rounded w-full py-2 px-4 text-red-600 text-sm mt-4"
      >
        {{ errorMessageSellModal }}
      </div>
      <div class="flex flex-row w-full mt-6">
        <button
          @click="sellTicket"
          :disabled="sellButtonLoading"
          class="flex justify-center items-center bg-red-500 color-white rounded text-white px-4 py-2 uppercase hover:bg-red-600 grow mr-2"
        >
          <span v-if="!sellButtonLoading">Sell</span>
          <LoadingSpinner v-if="sellButtonLoading" size="24" color="#fff" />
        </button>
        <button
          @click="sellModalOff"
          class="bg-gray-100 color-white rounded px-4 py-2 uppercase hover:bg-gray-200 grow ml-2"
        >
          Cancel
        </button>
      </div>
    </div>
  </div>

  <!-- Sell Update Modal -->
  <div
    v-if="showSellUpdateModal"
    class="absolute inset-0 backdrop-blur-md bg-black/50 z-50 flex justify-center items-center"
  >
    <div
      class="flex flex-col w-full sm:w-10/12 md:w-8/12 lg:w-4/12 m-2 p-6 bg-white rounded"
    >
      <div class="flex flex-row w-full items-center">
        <h1 class="text-3xl font-semibold uppercase">{{ activeEvent.name }}</h1>
        <div
          class="flex flex-row w-24 justify-center px-4 py-2 ml-auto rounded"
          :class="{
            'bg-green-500': isActiveEventUp,
            'bg-red-500': !isActiveEventUp,
          }"
        >
          <span class="text-white">{{ isActiveEventUp ? "▲" : "▼" }}</span>
          <h2 class="ml-2 text-white">£{{ activeEvent.price.toFixed(2) }}</h2>
        </div>
      </div>
      <h2 class="font-light text-gray-500 text-xl mb-4">
        {{ activeEvent.readableDate }}
      </h2>
      <div class="flex flex-row w-full mt-2">
        <div
          class="flex flex-row w-56 justify-center px-4 py-2 mr-2 rounded bg-gray-100"
        >
          <h2 class="text-gray-500 font-semibold">Current Price</h2>
        </div>
        <div class="bg-gray-100 w-full flex flex-row px-4 py-2 rounded">
          <h1 class="text-gray-500">£ {{ updateTicket.price }}</h1>
        </div>
      </div>
      <div class="flex flex-row w-full mt-2 mb-6">
        <div
          class="flex flex-row justify-center px-4 py-2 mr-2 rounded bg-gray-100"
        >
          <h2 class="text-gray-500 font-semibold">£</h2>
        </div>
        <input
          type="number"
          placeholder="Change Selling Price"
          class="bg-gray-100 text-gray-800 w-full rounded p-2"
          v-model="newTicketPrice"
        />
      </div>
      <div
        v-if="errorMessageUpdateModal != null"
        class="mb-4 bg-red-50 border-red-300 border rounded w-full py-2 px-4 text-red-600 text-sm"
      >
        {{ errorMessageUpdateModal }}
      </div>
      <div class="flex flex-col lg:flex-row w-full my-2">
        <button
          @click="updateTicketPrice"
          :disabled="updateButtonLoading"
          class="flex justify-center items-center bg-green-500 color-white rounded text-white px-4 py-2 uppercase hover:bg-green-600 grow my-1"
        >
          <span v-if="!updateButtonLoading">Update</span>
          <LoadingSpinner v-if="updateButtonLoading" size="24" color="#fff" />
        </button>
        <button
          @click="cancelTicketSale"
          :disabled="cancelButtonLoading"
          class="flex justify-center items-center bg-red-500 color-white rounded text-white px-4 py-2 uppercase hover:bg-red-600 grow lg:mx-2 my-1"
        >
          <span v-if="!cancelButtonLoading">Withdraw</span>
          <LoadingSpinner v-if="cancelButtonLoading" size="24" color="#fff" />
        </button>
        <button
          @click="sellUpdateModalOff"
          class="bg-gray-100 color-white rounded px-4 py-2 uppercase hover:bg-gray-200 grow my-1"
        >
          Cancel
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped></style>
