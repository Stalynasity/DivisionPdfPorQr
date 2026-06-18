import fs from "fs-extra";
import path from "path";
import { PDFDocument } from "pdf-lib";
import pLimit from "p-limit";
import { renderizarPdfAImagenes } from "./render.service.js";
import { leerQR } from "./qr.service.js";
import { subirArchivoDrive } from "./drive.service.js";
import { encolarEstado, encolarFilasDocumentos, encolarActualizacionCelda } from "./excel.service.js";
import { TENANT_FOLDERS, PATHS } from "../config/tenants.js";

/** Sanitiza un string para usarlo en nombres de archivo. */
const sanitizarNombre = (str) => String(str).replace(/[/\\?%*:|"<>]/g, "-");

/** Devuelve la fecha actual como "YYYY-MM-DD HH:MM:SS". */
const fechaActual = () => new Date().toISOString().replace("T", " ").split(".")[0];

/**
 * Divide un PDF en segmentos según separadores QR (SEP|<código>),
 * sube cada parte a Drive y registra los resultados en Sheets vía cola Redis.
 *
 * @param {string} rutaPdf           - Ruta absoluta del PDF en disco
 * @param {string} jobId             - ID del job BullMQ
 * @param {string} carpetaDestino    - Carpeta Drive destino para los segmentos
 * @param {object} metadatos         - Fila del Maestro (incluye rowNumber)
 */
export const dividirPdf = async (rutaPdf, jobId, carpetaDestino, metadatos) => {
    const inicio  = Date.now();
    const tmpDir  = path.join(PATHS.tempImg, `job-${jobId}`);
    const logId   = `JOB:${jobId}`;

    try {
        // ── 1. Validación ────────────────────────────────────────────────────
        if (!(await fs.pathExists(rutaPdf))) {
            throw new Error(`ARCHIVO_NO_ENCONTRADO: ${rutaPdf}`);
        }

        await fs.ensureDir(tmpDir);
        await fs.emptyDir(tmpDir);

        // ── 2. Renderizar páginas ────────────────────────────────────────────
        await renderizarPdfAImagenes(rutaPdf, tmpDir);

        const archivos = (await fs.readdir(tmpDir)).sort((a, b) => {
            const n = (f) => parseInt(f.match(/\d+/)?.[0] ?? 0);
            return n(a) - n(b);
        });

        if (!archivos.length) throw new Error("PDF_VACIO_O_RENDER_FALLIDO");
        console.log(`[SPLIT] ${logId} | Páginas renderizadas: ${archivos.length}`);

        // ── 3. Leer QR en paralelo (se omite la primera página, es la carátula) ──
        const limitarQR  = pLimit(4);
        const resultadosQR = await Promise.all(
            archivos.slice(1).map((archivo) =>
                limitarQR(async () => {
                    const indicePagina = parseInt(archivo.match(/\d+/)?.[0] ?? 1) - 1;
                    let codigoQR = null;
                    try {
                        codigoQR = await leerQR(path.join(tmpDir, archivo));
                        if (codigoQR) codigoQR = codigoQR.replace(/^"+|"+$/g, "").trim();
                    } catch (err) {
                        console.warn(`[SPLIT] Error QR — ${logId} | Pág ${indicePagina + 1}: ${err.message}`);
                    }
                    return { codigoQR, indicePagina };
                })
            )
        );

        // ── 4. Segmentar por bloques SEP|<código> ───────────────────────────
        const bloques = [];
        let bloqueActual = null;

        for (const { codigoQR, indicePagina } of resultadosQR) {
            if (codigoQR?.startsWith("SEP|")) {
                if (bloqueActual?.indices.length) bloques.push(bloqueActual);
                bloqueActual = { codigo: codigoQR.split("|")[1]?.trim() ?? "DESCONOCIDO", indices: [] };
            } else if (bloqueActual) {
                bloqueActual.indices.push(indicePagina);
            }
        }
        if (bloqueActual?.indices.length) bloques.push(bloqueActual);

        if (!bloques.length) {
            console.warn(`[SPLIT] ${logId} | Sin separadores QR válidos.`);
            throw new Error("NO_CATEGORIES_FOUND");
        }

        // ── 5. Cargar PDF fuente ─────────────────────────────────────────────
        const bufferPdf  = await fs.readFile(rutaPdf);
        const docFuente  = await PDFDocument.load(bufferPdf, { ignoreEncryption: true });
        const idSeguro   = sanitizarNombre(metadatos.ID_Caratula);

        // ── 6. Subir PDF completo (en paralelo con los segmentos) ────────────
        const tareaRespaldo = (async () => {
            const nombre  = `GEN_${idSeguro}_${jobId}.pdf`;
            const driveId = await subirArchivoDrive(bufferPdf, nombre, TENANT_FOLDERS.PDF_COMPLETO_AUTOMATIZACION);
            await encolarActualizacionCelda(
                metadatos.rowNumber,
                "Pdf_Completo",
                `DIGITALIZACION_APP/DOCUMENTOS_COMPLETOS_PROCESADOS/${nombre}`
            );
            return { categoria: "PDF_COMPLETO", url: driveId };
        })();

        // ── 7. Generar y subir segmentos (máx 2 en paralelo) ────────────────
        const limitarSubida = pLimit(2);
        const tareasSegmentos = bloques.map((bloque) =>
            limitarSubida(async () => {
                if (!bloque.indices.length) return null;
                try {
                    const nuevoDoc = await PDFDocument.create();
                    const paginas  = await nuevoDoc.copyPages(docFuente, bloque.indices);
                    paginas.forEach((p) => nuevoDoc.addPage(p));

                    const nombre  = `${sanitizarNombre(bloque.codigo)}_${idSeguro}.pdf`;
                    const bytes   = await nuevoDoc.save({ useObjectStreams: false, addDefaultFont: false });
                    const driveId = await subirArchivoDrive(Buffer.from(bytes), nombre, carpetaDestino);

                    return { categoria: bloque.codigo, url: driveId, nombre, totalPaginas: nuevoDoc.getPageCount() };
                } catch (err) {
                    console.error(`[SPLIT] Error en segmento — ${logId} | ${bloque.codigo}: ${err.message}`);
                    if (/getaddrinfo|timeout|econnreset/i.test(err.message)) {
                        throw new Error(`REINTENTO_POR_RED: ${err.message}`);
                    }
                    return null; // error no crítico: omitir segmento
                }
            })
        );

        // ── 8. Esperar todo y filtrar nulos y el respaldo ────────────────────
        const todosResultados   = await Promise.all([tareaRespaldo, ...tareasSegmentos]);
        const resultadosValidos = todosResultados.filter((r) => r && r.categoria !== "PDF_COMPLETO");

        // ── 9. Registrar segmentos en Sheets vía cola Redis ──────────────────
        if (resultadosValidos.length) {
            const fecha = fechaActual();
            const filas = resultadosValidos.map((r) => [
                r.url,
                `${r.categoria}_${metadatos.ID_Caratula}.pdf`,
                metadatos.ID_Caratula,
                r.categoria,
                metadatos.No_Identificacion,
                `https://drive.google.com/file/d/${r.url}/view`,
                fecha,
            ]);
            await encolarFilasDocumentos(filas, metadatos.APP_ASIGNADA);
        }

        const duracion = ((Date.now() - inicio) / 1000).toFixed(2);
        console.log(`[SPLIT] Completado — ${logId} | ${duracion}s | Segmentos: ${resultadosValidos.length}`);

        return { idCaratula: metadatos.ID_Caratula, jobId, archivos: resultadosValidos };

    } catch (err) {
        console.error(`[SPLIT] Fatal — ${logId}: ${err.message}`);
        await encolarEstado(metadatos.rowNumber, `SPLIT_FATAL — ${err.message}`);
        throw err;
    } finally {
        await fs.remove(tmpDir).catch(() => {});
    }
};