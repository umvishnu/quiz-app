const state = {
  config: null,
  email: "",
  user: null,
  driveLink: "",
  currentSection: "register",
  isRequestingOtp: false,
  isVerifyingOtp: false,
  isCreatingOrder: false,
  isFinalizingPayment: false,
};

const API_BASE = window.__APP_CONFIG__?.apiBase || "";
const CONFIG_CACHE_KEY = "studyBoardConfigCache";
const CONFIG_CACHE_TTL_MS = 5 * 60 * 1000;

const el = {
  statusMessage: document.getElementById("statusMessage"),
  registerForm: document.getElementById("registerForm"),
  otpForm: document.getElementById("otpForm"),
  storeSection: document.getElementById("storeSection"),
  successSection: document.getElementById("successSection"),
  logoutButton: document.getElementById("logoutButton"),
  name: document.getElementById("name"),
  email: document.getElementById("email"),
  phone: document.getElementById("phone"),
  otp: document.getElementById("otp"),
  otpDigits: Array.from(document.querySelectorAll(".otp-digit")),
  notesTitle: document.getElementById("notesTitle"),
  notesDescription: document.getElementById("notesDescription"),
  sideCardLabel: document.getElementById("sideCardLabel"),
  sideCardTitle: document.getElementById("sideCardTitle"),
  sideCardDescription: document.getElementById("sideCardDescription"),
  notesPrice: document.getElementById("notesPrice"),
  cardTitle: document.getElementById("cardTitle"),
  cardPrice: document.getElementById("cardPrice"),
  welcomeText: document.getElementById("welcomeText"),
  successText: document.getElementById("successText"),
  driveLink: document.getElementById("driveLink"),
  requestOtpButton: document.getElementById("requestOtpButton"),
  verifyOtpButton: document.getElementById("verifyOtpButton"),
  payButton: document.getElementById("payButton"),
  chips: {
    register: document.getElementById("chip-register"),
    otp: document.getElementById("chip-otp"),
    store: document.getElementById("chip-store"),
    success: document.getElementById("chip-success"),
  },
  loadingOverlay: document.getElementById("loadingOverlay"),
  loadingMessage: document.getElementById("loadingMessage"),
};

const sectionOrder = ["register", "otp", "store", "success"];
const sectionViews = {
  register: el.registerForm,
  otp: el.otpForm,
  store: el.storeSection,
  success: el.successSection,
};

function showLoading(message) {
  el.loadingMessage.textContent = message;
  el.loadingOverlay.classList.add("visible");
  document.body.classList.add("app-loading");
}

function hideLoading() {
  el.loadingOverlay.classList.remove("visible");
  document.body.classList.remove("app-loading");
}

function showMessage(message, type = "success") {
  el.statusMessage.textContent = message;
  el.statusMessage.className = `status ${type}`;
}

function hideMessage() {
  el.statusMessage.className = "status hidden";
  el.statusMessage.textContent = "";
}

function formatInr(value) {
  return `Rs. ${Number(value || 0).toLocaleString("en-IN")}`;
}

function normalizePhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (digits.length === 12 && digits.startsWith("91")) {
    return digits.slice(2);
  }
  return digits;
}

function readCachedConfig() {
  try {
    const raw = localStorage.getItem(CONFIG_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed?.savedAt || !parsed?.data) return null;
    if (Date.now() - parsed.savedAt > CONFIG_CACHE_TTL_MS) return null;
    return parsed.data;
  } catch (error) {
    return null;
  }
}

function writeCachedConfig(data) {
  try {
    localStorage.setItem(
      CONFIG_CACHE_KEY,
      JSON.stringify({
        savedAt: Date.now(),
        data: {
          appName: data.appName,
          notesTitle: data.notesTitle,
          notesDescription: data.notesDescription,
          sideCardLabel: data.sideCardLabel,
          sideCardTitle: data.sideCardTitle,
          sideCardDescription: data.sideCardDescription,
          notesPriceInr: data.notesPriceInr,
          razorpayKeyId: data.razorpayKeyId,
        },
      })
    );
  } catch (error) {
    console.warn("Config cache unavailable", error);
  }
}

