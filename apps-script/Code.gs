const SHEET_NAMES = {
  users: "Users",
  otps: "Otps",
  sessions: "Sessions",
  purchases: "Purchases",
  deliveries: "Deliveries",
  config: "Config",
};
const OTP_CACHE_PREFIX = "otp:";
const SESSION_CACHE_PREFIX = "session:";

function doGet(e) {
  const action = getParam_(e, "action");

  if (action === "config") {
    const sessionUser = getSessionUser_(getParam_(e, "token"));
    const deliveryState = sessionUser ? recoverLatestDelivery_(sessionUser) : { delivery: null, recovery: null };

    return jsonOutput_({
      ok: true,
      appName: getConfigValue_("APP_NAME", "CA Notes Hub"),
      notesTitle: getConfigValue_("NOTES_TITLE", "CA FINAL IDT NOTES"),
      notesDescription: getConfigValue_(
        "NOTES_DESCRIPTION",
        "Register with Gmail, verify OTP, pay, and receive your Google Drive link by email."
      ),
      sideCardLabel: getConfigValue_("SIDE_CARD_LABEL", "Release"),
      sideCardTitle: getConfigValue_("SIDE_CARD_TITLE", "2026 Edition"),
      sideCardDescription: getConfigValue_(
        "SIDE_CARD_DESCRIPTION",
        "Structured for fast purchase, verified delivery, and restricted folder access."
      ),
      notesPriceInr: Number(getConfigValue_("NOTES_PRICE_INR", "100")),
      paymentProvider: "razorpay",
      paymentLiveReady: Boolean(getConfigValue_("RAZORPAY_KEY_ID", "")),
      razorpayKeyId: getConfigValue_("RAZORPAY_KEY_ID", ""),
      user: sessionUser,
      latestDelivery: deliveryState.delivery,
      deliveryRecovery: deliveryState.recovery,
    });
  }

  return jsonOutput_({ ok: false, error: "Unknown action." });
}

function doPost(e) {
  try {
    const payload = e && e.postData && e.postData.contents ? JSON.parse(e.postData.contents) : {};
    const action = payload.action;

    switch (action) {
      case "requestOtp":
        return requestOtp_(payload);
      case "verifyOtp":
        return verifyOtp_(payload);
      case "createOrder":
        return createOrder_(payload);
      case "verifyPayment":
        return verifyPayment_(payload);
      case "logout":
        return logout_(payload);
      default:
        return jsonOutput_({ ok: false, error: "Unknown action." });
    }
  } catch (error) {
    return jsonOutput_({ ok: false, error: error.message });
  }
}

function requestOtp_(payload) {
  const name = String(payload.name || "").trim();
  const email = normalizeEmail_(payload.email);

  if (name.length < 2) {
    throw new Error("Please enter a valid name.");
  }

  if (!/^[a-zA-Z0-9._%+-]+@gmail\.com$/.test(email)) {
    throw new Error("Please enter a valid Gmail address.");
  }

  const userSheet = getSheet_(SHEET_NAMES.users, [
    "id",
    "name",
    "email",
    "verified",
    "createdAt",
    "updatedAt",
  ]);
  const otpSheet = getSheet_(SHEET_NAMES.otps, [
    "id",
    "email",
    "otp",
    "expiresAt",
    "used",
    "createdAt",
  ]);

  const userRow = findRowByValue_(userSheet, 3, email);
  const now = new Date();

  if (userRow) {
    userSheet.getRange(userRow.rowIndex, 2, 1, 5).setValues([
      [name, email, userRow.values[3], userRow.values[4], now.toISOString()],
    ]);
  } else {
    userSheet.appendRow([
      createId_("USR"),
      name,
      email,
      false,
      now.toISOString(),
      now.toISOString(),
    ]);
  }

  invalidateOtps_(otpSheet, email);

  const otp = createOtp_();
  const otpTtlMinutes = Number(getConfigValue_("OTP_TTL_MINUTES", "10"));
  const expiry = new Date(now.getTime() + otpTtlMinutes * 60000);

  otpSheet.appendRow([
    createId_("OTP"),
    email,
    otp,
    expiry.toISOString(),
    false,
    now.toISOString(),
  ]);
  CacheService.getScriptCache().put(
    `${OTP_CACHE_PREFIX}${email}`,
    JSON.stringify({
      otp: otp,
      email: email,
      expiresAt: expiry.toISOString(),
    }),
    Math.min(otpTtlMinutes * 60, 21600)
  );

  MailApp.sendEmail({
    to: email,
    subject: `${getConfigValue_("APP_NAME", "CA Notes Hub")} OTP Verification`,
    htmlBody: `
      <div style="font-family:Arial,sans-serif;padding:24px;color:#0f172a;">
        <h2 style="margin:0 0 12px;">OTP Verification</h2>
        <p style="margin:0 0 12px;">Use this OTP to log in:</p>
        <div style="font-size:32px;font-weight:700;letter-spacing:8px;margin:20px 0;">${otp}</div>
        <p style="margin:0;">This OTP will expire in ${getConfigValue_("OTP_TTL_MINUTES", "10")} minutes.</p>
      </div>
    `,
  });

  return jsonOutput_({ ok: true, message: "OTP sent to your Gmail." });
}

