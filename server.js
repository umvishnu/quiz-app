const path = require("path");
const crypto = require("crypto");
const express = require("express");
const cors = require("cors");
const session = require("express-session");
const nodemailer = require("nodemailer");
const Razorpay = require("razorpay");
const { google } = require("googleapis");
const dotenv = require("dotenv");
const store = require("./db");

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT || 3000);
const OTP_LENGTH = 6;
const OTP_TTL_MINUTES = Number(process.env.OTP_TTL_MINUTES || 10);
const PAYMENT_PROVIDER = (process.env.PAYMENT_PROVIDER || "demo").toLowerCase();
const PRICE_INR = Number(process.env.NOTES_PRICE_INR || 999);
const NOTES_TITLE = process.env.NOTES_TITLE || "CA Final IDT Notes";
const DRIVE_LINK = process.env.GOOGLE_DRIVE_LINK || "";
const DRIVE_FOLDER_ID = process.env.GOOGLE_DRIVE_FOLDER_ID || "";
const RAZORPAY_WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET || "";
const DELIVERY_RETRY_INTERVAL_MS = Number(process.env.DELIVERY_RETRY_INTERVAL_MS || 300000);
const APPS_SCRIPT_WEB_APP_URL =
  process.env.APPS_SCRIPT_WEB_APP_URL ||
  "https://script.google.com/macros/s/AKfycbxb62i-E-dUdhJQQlYFOIQ3MdG5zYpCaaXfLsL4fDzZMlo4RBCw12IITQnQmQBWvfwW/exec";
const GOOGLE_SHEET_ID = process.env.GOOGLE_SHEET_ID || process.env.GOOGLE_SPREADSHEET_ID || "";
const GOOGLE_CONFIG_SHEET_NAME = process.env.GOOGLE_CONFIG_SHEET_NAME || "Config";
const CONFIG_CACHE_TTL_MS = Number(process.env.CONFIG_CACHE_TTL_MS || 60000);

const DEFAULT_CONFIG = {
  appName: process.env.APP_NAME || "Study Board",
  notesTitle: process.env.NOTES_TITLE || "CA FINAL IDT NOTES",
  notesDescription:
    process.env.NOTES_DESCRIPTION ||
    "Register with your Gmail, verify OTP, then pay to receive the Drive access link.",
  sideCardLabel: process.env.SIDE_CARD_LABEL || "Release",
  sideCardTitle: process.env.SIDE_CARD_TITLE || "2026 Edition",
  sideCardDescription:
    process.env.SIDE_CARD_DESCRIPTION ||
    "Structured for fast purchase, verified delivery, and restricted folder access.",
  notesPriceInr: Number(process.env.NOTES_PRICE_INR || 999),
  otpTtlMinutes: Number(process.env.OTP_TTL_MINUTES || 10),
  driveLink: process.env.GOOGLE_DRIVE_LINK || "",
  driveFolderId: process.env.GOOGLE_DRIVE_FOLDER_ID || "",
};

let runtimeConfigCache = {
  loadedAt: 0,
  value: DEFAULT_CONFIG,
};

const hasMailConfig =
  Boolean(process.env.SMTP_HOST) &&
  Boolean(process.env.SMTP_PORT) &&
  Boolean(process.env.SMTP_USER) &&
  Boolean(process.env.SMTP_PASS);

const hasRazorpayConfig =
  Boolean(process.env.RAZORPAY_KEY_ID) && Boolean(process.env.RAZORPAY_KEY_SECRET);

const transporter = hasMailConfig
  ? nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT),
      secure: String(process.env.SMTP_SECURE || "false") === "true",
      family: 4,
      connectionTimeout: 30000,
      greetingTimeout: 30000,
      socketTimeout: 30000,
      tls: {
        servername: process.env.SMTP_HOST,
      },
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    })
  : null;

const razorpay =
  hasRazorpayConfig && PAYMENT_PROVIDER === "razorpay"
    ? new Razorpay({
        key_id: process.env.RAZORPAY_KEY_ID,
        key_secret: process.env.RAZORPAY_KEY_SECRET,
      })
  : null;

