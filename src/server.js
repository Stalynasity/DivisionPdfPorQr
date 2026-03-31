import express from "express";
import dotenv from "dotenv";
import { watchInputFolder } from "./services/monitor.service.js";
import { startBatchFlushCycle } from "./services/batch.service.js";
import { initMaintenanceScheduler } from "./services/maintenance.service.js";

dotenv.config({ path: "./.env" });

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3010;

app.listen(PORT, () => {
    console.log(`API PDF Split inicializada en puerto ${PORT}`);

    // 1. Iniciar el vaciado de Redis a Excel (Batch)
    startBatchFlushCycle();

    // 2. Iniciar el calendario de mantenimiento (Cron)
    initMaintenanceScheduler();

    const startMonitoring = async () => {
        const timestamp = new Date().toLocaleString();
        try {
            await watchInputFolder();

        } catch (error) {
            console.error(`[${timestamp}] ERROR: MONITOR_FAILED - Excepción en el ciclo de monitoreo`);
            console.error(` MOTIVO: ${error.message}`);
            
            if (error.stack) {
                console.error(`DETALLE: ${error.stack.split('\n')[1]}`); // Muestra la línea del error
            }
        } finally {
            // Importante: No bajar de 4000ms para no saturar las APIs de Google
            // El uso de setTimeout asegura que el siguiente ciclo solo empiece DESPUÉS de que termine el actual
            setTimeout(startMonitoring, 4000);
        }
    };

    // Iniciar el ciclo por primera vez
    startMonitoring();
});

// Manejo de cierres limpios
process.on('SIGINT', () => {
    console.log("\nINFO: Apagando servidor de monitoreo...");
    process.exit(0);
});