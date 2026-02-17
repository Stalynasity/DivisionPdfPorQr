import express from "express";
import dotenv from "dotenv";
import splitRouter from "./routes/split.route.js";
import { watchInputFolder } from "./services/monitor.service.js";

dotenv.config({ path: "./.env" });

const app = express();
app.use(express.json());

app.use("/split", splitRouter);

app.listen(3010, () => {
    console.log("API PDF Split corriendo en puerto 3010");
    
    // Definimos la función de rastreo
    const startMonitoring = async () => {
        console.log("[CRON] Revisando carpeta de entrada...");
        try {
            await watchInputFolder();
        } catch (error) {
            console.error("[CRON ERROR] Error en la ejecución del monitor:", error);
        } finally {
            setTimeout(startMonitoring, 60000);
        }
    };

    // Iniciamos el ciclo
    startMonitoring();
});