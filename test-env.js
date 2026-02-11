// test-drive-auth.js
import { google } from "googleapis";
import dotenv from "dotenv";
dotenv.config({ path: "./.env" });

const auth = new google.auth.GoogleAuth({
  keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS,
  scopes: ["https://www.googleapis.com/auth/drive.file"],
});

const drive = google.drive({ version: "v3", auth });

const test = async () => {
  const res = await drive.files.list({ pageSize: 1 });
  console.log("AUTH OK. Files:", res.data.files);
};

test();
