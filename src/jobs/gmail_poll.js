import { descargaPDFEmail } from "../services/gmail.service.js";

const INTERVALO_MS = 60000;

async function runPoll() {
    try {
        await descargaPDFEmail();
    } catch (error) {
        console.error("ERROR: GMAIL_POLL_JOB -", error.message);
    } finally {
        setTimeout(runPoll, INTERVALO_MS);
    }
}

// Iniciar el ciclo
console.log(`INFO: GMAIL_POLL - Iniciado (Intervalo: ${INTERVALO_MS / 1000 / 60} min)`);
runPoll();