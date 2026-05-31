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
            // tryHarder: true,
            tryInvert: true,
            formats: ["QRCode"],
            isPure: false,
            // binarizer: "GlobalHistogram"
        });

        if (results?.length > 0) {
            console.log(`QR Detectado: ${results[0].text}`);
            return results[0].text;
        }

        return null;

    } catch (err) {
        // Manejo de errores de memoria AMPLIADO
        const errorMsg = err.message.toLowerCase();
        if (errorMsg.includes('excptr') || errorMsg.includes('undefined') || errorMsg.includes('allocate') || errorMsg.includes('memory')) {
            console.error("Crash de memoria WASM detectado. Reiniciando motor para la próxima lectura...");
            isPrepared = false;
            try { purgeZXingModule(); } catch (e) {}
        } else {
            console.error(`❌ ERROR_QR_SERVICE: ${err.message}`);
        }
        return null;
    }
};