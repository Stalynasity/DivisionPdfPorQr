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

export const descargaPDFEmail = async () => {
    const auth = await getOAuthClient();
    const gmail = google.gmail({ version: 'v1', auth });

    try {
        // Aseguramos que la carpeta local exista
        await fs.mkdir(CARPETA_LOCAL_DESTINO, { recursive: true });

        const res = await gmail.users.messages.list({
            userId: 'me',
            q: `subject:("[IDX] INDEXACION_AUTOMATICA_APP -") is:unread -label:${NOMBRE_ETIQUETA}`
        });

        const messages = res.data.messages || [];
        if (messages.length > 0) console.log(`INFO: GMAIL - Analizando ${messages.length} mensaje(s).`);

        for (const msgInfo of messages) {
            const msg = await gmail.users.messages.get({ userId: 'me', id: msgInfo.id });
            
            // --- NUEVA LÓGICA: EXTRAER USUARIO DEL CORREO ---
            const cabeceraFrom = msg.data.payload.headers.find(h => h.name === 'From')?.value || '';
            // La expresión regular busca cualquier texto válido de email justo antes del '@'
            const coincidencia = cabeceraFrom.match(/([a-zA-Z0-9._-]+)@/);
            const prefijoUsuario = coincidencia ? coincidencia[1] : 'usuario_desconocido';
            // ------------------------------------------------

            const todasLasPartes = msg.data.payload.parts ? buscarPdfsEnPartes(msg.data.payload.parts) : [];

            if (todasLasPartes.length === 0) {
                console.warn(`WARN: GMAIL - Mensaje ${msgInfo.id} sin PDFs. Archivando...`);
                await enviarRespuestaError(gmail, msg.data);
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

                    // --- CAMBIO DE NOMBRE DEL ARCHIVO ---
                    const fileName = `${prefijoUsuario}-${Date.now()}_${part.filename}`;
                    const filePath = path.join(CARPETA_LOCAL_DESTINO, fileName);

                    // Guardado local
                    await fs.writeFile(filePath, fileBuffer);

                    pdfsGuardadosCount++;
                } catch (errAttach) {
                    console.error(`ERROR: FS_WRITE - ${part.filename}: ${errAttach.message}`);
                }
            }

            // EVALUACIÓN FINAL
            if (pdfsGuardadosCount > 0) {
                await enviarRespuesta(gmail, msg.data);
                await marcarComoProcesado(gmail, msgInfo.id, NOMBRE_ETIQUETA);
                console.log(`INFO: SUCCESS - Mensaje ${msgInfo.id} finalizado.`);
            } else {
                console.warn(`WARN: GMAIL - Mensaje ${msgInfo.id} con error de guardado/corrupción. Notificando...`);
                await enviarRespuestaError(gmail, msg.data);
                await marcarComoProcesado(gmail, msgInfo.id, ETIQUETA_SIN_PDF);
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
    </div>
  `;

    const str = [
        `To: ${from}`, `Subject: Re: ${subject}`,
        `In-Reply-To: ${originalMsg.id}`, `References: ${originalMsg.id}`,
        `Content-Type: text/html; charset=utf-8`, `MIME-Version: 1.0`, '', cuerpoHTML
    ].join('\r\n');

    const encodedMail = Buffer.from(str).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    await gmail.users.messages.send({ userId: 'me', requestBody: { raw: encodedMail, threadId } });
}

async function enviarRespuestaError(gmail, originalMsg) {
    const threadId = originalMsg.threadId;
    const subject = originalMsg.payload.headers.find(h => h.name === 'Subject')?.value;
    const from = originalMsg.payload.headers.find(h => h.name === 'From')?.value;

    const cuerpoHTML = `
    <div style="font-family: sans-serif; color: #333; line-height: 1.6; max-width: 600px; border: 1px solid #eee; padding: 20px; border-radius: 8px;">
      <h2 style="color: #d32f2f; margin-top: 0;">Error en la Recepción del Documento</h2>
      <p>Estimado usuario,</p>
      <p><strong>No se ha podido recibir ni procesar su documento.</strong></p>
      <div style="background-color: #ffebee; border-left: 4px solid #f44336; padding: 10px 15px; margin: 20px 0;">
        <strong>Atención requerida:</strong><br>
        Por favor, revise que el correo contenga el documento adjunto en <strong>formato PDF</strong> y verifique que el archivo no esté corrupto.
      </div>
      <p>Una vez corregido el problema, le solicitamos que vuelva a enviar el documento para su digitalización.</p>
      <hr style="border: 0; border-top: 1px solid #eee; margin: 20px 0;">
      <p style="font-size: 11px; color: #888;">Sistema Automatizado de Digitalización | No responder a este correo.</p>
    </div>
    `;

    const str = [
        `To: ${from}`, `Subject: Re: ${subject}`,
        `In-Reply-To: ${originalMsg.id}`, `References: ${originalMsg.id}`,
        `Content-Type: text/html; charset=utf-8`, `MIME-Version: 1.0`, '', cuerpoHTML
    ].join('\r\n');

    const encodedMail = Buffer.from(str).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    await gmail.users.messages.send({ userId: 'me', requestBody: { raw: encodedMail, threadId } });
}