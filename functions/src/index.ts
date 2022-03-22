import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import {DocumentSnapshot} from "firebase-admin/firestore";

import Stripe from "stripe";
import * as sendgrid from "@sendgrid/mail";
import * as mime from "mime-types";

admin.initializeApp();

const db = admin.firestore();
const bucket = admin.storage().bucket();
sendgrid.setApiKey(process.env.SENDGRID_API_KEY || "");
const stripe = new Stripe(process.env.STRIPE_API_KEY || "", {
  apiVersion: "2020-08-27",
});

const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET || "";
const webhookConnectSecret = process.env.STRIPE_CONNECT_WEBHOOK_SECRET || "";

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
    type: "standard",
    country: "GB",
    email: context.auth.token.email,
    business_type: "individual",
    business_profile: {
      product_description: "tickets",
      mcc: "7299",
      url: "https://sellingx.io",
    },
    settings: {
      payments: {
        statement_descriptor: "SellingX",
      },
      payouts: {
        statement_descriptor: "SellingX",
      },
    },
    // capabilities: {
    //   // card_payments: {requested: true},
    //   transfers: {requested: true},
    // },
  });

  await db.doc(`stripes/${context.auth.uid}`)
      .set({
        stripe_id: account.id,
      });

  await db.doc(`aids/${account.id}`)
      .set({
        uid: context.auth.uid,
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
        "invalid-argument",
        "'event' and 'ticket' must not be undefined");
  }

  const doc = await db.doc(`events/${data.event}/tickets/${data.ticket}`)
      .get()
      .then((doc) => doc.data());

  if (doc == undefined) {
    throw new functions.https.HttpsError(
        "invalid-argument",
        "'event' and 'ticket' must exist");
  }

  if (doc.price == undefined) {
    throw new functions.https.HttpsError(
        "invalid-argument",
        "'ticket' must have a price");
  }

  if (doc.seller_id == undefined) {
    throw new functions.https.HttpsError(
        "invalid-argument",
        "'ticket' must have a seller_id");
  }

  const stripeDoc = await db.doc(`stripes/${doc.seller_id}`)
      .get()
      .then((d) => d.data());

  if (stripeDoc == undefined) {
    throw new functions.https.HttpsError(
        "invalid-argument",
        "seller not found");
  }

  if (stripeDoc.stripe_id == undefined) {
    throw new functions.https.HttpsError(
        "invalid-argument",
        "seller does not have a recorded Stripe account");
  }

  // const markup = doc.price * 100 * 0.014 + 20 + 30;
  const markup = 80;
  const paymentIntent = await stripe.paymentIntents.create({
    amount: doc.price * 100 + markup,
    currency: "gbp",
    payment_method_types: [
      "card",
    ],
    application_fee_amount: markup,
    transfer_data: {
      destination: stripeDoc.stripe_id,
    },
  });

  await db.doc(`transactions/${paymentIntent.id}`)
      .set({
        buyer: context.auth.uid,
        event: data.event,
        ticket: data.ticket,
      });

  return {
    secret: paymentIntent.client_secret,
  };
});

