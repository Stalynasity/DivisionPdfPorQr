const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

const TOKEN_PATH = path.join(__dirname, '../../secrets/token.json');
const CREDENTIALS_PATH = path.join(__dirname, '../../secrets/auth.json');

// Función para obtener el cliente listo
async function getAuthenticatedClient() {
    const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH));
    const { client_secret, client_id, redirect_uris } = credentials.installed || credentials.web;
    
    const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);

    // Verificar si ya tenemos un token guardado
    if (!fs.existsSync(TOKEN_PATH)) {
        throw new Error("No se encontró token. Ejecuta primero el script de inicio.");
    }

    const token = fs.readFileSync(TOKEN_PATH);
    oAuth2Client.setCredentials(JSON.parse(token));
    
    return oAuth2Client;
}

module.exports = { getAuthenticatedClient };