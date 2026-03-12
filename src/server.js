import express from "express";
import dotenv from "dotenv";
import splitRouter from "./routes/split.route.js";
import { watchInputFolder } from "./services/monitor.service.js";
import { descargarFacturasEmail } from "./services/gmail.service.js";

dotenv.config({ path: "./.env" });

const app = express();
app.use(express.json());

app.use("/split", splitRouter);

const PORT = process.env.PORT || 3010;

app.listen(PORT, () => {
    // 1. Log de Inicialización de Entorno
    console.log("INFO: STARTUP - API PDF Split inicializada");

    const startMonitoring = async () => {
        try {
            // 1. Descarga de Gmail
            await descargarFacturasEmail();

            // 2. Monitoreo de Drive (Función existente)
            await watchInputFolder();

        } catch (error) {
            console.error("ERROR: MONITOR_FAILED - Excepción no controlada");
            console.error(`CONTEXT: ${error.message}`);
        } finally {
            // Importante: No bajar de 4000ms para no saturar las APIs de Google
            setTimeout(startMonitoring, 4000);
        }
    };

    startMonitoring();
});