import express from "express";
import dotenv from "dotenv";
import { watchInputFolder } from "./services/monitor.service.js";

dotenv.config({ path: "./.env" });

const app = express();
app.use(express.json());


const PORT = process.env.PORT || 3010;

app.listen(PORT, () => {
    console.log("INFO: STARTUP - API PDF Split inicializada");

    const startMonitoring = async () => {
        try {
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