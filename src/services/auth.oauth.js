import fs from "fs";
import path from "path";
import readline from "readline";
import { google } from "googleapis";
import https from 'https';

const SCOPES = [
    'https://www.googleapis.com/auth/drive',
    'https://www.googleapis.com/auth/drive.file',
    'https://www.googleapis.com/auth/drive.readonly',
    'https://www.googleapis.com/auth/spreadsheets',
    'https://www.googleapis.com/auth/gmail.modify'
];
const TOKEN_PATH = "token.json";
const CREDENTIALS_PATH = path.resolve("secrets/auth.json");

export const getOAuthClient = async () => {
    //para prueba sin certificado
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

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

    // Forzamos a que el transporte use un agente que ignore el error de certificado
    oAuth2Client.transporter.defaults.httpsAgent = new https.Agent({
        rejectUnauthorized: false
    });

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

    // 3. Generar la URL de autorización
    const authUrl = oAuth2Client.generateAuthUrl({
        access_type: 'offline',
        prompt: 'consent',
        scope: SCOPES,
    });

    console.log("\n--- AUTORIZACIÓN REQUERIDA ---");
    console.log("1. Abre este enlace en tu navegador:");
    console.log(`\x1b[36m${authUrl}\x1b[0m`); // En color cian para que resalte
    console.log("\n2. Inicia sesión y autoriza los permisos.");
    console.log("3. Copia el código que te dará Google y pégalo abajo.\n");

    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });

    const code = await new Promise(resolve => {
        rl.question("ENTER_CODE: Pega el código aquí: ", resolve);
    });

    rl.close();

    // 4. Canjear código por tokens
    try {
        const { tokens } = await oAuth2Client.getToken(code);
        oAuth2Client.setCredentials(tokens);
        fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens));

        console.log("INFO: AUTH_CONFIGURED - Token guardado con éxito.");
        return oAuth2Client;
    } catch (err) {
        console.error(`ERROR: AUTH_EXCHANGE_FAILED - ${err.message}`);
        throw err;
    }
};
