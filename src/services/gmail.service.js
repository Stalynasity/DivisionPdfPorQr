import { google } from "googleapis";
import { getOAuthClient } from "./auth.oauth.js";
import { Readable } from "stream"; // <--- CRÍTICO para solucionar el error .pipe()
import dotenv from "dotenv";
dotenv.config();

const ID_CARPETA_DESTINO = process.env.FOLDER_ENTRADA;
const NOMBRE_ETIQUETA = "PROCESADO_IDXA";

/**
 * Busca recursivamente archivos PDF en la estructura del mensaje de Gmail.
 * Maneja correos simples y correos complejos (multipart/related, multipart/mixed).
 */
function buscarPdfsEnPartes(parts, allPdfs = []) {
    for (const part of parts) {
        if (part.parts) {
            buscarPdfsEnPartes(part.parts, allPdfs);
        } else if (part.filename && part.filename.toLowerCase().endsWith('.pdf')) {
            allPdfs.push(part);
        }
    }
    return allPdfs;
}

/**
 * Servicio principal para descargar PDFs desde Gmail y subirlos a Drive.
 */
export const descargarFacturasEmail = async () => {
    console.log("DEBUG: GMAIL - Iniciando ciclo de descarga...");
    const auth = await getOAuthClient();
    const gmail = google.gmail({ version: 'v1', auth });
    const drive = google.drive({ version: 'v3', auth });

    try {
        // 1. Buscar correos con el asunto específico, no leídos y no procesados
        const res = await gmail.users.messages.list({
            userId: 'me',
            q: `subject:("[IDXA] INDEXACION_AUTOMATICA_APP - ") is:unread -label:${NOMBRE_ETIQUETA}`
        });

        const messages = res.data.messages || [];
        console.log(`INFO: GMAIL_POLLING - Mensajes candidatos encontrados: ${messages.length}`);

        for (const msgInfo of messages) {
            console.log(`DEBUG: GMAIL - Extrayendo contenido del mensaje: ${msgInfo.id}`);
            const msg = await gmail.users.messages.get({ userId: 'me', id: msgInfo.id });
            const payload = msg.data.payload;

            // Buscamos todos los adjuntos PDF (incluso en correos con imágenes o firmas complejas)
            const todasLasPartes = payload.parts ? buscarPdfsEnPartes(payload.parts) : [];
            let pdfsGuardadosCount = 0;

            for (const part of todasLasPartes) {
                const attachmentId = part.body.attachmentId;
                if (!attachmentId) continue;

                console.log(`DEBUG: GMAIL - Descargando adjunto: ${part.filename}`);

                try {
                    // Obtener los datos binarios del adjunto
                    const attach = await gmail.users.messages.attachments.get({
                        userId: 'me',
                        messageId: msgInfo.id,
                        id: attachmentId
                    });

                    // Convertimos la data de Gmail (base64url) a un Buffer de Node.js
                    const fileBuffer = Buffer.from(attach.data.data, 'base64url');

                    // --- SOLUCIÓN AL ERROR .PIPE() ---
                    // Convertimos el Buffer en un Stream legible para que la API de Drive no falle
                    const bufferStream = Readable.from(fileBuffer);

                    const driveRes = await drive.files.create({
                        requestBody: {
                            name: part.filename,
                            parents: [ID_CARPETA_DESTINO]
                        },
                        media: {
                            mimeType: 'application/pdf',
                            body: bufferStream // <--- Enviamos el Stream
                        }
                    });

                    console.log(`INFO: DRIVE_UPLOAD - Éxito: ${part.filename} (ID: ${driveRes.data.id})`);
                    pdfsGuardadosCount++;

                } catch (errAttach) {
                    console.error(`ERROR: GMAIL_ATTACH_PROC - Falló adjunto ${part.filename}: ${errAttach.message}`);
                }
            }

            // 2. Si procesamos al menos un PDF, respondemos y etiquetamos el correo
            if (pdfsGuardadosCount > 0) {
                try {
                    console.log(`DEBUG: GMAIL - Enviando respuesta automática y archivando hilo...`);
                    await enviarRespuesta(gmail, msg.data);

                    const labelId = await getOrCreateLabel(gmail, NOMBRE_ETIQUETA);

                    await gmail.users.messages.batchModify({
                        userId: 'me',
                        ids: [msgInfo.id],
                        removeLabelIds: ['UNREAD', 'INBOX'],
                        addLabelIds: [labelId]
                    });

                    console.log(`INFO: GMAIL_SUCCESS - Proceso completo para mensaje: ${msgInfo.id}`);
                } catch (errFinal) {
                    console.error(`ERROR: GMAIL_POST_PROCESS - ${errFinal.message}`);
                }
            }
        }
    } catch (error) {
        console.error("CRITICAL: GMAIL_SERVICE_FAILED -", error.message);
    }
};

/**
 * Obtiene el ID de la etiqueta de control o la crea si no existe.
 */
async function getOrCreateLabel(gmail, name) {
    const res = await gmail.users.labels.list({ userId: 'me' });
    const label = res.data.labels.find(l => l.name === name);
    if (label) return label.id;

    const newLabel = await gmail.users.labels.create({
        userId: 'me',
        requestBody: { name, labelListVisibility: 'labelShow', messageListVisibility: 'show' }
    });
    return newLabel.data.id;
}

/**
 * Envía una respuesta por correo electrónico manteniendo el hilo de conversación.
 */
async function enviarRespuesta(gmail, originalMsg) {
    const threadId = originalMsg.threadId;
    const subject = originalMsg.payload.headers.find(h => h.name === 'Subject')?.value;
    const from = originalMsg.payload.headers.find(h => h.name === 'From')?.value;

    const cuerpoHTML = `
        <div style="font-family: sans-serif; color: #333; line-height: 1.6; max-width: 600px; border: 1px solid #eee; padding: 20px; border-radius: 8px;">
          <h2 style="color: #1a73e8; margin-top: 0;">Confirmación de Recepción</h2>
          <p>Se ha recibido y guardado correctamente el archivo PDF para el proceso de <strong>Indexación Automática</strong>.</p>
          <div style="background-color: #fff4e5; border-left: 4px solid #ff9800; padding: 10px 15px; margin: 20px 0;">
            <strong>Validación de Calidad:</strong><br>
            Por favor, asegúrese de que el PDF escaneado contenga el orden correcto: 
            <br><em>Carátula + Separador + Contenido...</em>.
          </div>
          <p>El documento ha sido puesto en cola para su procesamiento.</p>
          <hr style="border: 0; border-top: 1px solid #eee; margin: 20px 0;">
          <p style="font-size: 11px; color: #888;">Sistema Automatizado de Digitalización | No responder a este correo.</p>
        </div>`;

    const str = [
        `To: ${from}`,
        `Subject: Re: ${subject}`,
        `In-Reply-To: ${originalMsg.id}`,
        `References: ${originalMsg.id}`,
        `Content-Type: text/html; charset=utf-8`,
        `MIME-Version: 1.0`,
        '',
        cuerpoHTML
    ].join('\r\n');

    const encodedMail = Buffer.from(str)
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');

    await gmail.users.messages.send({
        userId: 'me',
        requestBody: { raw: encodedMail, threadId }
    });
}
