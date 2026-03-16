import { readBarcodes, prepareZXingModule, purgeZXingModule } from "zxing-wasm/reader";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let isPrepared = false;
// Solo guardamos la ruta, NO cargamos el archivo en memoria aqui
const wasmPath = path.join(__dirname, "zxing_reader.wasm");

export const readQR = async (imagePath) => {
    const startTime = Date.now();
    const fileName = path.basename(imagePath);
    
    try {
        if (!fs.existsSync(imagePath)) return null;

        // Validacion de existencia del WASM
        if (!fs.existsSync(wasmPath)) {
            console.error("[QR-LOG] Error: No se encuentra el archivo .wasm en " + wasmPath);
            return null;
        }

        // --- Inicializacion del Motor ---
        if (!isPrepared) {
            try {
                await prepareZXingModule({
                    // Dejamos que la libreria gestione el fetch localmente
                    locateFile: (path) => {
                        if (path.endsWith('.wasm')) return wasmPath;
                        return path;
                    }
                });
                isPrepared = true;
            } catch (pErr) {
                console.error(`[QR-LOG] Error preparando modulo: ${pErr.message}`);
                return null;
            }
        }

        // --- Lectura ---
        const imageBuffer = fs.readFileSync(imagePath);
        
        const results = await readBarcodes(imageBuffer, {
            tryHarder: false, 
            formats: ["QRCode"],
            maxSymbols: 1
        });

        const duration = Date.now() - startTime;

        if (results?.length > 0) {
            console.log(`[QR-LOG] EXITO: "${results[0].text}" en ${duration}ms`);
            return results[0].text;
        }
        return null;

    } catch (err) {
        const errorDuration = Date.now() - startTime;
        
        // Si hay error de tabla, forzamos purga y reset
        if (err.message.includes('index') || err.message.includes('table') || err.message.includes('excPtr')) {
            console.error(`[QR-LOG] Crash de memoria detectado en ${errorDuration}ms`);
            isPrepared = false;
            try { 
                await purgeZXingModule(); 
                console.log(`[QR-LOG] Motor purgado`);
            } catch (e) {}
        } else {
            console.error(`[QR-LOG] Error en servicio QR: ${err.message}`);
        }
        return null;
    }
};