function applyConfig(data) {
  if (!data) return;
  state.config = { ...state.config, ...data };
  document.title = `${data.appName || "Study Board"}`;
  el.notesTitle.textContent = data.notesTitle || "Premium Notes";
  el.notesDescription.textContent =
    data.notesDescription || "Register with your Gmail, verify with OTP, then pay to receive the Drive access link.";
  el.sideCardLabel.textContent = data.sideCardLabel || "Release";
  el.sideCardTitle.textContent = data.sideCardTitle || "2026 Edition";
  el.sideCardDescription.textContent =
    data.sideCardDescription || "Structured for fast purchase, verified delivery, and restricted folder access.";
  el.notesPrice.textContent = formatInr(data.notesPriceInr);
  el.cardTitle.textContent = data.notesTitle || "Premium Notes";
  el.cardPrice.textContent = formatInr(data.notesPriceInr);
}

function showDeliveryState(delivery, recoveryMessage = "") {
  if (!delivery) return false;

  state.driveLink = delivery.driveLink || "";
  el.driveLink.href = delivery.driveLink || "#";
  el.driveLink.classList.toggle("hidden", !delivery.driveLink);

  if (delivery.emailSent) {
    el.successText.textContent = `Payment confirmed. The Google Drive access link has been sent to ${delivery.email}.`;
    showMessage(recoveryMessage || "Your access is already ready.", "success");
  } else {
    el.successText.textContent = `Payment is already recorded for ${delivery.email}. Email delivery is still pending, but your access record is safe.`;
    showMessage(recoveryMessage || "Payment is safe. Delivery email is pending retry.", "error");
  }

  showSection("success");
  return true;
}

function showSection(name) {
  const previousSection = state.currentSection;
  const previousIndex = sectionOrder.indexOf(previousSection);
  const nextIndex = sectionOrder.indexOf(name);
  const direction = nextIndex >= previousIndex ? "forward" : "backward";
  const nextView = sectionViews[name];
  const previousView = sectionViews[previousSection];

  Object.values(sectionViews).forEach((view) => {
    view.classList.remove("hidden", "flow-active", "flow-enter-left", "flow-enter-right", "flow-exit-left", "flow-exit-right");
  });

  if (nextView && previousView && nextView !== previousView) {
    nextView.classList.add(direction === "forward" ? "flow-enter-right" : "flow-enter-left");
    previousView.classList.add("flow-active");

    requestAnimationFrame(() => {
      previousView.classList.add(direction === "forward" ? "flow-exit-left" : "flow-exit-right");
      previousView.classList.remove("flow-active");
      nextView.classList.add("flow-active");
      nextView.classList.remove("flow-enter-right", "flow-enter-left");
    });
  } else if (nextView) {
    nextView.classList.add("flow-active");
  }

  state.currentSection = name;
  el.logoutButton.classList.toggle("hidden", !state.user);

  Object.entries(el.chips).forEach(([key, chip]) => {
    chip.classList.toggle("active", key === name);
  });

  if (name === "register") el.name.focus();
  if (name === "otp") el.otpDigits[0]?.focus();
}

function syncOtpValue() {
  el.otp.value = el.otpDigits.map((input) => input.value).join("");
}

function resetOtpInputs() {
  el.otpDigits.forEach((input) => {
    input.value = "";
  });
  syncOtpValue();
}

function handleOtpDigitInput(event) {
  const input = event.target;
  const index = el.otpDigits.indexOf(input);
  const digits = input.value.replace(/\D/g, "");

  if (!digits) {
    input.value = "";
    syncOtpValue();
    return;
  }

  if (digits.length > 1) {
    digits.slice(0, el.otpDigits.length - index).split("").forEach((digit, offset) => {
      if (el.otpDigits[index + offset]) {
        el.otpDigits[index + offset].value = digit;
      }
    });
  } else {
    input.value = digits;
  }

  syncOtpValue();
  const nextIndex = Math.min(index + digits.length, el.otpDigits.length - 1);
  el.otpDigits[nextIndex]?.focus();
  el.otpDigits[nextIndex]?.select();
}

