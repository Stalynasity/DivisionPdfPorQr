import express from "express";
import dotenv from "dotenv";
import splitRouter from "./routes/split.route.js";
import { watchInputFolder } from "./services/monitor.service.js";

dotenv.config({ path: "./.env" });

const app = express();
app.use(express.json());

app.use("/split", splitRouter);

const PORT = process.env.PORT || 3010;

app.listen(PORT, () => {
    // 1. Log de Inicialización de Entorno
    console.log("INFO: STARTUP - API PDF Split inicializada");
    console.log(`INFO: MONITOR - Iniciando polling de Google Drive cada 4000ms`);

    const startMonitoring = async () => {
        
        try {
            // console.log(`DEBUG: MONITOR_TICK - Inicio de escaneo a las ${new Date().toISOString()}`);
            
            await watchInputFolder();
            
        } catch (error) {
            // 4. Log de Error Estructurado
            // Reportamos el tipo de error y el contexto para evitar ambigüedades
            console.error("ERROR: MONITOR_FAILED - Excepción no controlada en el ciclo principal");
            console.error(`CONTEXT: Error_Name: ${error.name} | Message: ${error.message}`);
            
            if (error.stack) {
                console.error(`STACK_TRACE: ${error.stack}`);
            }
            
        } finally {
            setTimeout(startMonitoring, 4000);
        }
    };

    startMonitoring();
});