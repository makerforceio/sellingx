<script setup>
import { ref, onMounted } from 'vue'
import { getAuth, signOut, sendSignInLinkToEmail, isSignInWithEmailLink, signInWithEmailLink, onAuthStateChanged } from "firebase/auth";
import { getFirestore, collection, query, onSnapshot, doc } from "firebase/firestore"

import EventListElement from './EventListElement.vue'
import TicketListElement from './TicketListElement.vue'

// Firebase passwordless settings
const actionCodeSettings = {
  // URL you want to redirect back to. The domain (www.example.com) for this
  // URL must be in the authorized domains list in the Firebase Console.
  url: 'http://localhost:3000/',
  handleCodeInApp: true,
};

const email = ref('')
const page = ref('events');
const user = ref(null)
const isSigningIn = ref(false)
const events = ref(null)

// Ticket page stuff
const activeEvent = ref(null)
const activeTickets = ref(null)
let activeEventUnsub = null;
let activeTicketsUnsub = null;

onMounted(() => {
  const auth = getAuth()

  // Configure callback for the user login state
  onAuthStateChanged(auth, (userRaw) => {
    if(userRaw) {
      user.value = userRaw
    } else {
      user.value = null
    }
  })

  if (isSignInWithEmailLink(auth, window.location.href)) {
    console.log("hi")
    let email = window.localStorage.getItem('emailForSignIn');
    if (!email) {
      console.log("Please login with the same device");
    }
    signInWithEmailLink(auth, email, window.location.href)
    .then((result) => {
      window.localStorage.removeItem('emailForSignIn');
      user.value = result.user
    })
    .catch((error) => {
      console.log(error)
    });
  }

  subscribeEvents();
})

/******************* FIRESTORE CALLS **********************/
const subscribeEvents = () => {
  const fStore = getFirestore();
  const q = query(collection(fStore, "events"));
  const unsub = onSnapshot(q, (querySnapshot) => {
    const newEvents = []
    querySnapshot.forEach((doc) => {
      const newEvent = newEventFromDoc(doc.id, doc.data())
      newEvents.push(newEvent)
    })

    events.value = newEvents
  });

  return unsub
}

const subscribeActiveEvent = (eventId) => {
  const fStore = getFirestore()

  // Streaming Active Event
  const eventRef = doc(fStore, "events", eventId)
  activeEventUnsub = onSnapshot(eventRef, (doc) => {
      const newEvent = newEventFromDoc(doc.id, doc.data())
      activeEvent.value = newEvent
  })

  // Streaming Active Event Tickets
  const ticketsQuery = query(collection(fStore, "events/" + eventId + "/tickets"));
  activeTicketsUnsub = onSnapshot(ticketsQuery, (querySnapshot) => {
    const newTickets = []
    querySnapshot.forEach((doc) => {
      const newTicket = newTicketFromDoc(doc.id, doc.data())
      newTickets.push(newTicket)
      activeTickets.value = newTickets
    })
  });
}

const unsubscribeActiveEvent  = () => {
  activeEventUnsub()
  activeTicketsUnsub()

  activeEvent.value = null;
  activeTickets.value = null;

  activeEventUnsub = null;
  activeTicketsUnsub = null;
}

/******************* UTILITY FUNCTIONS **********************/
function newEventFromDoc(id, data) {
  const newEvent = {}

  newEvent.id = id
  newEvent.name = data.name
  newEvent.price = data.price
  newEvent.date = new Date(data.expiry.seconds * 1000)
  newEvent.readableDate = new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  }).format(newEvent.date)

  return newEvent
}

function newTicketFromDoc(id, data) {
  const newTicket = {}

  newTicket.id = id
  newTicket.email = data.email
  newTicket.cost = data.cost

  return newTicket
}

/**************** VUE FUNCTIONS **************************/

const gotoTickets = (eventId) => {
  // Hooking Active event to firebase
  subscribeActiveEvent(eventId)
  page.value = "tickets"
}

const gotoEvents = () => {
  unsubscribeActiveEvent();
  page.value = "events"
}

// Method to sign into firebase using passwordless
const signin = () => {
  const auth = getAuth()
  sendSignInLinkToEmail(auth, email.value, actionCodeSettings)
    .then(() => {
      // Save the email locally so you don't need to ask the user for it again
      // if they open the link on the same device.
      window.localStorage.setItem('emailForSignIn', email.value)
      email.value = ""
      isSigningIn.value = true
    })
  .catch((error) => {
    console.log(error.code)
    console.log(error.message)
  })
}

const signout = () => {
  const auth = getAuth();
  signOut(auth).then(() => {
    // Sign-out successful.
  }).catch((error) => {
    console.log(error)
  }); 
}
</script>

<template>
  <nav class="flex flex-row pb-6 items-center">
    <h1 class="text-3xl font-semibold">sellingx</h1>
    <template v-if="user">
      <div class="ml-auto">Signed in as <span class="font-semibold">{{ user.email }}</span></div>
      <button class="bg-gray-900 color-white rounded text-white px-4 py-2 uppercase hover:bg-gray-600 ml-4" @click="signout">Logout</button>
    </template>
    <template v-else>
      <input type="text" placeholder="Email" class="bg-gray-200 text-gray-800 ml-auto rounded p-2" v-model="email"/>
      <button class="bg-gray-900 color-white ml-2 rounded text-white px-4 py-2 uppercase hover:bg-gray-600" @click="signin">Sign In</button>
    </template>
  </nav>

  <!-- Status Messages -->
  <div v-if="isSigningIn" class="bg-yellow-50 border-yellow-300 border rounded w-full p-4 text-yellow-600 text-sm">
    A magic email is on the way. Please check <span class="font-semibold">{{ email }}</span> and open the email we've sent you on the same browser 🚀
  </div>

  <!-- Purchased Events -->
  <div class="bg-gray-100 rounded w-full px-4 py-2 text-gray-500 font-normal">
    Sell a ticket and it will show up here 😋
  </div>

  <!-- Divider between view and personal -->
  <div class="h-px w-full bg-gray-100 mt-4 mb-4"></div>

  <!-- Events View -->
  <template v-if="page == 'events'">
    <EventListElement v-for="event in events" 
    :name="event.name" 
    :price="event.price" 
    :date="event.readableDate" 
    :isUp="true" 
    @click="gotoTickets(event.id)"/>
  </template>

  <!-- Event Tickets View -->
  <template v-if="page == 'tickets'">

    <div class="flex flex-row w-full mb-4">
      <button class="bg-gray-100 color-white rounded px-4 py-2 uppercase hover:bg-gray-200" @click="gotoEvents">❮ back</button>
      <button class="bg-gray-100 color-white rounded px-4 py-2 uppercase hover:bg-gray-200 ml-2">➕ new</button>
    </div>

    <div class="flex flex-row w-full items-center">
      <h1 class="text-3xl font-semibold uppercase">{{ activeEvent.name }}</h1>
      <div class="flex flex-row w-24 justify-center px-4 py-2 ml-auto rounded bg-green-500"> 
        <span class="text-white">▼</span>
        <h2 class="ml-2 text-white">£{{ activeEvent.price }}</h2>
      </div>
    </div>
    <h2 class="ml-auto font-light text-gray-500 text-xl mb-4">{{ activeEvent.readableDate }}</h2>

    <TicketListElement v-for="ticket in activeTickets" :email="ticket.email" :cost="ticket.cost" />
  </template>

</template>

<style scoped>
</style>