function handleOtpDigitKeydown(event) {
  const input = event.target;
  const index = el.otpDigits.indexOf(input);

  if (event.key === "Backspace" && !input.value && index > 0) {
    el.otpDigits[index - 1].focus();
    el.otpDigits[index - 1].select();
  }

  if (event.key === "ArrowLeft" && index > 0) {
    event.preventDefault();
    el.otpDigits[index - 1].focus();
  }

  if (event.key === "ArrowRight" && index < el.otpDigits.length - 1) {
    event.preventDefault();
    el.otpDigits[index + 1].focus();
  }
}

function handleOtpPaste(event) {
  event.preventDefault();
  const pasted = (event.clipboardData?.getData("text") || "").replace(/\D/g, "").slice(0, el.otpDigits.length);
  if (!pasted) return;
  pasted.split("").forEach((digit, index) => {
    if (el.otpDigits[index]) {
      el.otpDigits[index].value = digit;
    }
  });
  syncOtpValue();
  const focusIndex = Math.min(pasted.length, el.otpDigits.length) - 1;
  el.otpDigits[Math.max(focusIndex, 0)]?.focus();
}

function setButtonState(button, isLoading) {
  button.disabled = isLoading;
  button.textContent = isLoading
    ? button.dataset.loadingLabel || "Please wait..."
    : button.dataset.defaultLabel || button.textContent;
}

async function api(url, options = {}) {
  const isGet = (options.method || "GET").toUpperCase() === "GET";
  const response = await fetch(`${API_BASE}${url}`, {
    headers: isGet ? {} : { "Content-Type": "application/json" },
    credentials: "same-origin",
    ...options,
  });

  const contentType = response.headers.get("content-type") || "";
  const data = contentType.includes("application/json")
    ? await response.json()
    : { error: await response.text() };
  if (!response.ok || data.ok === false) {
    throw new Error(data.error || "Something went wrong.");
  }
  return data;
}

async function loadConfig() {
  const cachedConfig = readCachedConfig();
  if (cachedConfig) {
    applyConfig(cachedConfig);
    showSection("register");
    hideLoading();
  } else {
    showLoading("Loading notes configuration and secure access details...");
  }

  try {
    const data = await api("/api/config", { method: "GET" });
    writeCachedConfig(data);
    applyConfig(data);
    state.user = data.user;

    if (state.user) {
      state.email = state.user.email;
      el.welcomeText.textContent = `Logged in as ${state.user.name} (${state.user.email})`;
      el.logoutButton.classList.remove("hidden");
      if (!showDeliveryState(data.latestDelivery, data.deliveryRecovery?.message || "")) {
        showSection("store");
      }
    } else {
      showSection("register");
    }
  } finally {
    hideLoading();
  }
}

async function handleRegister(event) {
  event.preventDefault();
  if (state.isRequestingOtp) return;

  state.isRequestingOtp = true;
  setButtonState(el.requestOtpButton, true);
  hideMessage();
  showMessage("Sending OTP to the registered Gmail account...", "success");

  const payload = {
    name: el.name.value.trim(),
    email: el.email.value.trim().toLowerCase(),
    phone: normalizePhone(el.phone.value),
  };

  try {
    const data = await api("/api/auth/request-otp", {
      method: "POST",
      body: JSON.stringify({
        ...payload,
      }),
    });

    state.email = payload.email;
    showMessage(data.message, "success");
    showSection("otp");
  } catch (error) {
    showMessage(error.message, "error");
  } finally {
    state.isRequestingOtp = false;
    setButtonState(el.requestOtpButton, false);
  }
}

