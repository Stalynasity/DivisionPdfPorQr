import { readBarcodes, prepareZXingModule, purgeZXingModule } from "zxing-wasm/reader";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let isPrepared = false;

/**
 * Lee códigos QR de una imagen de forma local usando ZXing WASM.
 * Incluye auto-recuperación en caso de fallos de memoria WebAssembly.
 */
export const readQR = async (imagePath) => {
    try {
        if (!fs.existsSync(imagePath)) return null;

        // Inicialización única del motor
        if (!isPrepared) {
            const wasmPath = path.join(__dirname, "zxing_reader.wasm");
            
            await prepareZXingModule({
                overrides: {
                    wasmBinary: fs.readFileSync(wasmPath),
                    noInitialRun: true
                },
                fireImmediately: true
            });
            
            isPrepared = true;
        }

        const results = await readBarcodes(fs.readFileSync(imagePath), {
            tryHarder: true,
            formats: ["QRCode"]
        });

        if (results?.length > 0) {
            console.log(`✅ QR Detectado: ${results[0].text}`);
            return results[0].text;
        }

        return null;

    } catch (err) {
        // Manejo de errores de memoria (excPtr/undefined)
        if (err.message.includes('excPtr') || err.message.includes('undefined')) {
            console.error("Crash de memoria WASM. Reiniciando motor...");
            isPrepared = false;
            try { purgeZXingModule(); } catch (e) {}
        } else {
            console.error(`❌ ERROR_QR_SERVICE: ${err.message}`);
        }
        return null;
    }
};