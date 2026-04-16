import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import readline from "readline";
import { google } from "googleapis";
import https from 'https';

// Configuración de rutas absolutas
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SCOPES = [
    'https://www.googleapis.com/auth/drive',
    'https://www.googleapis.com/auth/drive.file',
    'https://www.googleapis.com/auth/drive.readonly',
    'https://www.googleapis.com/auth/spreadsheets',
    'https://www.googleapis.com/auth/gmail.modify'
];

// Los archivos se buscan en la raíz del proyecto
const TOKEN_PATH = path.join(process.cwd(), "token.json");
const CREDENTIALS_PATH = path.join(process.cwd(), "secrets/auth.json");

export const getOAuthClient = async () => {
    // IMPORTANTE: Bypass de SSL para entornos con Proxy restrictivo
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

    // 1. Verificación de existencia de credenciales maestras
    if (!fs.existsSync(CREDENTIALS_PATH)) {
        console.error(`\x1b[31mCRITICAL: AUTH_FAILED - Archivo no encontrado en ${CREDENTIALS_PATH}\x1b[0m`);
        throw new Error("CREDENTIALS_FILE_MISSING");
    }

    const content = fs.readFileSync(CREDENTIALS_PATH);
    const credentials = JSON.parse(content);
    
    // Soporta tanto formato 'installed' como 'web' de Google Console
    const clientConfig = credentials.installed || credentials.web;
    if (!clientConfig) throw new Error("INVALID_CREDENTIALS_FORMAT");

    const { client_secret, client_id, redirect_uris } = clientConfig;
    const oAuth2Client = new google.auth.OAuth2(
        client_id,
        client_secret,
        redirect_uris[0]
    );

    // Configurar el agente HTTPS para ignorar errores de certificado si es necesario
    oAuth2Client.transporter.defaults.httpsAgent = new https.Agent({
        rejectUnauthorized: false
    });

    /**
     * MANEJADOR DE EVENTOS: Guardar tokens actualizados
     * Esto evita que el sistema pida código de nuevo si el token de acceso expira
     */
    oAuth2Client.on('tokens', (tokens) => {
        const existingToken = fs.existsSync(TOKEN_PATH) 
            ? JSON.parse(fs.readFileSync(TOKEN_PATH)) 
            : {};
        
        // Combinamos el token viejo con el nuevo (para no perder el refresh_token)
        const updatedToken = { ...existingToken, ...tokens };
        fs.writeFileSync(TOKEN_PATH, JSON.stringify(updatedToken, null, 2));
        console.log("INFO: AUTH_REFRESHED - Token actualizado en disco.");
    });

    // 2. Intentar cargar token desde disco
    if (fs.existsSync(TOKEN_PATH)) {
        try {
            const token = JSON.parse(fs.readFileSync(TOKEN_PATH));
            oAuth2Client.setCredentials(token);
            
            // Validar si el token es funcional
            await oAuth2Client.getAccessToken();
            return oAuth2Client;
        } catch (err) {
            console.warn(`WARN: AUTH_TOKEN_INVALID - Reintentando autorización... (${err.message})`);
            // Solo borramos el token si el error es de autenticación total
            if (err.message.includes("invalid_grant")) {
                fs.unlinkSync(TOKEN_PATH);
            }
        }
    }

    // 3. Flujo de Autorización Manual (Solo si falla lo anterior)
    const authUrl = oAuth2Client.generateAuthUrl({
        access_type: 'offline', // Clave para obtener el refresh_token
        prompt: 'consent',
        scope: SCOPES,
    });

    console.log("\n\x1b[43m\x1b[30m --- ACCIÓN REQUERIDA --- \x1b[0m");
    console.log("El servidor no tiene un token válido. Siga estos pasos:");
    console.log(`1. URL: \x1b[36m${authUrl}\x1b[0m`);
    console.log("2. Autorice y copie el código resultante.");

    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });

    const code = await new Promise(resolve => {
        rl.question("\nENTER_CODE: Pegue el código aquí: ", (answer) => {
            resolve(answer.trim());
        });
    });

    rl.close();

    try {
        const { tokens } = await oAuth2Client.getToken(code);
        oAuth2Client.setCredentials(tokens);
        fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));
        console.log("INFO: AUTH_INITIALIZED - Token generado y guardado.");
        return oAuth2Client;
    } catch (err) {
        console.error(`\x1b[31mERROR: AUTH_EXCHANGE_FAILED - ${err.message}\x1b[0m`);
        throw err;
    }
};