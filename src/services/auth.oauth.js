import fs from "fs";
import path from "path";
import readline from "readline";
import { google } from "googleapis";

const SCOPES = [
    'https://www.googleapis.com/auth/drive',
    'https://www.googleapis.com/auth/drive.file',
    'https://www.googleapis.com/auth/drive.readonly',
    'https://www.googleapis.com/auth/spreadsheets'
];
const TOKEN_PATH = "token.json";
const CREDENTIALS_PATH = path.resolve("secrets/auth.json");

export const getOAuthClient = async () => {
    const content = fs.readFileSync(CREDENTIALS_PATH);
    const credentials = JSON.parse(content);

    const { client_secret, client_id, redirect_uris } = credentials.installed;

    const oAuth2Client = new google.auth.OAuth2(
        client_id,
        client_secret,
        redirect_uris[0]
    );

    if (fs.existsSync(TOKEN_PATH)) {
        const token = JSON.parse(fs.readFileSync(TOKEN_PATH));
        oAuth2Client.setCredentials(token);
        return oAuth2Client;
    }

    const authUrl = oAuth2Client.generateAuthUrl({
        access_type: "offline", // Requerido para obtener refresh_token
        scope: SCOPES,
        prompt: 'consent'       // nuevo token persistente
    });

    console.log("Autoriza aquí:");
    console.log(authUrl);

    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });

    const code = await new Promise(resolve => {
        rl.question("Pega el código aquí: ", resolve);
    });

    rl.close();

    const { tokens } = await oAuth2Client.getToken(code);
    oAuth2Client.setCredentials(tokens);

    fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens));


    console.log("Token guardado en token.json");

    return oAuth2Client;
};