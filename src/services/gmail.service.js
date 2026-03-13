import { google } from "googleapis";
import { getOAuthClient } from "./auth.oauth.js";
import fs from "fs/promises";
import path from "path";
import dotenv from "dotenv";
dotenv.config();

// Carpeta local donde se guardarán los PDFs (ej: './descargas' o '/app/data')
const CARPETA_LOCAL_DESTINO = process.env.PATH_ENTRADA_LOCAL;
const NOMBRE_ETIQUETA = "PROCESADO_IDXA";
const ETIQUETA_SIN_PDF = "ERROR_SIN_PDF";

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

export const descargarFacturasEmail = async () => {
    const auth = await getOAuthClient();
    const gmail = google.gmail({ version: 'v1', auth });

    try {
        // Aseguramos que la carpeta local exista
        await fs.mkdir(CARPETA_LOCAL_DESTINO, { recursive: true });

        const res = await gmail.users.messages.list({
            userId: 'me',
            q: `subject:("[IDXA] INDEXACION_AUTOMATICA_APP - ") is:unread -label:${NOMBRE_ETIQUETA} -label:${ETIQUETA_SIN_PDF}`
        });

        const messages = res.data.messages || [];
        if (messages.length > 0) console.log(`INFO: GMAIL - Analizando ${messages.length} mensaje(s).`);

        for (const msgInfo of messages) {
            const msg = await gmail.users.messages.get({ userId: 'me', id: msgInfo.id });
            const todasLasPartes = msg.data.payload.parts ? buscarPdfsEnPartes(msg.data.payload.parts) : [];
            
            if (todasLasPartes.length === 0) {
                console.warn(`WARN: GMAIL - Mensaje ${msgInfo.id} sin PDFs. Archivando...`);
                await marcarComoProcesado(gmail, msgInfo.id, ETIQUETA_SIN_PDF);
                continue;
            }

            let pdfsGuardadosCount = 0;

            for (const part of todasLasPartes) {
                const attachmentId = part.body.attachmentId;
                if (!attachmentId) continue;

                try {
                    const attach = await gmail.users.messages.attachments.get({
                        userId: 'me', messageId: msgInfo.id, id: attachmentId
                    });

                    const fileBuffer = Buffer.from(attach.data.data, 'base64url');
                    
                    // Definimos la ruta completa del archivo
                    // Agregamos un timestamp al nombre para evitar sobrescribir archivos con el mismo nombre
                    const fileName = `${Date.now()}_${part.filename}`;
                    const filePath = path.join(CARPETA_LOCAL_DESTINO, fileName);

                    // Guardado local
                    await fs.writeFile(filePath, fileBuffer);

                    console.log(`INFO: LOCAL_SAVE - Guardado: ${fileName}`);
                    pdfsGuardadosCount++;
                } catch (errAttach) {
                    console.error(`ERROR: FS_WRITE - ${part.filename}: ${errAttach.message}`);
                }
            }

            if (pdfsGuardadosCount > 0) {
                await enviarRespuesta(gmail, msg.data);
                await marcarComoProcesado(gmail, msgInfo.id, NOMBRE_ETIQUETA);
                console.log(`INFO: SUCCESS - Mensaje ${msgInfo.id} finalizado.`);
            }
        }
    } catch (error) {
        console.error("CRITICAL: GMAIL_SERVICE -", error.message);
    }
};

async function marcarComoProcesado(gmail, messageId, labelName) {
    const labelId = await getOrCreateLabel(gmail, labelName);
    await gmail.users.messages.batchModify({
        userId: 'me',
        ids: [messageId],
        removeLabelIds: ['UNREAD', 'INBOX'],
        addLabelIds: [labelId]
    });
}

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

async function enviarRespuesta(gmail, originalMsg) {
    const threadId = originalMsg.threadId;
    const subject = originalMsg.payload.headers.find(h => h.name === 'Subject')?.value;
    const from = originalMsg.payload.headers.find(h => h.name === 'From')?.value;

    const cuerpoHTML = `
        <div style="font-family: sans-serif; color: #333; line-height: 1.4; max-width: 450px; border: 1px solid #e0e0e0; padding: 12px; border-radius: 6px;">
            <h3 style="color: #1a73e8; margin: 0 0 8px 0; font-size: 16px;">Confirmación de Recepción</h3>
            <p style="margin: 0 0 10px 0; font-size: 13px;">Documento recibido correctamente en el sistema local.</p>
            <p style="margin: 0; font-size: 12px; color: #10b981;">✓ En cola de procesamiento local</p>
        </div>`;

    const str = [
        `To: ${from}`, `Subject: Re: ${subject}`,
        `In-Reply-To: ${originalMsg.id}`, `References: ${originalMsg.id}`,
        `Content-Type: text/html; charset=utf-8`, `MIME-Version: 1.0`, '', cuerpoHTML
    ].join('\r\n');

    const encodedMail = Buffer.from(str).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    await gmail.users.messages.send({ userId: 'me', requestBody: { raw: encodedMail, threadId } });
}