app.use(cors());
app.use("/api/razorpay/webhook", express.raw({ type: "application/json" }));
app.use(express.json());
app.use(
  session({
    secret: process.env.SESSION_SECRET || "change-me-in-env",
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: false,
      maxAge: 1000 * 60 * 60 * 8,
    },
  })
);
app.use(express.static(path.join(__dirname, "public")));

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizePhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (digits.length === 10) {
    return digits;
  }
  if (digits.length === 12 && digits.startsWith("91")) {
    return digits.slice(2);
  }
  return digits;
}

function isValidGmail(email) {
  return /^[a-zA-Z0-9._%+-]+@gmail\.com$/.test(email);
}

function isValidPhone(phone) {
  return /^[6-9]\d{9}$/.test(phone);
}

function generateOtp() {
  const min = 10 ** (OTP_LENGTH - 1);
  const max = 10 ** OTP_LENGTH - 1;
  return String(Math.floor(Math.random() * (max - min + 1)) + min);
}

async function sendMail({ to, subject, html, text }) {
  if (!transporter) {
    throw new Error("SMTP is not configured");
  }

  await transporter.sendMail({
    from: process.env.MAIL_FROM || process.env.SMTP_USER,
    to,
    subject,
    html,
    text,
  });
}

async function verifyMailTransport() {
  if (APPS_SCRIPT_WEB_APP_URL) {
    console.log(`OTP delivery delegated to Apps Script: ${APPS_SCRIPT_WEB_APP_URL}`);
    return;
  }

  if (!transporter) {
    console.warn("SMTP is not configured. OTP email sending is disabled.");
    return;
  }

  try {
    await transporter.verify();
    console.log(`SMTP ready for OTP emails from ${process.env.MAIL_FROM || process.env.SMTP_USER}`);
  } catch (error) {
    console.error(`SMTP verification failed: ${error.message}`);
  }
}

async function callAppsScript(action, payload = {}) {
  if (!APPS_SCRIPT_WEB_APP_URL) {
    throw new Error("Apps Script OTP backend is not configured.");
  }

  const response = await fetch(APPS_SCRIPT_WEB_APP_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      action,
      ...payload,
    }),
  });

  const data = await response.json();
  if (!response.ok || data.ok === false) {
    throw new Error(data.error || `Apps Script ${action} failed.`);
  }

  return data;
}

async function recoverAppsScriptPendingPayment(req) {
  if (!APPS_SCRIPT_WEB_APP_URL || !req.session?.appsScriptToken || !req.session?.pendingOrderId || !razorpay) {
    return null;
  }

  try {
    const paymentsResponse = await razorpay.orders.fetchPayments(req.session.pendingOrderId);
    const payments = Array.isArray(paymentsResponse?.items) ? paymentsResponse.items : [];
    const paidPayment = payments.find((payment) => ["captured", "authorized"].includes(String(payment.status || "")));

    if (!paidPayment?.id) {
      return null;
    }

    const signature = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(`${req.session.pendingOrderId}|${paidPayment.id}`)
      .digest("hex");

    const data = await callAppsScript("verifyPayment", {
      token: req.session.appsScriptToken,
      razorpay_order_id: req.session.pendingOrderId,
      razorpay_payment_id: paidPayment.id,
      razorpay_signature: signature,
    });

    req.session.pendingOrderId = "";

    return {
      emailSent: Boolean(data.deliveryEmailSent),
      message: data.message || "Payment recovered successfully.",
      lastError: "",
    };
  } catch (error) {
    console.error(`Pending Apps Script payment recovery failed: ${error.message}`);
    return {
      emailSent: false,
      message: "Payment is recorded, but delivery is still pending. It will retry automatically when you return.",
      lastError: error.message,
    };
  }
}

async function readAppsScriptConfig(token = "") {
  if (!APPS_SCRIPT_WEB_APP_URL) {
    return {};
  }

  const url = new URL(APPS_SCRIPT_WEB_APP_URL);
  url.searchParams.set("action", "config");
  if (token) {
    url.searchParams.set("token", token);
  }

  const response = await fetch(url.toString(), {
    method: "GET",
  });

  const data = await response.json();
  if (!response.ok || data.ok === false) {
    throw new Error(data.error || "Apps Script config fetch failed.");
  }

  return data;
}