function verifyOtp_(payload) {
  const email = normalizeEmail_(payload.email);
  const otp = String(payload.otp || "").trim();
  const userSheet = getSheet_(SHEET_NAMES.users, []);
  const sessionSheet = getSheet_(SHEET_NAMES.sessions, [
    "token",
    "userId",
    "email",
    "expiresAt",
    "createdAt",
    "active",
  ]);
  const cachedOtpRaw = CacheService.getScriptCache().get(`${OTP_CACHE_PREFIX}${email}`);

  if (!cachedOtpRaw) {
    throw new Error("No active OTP found. Please request a new OTP.");
  }

  const cachedOtp = JSON.parse(cachedOtpRaw);
  if (new Date(cachedOtp.expiresAt).getTime() < Date.now()) {
    CacheService.getScriptCache().remove(`${OTP_CACHE_PREFIX}${email}`);
    throw new Error("OTP expired. Please request a new OTP.");
  }

  if (String(cachedOtp.otp).trim() !== otp) {
    throw new Error("Incorrect OTP.");
  }
  CacheService.getScriptCache().remove(`${OTP_CACHE_PREFIX}${email}`);
  markLatestOtpUsed_(email);

  const userRow = findRowByValue_(userSheet, 3, email);
  if (!userRow) {
    throw new Error("User not found.");
  }

  userSheet.getRange(userRow.rowIndex, 4).setValue(true);
  userSheet.getRange(userRow.rowIndex, 6).setValue(new Date().toISOString());

  const token = Utilities.getUuid();
  const expiry = new Date(Date.now() + 8 * 60 * 60 * 1000);

  sessionSheet.appendRow([
    token,
    userRow.values[0],
    email,
    expiry.toISOString(),
    new Date().toISOString(),
    true,
  ]);
  CacheService.getScriptCache().put(
    `${SESSION_CACHE_PREFIX}${token}`,
    JSON.stringify({
      id: userRow.values[0],
      name: userRow.values[1],
      email: userRow.values[2],
      verified: true,
      expiresAt: expiry.toISOString(),
    }),
    21600
  );

  return jsonOutput_({
    ok: true,
    token,
    user: {
      id: userRow.values[0],
      name: userRow.values[1],
      email: userRow.values[2],
      verified: true,
    },
  });
}

function createOrder_(payload) {
  const user = requireSession_(payload.token);
  const amount = Number(getConfigValue_("NOTES_PRICE_INR", "100")) * 100;
  const keyId = getConfigValue_("RAZORPAY_KEY_ID", "");
  const keySecret = getConfigValue_("RAZORPAY_KEY_SECRET", "");

  if (!keyId || !keySecret) {
    throw new Error("Razorpay is not configured.");
  }

  const response = UrlFetchApp.fetch("https://api.razorpay.com/v1/orders", {
    method: "post",
    contentType: "application/json",
    headers: {
      Authorization: "Basic " + Utilities.base64Encode(`${keyId}:${keySecret}`),
    },
    payload: JSON.stringify({
      amount,
      currency: "INR",
      receipt: `notes_${user.id}_${Date.now()}`,
      notes: {
        product: getConfigValue_("NOTES_TITLE", "CA FINAL IDT NOTES"),
      },
    }),
    muteHttpExceptions: true,
  });

  const body = JSON.parse(response.getContentText());
  if (response.getResponseCode() >= 400) {
    throw new Error(body.error && body.error.description ? body.error.description : "Unable to create Razorpay order.");
  }

  return jsonOutput_({
    ok: true,
    provider: "razorpay",
    orderId: body.id,
    amount: body.amount,
    currency: body.currency,
  });
}