async function handleOtpVerify(event) {
  event.preventDefault();
  if (state.isVerifyingOtp) return;

  state.isVerifyingOtp = true;
  setButtonState(el.verifyOtpButton, true);
  hideMessage();
  showMessage("Verifying OTP and preparing your secure session...", "success");

  try {
    const data = await api("/api/auth/verify-otp", {
      method: "POST",
      body: JSON.stringify({
        email: state.email,
        otp: el.otp.value.trim(),
      }),
    });

    state.user = data.user;
    el.welcomeText.textContent = `Welcome ${data.user.name}. After payment, the Drive link will be mailed to ${data.user.email}.`;
    el.logoutButton.classList.remove("hidden");
    hideMessage();
    showSection("store");
  } catch (error) {
    showMessage(error.message, "error");
  } finally {
    state.isVerifyingOtp = false;
    setButtonState(el.verifyOtpButton, false);
  }
}

async function completePayment(orderId, razorpayResponse = null) {
  const payload = razorpayResponse
    ? razorpayResponse
    : {
        orderId,
      };
  state.isFinalizingPayment = true;
  showLoading("Confirming payment, enabling Drive access, and sending your delivery email...");
  try {
    const data = await api("/api/payment/verify", {
      method: "POST",
      body: JSON.stringify({
        ...payload,
      }),
    });

    state.driveLink = data.driveLink;
    showDeliveryState(
      {
        email: state.user.email,
        driveLink: data.driveLink,
        emailSent: data.deliveryEmailSent !== false,
      },
      data.message
    );
  } finally {
    state.isFinalizingPayment = false;
    hideLoading();
  }
}

async function handlePayment() {
  if (state.isCreatingOrder) return;

  state.isCreatingOrder = true;
  setButtonState(el.payButton, true);
  hideMessage();
  showMessage("Preparing your secure Razorpay checkout...", "success");

  try {
    const order = await api("/api/payment/create-order", {
      method: "POST",
      body: JSON.stringify({}),
    });

    if (order.provider === "razorpay") {
      if (!state.config.razorpayKeyId) {
        showMessage("Razorpay key is missing in server configuration.", "error");
        return;
      }

      if (!window.Razorpay) {
        showMessage("Razorpay checkout failed to load. Refresh the page and try again.", "error");
        return;
      }

      const razorpay = new window.Razorpay({
        key: state.config.razorpayKeyId,
        amount: order.amount,
        currency: order.currency,
        name: state.config.appName,
        description: state.config.notesTitle,
        order_id: order.orderId,
        handler: async (response) => {
          try {
            await completePayment(order.orderId, response);
          } catch (error) {
            showMessage(error.message, "error");
          }
        },
        prefill: {
          name: state.user.name,
          email: state.user.email,
          contact: state.user.phone || "",
        },
        theme: {
          color: "#0f766e",
        },
      });

      razorpay.on("payment.failed", (response) => {
        const reason =
          response?.error?.description || response?.error?.reason || "Payment failed. Please try again.";
        showMessage(reason, "error");
      });

      razorpay.open();
      return;
    }

    await completePayment(order.orderId);
  } catch (error) {
    showMessage(error.message, "error");
  } finally {
    state.isCreatingOrder = false;
    setButtonState(el.payButton, false);
  }
}

async function handleLogout() {
  try {
    await api("/api/auth/logout", {
      method: "POST",
      body: JSON.stringify({}),
    });
  } catch (error) {
    console.error(error);
  }

  state.user = null;
  state.email = "";
  state.driveLink = "";
  el.registerForm.reset();
  resetOtpInputs();
  el.logoutButton.classList.add("hidden");
  hideMessage();
  showSection("register");
}

el.registerForm.addEventListener("submit", handleRegister);
el.otpForm.addEventListener("submit", handleOtpVerify);
el.payButton.addEventListener("click", handlePayment);
el.logoutButton.addEventListener("click", handleLogout);
el.otpDigits.forEach((input) => {
  input.addEventListener("input", handleOtpDigitInput);
  input.addEventListener("keydown", handleOtpDigitKeydown);
  input.addEventListener("focus", () => input.select());
  input.addEventListener("paste", handleOtpPaste);
});

loadConfig().catch((error) => {
  hideLoading();
  showMessage(error.message, "error");
});