function mapSheetConfigRows(rows = []) {
  const values = {};
  for (const row of rows) {
    const key = String(row[0] || "").trim();
    if (!key) continue;
    values[key] = row[1];
  }
  return values;
}

async function readGoogleSheetConfig() {
  if (!GOOGLE_SHEET_ID || !process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE) {
    return {};
  }

  const auth = new google.auth.GoogleAuth({
    keyFile: process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE,
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });
  const sheets = google.sheets({ version: "v4", auth });
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: GOOGLE_SHEET_ID,
    range: `${GOOGLE_CONFIG_SHEET_NAME}!A:B`,
  });

  const rows = response.data.values || [];
  if (rows.length <= 1) {
    return {};
  }

  return mapSheetConfigRows(rows.slice(1));
}

async function getRuntimeConfig() {
  if (Date.now() - runtimeConfigCache.loadedAt < CONFIG_CACHE_TTL_MS) {
    return runtimeConfigCache.value;
  }

  let appsScriptConfig = {};
  try {
    appsScriptConfig = await readAppsScriptConfig();
  } catch (error) {
    console.error(`Apps Script config read failed: ${error.message}`);
  }

  let sheetConfig = {};
  try {
    sheetConfig = await readGoogleSheetConfig();
  } catch (error) {
    console.error(`Google Sheet config read failed: ${error.message}`);
  }

  const normalizedAppsScriptConfig = Object.keys(appsScriptConfig).length
    ? {
        APP_NAME: appsScriptConfig.appName,
        NOTES_TITLE: appsScriptConfig.notesTitle,
        NOTES_DESCRIPTION: appsScriptConfig.notesDescription,
        SIDE_CARD_LABEL: appsScriptConfig.sideCardLabel,
        SIDE_CARD_TITLE: appsScriptConfig.sideCardTitle,
        SIDE_CARD_DESCRIPTION: appsScriptConfig.sideCardDescription,
        NOTES_PRICE_INR: appsScriptConfig.notesPriceInr,
        OTP_TTL_MINUTES: appsScriptConfig.otpTtlMinutes,
        GOOGLE_DRIVE_LINK: appsScriptConfig.driveLink,
        GOOGLE_DRIVE_FOLDER_ID: appsScriptConfig.driveFolderId,
      }
    : {};

  const configValues = {
    ...sheetConfig,
    ...normalizedAppsScriptConfig,
  };

  const mergedConfig = {
    appName: String(configValues.APP_NAME || DEFAULT_CONFIG.appName),
    notesTitle: String(configValues.NOTES_TITLE || DEFAULT_CONFIG.notesTitle),
    notesDescription: String(configValues.NOTES_DESCRIPTION || DEFAULT_CONFIG.notesDescription),
    sideCardLabel: String(configValues.SIDE_CARD_LABEL || DEFAULT_CONFIG.sideCardLabel),
    sideCardTitle: String(configValues.SIDE_CARD_TITLE || DEFAULT_CONFIG.sideCardTitle),
    sideCardDescription: String(configValues.SIDE_CARD_DESCRIPTION || DEFAULT_CONFIG.sideCardDescription),
    notesPriceInr: Number(configValues.NOTES_PRICE_INR || DEFAULT_CONFIG.notesPriceInr),
    otpTtlMinutes: Number(configValues.OTP_TTL_MINUTES || DEFAULT_CONFIG.otpTtlMinutes),
    driveLink: String(configValues.GOOGLE_DRIVE_LINK || DEFAULT_CONFIG.driveLink),
    driveFolderId: String(configValues.GOOGLE_DRIVE_FOLDER_ID || DEFAULT_CONFIG.driveFolderId),
  };

  runtimeConfigCache = {
    loadedAt: Date.now(),
    value: mergedConfig,
  };
  return mergedConfig;
}

