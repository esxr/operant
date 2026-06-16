/**
 * @module pdf
 *
 * Convert markdown artifacts to PDF for WhatsApp media attachments.
 * ADR-004: Serve PDFs via cloudflared tunnel.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
/**
 * Convert a markdown file to PDF using md-to-pdf.
 * Returns the absolute path to the generated PDF.
 */
export async function markdownToPdf(markdownPath, outputDir, outputFilename) {
    const { mdToPdf } = await import("md-to-pdf");
    mkdirSync(outputDir, { recursive: true });
    const outputPath = join(outputDir, outputFilename);
    const pdf = await mdToPdf({ path: markdownPath }, {
        dest: outputPath,
        pdf_options: {
            format: "A4",
            margin: { top: "20mm", right: "20mm", bottom: "20mm", left: "20mm" },
        },
    });
    if (pdf?.content) {
        writeFileSync(outputPath, pdf.content);
    }
    return outputPath;
}
/**
 * Generate a PDF for a spec artifact and return the media URL.
 */
export async function generateArtifactPdf(artifactPath, specName, artifactType, dataDir, tunnelUrl) {
    const outputDir = join(dataDir, "media", specName);
    const outputFilename = `${artifactType}.pdf`;
    await markdownToPdf(artifactPath, outputDir, outputFilename);
    return `${tunnelUrl}/media/${specName}/${outputFilename}`;
}
