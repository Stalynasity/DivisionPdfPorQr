import { splitQueue } from "../jobs/queue.js";
import { downloadFromDrive } from "../services/drive.service.js";

export const splitController = async (req, res) => {
    try {
        const { fileId, tenant } = req.body;
        console.log("REQUEST BODY:", req.body);

        if (!fileId) {
            return res.status(400).json({ ok: false, error: "Falta fileId" });
        }

        if (!tenant) {
            return res.status(400).json({ ok: false, error: "Falta tenant" });
        }

        // 1) Descargar PDF
        const tmpPath = await downloadFromDrive(fileId);

        console.log("PDF descargado:", tmpPath);

        /// 2) Encolar job CON DATA + optimizaciones
        const job = await splitQueue.add("split", {
            pdfPath: tmpPath,
            tenant: tenant
        }, {
            attempts: 3, // reintenta hasta 3 veces si falla
            backoff: { type: "exponential", delay: 5000 }, // backoff exponencial
            removeOnComplete: true, // borra automáticamente si se completa
            removeOnFail: false     // mantiene si falla (para debug)
        });

        console.log("JOB ENCOLADO:", {
            id: job.id,
            pdfPath: tmpPath,
            tenant: tenant
        });

        res.json({
            ok: true,
            jobId: job.id
        });

    } catch (err) {
        console.error("ERROR CONTROLLER:", err);
        res.status(500).json({ ok: false, error: err.message });
    }
};
