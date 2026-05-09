# CA Notes Hub Setup

This project supports:

- Gmail OTP login
- Razorpay payment
- Delivery of the Google Drive link by email
- Google Apps Script + Google Sheets backend

## Recommended for Netlify

If you are deploying on Netlify, the easiest backend is:

- Netlify for frontend
- Google Apps Script for backend
- Google Sheets for data storage

This avoids running your own server.

## 1. Start the app

```powershell
cd "C:\Users\HP\OneDrive\Desktop\VISHNU\Note Download"
npm start
```

Open:

`http://localhost:3000`

## 2. Google Apps Script backend

The Apps Script backend files are in:

- [apps-script/Code.gs](C:\Users\HP\OneDrive\Desktop\VISHNU\Note Download\apps-script\Code.gs)
- [apps-script/appsscript.json](C:\Users\HP\OneDrive\Desktop\VISHNU\Note Download\apps-script\appsscript.json)
- [apps-script/README.md](C:\Users\HP\OneDrive\Desktop\VISHNU\Note Download\apps-script\README.md)

Use this flow:

1. Create a Google Sheet
2. Open `Extensions > Apps Script`
3. Paste the script files
4. Run `setupSheets()`
5. Run `seedConfig()`
6. Add your Razorpay keys in the `Config` sheet
7. Deploy the Apps Script as a `Web app`
8. Copy the web app URL
9. Put that URL into [public/config.js](C:\Users\HP\OneDrive\Desktop\VISHNU\Note Download\public\config.js)

Example:

```js
window.__APP_CONFIG__ = {
  apiBase: "https://script.google.com/macros/s/YOUR_DEPLOYMENT_ID/exec",
};
```

## 3. Gmail OTP setup

Your OTP email is already configured in `.env`:

- `SMTP_USER=sb.idt.ca.final.note@gmail.com`
- `MAIL_FROM=sb.idt.ca.final.note@gmail.com`

If OTP stops working in future, create a new Google App Password and replace:

```env
SMTP_PASS=your-new-google-app-password
```

If you use Google Apps Script backend, email sending can be done by `MailApp.sendEmail()` from your Google account instead of local SMTP.

## 4. Enable real Razorpay payment

Right now the project may still be in demo payment mode until you add your live or test Razorpay keys.

Update `.env`:

```env
PAYMENT_PROVIDER=razorpay
RAZORPAY_KEY_ID=rzp_test_your_key_id
RAZORPAY_KEY_SECRET=your_key_secret
```

For the Google Apps Script version, add these two values to the `Config` sheet instead.

Then restart the server:

```powershell
taskkill /F /IM node.exe
npm start
```

## 5. Razorpay dashboard

Get your keys from the Razorpay Dashboard:

- `Settings`
- `API Keys`
- create or view `Test Mode` keys first

Use test mode before live mode.

## 6. Google Drive access

The project currently:

- emails the Google Drive folder link after payment
- also tries to grant Drive reader access using the service account JSON

Current folder values come from `.env`:

```env
GOOGLE_DRIVE_LINK=...
GOOGLE_DRIVE_FOLDER_ID=...
GOOGLE_SERVICE_ACCOUNT_KEY_FILE=./igneous-river-492610-n8-5dbdd000acf6.json
```

Important:

The Google Drive folder must be shared in a way that allows the service account to manage permissions, or the mail will still go out but Drive permission creation may fail.

## 7. Delivery flow

The buyer flow is:

1. User enters name and Gmail
2. OTP is sent to email
3. User verifies OTP
4. User pays with Razorpay
5. Server verifies payment
6. Server emails the Drive link to the buyer

## 8. Test checklist

Use this order:

1. Start the server
2. Register with a Gmail address
3. Verify the OTP received in mail
4. Click `Pay Now`
5. Complete payment
6. Confirm access email arrives
