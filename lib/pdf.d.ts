/**
 * @module pdf
 *
 * Convert markdown artifacts to PDF for WhatsApp media attachments.
 * ADR-004: Serve PDFs via cloudflared tunnel.
 */
/**
 * Convert a markdown file to PDF using md-to-pdf.
 * Returns the absolute path to the generated PDF.
 */
export declare function markdownToPdf(markdownPath: string, outputDir: string, outputFilename: string): Promise<string>;
/**
 * Generate a PDF for a spec artifact and return the media URL.
 */
export declare function generateArtifactPdf(artifactPath: string, specName: string, artifactType: string, dataDir: string, tunnelUrl: string): Promise<string>;
