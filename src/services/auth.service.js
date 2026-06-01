import fs from "fs";
import path from "path";
import https from "https";
import readline from "readline";
import { google } from "googleapis";

const TOKEN_PATH       = path.join(process.cwd(), "token.json");
const CREDENTIALS_PATH = path.join(process.cwd(), "secrets/auth.json");

// Agente reutilizable — evita verificación SSL en redes corporativas con proxy
const httpsAgent = new https.Agent({ rejectUnauthorized: false });

const SCOPES = [
    "https://www.googleapis.com/auth/drive",
    "https://www.googleapis.com/auth/drive.file",
    "https://www.googleapis.com/auth/drive.readonly",
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/gmail.modify",
];

// ─── Helpers de token en disco ───────────────────────────────────────────────

const readToken  = () => JSON.parse(fs.readFileSync(TOKEN_PATH));
const writeToken = (tokens) => {
    const current = fs.existsSync(TOKEN_PATH) ? readToken() : {};
    fs.writeFileSync(TOKEN_PATH, JSON.stringify({ ...current, ...tokens }, null, 2), { mode: 0o600 });
};

// ─── Cliente OAuth ───────────────────────────────────────────────────────────

export const getOAuthClient = async () => {
    if (!fs.existsSync(CREDENTIALS_PATH)) throw new Error("CREDENTIALS_FILE_MISSING");

    const { installed, web } = JSON.parse(fs.readFileSync(CREDENTIALS_PATH));
    const config = installed ?? web;

    const client = new google.auth.OAuth2(
        config.client_id,
        config.client_secret,
        config.redirect_uris[0]
    );

    // Aplicar agente HTTPS al cliente y a todas las APIs de Google
    client.transporter.defaults.httpsAgent = httpsAgent;
    client.transporter.defaults.agent      = httpsAgent;
    google.options({ auth: client, agent: httpsAgent });

    // Persistir tokens renovados automáticamente
    client.on("tokens", writeToken);

    // Intentar con token guardado
    if (fs.existsSync(TOKEN_PATH)) {
        try {
            client.setCredentials(readToken());
            await client.getAccessToken();
            return client;
        } catch (err) {
            console.warn("[AUTH] Token inválido, iniciando flujo manual...");
            if (err.message.includes("invalid_grant")) fs.unlinkSync(TOKEN_PATH);
        }
    }

    return authorizeManual(client);
};

// ─── Flujo manual (primera vez o token revocado) ─────────────────────────────

async function authorizeManual(client) {
    const authUrl = client.generateAuthUrl({
        access_type: "offline",
        prompt: "consent",
        scope: SCOPES,
    });

    console.log(`[AUTH] Abre esta URL en tu navegador:\n${authUrl}`);

    const rl   = readline.createInterface({ input: process.stdin, output: process.stdout });
    const code = await new Promise((res) => rl.question("Pegue el código: ", (a) => res(a.trim())));
    rl.close();

    const { tokens } = await client.getToken({ code, opts: { agent: httpsAgent } });
    client.setCredentials(tokens);
    writeToken(tokens);

    return client;
}