async function grantGoogleDriveAccess(email) {
  const runtimeConfig = await getRuntimeConfig();

  if (!runtimeConfig.driveFolderId || !process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE) {
    return { attempted: false, status: "not_configured" };
  }

  try {
    const auth = new google.auth.GoogleAuth({
      keyFile: process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE,
      scopes: ["https://www.googleapis.com/auth/drive"],
    });
    const drive = google.drive({ version: "v3", auth });

    await drive.permissions.create({
      fileId: runtimeConfig.driveFolderId,
      sendNotificationEmail: false,
      requestBody: {
        type: "user",
        role: "reader",
        emailAddress: email,
      },
    });

    return { attempted: true, status: "granted" };
  } catch (error) {
    return {
      attempted: true,
      status: `failed: ${error.message}`,
    };
  }
}

function getDeliveryView(delivery) {
  if (!delivery) return null;
  return {
    id: delivery.id,
    email: delivery.email,
    paymentId: delivery.payment_id || delivery.paymentId || "",
    orderId: delivery.order_id || delivery.orderId || "",
    driveLink: delivery.drive_link || delivery.driveLink || "",
    driveAccessStatus: delivery.drive_access_status || delivery.driveAccessStatus || "",
    emailSent: Boolean(
      Object.prototype.hasOwnProperty.call(delivery, "email_sent") ? delivery.email_sent : delivery.emailSent
    ),
    emailSentAt: delivery.email_sent_at || delivery.emailSentAt || "",
    lastError: delivery.last_error || delivery.lastError || "",
  };
}

async function sendDeliveryEmail({ user, driveAccessStatus, driveLink }) {
  const runtimeConfig = await getRuntimeConfig();
  const safeUserName = user?.name || user?.email || "Student";
  await sendMail({
    to: user.email,
    subject: `${runtimeConfig.notesTitle} access link`,
    text: `Your payment is successful. Access your notes here: ${driveLink}`,
    html: `
      <div style="font-family: Arial, sans-serif; padding: 24px; color: #0f172a;">
        <h2 style="margin: 0 0 12px;">Payment Successful</h2>
        <p style="margin: 0 0 12px;">Hi ${safeUserName},</p>
        <p style="margin: 0 0 20px;">Your payment for <strong>${runtimeConfig.notesTitle}</strong> is successful.</p>
        <a href="${driveLink}" style="display: inline-block; background: #2563eb; color: #ffffff; text-decoration: none; padding: 12px 20px; border-radius: 10px; font-weight: 700;">Open Google Drive Folder</a>
        <p style="margin: 20px 0 0;">Drive permission status: ${driveAccessStatus}</p>
      </div>
    `,
  });
}

