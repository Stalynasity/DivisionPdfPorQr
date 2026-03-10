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
    // 1. Verificación de archivo de credenciales
    if (!fs.existsSync(CREDENTIALS_PATH)) {
        console.error(`CRITICAL: AUTH_FAILED - No se encontró el archivo de credenciales en ${CREDENTIALS_PATH}`);
        throw new Error("CREDENTIALS_FILE_MISSING");
    }

    const content = fs.readFileSync(CREDENTIALS_PATH);
    const credentials = JSON.parse(content);
    const { client_secret, client_id, redirect_uris } = credentials.installed;

    const oAuth2Client = new google.auth.OAuth2(
        client_id,
        client_secret,
        redirect_uris[0]
    );

    // 2. Intento de carga de token existente
    if (fs.existsSync(TOKEN_PATH)) {
        try {
            const token = JSON.parse(fs.readFileSync(TOKEN_PATH));
            oAuth2Client.setCredentials(token);
            // Log minimalista de éxito
            return oAuth2Client;
        } catch (err) {
            console.warn("WARN: AUTH_TOKEN_CORRUPT - El archivo token.json es inválido. Se requiere nueva autorización.");
        }
    }

    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });

    const code = await new Promise(resolve => {
        rl.question("ENTER_CODE: Pega el código de autorización aquí: ", resolve);
    });

    rl.close();

    try {
        const { tokens } = await oAuth2Client.getToken(code);
        oAuth2Client.setCredentials(tokens);
        fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens));
        
        console.log("INFO: AUTH_CONFIGURED - Nuevo token generado y persistido correctamente.");
        return oAuth2Client;
    } catch (err) {
        console.error(`ERROR: AUTH_EXCHANGE_FAILED - No se pudo canjear el código por un token: ${err.message}`);
        throw err;
    }
};