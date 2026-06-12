import express from "express";
import dotenv from "dotenv";
import { getOAuthClient } from "./services/auth.service.js";
import { iniciarCiclosBatch } from "./services/batch.service.js";
import { iniciarSchedulerMantenimiento } from "./services/maintenance.service.js";
import { descargaPDFEmail } from "./services/gmail.service.js";
import { vigilarCarpetaEntrada } from "./services/monitor.service.js";

dotenv.config();

const app  = express();
const PORT = process.env.PORT ?? 3010;
app.use(express.json());

// ─── Arranque ─────────────────────────────────────────────────────────────────

app.listen(PORT, async () => {
    console.log(`[SERVER] Escuchando en puerto ${PORT}`);

    // 1. Validar credenciales Google — si falla, no tiene sentido arrancar
    try {
        await getOAuthClient();
        console.log("[SERVER] Credenciales de Google OK");
    } catch (err) {
        console.error(`[CRITICAL] Autorización Google fallida: ${err.message}`);
        process.exit(1);
    }

    // 2. Batch Redis → Sheets
    iniciarCiclosBatch();

    // 3. Cron de mantenimiento semanal
    iniciarSchedulerMantenimiento();

    // 4. Monitor de carpeta de entrada (cada 4 s)
    ejecutarEnBucle("MONITOR", vigilarCarpetaEntrada, 4_000);
});

// ─── Cierre limpio ────────────────────────────────────────────────────────────

process.on("SIGINT", () => {
    console.log("\n[SERVER] Apagando...");
    process.exit(0);
});

// ─── Helper ───────────────────────────────────────────────────────────────────

/**
 * Ejecuta una función en bucle con un intervalo fijo entre cada llamada.
 * Los errores se loguean pero nunca detienen el ciclo.
 *
 * @param {string}   nombre      - Nombre del ciclo para los logs
 * @param {Function} fn          - Función async a ejecutar
 * @param {number}   intervaloMs - Milisegundos de espera entre ejecuciones
 */
function ejecutarEnBucle(nombre, fn, intervaloMs) {
    const ciclo = async () => {
        try {
            await fn();
        } catch (err) {
            console.error(`[${nombre}] Error en ciclo: ${err.message}`);
        } finally {
            setTimeout(ciclo, intervaloMs);
        }
    };
    console.log(`[SERVER] ${nombre} iniciado (intervalo: ${intervaloMs / 1000}s)`);
    ciclo();
}