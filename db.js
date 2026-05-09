const fs = require("fs");
const path = require("path");

const DB_PATH = path.join(__dirname, "notes-store.json");

function getInitialState() {
  return {
    counters: {
      users: 0,
      otpCodes: 0,
      purchases: 0,
      orders: 0,
      deliveries: 0,
    },
    users: [],
    otpCodes: [],
    purchases: [],
    orders: [],
    deliveries: [],
  };
}

function ensureDb() {
  if (!fs.existsSync(DB_PATH)) {
    fs.writeFileSync(DB_PATH, JSON.stringify(getInitialState(), null, 2));
  }
}

function readDb() {
  ensureDb();
  return JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
}

function writeDb(data) {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

function upsertUser(name, email) {
  const data = readDb();
  let user = data.users.find((entry) => entry.email === email);

  if (user) {
    user.name = name;
  } else {
    const id = ++data.counters.users;
    user = {
      id,
      name,
      email,
      verified: 0,
      created_at: new Date().toISOString(),
    };
    data.users.push(user);
  }

  writeDb(data);
  return user;
}

function findUserByEmail(email) {
  return readDb().users.find((entry) => entry.email === email) || null;
}

function findUserById(id) {
  return readDb().users.find((entry) => entry.id === id) || null;
}

function markUserVerified(email) {
  const data = readDb();
  const user = data.users.find((entry) => entry.email === email);
  if (!user) {
    return null;
  }

  user.verified = 1;
  writeDb(data);
  return user;
}

function invalidateOtps(email) {
  const data = readDb();
  data.otpCodes.forEach((entry) => {
    if (entry.email === email && entry.used === 0) {
      entry.used = 1;
    }
  });
  writeDb(data);
}

function createOtp(email, otp, expiresAt) {
  const data = readDb();
  const id = ++data.counters.otpCodes;
  const otpRow = {
    id,
    email,
    otp,
    expires_at: expiresAt,
    used: 0,
    created_at: new Date().toISOString(),
  };
  data.otpCodes.push(otpRow);
  writeDb(data);
  return otpRow;
}

function findLatestActiveOtp(email) {
  const rows = readDb()
    .otpCodes.filter((entry) => entry.email === email && entry.used === 0)
    .sort((a, b) => b.id - a.id);

  return rows[0] || null;
}

function markOtpUsed(id) {
  const data = readDb();
  const otpRow = data.otpCodes.find((entry) => entry.id === id);
  if (otpRow) {
    otpRow.used = 1;
    writeDb(data);
  }
}

function findPurchaseByPaymentId(paymentId) {
  return readDb().purchases.find((entry) => entry.payment_id === paymentId) || null;
}

function createPurchase(record) {
  const data = readDb();
  const id = ++data.counters.purchases;
  const purchase = {
    id,
    ...record,
    created_at: new Date().toISOString(),
  };
  data.purchases.push(purchase);
  writeDb(data);
  return purchase;
}

function findPurchaseByOrderId(orderId) {
  return readDb().purchases.find((entry) => entry.order_id === orderId) || null;
}

function createOrder(record) {
  const data = readDb();
  const id = ++data.counters.orders;
  const order = {
    id,
    status: "created",
    payment_id: "",
    payment_status: "pending",
    webhook_received: 0,
    delivery_processed: 0,
    delivery_id: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...record,
  };
  data.orders.push(order);
  writeDb(data);
  return order;
}

function findOrderByOrderId(orderId) {
  return readDb().orders.find((entry) => entry.order_id === orderId) || null;
}

function updateOrder(orderId, fields) {
  const data = readDb();
  const order = data.orders.find((entry) => entry.order_id === orderId);
  if (!order) {
    return null;
  }

  Object.assign(order, fields, {
    updated_at: new Date().toISOString(),
  });
  writeDb(data);
  return order;
}

function createDelivery(record) {
  const data = readDb();
  const id = ++data.counters.deliveries;
  const delivery = {
    id,
    email_sent: 0,
    email_sent_at: "",
    drive_access_status: "",
    last_error: "",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...record,
  };
  data.deliveries.push(delivery);
  writeDb(data);
  return delivery;
}

function updateDelivery(id, fields) {
  const data = readDb();
  const delivery = data.deliveries.find((entry) => entry.id === id);
  if (!delivery) {
    return null;
  }

  Object.assign(delivery, fields, {
    updated_at: new Date().toISOString(),
  });
  writeDb(data);
  return delivery;
}

function findDeliveryByPaymentId(paymentId) {
  return readDb().deliveries.find((entry) => entry.payment_id === paymentId) || null;
}

function findDeliveryByOrderId(orderId) {
  return readDb().deliveries.find((entry) => entry.order_id === orderId) || null;
}

function findLatestDeliveryByEmail(email) {
  const rows = readDb()
    .deliveries.filter((entry) => entry.email === email)
    .sort((a, b) => new Date(b.updated_at || b.created_at) - new Date(a.updated_at || a.created_at));
  return rows[0] || null;
}

function findPendingDeliveries() {
  return readDb().deliveries.filter((entry) => entry.email_sent !== 1);
}

module.exports = {
  upsertUser,
  findUserByEmail,
  findUserById,
  markUserVerified,
  invalidateOtps,
  createOtp,
  findLatestActiveOtp,
  markOtpUsed,
  findPurchaseByPaymentId,
  findPurchaseByOrderId,
  createPurchase,
  createOrder,
  findOrderByOrderId,
  updateOrder,
  createDelivery,
  updateDelivery,
  findDeliveryByPaymentId,
  findDeliveryByOrderId,
  findLatestDeliveryByEmail,
  findPendingDeliveries,
};
