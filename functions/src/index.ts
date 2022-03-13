import * as functions from "firebase-functions";
// const admin = require('firebase-admin');
import * as admin from "firebase-admin";
import {DocumentSnapshot} from "firebase-admin/firestore";

admin.initializeApp();
const db = admin.firestore();

// // Start writing Firebase Functions
// // https://firebase.google.com/docs/functions/typescript

export const helloWorld = functions.https.onRequest((request, response) => {
  functions.logger.info("Hello logs!", {structuredData: true});
  response.send("Hello from Firebase!");
});

const onTicketChange = async (
    change: functions.Change<DocumentSnapshot>,
    context: functions.EventContext
) => {
  const doc = await db.doc(`events/${context.params.event}`)
      .get()
      .then((doc) => doc.data());
  const previousAverage = doc!.average_price || 0;
  const n = doc!.n || [];

  const changeData = change.after.data();
  if (changeData == undefined || changeData!.price == null) {
    return;
  }

  if (n.length >= 5) {
    n.splice(0, 1);
  }

  n.push(changeData!.price);

  // eslint max lengths are annoying
  const totalPrice = n.reduce((acc:number, val:number) => acc + val, 0);
  const averagePrice = totalPrice / n.length;
  await db.doc(`events/${context.params.event}`)
      .set({
        n,
        average_price: averagePrice,
        previous_average: previousAverage,
      }, {
        merge: true,
      });
};

// // events/{event}/tickets/{ticket}
export const updateRollingAverageOnWrite = functions.firestore
    .document("events/{event}/tickets/{ticket}")
    .onWrite(onTicketChange);

export const updateRollingAverageOnUpdate = functions.firestore
    .document("events/{event}/tickets/{ticket}")
    .onUpdate(onTicketChange);