function verifyPayment_(payload) {
  const user = requireSession_(payload.token);
  const keySecret = getConfigValue_("RAZORPAY_KEY_SECRET", "");

  const orderId = String(payload.razorpay_order_id || "");
  const paymentId = String(payload.razorpay_payment_id || "");
  const signature = String(payload.razorpay_signature || "");

  const expectedSignature = Utilities.computeHmacSha256Signature(
    `${orderId}|${paymentId}`,
    keySecret
  )
    .map(function (byte) {
      const v = (byte < 0 ? byte + 256 : byte).toString(16);
      return v.length === 1 ? "0" + v : v;
    })
    .join("");

  if (expectedSignature !== signature) {
    throw new Error("Payment verification failed.");
  }

  const purchasesSheet = getSheet_(SHEET_NAMES.purchases, [
    "id",
    "userId",
    "email",
    "paymentId",
    "orderId",
    "amount",
    "currency",
    "driveLink",
    "createdAt",
  ]);
  const deliveriesSheet = getSheet_(SHEET_NAMES.deliveries, [
    "id",
    "userId",
    "name",
    "email",
    "paymentId",
    "orderId",
    "amount",
    "currency",
    "driveLink",
    "driveAccessStatus",
    "emailSent",
    "emailSentAt",
    "lastError",
    "createdAt",
    "updatedAt",
  ]);

  const existing = findRowByValue_(purchasesSheet, 4, paymentId);
  const driveLink = getConfigValue_("GOOGLE_DRIVE_LINK", "");
  const driveFolderId = getConfigValue_("GOOGLE_DRIVE_FOLDER_ID", "");
  const notesTitle = getConfigValue_("NOTES_TITLE", "CA FINAL IDT NOTES");
  const amountPaise = Number(getConfigValue_("NOTES_PRICE_INR", "100")) * 100;

  if (!existing) {
    purchasesSheet.appendRow([
      createId_("PUR"),
      user.id,
      user.email,
      paymentId,
      orderId,
      amountPaise,
      "INR",
      driveLink,
      new Date().toISOString()
    ]);
  }

  let deliveryRow = findRowByValue_(deliveriesSheet, 5, paymentId);
  const nowIso = new Date().toISOString();

  if (!deliveryRow) {
    deliveriesSheet.appendRow([
      createId_("DLV"),
      user.id,
      user.name,
      user.email,
      paymentId,
      orderId,
      amountPaise,
      "INR",
      driveLink,
      "",
      false,
      "",
      "",
      nowIso,
      nowIso,
    ]);
    deliveryRow = findRowByValue_(deliveriesSheet, 5, paymentId);
  }

  if (deliveryRow && deliveryRow.values[10] === true) {
    return jsonOutput_({
      ok: true,
      driveLink,
      driveAccessStatus: String(deliveryRow.values[9] || ""),
      deliveryEmailSent: true,
      message: "Payment already verified and the access email was already sent.",
    });
  }

  const deliveryResult = sendOrRetryDelivery_(deliveriesSheet, deliveryRow, user, notesTitle, driveLink, driveFolderId);

  return jsonOutput_({
    ok: true,
    driveLink,
    driveAccessStatus: deliveryResult.driveAccessStatus,
    deliveryEmailSent: deliveryResult.emailSent,
    message: deliveryResult.emailSent
      ? "Payment verified and the access email has been sent."
      : "Payment verified. Email delivery is pending and will retry automatically when the user logs in again.",
  });
}

function logout_(payload) {
  const token = String(payload.token || "");
  CacheService.getScriptCache().remove(`${SESSION_CACHE_PREFIX}${token}`);
  const sessionSheet = getSheet_(SHEET_NAMES.sessions, []);
  const row = findRowByValue_(sessionSheet, 1, token);
  if (row) {
    sessionSheet.getRange(row.rowIndex, 6).setValue(false);
  }
  return jsonOutput_({ ok: true });
}

