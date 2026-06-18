import fs from "fs/promises";
import path from "path";
import { google } from "googleapis";
import { getOAuthClient } from "./auth.service.js";
import redisGmail from "../config/redisGmail.js";
import dotenv from "dotenv";

dotenv.config();

const DESTINO = process.env.PATH_ENTRADA_LOCAL;
const LABEL_OK = "PROCESADO_IDXA";
const LABEL_ERROR = "ERROR_SIN_PDF";
const QUERY_UNREAD = `subject:("[IDX] INDEXACION_AUTOMATICA_APP -") is:unread -label:${LABEL_OK}`;
const REDIS_PREFIX = "gmail:msg:";
const REDIS_TTL = 60 * 60 * 24 * 7; // 7 días

const mensajeYaProcesado = async (messageId) => {
    const val = await redisGmail.get(REDIS_PREFIX + messageId);
    return val !== null;
};

// Cambiar 'threadId' por 'messageId'
const marcarMensajeProcesado = async (messageId) => {
    await redisGmail.set(REDIS_PREFIX + messageId, "1", "EX", REDIS_TTL);
};

// ─── Helpers privados ─────────────────────────────────────────────────────────

/** Extrae recursivamente todas las partes adjuntas que sean PDF. */
const findPdfParts = (parts = []) => {
    const pdfs = [];
    for (const part of parts) {
        if (part.parts) findPdfParts(part.parts).forEach(p => pdfs.push(p));
        else if (part.filename?.toLowerCase().endsWith(".pdf")) pdfs.push(part);
    }
    return pdfs;
};

/** Obtiene el valor de un header del mensaje por nombre. */
const getHeader = (msg, name) =>
    msg.payload.headers.find((h) => h.name === name)?.value ?? "";

/** Extrae el prefijo del remitente (la parte antes del @). */
const senderPrefix = (from) =>
    from.match(/([a-zA-Z0-9._-]+)@/)?.[1] ?? "usuario_desconocido";

/** Resuelve o crea una etiqueta Gmail por nombre. */
const resolveLabel = async (gmail, name) => {
    const { data } = await gmail.users.labels.list({ userId: "me" });
    const found = data.labels.find((l) => l.name === name);
    if (found) return found.id;

    const created = await gmail.users.labels.create({
        userId: "me",
        requestBody: { name, labelListVisibility: "labelShow", messageListVisibility: "show" },
    });
    return created.data.id;
};

/** Mueve el mensaje a la etiqueta indicada y lo saca del INBOX. */
const archiveWithLabel = async (gmail, messageId, labelName) => {
    const labelId = await resolveLabel(gmail, labelName);
    await gmail.users.messages.batchModify({
        userId: "me",
        ids: [messageId],
        removeLabelIds: ["UNREAD", "INBOX"],
        addLabelIds: [labelId],
    });
};

/**
 * Construye y envía un email de respuesta en el mismo hilo.
 * @param {string} cuerpoHTML - HTML del cuerpo del mensaje
 */
const sendReply = async (gmail, originalMsg, cuerpoHTML) => {
    const from = getHeader(originalMsg, "From");
    const subject = getHeader(originalMsg, "Subject");

    const raw = [
        `To: ${from}`,
        `Subject: Re: ${subject}`,
        `In-Reply-To: ${originalMsg.id}`,
        `References: ${originalMsg.id}`,
        `Content-Type: text/html; charset=utf-8`,
        `MIME-Version: 1.0`,
        "",
        cuerpoHTML,
    ].join("\r\n");

    const encoded = Buffer.from(raw).toString("base64")
        .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

    await gmail.users.messages.send({
        userId: "me",
        requestBody: { raw: encoded, threadId: originalMsg.threadId },
    });
};

// ─── Plantillas de respuesta ──────────────────────────────────────────────────

const HTML_OK = `
<div style="font-family:sans-serif;color:#333;line-height:1.6;max-width:600px;border:1px solid #eee;padding:20px;border-radius:8px">
  <h2 style="color:#1a73e8;margin-top:0">Confirmación de Recepción</h2>
  <p>Se recibió y guardó correctamente el PDF para el proceso de <strong>Indexación Automática</strong>.</p>
  <div style="background:#fff4e5;border-left:4px solid #ff9800;padding:10px 15px;margin:20px 0">
    <strong>Validación de Calidad:</strong><br>
    Asegúrese de que el PDF tenga el orden correcto: <em>Carátula + Separador + Contenido…</em>
  </div>
  <p>El documento está en cola para su procesamiento.</p>
  <hr style="border:0;border-top:1px solid #eee;margin:20px 0">
  <p style="font-size:11px;color:#888">Sistema Automatizado de Digitalización | No responder.</p>
</div>`;