async function finalizeDelivery({ orderId, paymentId, paymentStatus = "captured", source = "browser" }) {
  const runtimeConfig = await getRuntimeConfig();
  let order = store.findOrderByOrderId(orderId);
  if (!order) {
    throw new Error("Order record not found.");
  }

  const user =
    (order.user_id && store.findUserById(order.user_id)) ||
    (order.user_email && store.findUserByEmail(order.user_email));

  if (!user) {
    throw new Error("User for this order was not found.");
  }

  if (!store.findPurchaseByPaymentId(paymentId)) {
    store.createPurchase({
      user_id: user.id,
      email: user.email,
      payment_id: paymentId,
      order_id: orderId,
      amount: order.amount || runtimeConfig.notesPriceInr * 100,
      currency: order.currency || "INR",
      drive_link: runtimeConfig.driveLink,
      drive_permission_status: "",
      source,
    });
  }

  let delivery =
    store.findDeliveryByPaymentId(paymentId) ||
    store.findDeliveryByOrderId(orderId) ||
    store.createDelivery({
      user_id: user.id,
      name: user.name || user.email || "Student",
      email: user.email,
      payment_id: paymentId,
      order_id: orderId,
      amount: order.amount || runtimeConfig.notesPriceInr * 100,
      currency: order.currency || "INR",
      drive_link: runtimeConfig.driveLink,
      source,
    });

  const orderPatch = {
    payment_id: paymentId,
    payment_status: paymentStatus,
    webhook_received: source === "webhook" ? 1 : order.webhook_received || 0,
    status: "paid",
    delivery_id: delivery.id,
  };

  if (delivery.email_sent) {
    store.updateOrder(orderId, {
      ...orderPatch,
      delivery_processed: 1,
    });
    return {
      delivery,
      drivePermissionStatus: delivery.drive_access_status,
      emailSent: true,
      alreadyDelivered: true,
    };
  }

  const drivePermission = await grantGoogleDriveAccess(user.email);
  delivery = store.updateDelivery(delivery.id, {
    drive_access_status: drivePermission.status,
    last_error: "",
  });

  try {
    await sendDeliveryEmail({
      user,
      driveAccessStatus: drivePermission.status,
      driveLink: runtimeConfig.driveLink,
    });

    delivery = store.updateDelivery(delivery.id, {
      email_sent: 1,
      email_sent_at: new Date().toISOString(),
      last_error: "",
      drive_access_status: drivePermission.status,
    });
    store.updateOrder(orderId, {
      ...orderPatch,
      delivery_processed: 1,
    });

    return {
      delivery,
      drivePermissionStatus: drivePermission.status,
      emailSent: true,
      alreadyDelivered: false,
    };
  } catch (error) {
    delivery = store.updateDelivery(delivery.id, {
      email_sent: 0,
      last_error: error.message,
      drive_access_status: drivePermission.status,
    });
    store.updateOrder(orderId, {
      ...orderPatch,
      delivery_processed: 0,
    });
    return {
      delivery,
      drivePermissionStatus: drivePermission.status,
      emailSent: false,
      alreadyDelivered: false,
      error: error.message,
    };
  }
}

async function retryPendingDeliveries() {
  const pendingDeliveries = store.findPendingDeliveries();

  for (const delivery of pendingDeliveries) {
    const user =
      (delivery.user_id && store.findUserById(delivery.user_id)) ||
      (delivery.email && store.findUserByEmail(delivery.email));

    if (!user || !delivery.order_id || !delivery.payment_id) {
      continue;
    }

    try {
      await finalizeDelivery({
        orderId: delivery.order_id,
        paymentId: delivery.payment_id,
        paymentStatus: "captured",
        source: "retry",
      });
    } catch (error) {
      store.updateDelivery(delivery.id, {
        last_error: error.message,
      });
    }
  }
}

function requireAuth(req, res, next) {
  if (!req.session.userId) {
    return res.status(401).json({ error: "Please verify OTP and login first." });
  }
  return next();
}

app.get("/api/config", async (req, res) => {
  const runtimeConfig = await getRuntimeConfig();
  const user = req.session.userId ? store.findUserById(req.session.userId) : null;
  const paymentLiveReady = PAYMENT_PROVIDER === "razorpay" && hasRazorpayConfig;
  let latestDelivery = user ? store.findLatestDeliveryByEmail(user.email) : null;
  let deliveryRecovery = null;

  if (APPS_SCRIPT_WEB_APP_URL && req.session.appsScriptToken) {
    deliveryRecovery = await recoverAppsScriptPendingPayment(req);
    try {
      const appsScriptConfig = await readAppsScriptConfig(req.session.appsScriptToken);
      if (appsScriptConfig.latestDelivery) {
        latestDelivery = appsScriptConfig.latestDelivery;
      }
      if (appsScriptConfig.deliveryRecovery) {
        deliveryRecovery = appsScriptConfig.deliveryRecovery;
      }
    } catch (error) {
      console.error(`Apps Script delivery recovery read failed: ${error.message}`);
    }
  }

  res.json({
    appName: runtimeConfig.appName,
    notesTitle: runtimeConfig.notesTitle,
    notesDescription: runtimeConfig.notesDescription,
    sideCardLabel: runtimeConfig.sideCardLabel,
    sideCardTitle: runtimeConfig.sideCardTitle,
    sideCardDescription: runtimeConfig.sideCardDescription,
    notesPriceInr: runtimeConfig.notesPriceInr,
    paymentProvider: PAYMENT_PROVIDER,
    paymentLiveReady,
    razorpayKeyId: process.env.RAZORPAY_KEY_ID || "",
    user,
    latestDelivery: getDeliveryView(latestDelivery),
    deliveryRecovery,
  });
});

