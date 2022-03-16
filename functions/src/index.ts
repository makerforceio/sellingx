import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import {DocumentSnapshot} from "firebase-admin/firestore";

import Stripe from "stripe";

admin.initializeApp();

const db = admin.firestore();
const stripe = new Stripe(process.env.STRIPE_API_KEY || "", {
  apiVersion: "2020-08-27",
});

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

  if (doc == undefined) {
    return;
  }

  const previousAverage = doc.average_price || 0;
  const n = doc.n || [];

  const changeData = change.after.data();
  if (changeData == undefined || changeData.price == null) {
    return;
  }

  if (n.length >= 5) {
    n.splice(0, 1);
  }

  n.push(changeData.price);

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

export const onTicketUpload = functions.storage
    .object()
    .onFinalize(async (object) => {
      if (!object.metadata) {
        return;
      }

      if (object.metadata.event == "") {
        return;
      }

      if (object.metadata.seller == "") {
        return;
      }

      const doc = await db.doc(`events/${object.metadata.event}`)
          .get();

      if (!doc.exists) {
        return;
      }

      const user = await admin.auth().getUser(object.metadata.seller);
      await db.doc(`events/${object.metadata.event}/tickets/${object.name}`)
          .set({
            seller: user.email,
            seller_id: user.uid,
            price: +object.metadata.price || 0,
            sold: false,
          });
    });

export const signup = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError(
        "failed-precondition",
        "The function must be called while authenticated");
  }

  const account = await stripe.accounts.create({
    type: "express",
    country: "GB",
    email: context.auth.token.email,
    business_type: "individual",
    business_profile: {
      product_description: "tickets",
      mcc: "7299",
    },
    capabilities: {
      card_payments: {requested: true},
      transfers: {requested: true},
    },
  });

  await db.doc(`stripes/${context.auth.uid}`)
      .set({
        stripe_id: account.id,
      });

  const accountLink = await stripe.accountLinks.create({
    account: account.id,
    refresh_url: `${process.env.SIGNUP_REFRESH_URL}?id=${account.id}`,
    return_url: process.env.SIGNUP_RETURN_URL,
    type: "account_onboarding",
  });

  return {
    url: accountLink.url,
  };
});

export const signupRefresh = functions.https
    .onRequest(async (request, response) => {
      if (!request.query.id) {
        response.status(400).send("404 ID Not Found");
        return;
      }

      const id = request.query.id as string;
      const accountLink = await stripe.accountLinks.create({
        account: id,
        refresh_url: `${process.env.SIGNUP_REFRESH_URL}?id=${id}`,
        return_url: process.env.SIGNUP_RETURN_URL,
        type: "account_onboarding",
      });

      response.status(302).redirect(accountLink.url);
    });

export const buyTicket = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError(
        "failed-precondition",
        "The function must be called while authenticated");
  }

  if (data.event == undefined || data.ticket == undefined) {
    throw new functions.https.HttpsError(
        "failed-precondition",
        "'event' and 'ticket' must not be undefined");
  }

  const doc = await db.doc(`events/${data.event}/tickets/${data.ticket}`)
      .get()
      .then((doc) => doc.data());

  if (doc == undefined) {
    throw new functions.https.HttpsError(
        "failed-precondition",
        "'event' and 'ticket' must exist");
  }

  if (doc.price == undefined) {
    throw new functions.https.HttpsError(
        "failed-precondition",
        "'ticket' must have a price");
  }

  if (doc.seller_id == undefined) {
    throw new functions.https.HttpsError(
        "failed-precondition",
        "'ticket' must have a seller_id");
  }

  const stripeDoc = await db.doc(`stripes/${doc.seller_id}`)
      .get()
      .then((d) => d.data());

  if (stripeDoc == undefined) {
    throw new functions.https.HttpsError(
        "failed-precondition",
        "seller not found");
  }

  if (stripeDoc.stripe_id == undefined) {
    throw new functions.https.HttpsError(
        "failed-precondition",
        "seller does not have a recorded Stripe account");
  }

  const paymentIntent = await stripe.paymentIntents.create({
    amount: doc.price * 100 + 30,
    currency: "gbp",
    payment_method_types: [
      "card",
    ],
    application_fee_amount: 30,
    transfer_data: {
      destination: stripeDoc.stripe_id,
    },
  });

  return {
    secret: paymentIntent.client_secret,
  };
});