const HTML_ERROR = `
<div style="font-family:sans-serif;color:#333;line-height:1.6;max-width:600px;border:1px solid #eee;padding:20px;border-radius:8px">
  <h2 style="color:#d32f2f;margin-top:0">Error en la Recepción del Documento</h2>
  <p>Estimado usuario,</p>
  <p><strong>No se pudo recibir ni procesar su documento.</strong></p>
  <div style="background:#ffebee;border-left:4px solid #f44336;padding:10px 15px;margin:20px 0">
    <strong>Atención requerida:</strong><br>
    Revise que el correo tenga el PDF adjunto y que el archivo no esté corrupto.
  </div>
  <p>Por favor, vuelva a enviar el documento corregido.</p>
  <hr style="border:0;border-top:1px solid #eee;margin:20px 0">
  <p style="font-size:11px;color:#888">Sistema Automatizado de Digitalización | No responder.</p>
</div>`;

// ─── Función principal ────────────────────────────────────────────────────────

export const descargaPDFEmail = async () => {
    const auth = await getOAuthClient();
    const gmail = google.gmail({ version: "v1", auth });

    await fs.mkdir(DESTINO, { recursive: true });

    const { data } = await gmail.users.messages.list({ userId: "me", q: QUERY_UNREAD });
    const messages = data.messages ?? [];

    if (!messages.length) return;

    // FIX #2 — obtener internalDate y ordenar cronológicamente antes de procesar
    const mensajesConFecha = await Promise.all(
        messages.map(async ({ id, threadId }) => {
            const { data: meta } = await gmail.users.messages.get({
                userId: "me", id, format: "metadata",
                metadataHeaders: ["From", "Subject"],
            });
            return { id, threadId, internalDate: Number(meta.internalDate) };
        })
    );
    mensajesConFecha.sort((a, b) => a.internalDate - b.internalDate);

    console.log(`[GMAIL] ${mensajesConFecha.length} mensaje(s) pendientes.`);

    for (const { id, threadId } of mensajesConFecha) {

        // FIX #1 CORREGIDO: Usar el ID del mensaje, no del hilo
        if (await mensajeYaProcesado(id)) {
            console.warn(`[GMAIL] Mensaje ${id} omitido — mensaje ya procesado (Redis).`);
            await archiveWithLabel(gmail, id, LABEL_OK);
            continue;
        }

        const { data: msg } = await gmail.users.messages.get({ userId: "me", id });
        const prefix = senderPrefix(getHeader(msg, "From"));
        const pdfParts = findPdfParts(msg.payload.parts ?? []);

        if (!pdfParts.length) {
            console.warn(`[GMAIL] Mensaje ${id} sin PDFs.`);
            await sendReply(gmail, msg, HTML_ERROR);
            await archiveWithLabel(gmail, id, LABEL_ERROR);
            continue;
        }

        let saved = 0;
        let failed = 0;

        for (const part of pdfParts) {
            // FIX #3 — contar adjuntos sin ID como fallo en vez de ignorarlos
            if (!part.body?.attachmentId) {
                console.warn(`[GMAIL] Parte sin attachmentId: ${part.filename}`);
                failed++;
                continue;
            }
            try {
                const { data: attach } = await gmail.users.messages.attachments.get({
                    userId: "me", messageId: id, id: part.body.attachmentId,
                });
                const buffer = Buffer.from(attach.data, "base64url");
                const fileName = `${prefix}-${Date.now()}_${part.filename}`;
                await fs.writeFile(path.join(DESTINO, fileName), buffer);
                console.log(`[GMAIL] Guardado: ${fileName}`);
                saved++;
            } catch (err) {
                console.error(`[GMAIL] Error guardando ${part.filename}: ${err.message}`);
                failed++;
            }
        }

        if (saved > 0) {
            await sendReply(gmail, msg, HTML_OK);
            await archiveWithLabel(gmail, id, LABEL_OK);
            
            // FIX #4 CORREGIDO: Guardar en Redis usando el ID del mensaje
            await marcarMensajeProcesado(id); 
            console.log(`[GMAIL] Mensaje ${id} procesado — ${saved} PDF(s) guardados, ${failed} fallidos.`);
        } else {
            console.warn(`[GMAIL] Mensaje ${id} — todos los adjuntos fallaron (${failed} errores).`);
            await sendReply(gmail, msg, HTML_ERROR);
            await archiveWithLabel(gmail, id, LABEL_ERROR);
        }
    }
};