app.post("/api/auth/request-otp", async (req, res) => {
  const runtimeConfig = await getRuntimeConfig();
  const name = String(req.body.name || "").trim();
  const email = normalizeEmail(req.body.email);
  const phone = normalizePhone(req.body.phone);

  if (!name || name.length < 2) {
    return res.status(400).json({ error: "Please enter a valid name." });
  }

  if (!isValidGmail(email)) {
    return res.status(400).json({ error: "Please enter a valid Gmail address." });
  }

  if (!isValidPhone(phone)) {
    return res.status(400).json({ error: "Please enter a valid 10-digit phone number." });
  }

  if (!APPS_SCRIPT_WEB_APP_URL && !transporter) {
    return res.status(500).json({
      error: "OTP delivery is not configured. Add Apps Script URL or email settings first.",
    });
  }

  store.upsertUser(name, email, phone);

  if (APPS_SCRIPT_WEB_APP_URL) {
    try {
      const data = await callAppsScript("requestOtp", {
        name,
        email,
      });
      return res.json({ ok: true, message: data.message || "OTP sent to your Gmail." });
    } catch (error) {
      return res.status(500).json({ error: `Unable to send OTP email: ${error.message}` });
    }
  }

  const otp = generateOtp();
  const expiresAt = new Date(Date.now() + runtimeConfig.otpTtlMinutes * 60 * 1000).toISOString();

  store.invalidateOtps(email);
  store.createOtp(email, otp, expiresAt);

  try {
    await sendMail({
      to: email,
      subject: `${runtimeConfig.appName} OTP Verification`,
      text: `Your OTP is ${otp}. It will expire in ${runtimeConfig.otpTtlMinutes} minutes.`,
      html: `
        <div style="font-family: Arial, sans-serif; padding: 24px; color: #0f172a;">
          <h2 style="margin: 0 0 12px;">OTP Verification</h2>
          <p style="margin: 0 0 12px;">Use this OTP to login to the notes portal:</p>
          <div style="font-size: 32px; font-weight: 700; letter-spacing: 8px; margin: 20px 0;">${otp}</div>
          <p style="margin: 0;">This OTP will expire in ${runtimeConfig.otpTtlMinutes} minutes.</p>
        </div>
      `,
    });

    res.json({ ok: true, message: "OTP sent to your Gmail." });
  } catch (error) {
    res.status(500).json({ error: `Unable to send OTP email: ${error.message}` });
  }
});

