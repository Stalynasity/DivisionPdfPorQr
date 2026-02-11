import { readBarcodes } from "zxing-wasm/reader";
import fs from "fs";

export const readQR = async (imagePath) => {
    const imageBuffer = fs.readFileSync(imagePath);
    const results = await readBarcodes(imageBuffer);
    if (!results.length) return null;
    return results[0].text; // el primer QR
};
