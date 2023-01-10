const functions = require("firebase-functions");
const admin = require("firebase-admin");
const { Timestamp } = require("firebase-admin/firestore");
admin.initializeApp(functions.config().firebase);
const { Logging } = require("@google-cloud/logging");
const logging = new Logging({
  projectId: process.env.GCLOUD_PROJECT,
});
const querystring = require("querystring");
const request = require("request-promise-native");
const bodyParser = require("body-parser");
const cors = require("cors");
const express = require("express");
const session = require("express-session");
const { Firestore } = require("@google-cloud/firestore");
const { FirestoreStore } = require("@google-cloud/connect-firestore");
const stripeModule = require("stripe");

// Credentials - move these to environment variables so that you can commit this code to version control without exposing secrets
// see the readme for an example command to run to setup your secrets
//const kStripeProdSecretKey = "";
//const kStripeTestSecretKey = "";

//get secrets with these types of variables so that you can commit this code to version control
const env = functions.config();
const STRIPE_TEST_SK = env.stripe.test_sk;
const STRIPE_PROD_SK = env.stripe.prod_sk;
const STRIPE_TEST_CLIENTID = env.stripe.test_client_id;
const STRIPE_PROD_CLIENTID = env.stripe.prod_client_id;
const STRIPE_TOKEN_URI = env.stripe.token_uri;
const STRIPE_STANDARD_AUTHORIZE_URI = env.stripe.standard_authorize_uri;
const STRIPE_EXPRESS_AUTHORIZE_URI = env.stripe.express_authorize_uri;

//these use dynamic links in firebase in order to handle both web and app uri's but you can use anything you want here.
const REDIRECT_SUCCESSFUL_URI =
  "https://YOUR-PAGE-ID-HERE.page.link/successful-stripe-authorize";
const REDIRECT_FAIL_URI =
  "https://YOUR-PAGE-ID-HERE.page.link/failed-stripe-authorize";
const YOUR_CLOUD_FUNCTION_URL =
  "https://us-central1-YOUR-PROJECT-ID-HERE.cloudfunctions.net";

const secretKey = (isProd) => (isProd ? STRIPE_PROD_SK : STRIPE_TEST_SK);
const clientId = (isProd) =>
  isProd ? STRIPE_PROD_CLIENTID : STRIPE_TEST_CLIENTID;
const authorizeUri = (isExpress) =>
  isExpress ? STRIPE_EXPRESS_AUTHORIZE_URI : STRIPE_STANDARD_AUTHORIZE_URI;

const app = express();
app.use(cors({ origin: true }));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));
// app.use(cookieParser(secretKey(false)));

app.use(
  session({
    store: new FirestoreStore({
      dataset: new Firestore(),
      kind: "express-sessions",
    }),
    signed: true,
    secret: STRIPE_PROD_SK,
    resave: true,
    saveUninitialized: true,
  })
);

/**
 *
 */
exports.initStripePayment = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    return "Unauthenticated calls are not allowed.";
  }
  return await initPayment(data, true);
});

/**
 *
 */
exports.initStripeTestPayment = functions.https.onCall(
  async (data, context) => {
    if (!context.auth) {
      return "Unauthenticated calls are not allowed.";
    }
    return await initPayment(data, false);
  }
);

//this replaces the stripepaymentapi function from the article @ https://medium.com/@brinorw24/using-stripe-connect-with-flutterflow-1929346c6dc3
//this method is better for flutterflow because it uses the existing stripe payment sheets built into flutterflow and is more secure since it wont be
//called if the user is not authenticated.
async function initPayment(data, isProd) {
  try {
    const stripe = new stripeModule.Stripe(secretKey(isProd), {
      apiVersion: "2020-08-27",
    });

    const customers = await stripe.customers.list({
      email: data.email,
      limit: 1,
    });
    var customer = customers.data[0];
    if (!customer) {
      customer = await stripe.customers.create({
        email: data.email,
        ...(data.name && { name: data.name }),
      });
    }

    const ephemeralKey = await stripe.ephemeralKeys.create(
      { customer: customer.id },
      { apiVersion: "2020-08-27" }
    );

    //get user from email so that you can get the stripe account id needed to split the payment
    const userSnapShot = await db
      .collection("users")
      .where("email", "==", data.email)
      .get();

    let paymentObject = {
      amount: data.amount,
      currency: data.currency,
      customer: customer.id,
      ...(data.description && { description: data.description }),
    };

    if (userSnapShot.size > 0 && userSnapShot.data().stripe_account_id !== "") {
      let splitAmount = 1000; //do your calculations to get the amount to send to the user here
      paymentObject.transfer_data = {
        //add the transfer_data to the object with the amount and account to handle the split
        amount: splitAmount,
        destination: userSnapShot.data().stripe_account_id,
      };
    }

    const paymentIntent = await stripe.paymentIntents.create(paymentObject);

    return {
      paymentId: paymentIntent.id,
      paymentIntent: paymentIntent.client_secret,
      ephemeralKey: ephemeralKey.secret,
      customer: customer.id,
      success: true,
    };
  } catch (error) {
    await reportError(error);
    return { success: false, error: userFacingMessage(error) };
  }
}