app.post("/api/auth/verify-otp", async (req, res) => {
  const email = normalizeEmail(req.body.email);
  const otp = String(req.body.otp || "").trim();

  if (APPS_SCRIPT_WEB_APP_URL) {
    try {
      const data = await callAppsScript("verifyOtp", {
        email,
        otp,
      });

      const user = store.markUserVerified(email);
      req.session.userId = user.id;
      req.session.userEmail = user.email;
      req.session.appsScriptToken = data.token || "";
      return res.json({ ok: true, user });
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
  }

  const otpRow = store.findLatestActiveOtp(email);

  if (!otpRow) {
    return res.status(400).json({ error: "No active OTP found. Please request a new OTP." });
  }

  if (new Date(otpRow.expires_at).getTime() < Date.now()) {
    return res.status(400).json({ error: "OTP expired. Please request a new OTP." });
  }

  if (otpRow.otp !== otp) {
    return res.status(400).json({ error: "Incorrect OTP." });
  }

  store.markOtpUsed(otpRow.id);
  const user = store.markUserVerified(email);

  req.session.userId = user.id;
  req.session.userEmail = user.email;

  res.json({ ok: true, user });
});

app.post("/api/auth/logout", (req, res) => {
  req.session.destroy(() => {
    res.json({ ok: true });
  });
});

app.post("/api/payment/create-order", requireAuth, async (req, res) => {
  const runtimeConfig = await getRuntimeConfig();
  if (PAYMENT_PROVIDER === "razorpay") {
    if (!razorpay) {
      return res.status(500).json({ error: "Razorpay is not configured in .env." });
    }

    try {
      const currentUser = store.findUserById(req.session.userId);
      const order = await razorpay.orders.create({
        amount: runtimeConfig.notesPriceInr * 100,
        currency: "INR",
        receipt: `notes_${req.session.userId}_${Date.now()}`,
        notes: {
          product: runtimeConfig.notesTitle,
          userId: String(req.session.userId),
          email: req.session.userEmail || "",
          phone: currentUser?.phone || "",
          appsScriptToken: req.session.appsScriptToken || "",
        },
      });
      store.createOrder({
        user_id: currentUser?.id || req.session.userId,
        user_email: currentUser?.email || "",
        order_id: order.id,
        receipt: order.receipt,
        amount: order.amount,
        currency: order.currency,
      });
      req.session.pendingOrderId = order.id;

      return res.json({
        provider: "razorpay",
        orderId: order.id,
        amount: order.amount,
        currency: order.currency,
      });
    } catch (error) {
      return res.status(500).json({ error: `Unable to create Razorpay order: ${error.message}` });
    }
  }

  return res.json({
    provider: "demo",
    orderId: `demo_${Date.now()}`,
    amount: runtimeConfig.notesPriceInr * 100,
    currency: "INR",
  });
});

app.post("/api/payment/verify", requireAuth, async (req, res) => {
  const user = store.findUserById(req.session.userId);
  const runtimeConfig = await getRuntimeConfig();

  if (!user) {
    return res.status(404).json({ error: "User not found." });
  }

  if (APPS_SCRIPT_WEB_APP_URL && req.session.appsScriptToken) {
    try {
      const data = await callAppsScript("verifyPayment", {
        token: req.session.appsScriptToken,
        ...req.body,
      });
      req.session.pendingOrderId = "";
      return res.json({
        ok: true,
        driveLink: data.driveLink || runtimeConfig.driveLink,
        drivePermissionStatus: data.driveAccessStatus || "",
        deliveryEmailSent: Boolean(data.deliveryEmailSent),
        message: data.message || "Payment verified.",
      });
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  }

  let paymentId = "";
  let orderId = "";

  if (PAYMENT_PROVIDER === "razorpay") {
    const {
      razorpay_order_id: razorpayOrderId,
      razorpay_payment_id: razorpayPaymentId,
      razorpay_signature: razorpaySignature,
    } = req.body;

    const expectedSignature = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(`${razorpayOrderId}|${razorpayPaymentId}`)
      .digest("hex");

    if (expectedSignature !== razorpaySignature) {
      return res.status(400).json({ error: "Payment verification failed." });
    }

    paymentId = razorpayPaymentId;
    orderId = razorpayOrderId;
  } else {
    paymentId = `demo_payment_${Date.now()}`;
    orderId = String(req.body.orderId || `demo_order_${Date.now()}`);
    if (!store.findOrderByOrderId(orderId)) {
      store.createOrder({
        user_id: user.id,
        user_email: user.email,
        order_id: orderId,
        receipt: orderId,
        amount: runtimeConfig.notesPriceInr * 100,
        currency: "INR",
      });
    }
  }

  const existingPurchase = store.findPurchaseByPaymentId(paymentId);

  if (existingPurchase) {
    const delivery = store.findDeliveryByPaymentId(paymentId) || store.findDeliveryByOrderId(orderId);
    return res.json({
      ok: true,
      driveLink: (delivery && delivery.drive_link) || existingPurchase.drive_link,
      deliveryEmailSent: delivery ? Boolean(delivery.email_sent) : true,
      message: delivery?.email_sent
        ? "Payment was already verified."
        : "Payment is already verified. Delivery email is still pending retry.",
    });
  }

  const deliveryResult = await finalizeDelivery({
    orderId,
    paymentId,
    paymentStatus: "captured",
    source: "browser",
  });

  res.json({
    ok: true,
    driveLink: deliveryResult.delivery.drive_link || runtimeConfig.driveLink,
    drivePermissionStatus: deliveryResult.drivePermissionStatus,
    deliveryEmailSent: deliveryResult.emailSent,
    message: deliveryResult.emailSent
      ? "Payment verified and the access email has been sent."
      : "Payment verified. Delivery email is pending retry.",
  });
});

app.post("/api/razorpay/webhook", async (req, res) => {
  if (PAYMENT_PROVIDER !== "razorpay" || !RAZORPAY_WEBHOOK_SECRET) {
    return res.status(400).json({ error: "Razorpay webhook is not configured." });
  }

  const signature = req.get("X-Razorpay-Signature");
  const body = req.body;
  const rawBody = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body || {}));
  const expectedSignature = crypto
    .createHmac("sha256", RAZORPAY_WEBHOOK_SECRET)
    .update(rawBody)
    .digest("hex");

  if (!signature || signature !== expectedSignature) {
    return res.status(400).json({ error: "Invalid webhook signature." });
  }

  const event = JSON.parse(rawBody.toString("utf8"));
  const paymentEntity = event?.payload?.payment?.entity;

  if (!paymentEntity) {
    return res.json({ ok: true, ignored: true });
  }

  if (!["payment.captured", "order.paid"].includes(event.event)) {
    return res.json({ ok: true, ignored: true, event: event.event });
  }

  const orderId = String(paymentEntity.order_id || "");
  const paymentId = String(paymentEntity.id || "");
  const appsScriptToken = String(paymentEntity.notes?.appsScriptToken || "");

  if (!orderId || !paymentId) {
    return res.status(400).json({ error: "Missing order or payment id." });
  }

  if (APPS_SCRIPT_WEB_APP_URL && appsScriptToken) {
    try {
      const browserStyleSignature = crypto
        .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
        .update(`${orderId}|${paymentId}`)
        .digest("hex");

      const result = await callAppsScript("verifyPayment", {
        token: appsScriptToken,
        razorpay_order_id: orderId,
        razorpay_payment_id: paymentId,
        razorpay_signature: browserStyleSignature,
      });

      return res.json({
        ok: true,
        emailSent: Boolean(result.deliveryEmailSent),
        delegatedTo: "apps-script",
      });
    } catch (error) {
      return res.status(500).json({ error: `Apps Script webhook delivery failed: ${error.message}` });
    }
  }

  let order = store.findOrderByOrderId(orderId);
  if (!order) {
    const runtimeConfig = await getRuntimeConfig();
    const userEmail =
      normalizeEmail(paymentEntity.email) ||
      normalizeEmail(paymentEntity.notes?.email) ||
      normalizeEmail(paymentEntity.notes?.userEmail);
    const user =
      (paymentEntity.notes?.userId && store.findUserById(Number(paymentEntity.notes.userId))) ||
      (userEmail && store.findUserByEmail(userEmail));

    if (!user) {
      return res.status(404).json({ error: "Order user could not be resolved." });
    }

    order = store.createOrder({
      user_id: user.id,
      user_email: user.email,
      order_id: orderId,
      receipt: paymentEntity.description || orderId,
      amount: Number(paymentEntity.amount || runtimeConfig.notesPriceInr * 100),
      currency: paymentEntity.currency || "INR",
      webhook_received: 1,
    });
  } else {
    store.updateOrder(orderId, { webhook_received: 1 });
  }

  try {
    const result = await finalizeDelivery({
      orderId,
      paymentId,
      paymentStatus: String(paymentEntity.status || "captured"),
      source: "webhook",
    });
    return res.json({
      ok: true,
      emailSent: result.emailSent,
      alreadyDelivered: result.alreadyDelivered,
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.use((req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  verifyMailTransport();
  setInterval(() => {
    retryPendingDeliveries().catch((error) => {
      console.error(`Pending delivery retry failed: ${error.message}`);
    });
  }, DELIVERY_RETRY_INTERVAL_MS);
});
