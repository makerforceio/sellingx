import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import {DocumentSnapshot} from "firebase-admin/firestore";

import * as crypto from "crypto";
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
const encryptSecret = process.env.ENCRYPT_SECRET || "8f87c82907ad638becba3a28a68cbd69";

const encrypt = (text:string, secret = encryptSecret) => {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(secret), iv);
  const encrypted = cipher.update(text);

  return {
    iv: iv.toString('hex'),
    encrypted: Buffer.concat([encrypted, cipher.final()]).toString('hex'),
  };
};

const decrypt = (block: {iv: string, encrypted: string}, secret = encryptSecret) => {
  const iv = Buffer.from(block.iv, 'hex');
  const encrypted = Buffer.from(block.encrypted, 'hex');

  const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(secret), iv);
  const deencrypted = decipher.update(encrypted);

  return Buffer.concat([deencrypted, decipher.final()]).toString();
};

// // Start writing Firebase Functions
// // https://firebase.google.com/docs/functions/typescript

export const helloWorld = functions.https.onRequest((request, response) => {
  functions.logger.info("Hello logs!", {structuredData: true});
  response.send("Hello from Firebase!");
});

/* Updates rolling average of ticket price */
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

// Automatically populate price fields of new events
export const onEventUpload = functions.firestore
    .document("events/{event}")
    .onWrite(async (
        change: functions.Change<DocumentSnapshot>,
        context: functions.EventContext
    ) => {
      const changeData = change.after.data();
      if (changeData == undefined) {
        return;
      }

      await db.doc(`events/${context.params.event}`)
        .set({
           average_price: changeData.average_price || 0,
           previous_price: changeData.previous_price || 0,
        }, {
          merge: true,
        });
    });

/* New ticket, populates DB with defaults */
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

/* Handle user signup */
export const signup = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError(
        "failed-precondition",
        "The function must be called while authenticated");
  }

  // Set up non-payable user if sort_code/account-number are not provided
  if (data.sort_code != undefined && data.account_number != undefined) {
    if (!/(?:[0-9]{2}-?){3}/.test(data.sort_code)) {
      throw new functions.https.HttpsError(
          "invalid-argument",
          "invalid 'sort_code'");
    }

    // Account numbers are too much of a pain to lazy-validate
    if (!/[0-9]{0,8}/.test(data.account_number)) {
      throw new functions.https.HttpsError(
          "invalid-argument",
          "invalid 'account_number'");
    }

    // Set user
    await db.doc(`users/${context.auth.uid}`)
      .set({
        sort_code: encrypt(data.sort_code),
        account_number: encrypt(data.account_number),
        payable: true,
      });
  } else {
    await db.doc(`users/${context.auth.uid}`)
      .set({
        payable: false,
      });
  }

  return {
    result: 'success',
  };
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

  const markup = doc.price * 100 * 0.014 + 20 + 50;
  // const markup = 80;
  const paymentIntent = await stripe.paymentIntents.create({
    amount: doc.price * 100 + markup,
    currency: "gbp",
    payment_method_types: [
      "card",
    ],
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

// Stripe webhook
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

    const ticket = await db.doc(`events/${doc.event}/tickets/${doc.ticket}`)
        .get()
        .then((d) => d.data());

    if (ticket == undefined) {
      response.status(404).send("404 Ticket Not Found");
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
      const soldAmount = `£${ticket.price.toFixed(2)}`;
      const sellerMsg = {
        to: seller.email,
        from: process.env.SENDGRID_SENDER_EMAIL || "sellingx@octalorca.me",
        // eslint-disable-next-line
        subject: `Your ${ticketEvent.name || ""} ticket has been sold for ${soldAmount}!`,
        // eslint-disable-next-line
        text: `Congratulations! Your ${ticketEvent.name || ""} ticket has been sold for ${soldAmount}! We'll be sending you your money at the end of the week.`,
      };

      await sendgrid.send(sellerMsg);

      const sellerData = await db.doc(`users/${seller.uid}`)
        .get()
        .then(d => d.data());

      const seller_sort_code = sellerData ? decrypt(sellerData.sort_code) : 'not found';
      const seller_account_number = sellerData ? decrypt(sellerData.account_number) : 'not found';

      const opsMsg = {
        to: 'support@sellingx.io',
        from: process.env.SENDGRID_SENDER_EMAIL || "sellingx@octalorca.me",
        subject: `${ticketEvent.name || ""} ticket has been sold to ${seller.email} for ${soldAmount}!`,
        text: `
          <p>${ticketEvent.name || ""} ticket has been sold to ${seller.email} for ${soldAmount}!</p>
          <table>
            <tr>
              <td>Sort code</td>
              <td>${seller_sort_code}</td>
            </tr>
            <tr>
              <td>Account number</td>
              <td>${seller_account_number}</td>
            </tr>
          </table>
        `,
      };

      await sendgrid.send(opsMsg);
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
    const id = (event.data.object as Stripe.PaymentIntent).id;
    await db.doc(`failed_transactions/${id}`)
      .set(event.data.object);
    await db.doc(`transactions/${id}`).delete();
  } else {
    functions.logger.info(`Unsupported webhook event ${event.type} tried`);
  }

  response.status(200).send("200 OK");
});