function setupSheets() {
  getSheet_(SHEET_NAMES.users, ["id", "name", "email", "verified", "createdAt", "updatedAt"]);
  getSheet_(SHEET_NAMES.otps, ["id", "email", "otp", "expiresAt", "used", "createdAt"]);
  getSheet_(SHEET_NAMES.sessions, ["token", "userId", "email", "expiresAt", "createdAt", "active"]);
  getSheet_(SHEET_NAMES.purchases, ["id", "userId", "email", "paymentId", "orderId", "amount", "currency", "driveLink", "createdAt"]);
  getSheet_(SHEET_NAMES.deliveries, ["id", "userId", "name", "email", "paymentId", "orderId", "amount", "currency", "driveLink", "driveAccessStatus", "emailSent", "emailSentAt", "lastError", "createdAt", "updatedAt"]);
  getSheet_(SHEET_NAMES.config, ["key", "value"]);
}

function seedConfig() {
  const entries = {
    APP_NAME: "Study Board",
    NOTES_TITLE: "CA FINAL IDT NOTES",
    NOTES_DESCRIPTION: "Register with Gmail, verify OTP, pay, and receive your Google Drive link by email.",
    SIDE_CARD_LABEL: "Release",
    SIDE_CARD_TITLE: "2026 Edition",
    SIDE_CARD_DESCRIPTION: "Structured for fast purchase, verified delivery, and restricted folder access.",
    NOTES_PRICE_INR: "100",
    OTP_TTL_MINUTES: "10",
    GOOGLE_DRIVE_LINK: "https://drive.google.com/drive/folders/1qFgtZFU8wYl8sD8UtIYEJxwoWg17EYJx?usp=drive_link",
    GOOGLE_DRIVE_FOLDER_ID: "1qFgtZFU8wYl8sD8UtIYEJxwoWg17EYJx",
    RAZORPAY_KEY_ID: "",
    RAZORPAY_KEY_SECRET: "",
  };

  const configSheet = getSheet_(SHEET_NAMES.config, ["key", "value"]);
  const existing = getDataRows_(configSheet).reduce(function (acc, row) {
    acc[row.values[0]] = true;
    return acc;
  }, {});

  Object.keys(entries).forEach(function (key) {
    if (!existing[key]) {
      configSheet.appendRow([key, entries[key]]);
    }
  });
}

function installDeliveryRetryTrigger() {
  const handlerName = "retryPendingDeliveries";
  const existing = ScriptApp.getProjectTriggers().filter(function (trigger) {
    return trigger.getHandlerFunction() === handlerName;
  });

  if (!existing.length) {
    ScriptApp.newTrigger(handlerName).timeBased().everyMinutes(5).create();
  }
}

function getConfigValue_(key, fallback) {
  const sheet = getSheet_(SHEET_NAMES.config, ["key", "value"]);
  const row = findRowByValue_(sheet, 1, key);
  return row ? String(row.values[1] || "") : fallback;
}

function requireSession_(token) {
  const user = getSessionUser_(token);
  if (!user) {
    throw new Error("Please verify OTP and login first.");
  }
  return user;
}

function getSessionUser_(token) {
  const sessionToken = String(token || "");
  if (!sessionToken) {
    return null;
  }
  const cachedSessionRaw = CacheService.getScriptCache().get(`${SESSION_CACHE_PREFIX}${sessionToken}`);
  if (cachedSessionRaw) {
    const cachedSession = JSON.parse(cachedSessionRaw);
    if (new Date(cachedSession.expiresAt).getTime() >= Date.now()) {
      return {
        id: cachedSession.id,
        name: cachedSession.name,
        email: cachedSession.email,
        verified: cachedSession.verified,
      };
    }
    CacheService.getScriptCache().remove(`${SESSION_CACHE_PREFIX}${sessionToken}`);
  }

  const sessionSheet = getSheet_(SHEET_NAMES.sessions, []);
  const userSheet = getSheet_(SHEET_NAMES.users, []);
  const sessionRow = findRowByValue_(sessionSheet, 1, sessionToken);

  if (!sessionRow || sessionRow.values[5] !== true) {
    return null;
  }

  if (new Date(sessionRow.values[3]).getTime() < Date.now()) {
    sessionSheet.getRange(sessionRow.rowIndex, 6).setValue(false);
    return null;
  }

  const userRow = findRowByValue_(userSheet, 1, sessionRow.values[1]);
  if (!userRow) {
    return null;
  }

  const user = {
    id: userRow.values[0],
    name: userRow.values[1],
    email: userRow.values[2],
    verified: userRow.values[3],
  };
  CacheService.getScriptCache().put(
    `${SESSION_CACHE_PREFIX}${sessionToken}`,
    JSON.stringify({
      id: user.id,
      name: user.name,
      email: user.email,
      verified: user.verified,
      expiresAt: sessionRow.values[3],
    }),
    21600
  );
  return user;
}