app.get("/authorize", async (req, res) => {
  // Saves session ID
  req.session.state = Math.random().toString(36).slice(2);
  req.session.save();
  req.session.uid = req.query.userId;
  req.session.isprod = req.query.isprod || false;

  // Define the mandatory Stripe parameters
  let parameters = {
    client_id: clientId(req.query.isprod),
    state: req.session.state,
  };

  // Pass params that were gathered from your app, any params passed will be auto filled in the remote Stripe setup
  parameters = Object.assign(parameters, {
    // Redirect to this URL after Stripe account setup flow is complete
    redirect_uri:
      "https://us-central1-yourfirebaseapp-id.cloudfunctions.net/stripeapi/token",
    "stripe_user[email]": req.query.email || undefined,
  });

  // Logging for your reference
  console.log("Starting Express flow:", parameters);

  // Redirect to Stripe Account Setup
  res.redirect(
    authorizeUri(req.query.isexpress) + "?" + querystring.stringify(parameters)
  );
});

app.get("/token", async (req, res) => {
  if (req.session.state !== req.query.state) {
    console.log(
      `Cannot find the request session state ${req.session.uid}, ${req.session.state} and this is what was sent ${req.query.state}`
    );
    // On session state error, deeplink back to your app
    return res.redirect("https://yourapp.page.link/redirectPage");
  }

  try {
    // Launch express account creation with auth code from the setup
    const expressAuthorized = await request.post({
      uri: STRIPE_TOKEN_URI,
      form: {
        grant_type: "authorization_code",
        client_id: clientId(req.session.isprod),
        client_secret: secretKey(req.session.isprod),
        code: req.query.code,
      },
      json: true,
    });

    // Catch for if express account creation failed
    if (expressAuthorized.error) {
      throw expressAuthorized.error;
    }

    // Additional logging to help with debugging
    console.log(
      `New stripe user id ${expressAuthorized.stripe_user_id} and the request body \n${req.query}`
    );

    // Set stripe account id and setup status in Firebase
    if (req.session.uid !== undefined && req.session.uid !== null) {
      await db.doc(`/users/${req.session.uid}`).update({
        stripe_account_id: expressAuthorized.stripe_user_id,
        stripe_setup_complete: true,
      });
    }
    // On successful setup, deeplink back to your app
    res.redirect(REDIRECT_SUCCESSFUL_URI);
  } catch (err) {
    // Catch for if the onboarding process was unable to complete
    console.log(`The Stripe onboarding process has not succeeded. ${err}`);
  }
});

exports.stripeapi = functions.https.onRequest(app);

/**
 * To keep on top of errors, we should raise a verbose error report with Stackdriver rather
 * than simply relying on functions.logger.error. This will calculate users affected + send you email
 * alerts, if you've opted into receiving them.
 */

// [START reporterror]

function reportError(err) {
  // This is the name of the StackDriver log stream that will receive the log
  // entry. This name can be any valid log stream name, but must contain "err"
  // in order for the error to be picked up by StackDriver Error Reporting.
  const logName = "errors";
  const log = logging.log(logName);

  // https://cloud.google.com/logging/docs/api/ref_v2beta1/rest/v2beta1/MonitoredResource
  const metadata = {
    resource: {
      type: "cloud_function",
      labels: { function_name: process.env.FUNCTION_NAME },
    },
  };

  // https://cloud.google.com/error-reporting/reference/rest/v1beta1/ErrorEvent
  const errorEvent = {
    message: err.stack,
    serviceContext: {
      service: process.env.FUNCTION_NAME,
      resourceType: "cloud_function",
    },
  };

  // Write the error log entry
  return new Promise((resolve, reject) => {
    log.write(log.entry(metadata, errorEvent), (error) => {
      if (error) {
        return reject(error);
      }
      return resolve();
    });
  });
}

// [END reporterror]

/**
 * Sanitize the error message for the user.
 */
function userFacingMessage(error) {
  return error.type
    ? error.message
    : "An error occurred, developers have been alerted";
}
