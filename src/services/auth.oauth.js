import fs from "fs";
import path from "path";
import { google } from "googleapis";
import https from 'https';
import readline from "readline";

const TOKEN_PATH = path.join(process.cwd(), "token.json");
const CREDENTIALS_PATH = path.join(process.cwd(), "secrets/auth.json");

// 1. Definimos el agente a nivel de módulo para reusarlo
const customAgent = new https.Agent({
    rejectUnauthorized: false
});

// 1. Scopes reducidos (Menor privilegio)
const SCOPES = [
    'https://www.googleapis.com/auth/drive',
    'https://www.googleapis.com/auth/drive.file',
    'https://www.googleapis.com/auth/drive.readonly',
    'https://www.googleapis.com/auth/spreadsheets',
    'https://www.googleapis.com/auth/gmail.modify'
];

export const getOAuthClient = async () => {
    if (!fs.existsSync(CREDENTIALS_PATH)) throw new Error("CREDENTIALS_FILE_MISSING");

    const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH));
    const config = credentials.installed || credentials.web;

    const oAuth2Client = new google.auth.OAuth2(
        config.client_id,
        config.client_secret,
        config.redirect_uris[0]
    );
    
    // Nivel A: Para el cliente OAuth2 (renovación de tokens)
    oAuth2Client.transporter.defaults.httpsAgent = customAgent;
    // 2. IMPORTANTE: Forzar el agente específicamente para las peticiones de AXIOS internas
    oAuth2Client.transporter.defaults.agent = customAgent;

    // Nivel B: Configuración global de la librería (para Sheets, Drive, etc.)
    // Esto asegura que cualquier servicio que crees herede el agente.
    google.options({
        auth: oAuth2Client,
        agent: customAgent
    });

    // Manejador de guardado de tokens (con permisos seguros)
    oAuth2Client.on('tokens', (tokens) => {
        const current = fs.existsSync(TOKEN_PATH) ? JSON.parse(fs.readFileSync(TOKEN_PATH)) : {};
        fs.writeFileSync(TOKEN_PATH, JSON.stringify({ ...current, ...tokens }, null, 2), { mode: 0o600 });
    });

    if (fs.existsSync(TOKEN_PATH)) {
        try {
            oAuth2Client.setCredentials(JSON.parse(fs.readFileSync(TOKEN_PATH)));
            // El agente configurado arriba se encargará de esta llamada
            await oAuth2Client.getAccessToken();
            return oAuth2Client;
        } catch (err) {
            console.warn("Token inválido, procediendo a flujo manual...");
            if (err.message.includes("invalid_grant")) fs.unlinkSync(TOKEN_PATH);
        }
    }

    return await authorizeManual(oAuth2Client);
};

async function authorizeManual(oAuth2Client) {
    const authUrl = oAuth2Client.generateAuthUrl({
        access_type: 'offline',
        prompt: 'consent',
        scope: SCOPES
    });

    console.log(`URL de autorización: ${authUrl}`);
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const code = await new Promise(res => rl.question("Pegue el código: ", a => res(a.trim())));
    rl.close();

    try {
        const { tokens } = await oAuth2Client.getToken({
            code: code,
            opts: { agent: customAgent } // <-- PASAMOS EL AGENTE AQUÍ DIRECTAMENTE
        });

        oAuth2Client.setCredentials(tokens);
        fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2), { mode: 0o600 });

        return oAuth2Client;
    } catch (err) {
        console.error(`Error en intercambio: ${err.message}`);
        throw err;
    }
}