function invalidateOtps_(sheet, email) {
  getDataRows_(sheet).forEach(function (row) {
    if (row.values[1] === email && row.values[4] !== true) {
      sheet.getRange(row.rowIndex, 5).setValue(true);
    }
  });
  CacheService.getScriptCache().remove(`${OTP_CACHE_PREFIX}${email}`);
}

function markLatestOtpUsed_(email) {
  const sheet = getSheet_(SHEET_NAMES.otps, []);
  const otpRows = getDataRows_(sheet).filter(function (row) {
    return row.values[1] === email && row.values[4] !== true;
  });
  const latestOtp = otpRows.sort(function (a, b) {
    return new Date(b.values[5]) - new Date(a.values[5]);
  })[0];
  if (latestOtp) {
    sheet.getRange(latestOtp.rowIndex, 5).setValue(true);
  }
}

function createOtp_() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function retryPendingDeliveries() {
  const deliverySheet = getSheet_(SHEET_NAMES.deliveries, []);
  const notesTitle = getConfigValue_("NOTES_TITLE", "CA FINAL IDT NOTES");
  const driveFolderId = getConfigValue_("GOOGLE_DRIVE_FOLDER_ID", "");
  const pendingRows = getDataRows_(deliverySheet).filter(function (row) {
    return row.values[10] !== true;
  });

  pendingRows.forEach(function (row) {
    const user = {
      id: row.values[1],
      name: row.values[2],
      email: row.values[3],
    };
    const driveLink = String(row.values[8] || getConfigValue_("GOOGLE_DRIVE_LINK", ""));
    sendOrRetryDelivery_(deliverySheet, row, user, notesTitle, driveLink, driveFolderId);
  });
}

function getLatestDeliveryRowForEmail_(email) {
  const deliverySheet = getSheet_(SHEET_NAMES.deliveries, []);
  const rows = getDataRows_(deliverySheet).filter(function (row) {
    return String(row.values[3]) === String(email);
  });

  if (!rows.length) {
    return null;
  }

  rows.sort(function (a, b) {
    return new Date(b.values[14] || b.values[13] || 0) - new Date(a.values[14] || a.values[13] || 0);
  });

  return rows[0];
}

function mapDeliveryRow_(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.values[0],
    userId: row.values[1],
    name: row.values[2],
    email: row.values[3],
    paymentId: row.values[4],
    orderId: row.values[5],
    amount: Number(row.values[6] || 0),
    currency: row.values[7] || "INR",
    driveLink: row.values[8] || "",
    driveAccessStatus: row.values[9] || "",
    emailSent: row.values[10] === true,
    emailSentAt: row.values[11] || "",
    lastError: row.values[12] || "",
    createdAt: row.values[13] || "",
    updatedAt: row.values[14] || "",
  };
}

function updateDeliveryRow_(sheet, rowIndex, fields) {
  const current = getDataRows_(sheet).find(function (row) {
    return row.rowIndex === rowIndex;
  });

  if (!current) {
    return null;
  }

  const values = current.values.slice();
  if (Object.prototype.hasOwnProperty.call(fields, "driveAccessStatus")) values[9] = fields.driveAccessStatus;
  if (Object.prototype.hasOwnProperty.call(fields, "emailSent")) values[10] = fields.emailSent;
  if (Object.prototype.hasOwnProperty.call(fields, "emailSentAt")) values[11] = fields.emailSentAt;
  if (Object.prototype.hasOwnProperty.call(fields, "lastError")) values[12] = fields.lastError;
  if (Object.prototype.hasOwnProperty.call(fields, "updatedAt")) values[14] = fields.updatedAt;

  sheet.getRange(rowIndex, 10, 1, 6).setValues([values.slice(9, 15)]);
  return findRowByValue_(sheet, 1, values[0]);
}

function sendAccessEmail_(user, notesTitle, driveLink, driveAccessStatus) {
  MailApp.sendEmail({
    to: user.email,
    subject: `${notesTitle} access link`,
    htmlBody: `
      <div style="font-family:Arial,sans-serif;padding:24px;color:#0f172a;">
        <h2 style="margin:0 0 12px;">Payment Successful</h2>
        <p style="margin:0 0 12px;">Hi ${user.name},</p>
        <p style="margin:0 0 20px;">Your payment for <strong>${notesTitle}</strong> is successful.</p>
        <p style="margin:0 0 16px;">Drive access status: <strong>${driveAccessStatus}</strong></p>
        <a href="${driveLink}" style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:10px;font-weight:700;">Open Google Drive Folder</a>
      </div>
    `,
  });
}

