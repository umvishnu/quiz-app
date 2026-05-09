# Google Apps Script Backend

This folder contains a Google Apps Script backend for:

- user registration
- OTP email login
- Razorpay order creation
- Razorpay payment verification
- Google Drive link delivery email
- storing data in Google Sheets

## Sheet tabs used

Run these two functions once inside Apps Script:

1. `setupSheets()`
2. `seedConfig()`

That creates:

- `Users`
- `Otps`
- `Sessions`
- `Purchases`
- `Config`

## Config values

Open the `Config` sheet and fill these:

- `APP_NAME`
- `NOTES_TITLE`
- `NOTES_DESCRIPTION`
- `NOTES_PRICE_INR`
- `OTP_TTL_MINUTES`
- `GOOGLE_DRIVE_LINK`
- `GOOGLE_DRIVE_FOLDER_ID`
- `RAZORPAY_KEY_ID`
- `RAZORPAY_KEY_SECRET`

Set `NOTES_PRICE_INR` to `100` if you want the checkout amount to be Rs. 100.

`GOOGLE_DRIVE_FOLDER_ID` should be only the folder ID, not the full link.
Example:

```text
1qFgtZFU8wYl8sD8UtIYEJxwoWg17EYJx
```

After successful payment, the script will:

- email the Drive link
- add the buyer's Gmail as a viewer on the Drive folder automatically

Important:

- the Google account running the Apps Script must have permission to share that folder
- if the folder belongs to another account, that owner must allow sharing or make this Google account an editor

## Deploy

1. Open [script.google.com](https://script.google.com/)
2. Create a new Apps Script project attached to a Google Sheet
3. Paste `Code.gs`
4. Add `appsscript.json`
5. Save
6. Run `setupSheets()`
7. Run `seedConfig()`
8. Click `Deploy`
9. Choose `New deployment`
10. Select `Web app`
11. Execute as: `Me`
12. Who has access: `Anyone`
13. Deploy

Copy the web app URL. You will use it in the frontend config.

## API actions

GET:

- `?action=config&token=...`

POST JSON body:

- `action=requestOtp`
- `action=verifyOtp`
- `action=createOrder`
- `action=verifyPayment`
- `action=logout`