export const webhook = functions.https.onRequest(async (request, response) => {
  let event;
  try {
    event = stripe.webhooks.constructEvent(
        request.rawBody,
        request.headers["stripe-signature"] as string,
        webhookSecret,
    );
  } catch (err) {
    functions.logger.warn(err, {structuredData: true});
    response.status(500).send("500 Internal Server Error");
    return;
  }

  if (event.type == "payment_intent.succeeded") {
    const pi = event.data.object as Stripe.PaymentIntent;
    const doc = await db.doc(`transactions/${pi.id}`)
        .get()
        .then((d) => d.data());

    if (doc == undefined) {
      response.status(404).send("404 Transaction Not Found");
      return;
    }

    const buyer = await admin.auth().getUser(doc.buyer);
    const ticketEvent = await db.doc(`events/${doc.event}`)
        .get()
        .then((d) => d.data());

    if (ticketEvent == undefined) {
      response.status(404).send("404 Event Not Found");
      return;
    }

    const [file] = await bucket.file(doc.ticket)
        .get();


    const [metadata] = await file.getMetadata();
    const [data] = await file.download();

    const buyerMsg = {
      to: buyer.email,
      from: process.env.SENDGRID_SENDER_EMAIL || "sellingx@octalorca.me",
      subject: `Your ${ticketEvent.name || ""} ticket!`,
      text: "Thank you! Your ticket is attached!",
      attachments: [
        {
          content: data.toString("base64"),
          filename: `ticket.${mime.extension(metadata.contentType)}`,
          type: metadata.contentType,
          disposition: "attachment",
        },
      ],
    };

    await sendgrid.send(buyerMsg);

    const seller = await db.doc(`events/${doc.event}/tickets/${doc.ticket}`)
        .get()
        .then((d) => d.data())
        .then((d) => {
          if (d != undefined) {
            return admin.auth().getUser(d.seller_id);
          } else {
            return undefined;
          }
        });

    if (seller != undefined) {
      // eslint-disable-next-line
      const soldAmount = `£${((pi.amount - (pi.application_fee_amount || 0)) / 100).toFixed(2)}`;
      const sellerMsg = {
        to: seller.email,
        from: process.env.SENDGRID_SENDER_EMAIL || "sellingx@octalorca.me",
        // eslint-disable-next-line
        subject: `Your ${ticketEvent.name || ""} ticket has been sold for ${soldAmount}!`,
        // eslint-disable-next-line
        text: `Congratulations! Your ${ticketEvent.name || ""} ticket has been sold for ${soldAmount}! Sign in and check your Stripe Dashboard to withdraw your money.`,
      };

      await sendgrid.send(sellerMsg);
    }


    await db.doc(`events/${doc.event}/tickets/${doc.ticket}`)
        .set({
          sold: true,
        }, {
          merge: true,
        });

    await db.doc(`transactions/${pi.id}`)
        .delete();
  } else if (event.type == "payment_intent.payment_failed") {
    // const id = (event.data.object as Stripe.PaymentIntent).id;
    // await db.doc(`transactions/${id}`).delete();
  } else if (event.type == "account.updated") {
    const account = event.data.object as Stripe.Account;
    const uid = await db.doc(`aids/${account.id}`)
        .get()
        .then((doc) => doc.data())
        .then((data) => data ? data.uid : undefined);

    if (uid == undefined) {
      response.status(404).send("404 User Not Found");
      return;
    }

    const payable = account.capabilities ?
        account.capabilities.transfers == "active" : false;

    await db.doc(`users/${uid}`)
        .set({
          payable,
        }, {
          merge: true,
        });
  } else {
    functions.logger.info(`Unsupported webhook event ${event.type} tried`);
  }

  response.status(200).send("200 OK");
});

export const webhookConnect = functions.https
    .onRequest(async (request, response) => {
      let event;
      try {
        event = stripe.webhooks.constructEvent(
            request.rawBody,
            request.headers["stripe-signature"] as string,
            webhookConnectSecret,
        );
      } catch (err) {
        functions.logger.warn(err, {structuredData: true});
        response.status(500).send("500 Internal Server Error");
        return;
      }

      if (event.type == "account.updated") {
        const account = event.data.object as Stripe.Account;
        const uid = await db.doc(`aids/${account.id}`)
            .get()
            .then((doc) => doc.data())
            .then((data) => data ? data.uid : undefined);

        if (uid == undefined) {
          response.status(404).send("404 User Not Found");
          return;
        }

        const payable = account.capabilities ?
            account.capabilities.transfers == "active" : false;

        await db.doc(`users/${uid}`)
            .set({
              payable,
            }, {
              merge: true,
            });
      } else {
        functions.logger.info(`Unsupported webhook event ${event.type} tried`);
      }

      response.status(200).send("200 OK");
    });
