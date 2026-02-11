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
    
    // Iniciar sensing cada 60 segundos
    setInterval(() => {
        console.log("[CRON] Revisando carpeta de entrada...");
        watchInputFolder();
    }, 60000); 
});