function sendOrRetryDelivery_(deliverySheet, deliveryRow, user, notesTitle, driveLink, driveFolderId) {
  const driveAccessStatus = grantDriveAccess_(driveFolderId, user.email);
  const nowIso = new Date().toISOString();

  updateDeliveryRow_(deliverySheet, deliveryRow.rowIndex, {
    driveAccessStatus: driveAccessStatus,
    lastError: "",
    updatedAt: nowIso,
  });

  try {
    sendAccessEmail_(user, notesTitle, driveLink, driveAccessStatus);
    updateDeliveryRow_(deliverySheet, deliveryRow.rowIndex, {
      driveAccessStatus: driveAccessStatus,
      emailSent: true,
      emailSentAt: nowIso,
      lastError: "",
      updatedAt: nowIso,
    });
    return {
      emailSent: true,
      driveAccessStatus: driveAccessStatus,
      lastError: "",
    };
  } catch (error) {
    updateDeliveryRow_(deliverySheet, deliveryRow.rowIndex, {
      driveAccessStatus: driveAccessStatus,
      emailSent: false,
      lastError: error.message,
      updatedAt: nowIso,
    });
    return {
      emailSent: false,
      driveAccessStatus: driveAccessStatus,
      lastError: error.message,
    };
  }
}

function recoverLatestDelivery_(user) {
  const deliverySheet = getSheet_(SHEET_NAMES.deliveries, []);
  let latestRow = getLatestDeliveryRowForEmail_(user.email);

  if (!latestRow) {
    return {
      delivery: null,
      recovery: null,
    };
  }

  let recovery = null;
  if (latestRow.values[10] !== true) {
    const driveLink = String(latestRow.values[8] || getConfigValue_("GOOGLE_DRIVE_LINK", ""));
    const notesTitle = getConfigValue_("NOTES_TITLE", "CA FINAL IDT NOTES");
    const driveFolderId = getConfigValue_("GOOGLE_DRIVE_FOLDER_ID", "");
    const result = sendOrRetryDelivery_(deliverySheet, latestRow, user, notesTitle, driveLink, driveFolderId);
    latestRow = findRowByValue_(deliverySheet, 1, latestRow.values[0]);
    recovery = {
      emailSent: result.emailSent,
      message: result.emailSent
        ? "Your access email was recovered and sent successfully."
        : "Your payment is recorded, but email delivery is still pending. It will retry again when you log in.",
      lastError: result.lastError || "",
    };
  }

  return {
    delivery: mapDeliveryRow_(latestRow),
    recovery: recovery,
  };
}

function grantDriveAccess_(folderId, email) {
  if (!folderId) {
    return "skipped: missing folder id";
  }

  try {
    const folder = DriveApp.getFolderById(folderId);
    folder.addViewer(email);
    return "viewer access granted";
  } catch (error) {
    return `share failed: ${error.message}`;
  }
}

function getParam_(e, key) {
  return e && e.parameter ? String(e.parameter[key] || "") : "";
}

function normalizeEmail_(value) {
  return String(value || "").trim().toLowerCase();
}

function createId_(prefix) {
  return `${prefix}_${Utilities.getUuid().replace(/-/g, "").slice(0, 12)}`;
}

function getSheet_(name, headers) {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = spreadsheet.getSheetByName(name);

  if (!sheet) {
    sheet = spreadsheet.insertSheet(name);
  }

  if (headers.length && sheet.getLastRow() === 0) {
    sheet.appendRow(headers);
  }

  return sheet;
}

function getDataRows_(sheet) {
  if (sheet.getLastRow() <= 1) {
    return [];
  }

  return sheet
    .getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn())
    .getValues()
    .map(function (values, index) {
      return {
        rowIndex: index + 2,
        values: values,
      };
    });
}

function findRowByValue_(sheet, columnNumber, value) {
  return getDataRows_(sheet).find(function (row) {
    return String(row.values[columnNumber - 1]) === String(value);
  }) || null;
}

function jsonOutput_(data) {
  return ContentService.createTextOutput(JSON.stringify(data)).setMimeType(ContentService.MimeType.JSON);
}
